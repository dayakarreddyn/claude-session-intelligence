#!/usr/bin/env node
/**
 * Session Intelligence — Task Change Detector
 *
 * Runs on UserPromptSubmit. Decides whether the new prompt is in the SAME
 * domain as the current task (from session-context.md). If it's clearly a
 * different domain AND context is heavy enough to matter, the hook asks the
 * user whether to /clear, /compact, or continue — then blocks the prompt so
 * the user can act before work starts.
 *
 * Signals (combined into a 0..1 same-domain score):
 *   1. File overlap   — paths mentioned in the new prompt vs. Key Files in
 *                       session-context.md.
 *   2. Git locality   — paths mentioned in the new prompt vs. files the git
 *                       working tree has actually touched.
 *   3. Root prefix    — top-level folder of new files vs. tracked files.
 *   4. Keyword Jaccard — stopword-filtered Jaccard between current task
 *                        description and new prompt.
 *
 * Absence of a signal is neutral, not negative — a prompt that mentions no
 * files relies on (4) alone.
 *
 * Decision matrix (requires tokens ≥ taskChange.minTokens to fire at all):
 *   score ≥ sameDomainScore      → silent
 *   differentDomain < score      → advise /compact (preserve current task)
 *   score < differentDomainScore → advise /clear (fresh start cheaper)
 *
 * One-shot per (session, promptHash). Reset when tokens drop after
 * /compact or /clear so the next change is detected again.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const {
  getTempDir,
  writeFile,
  log,
} = require('../lib/utils');
const { intelLog } = require('../lib/intel-debug');

function loadSiConfig() {
  try { return require('../lib/config').loadConfig(); }
  catch { return null; }
}

// ─── Inputs ──────────────────────────────────────────────────────────────────

function readStdinSync() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function parseInput(raw) {
  try { return raw.trim() ? JSON.parse(raw) : {}; } catch { return {}; }
}

function resolveProjectDir(cwd) {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const projectsDir = path.join(home, '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return null;
  const encoded = cwd.replace(/\//g, '-');
  const direct = path.join(projectsDir, encoded);
  if (fs.existsSync(direct)) return direct;
  try {
    const children = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const d of children) {
      if (!d.isDirectory()) continue;
      const decoded = '/' + d.name.replace(/^-/, '').replace(/-/g, '/');
      if (cwd.startsWith(decoded)) return path.join(projectsDir, d.name);
    }
  } catch { /* ignore */ }
  return null;
}

function readSessionContext(projectDir) {
  if (!projectDir) return '';
  try {
    return fs.readFileSync(path.join(projectDir, 'session-context.md'), 'utf8');
  } catch { return ''; }
}

