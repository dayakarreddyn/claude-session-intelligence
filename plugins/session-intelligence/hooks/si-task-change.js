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
  resolveProjectDir,
  readTranscriptTokens,
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

function readSessionContext(projectDir) {
  if (!projectDir) return '';
  try {
    return fs.readFileSync(path.join(projectDir, 'session-context.md'), 'utf8');
  } catch { return ''; }
}

// Lines like "type: (bug-fix | feature | test | ...)" or
// "description: (what you're working on)" are still the template's
// placeholder text. Treat them as empty so an unfilled session-context.md
// doesn't act as a real baseline — otherwise every prompt scores 0.00
// against the template and gets blocked as "different domain".
function stripPlaceholders(text) {
  return text.replace(/^\s*[A-Za-z][A-Za-z0-9_-]*:\s*\([^)]*\)\s*$/gm, '')
             .replace(/^\s*\([^)]*\)\s*$/gm, '');
}

function extractCurrentTaskText(sessionContext) {
  const m = sessionContext.match(/##\s+Current Task\s*([\s\S]*?)(?=\n##\s|$)/);
  if (!m) return '';
  return stripPlaceholders(m[1]).trim();
}

function extractKeyFiles(sessionContext) {
  const m = sessionContext.match(/##\s+Key Files\s*([\s\S]*?)(?=\n##\s|$)/);
  if (!m) return [];
  const files = [];
  for (const line of m[1].split('\n')) {
    const t = line.trim().replace(/^[-*\s]+/, '');
    if (!t) continue;
    // Skip template placeholders like "(list the files currently in play)".
    if (/^\([^)]*\)$/.test(t)) continue;
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

/**
 * Files touched by recent commits. Grounds the "current context" in what
 * you've actually been working on, not just what session-context.md says.
 * Bounded by a time window so abandoned-months-ago files don't leak in.
 */
function gitRecentlyTouchedFiles(cwd, sinceHours = 24) {
  const opts = {
    encoding: 'utf8', timeout: 1500,
    stdio: ['ignore', 'pipe', 'ignore'],
  };
  try {
    const out = execFileSync('git', [
      '-C', cwd, 'log', `--since=${sinceHours} hours ago`,
      '--pretty=format:', '--name-only', 'HEAD',
    ], opts);
    return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
  } catch { return new Set(); }
}

/**
 * File paths mentioned in the last N transcript turns. Captures in-flight
 * conversation that hasn't yet made it into session-context.md — the main
 * gap in the prior heuristic, which went cold as soon as you stopped
 * re-quoting file names.
 */
function transcriptRecentFiles(transcriptPath, turnLimit = 20) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return new Set();
  const found = new Set();
  try {
    const stat = fs.statSync(transcriptPath);
    const SCAN_BYTES = Math.min(stat.size, 256 * 1024);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(SCAN_BYTES);
      fs.readSync(fd, buf, 0, SCAN_BYTES, stat.size - SCAN_BYTES);
      const lines = buf.toString('utf8').split('\n').filter(Boolean);
      let turns = 0;
      for (let i = lines.length - 1; i >= 0 && turns < turnLimit; i--) {
        try {
          const d = JSON.parse(lines[i]);
          const content = d && d.message && d.message.content;
          const text = typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content.map((c) => c.text || c.input?.file_path || '').join(' ')
              : '';
          if (!text) continue;
          turns++;
          for (const m of text.matchAll(/@?([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)/g)) {
            const p = m[1].replace(/[,.;:]$/, '');
            if (/[./]/.test(p)) found.add(p);
          }
        } catch { /* partial line */ }
      }
    } finally { fs.closeSync(fd); }
  } catch { /* silent */ }
  return found;
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

function resolveTokenBudget(input, sessionId) {
  const fromTranscript = readTranscriptTokens(input && input.transcript_path);
  if (fromTranscript > 0) return fromTranscript;
  return readTokenBudget(sessionId);
}

function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ─── Semantic tie-breaker (Claude Haiku) ─────────────────────────────────────
//
// Heuristics can't tell "refactor the compact hook" from "rewrite the auth
// layer" when both prompts share almost no vocabulary with session-context
// but reference the same files. When the layer-1 score lands in the
// ambiguous band [differentDomainScore, sameDomainScore], we ask Haiku for
// a boolean verdict. Gated by taskChange.semanticFallback=true so no one
// pays for it unless they opt in.
//
// We shell out to the `claude` CLI rather than hitting api.anthropic.com
// directly: (1) uses whatever auth the user already has — OAuth subscription
// or ANTHROPIC_API_KEY — no env-forwarding of the API key to a child argv;
// (2) no inline HTTPS / JSON wire code to maintain; (3) `--setting-sources ''`
// prevents the subprocess from loading user settings.json, which means none
// of the parent session's hooks (including THIS hook) fire in the child —
// no recursion risk. `--tools ''` and `--no-session-persistence` keep the
// call small and stateless.
function callClassifier(currentContext, newPrompt, cfg) {
  const model = cfg.haikuModel || 'claude-haiku-4-5';
  const timeoutMs = Number.isFinite(cfg.semanticTimeoutMs) ? cfg.semanticTimeoutMs : 3000;

  const prompt =
    'Classify whether two messages describe the SAME task domain in an ongoing coding session.\n' +
    'Reply with EXACTLY one word — SAME or DIFFERENT — no explanation.\n' +
    'SAME = continuation/refinement of the current task.\n' +
    'DIFFERENT = unrelated feature, file, or subsystem.\n\n' +
    `CURRENT CONTEXT:\n${currentContext}\n\n` +
    `NEW PROMPT:\n${newPrompt}\n\n` +
    'Reply SAME or DIFFERENT.';

  try {
    const out = execFileSync('claude', [
      '--print',
      '--model', model,
      '--tools', '',
      '--no-session-persistence',
      '--setting-sources', '',
    ], {
      input: prompt,
      encoding: 'utf8',
      timeout: timeoutMs + 500,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const text = (out || '').trim().toUpperCase();
    if (text.startsWith('SAME'))      return { verdict: 'same',      reason: text.slice(0, 80) };
    if (text.startsWith('DIFFERENT')) return { verdict: 'different', reason: text.slice(0, 80) };
    return { verdict: 'unavailable', reason: `unparsed: ${text.slice(0, 40)}` };
  } catch (err) {
    // ENOENT → claude CLI not on PATH; ETIMEDOUT → classifier too slow; auth
    // failure → non-zero exit. All collapse to "unavailable" so the caller
    // falls back to the heuristic verdict without blocking the prompt.
    return { verdict: 'unavailable', reason: err.code || (err.message || '').slice(0, 80) };
  }
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

  const tokenBudget = resolveTokenBudget(input, sessionId);
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

  // Layer 1: expanded baseline. session-context is what the user wrote down,
  // but actual current work lives in (a) recently committed files and
  // (b) files mentioned in the last N transcript turns. Pool all three so
  // a prompt about today's work scores as "same domain" even when the user
  // hasn't updated session-context in hours.
  const recentGit = gitRecentlyTouchedFiles(cwd,
    Number.isFinite(cfg.recentHours) ? cfg.recentHours : 24);
  const recentFromTranscript = transcriptRecentFiles(
    input.transcript_path,
    Number.isFinite(cfg.transcriptTurns) ? cfg.transcriptTurns : 20
  );
  const pooledFiles = new Set([...gitSet, ...recentGit, ...recentFromTranscript]);

  // Conversational guard: a short prompt with no file references, no
  // backtick-quoted tokens, and no path-like mentions is follow-up talk
  // ("draft and go on parallel", "yes do that too") — not task drift.
  // Jaccard against a populated session-context will always read as 0.00
  // for these, so the hook would block every casual reply. Require either
  // file evidence or a meaningful prompt length (>=120 chars) before we
  // bother scoring.
  const convoMaxLen = Number.isFinite(cfg.conversationalMaxLen)
    ? cfg.conversationalMaxLen : 120;
  if (!promptFiles.length && prompt.trim().length < convoMaxLen) {
    intelLog('task-change', 'debug', 'conversational prompt — silent', {
      length: prompt.trim().length, convoMaxLen,
    });
    process.exit(0);
  }

  const overlap = fileOverlap(promptFiles, keyFiles, pooledFiles);
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
      recentGit: recentGit.size, transcriptFiles: recentFromTranscript.size,
    });
    process.exit(0);
  }

  // Layer 2: Haiku tie-breaker via the `claude` CLI. Only fires in the
  // ambiguous band and only when the user has opted in. Auth is whatever the
  // user's `claude` CLI already has (OAuth or ANTHROPIC_API_KEY); on any
  // failure the verdict is "unavailable" and we fall back to the heuristic.
  let haikuVerdict = null;
  const inAmbiguousBand = combined.score > diffThresh && combined.score < sameThresh;
  if (cfg.semanticFallback === true && inAmbiguousBand) {
    const recentFilesList = [...pooledFiles].slice(0, 15).join('\n');
    const contextBlob = [
      currentTask && `Current task: ${currentTask}`,
      keyFiles.length && `Key files:\n${keyFiles.slice(0, 10).join('\n')}`,
      recentFilesList && `Recently touched:\n${recentFilesList}`,
    ].filter(Boolean).join('\n\n');

    const result = callClassifier(contextBlob, prompt, cfg);
    haikuVerdict = result.verdict;
    intelLog('task-change', 'info', 'semantic tie-breaker', {
      verdict: haikuVerdict, reason: result.reason, score: combined.score,
    });
    if (haikuVerdict === 'same') {
      intelLog('task-change', 'debug', 'semantic override — allowed', {
        score: combined.score, verdict: haikuVerdict,
      });
      process.exit(0);
    }
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