function extractCurrentTaskText(sessionContext) {
  const m = sessionContext.match(/##\s+Current Task\s*([\s\S]*?)(?=\n##\s|$)/);
  return m ? m[1].trim() : '';
}

function extractKeyFiles(sessionContext) {
  const m = sessionContext.match(/##\s+Key Files\s*([\s\S]*?)(?=\n##\s|$)/);
  if (!m) return [];
  const files = [];
  for (const line of m[1].split('\n')) {
    const t = line.trim().replace(/^[-*\s]+/, '');
    if (!t) continue;
    // First whitespace-delimited token that looks like a path.
    const pathMatch = t.match(/[^\s`'"]+[./][^\s`'"]+/);
    if (pathMatch) files.push(pathMatch[0].replace(/[,.;]$/, ''));
  }
  return files;
}

// ─── Prompt parsing ──────────────────────────────────────────────────────────

const EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|cpp|c|h|hpp|cs|sql|md|json|yaml|yml|toml|html|css|scss|sh|bash)\b/i;

function extractPromptFiles(prompt) {
  if (!prompt) return [];
  const found = new Set();

  // `@path/to/file.ext` mentions.
  for (const m of prompt.matchAll(/@([^\s`'"]+[./][^\s`'"]+)/g)) {
    found.add(m[1].replace(/[,.;]$/, ''));
  }
  // Backtick-quoted paths.
  for (const m of prompt.matchAll(/`([^`]+)`/g)) {
    const t = m[1].trim();
    if (/[./]/.test(t) && !/\s/.test(t)) found.add(t.replace(/[,.;]$/, ''));
  }
  // Bare path-like tokens with a recognisable extension.
  for (const m of prompt.matchAll(/(?:^|\s)([^\s`'"]+\/[^\s`'"]+)/g)) {
    const t = m[1].replace(/[,.;:]$/, '');
    if (EXT_RE.test(t) || /\//.test(t)) found.add(t);
  }

  return [...found];
}

function gitTrackedChangeSet(cwd) {
  const opts = {
    encoding: 'utf8', timeout: 1500,
    stdio: ['ignore', 'pipe', 'ignore'],
  };
  let out = '';
  let extra = '';
  try { out = execFileSync('git', ['-C', cwd, 'diff', '--name-only', 'HEAD'], opts); } catch { /* not a repo */ }
  try { extra = execFileSync('git', ['-C', cwd, 'ls-files', '--others', '--exclude-standard'], opts); } catch { /* ignore */ }
  return new Set([...out.split('\n'), ...extra.split('\n')].map((s) => s.trim()).filter(Boolean));
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

function rootPrefix(p) {
  const parts = p.split('/').filter(Boolean);
  if (!parts.length) return '';
  // Prefer first two segments so "src/api" is distinct from "src/frontend".
  return parts.slice(0, 2).join('/');
}

function fileOverlap(newFiles, keyFiles, gitSet) {
  if (!newFiles.length) return { score: null, reason: 'no-files-in-prompt' };

  const normalise = (p) => p.replace(/^\.\//, '').toLowerCase();
  const keySet = new Set(keyFiles.map(normalise));
  const gitNorm = new Set([...gitSet].map(normalise));
  const newNorm = newFiles.map(normalise);

  let directHit = 0;
  let rootHit = 0;
  const keyRoots = new Set([...keySet, ...gitNorm].map(rootPrefix));

  for (const p of newNorm) {
    if (keySet.has(p) || gitNorm.has(p)) directHit++;
    else if (keyRoots.has(rootPrefix(p))) rootHit++;
  }

  const total = newNorm.length;
  if (total === 0) return { score: null, reason: 'no-files' };

  // Direct hits are worth more than root-prefix hits.
  const weighted = (directHit + rootHit * 0.5) / total;
  return {
    score: Math.min(1, weighted),
    reason: `direct=${directHit} root=${rootHit} total=${total}`,
  };
}

const STOPWORDS = new Set([
  'the','a','an','and','or','but','if','then','else','for','in','on','at','to','of',
  'from','by','with','as','is','are','was','were','be','been','being','it','this',
  'that','these','those','we','i','you','can','should','would','could','will','do',
  'does','did','have','has','had','my','our','your','let','lets','how','what','why',
  'when','where','now','please','need','help','also','just','like','about','so','not',
  'no','yes','ok','ill','im',
]);

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s/_.-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && t.length > 2 && !STOPWORDS.has(t));
}

function jaccard(oldText, newText) {
  const a = new Set(tokenize(oldText));
  const b = new Set(tokenize(newText));
  if (!a.size || !b.size) return { score: null, reason: 'insufficient-tokens' };
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return { score: union === 0 ? null : inter / union, reason: `|A|=${a.size} |B|=${b.size} |∩|=${inter}` };
}

function combineSignals(signals) {
  const defined = signals.filter((s) => s.score !== null && s.score !== undefined);
  if (!defined.length) return { score: null, parts: signals };
  let weighted = 0;
  let weightSum = 0;
  for (const s of defined) {
    weighted += s.score * s.weight;
    weightSum += s.weight;
  }
  return { score: weighted / weightSum, parts: signals };
}

// ─── Token budget ────────────────────────────────────────────────────────────

function readTokenBudget(sessionId) {
  const file = path.join(getTempDir(), `claude-token-budget-${sessionId}`);
  try {
    const n = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}

function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ─── Dialog ──────────────────────────────────────────────────────────────────

function askUserTaskChange(action, score, tokens, cfg) {
  if (cfg.prompt === false) return 'unavailable';
  if (process.platform !== 'darwin') return 'unavailable';

  const body =
    `New prompt looks like a different task domain (same-domain score ${score.toFixed(2)}).\n` +
    `Context is at ~${fmtTokens(tokens)} tokens.\n\n` +
    (action === 'clear'
      ? `Fresh start (/clear) is usually cheapest. What do you want to do?`
      : `Recommend /compact (preserve current task). What do you want to do?`);

  const timeoutSec = Number.isFinite(cfg.promptTimeout) && cfg.promptTimeout > 0
    ? cfg.promptTimeout : 20;

  const script =
    `display dialog ${JSON.stringify(body)} ` +
    `buttons {"Continue", "Compact", "Clear"} default button ${JSON.stringify(action === 'clear' ? 'Clear' : 'Compact')} ` +
    `with title "Claude Code — Task Change Detected" with icon note ` +
    `giving up after ${timeoutSec}`;

  try {
    const out = execFileSync('osascript', ['-e', script], {
      encoding: 'utf8',
      timeout: (timeoutSec + 5) * 1000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (/gave up:\s*true/.test(out)) return 'timeout';
    if (/button returned:\s*Clear/.test(out)) return 'clear';
    if (/button returned:\s*Compact/.test(out)) return 'compact';
    if (/button returned:\s*Continue/.test(out)) return 'continue';
    return 'unavailable';
  } catch { return 'unavailable'; }
}

// ─── Main ────────────────────────────────────────────────────────────────────

function hashPrompt(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function main() {
  const input = parseInput(readStdinSync());
  const sessionId = (input.session_id || process.env.CLAUDE_SESSION_ID || 'default')
    .replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
  const cfg = (loadSiConfig() || {}).taskChange || {};

  if (cfg.enabled === false) process.exit(0);

  const cwd = input.cwd || input.workspace?.current_dir || process.cwd();
  const prompt = input.prompt || input.user_message?.content || input.message || '';
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 20) {
    // Too short to be a task change — things like "yes", "continue", "fix this".
    process.exit(0);
  }

  const tokenBudget = readTokenBudget(sessionId);
  const minTokens = Number.isFinite(cfg.minTokens) ? cfg.minTokens : 100000;
  if (tokenBudget < minTokens) {
    intelLog('task-change', 'debug', 'below min-tokens threshold', { tokenBudget, minTokens });
    process.exit(0);
  }

  const projectDir = resolveProjectDir(cwd);
  const sessionCtx = readSessionContext(projectDir);
  const currentTask = extractCurrentTaskText(sessionCtx);
  const keyFiles = extractKeyFiles(sessionCtx);

  // If we have no baseline, we can't judge — stay silent.
  if (!currentTask && !keyFiles.length) {
    intelLog('task-change', 'debug', 'no baseline in session-context.md', {});
    process.exit(0);
  }

  const promptFiles = extractPromptFiles(prompt);
  const gitSet = gitTrackedChangeSet(cwd);

  const overlap = fileOverlap(promptFiles, keyFiles, gitSet);
  const jac = jaccard(currentTask, prompt);

  const combined = combineSignals([
    { ...overlap, weight: 2 },  // file evidence is worth more when present
    { ...jac,      weight: 1 },
  ]);

  if (combined.score === null) {
    // Signals all missing — don't prompt on no-evidence.
    process.exit(0);
  }

  const sameThresh = Number.isFinite(cfg.sameDomainScore) ? cfg.sameDomainScore : 0.5;
  const diffThresh = Number.isFinite(cfg.differentDomainScore) ? cfg.differentDomainScore : 0.2;

  if (combined.score >= sameThresh) {
    intelLog('task-change', 'debug', 'same domain — silent', {
      score: combined.score, tokenBudget, promptFiles: promptFiles.length,
    });
    process.exit(0);
  }

  const action = combined.score < diffThresh ? 'clear' : 'compact';

  // One-shot per prompt hash so retries don't re-prompt.
  const stateFile = path.join(getTempDir(), `claude-task-change-${sessionId}`);
  const promptHash = hashPrompt(prompt);
  try {
    const last = fs.readFileSync(stateFile, 'utf8').trim();
    if (last === promptHash) process.exit(0);
  } catch { /* no prior */ }
  try { writeFile(stateFile, promptHash); } catch { /* best effort */ }

  const answer = askUserTaskChange(action, combined.score, tokenBudget, cfg);
  intelLog('task-change', 'info', 'prompted', {
    action, answer, score: combined.score, tokenBudget,
    filesInPrompt: promptFiles.length, keyFiles: keyFiles.length,
  });

  if (answer === 'continue') {
    log(`[TaskChange] domain shift acknowledged — continuing (score ${combined.score.toFixed(2)}).`);
    process.exit(0);
  }

  // "compact", "clear", "timeout", "unavailable" → block with instruction.
  const slash = (answer === 'clear' || action === 'clear') ? '/clear' : '/compact';
  const approvedPrefix = (answer === 'clear' || answer === 'compact')
    ? `User approved ${slash} via prompt. `
    : '';
  const msg =
    `[TaskChange] ${approvedPrefix}New prompt appears to be a different task domain ` +
    `(same-domain score ${combined.score.toFixed(2)}, ~${fmtTokens(tokenBudget)} tokens). ` +
    `Run \`${slash}\`${slash === '/compact' ? ' (preserve current task context)' : ''} ` +
    `before continuing; this prompt was blocked so you can act first. ` +
    `Disable via /si set taskChange.enabled false.`;
  process.stderr.write(`${msg}\n`);
  process.exit(2); // block the prompt
}

try { main(); } catch (err) {
  intelLog('task-change', 'error', 'hook crashed', { err: err.message });
  process.exit(0); // never break the user's flow on a bug here
}
