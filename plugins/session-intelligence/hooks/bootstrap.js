#!/usr/bin/env node
/**
 * Session Intelligence — SessionStart bootstrap.
 *
 * Runs once per session. Idempotent. Does four things:
 *
 *   1. Seeds ~/.claude/session-intelligence.json from the shipped template
 *      (only if the file is missing — never overwrites user edits).
 *
 *   2. Wires the status-line chain wrapper into ~/.claude/settings.json so
 *      the intel line shows up below whatever the user already had. If the
 *      user has a different statusLine, the chain preserves it via the
 *      PREV_STATUSLINE placeholder inside statusline-chain.sh. If our chain
 *      is already wired, this step is a no-op.
 *
 *   3. Seeds templates/session-context.md into the active project's
 *      ~/.claude/projects/<encoded>/session-context.md if that project has
 *      no session-context.md yet. Claude updates it as real work happens.
 *
 *   4. Auto-populates Current Task + Key Files in that session-context.md
 *      from the last commit (subject, branch, touched files) when the
 *      sections are still placeholder-only. Tracks the HEAD SHA in state
 *      so we don't rewrite the same content every session. Hands-off the
 *      moment a human writes real content — we never touch real data.
 *
 *   5. Injects a managed "session discipline" block into the project's
 *      CLAUDE.md between BEGIN/END markers so Claude in that repo knows
 *      to read/update session-context.md at task boundaries. Content
 *      between the markers is fully managed by this hook (safe to refresh
 *      on upgrades); anything outside the markers is left untouched.
 *
 * Silent on success. Only logs on first-install or on error.
 *
 * Plugin convention: __dirname points to .../plugins/session-intelligence/hooks,
 * so the plugin root is __dirname/.. — ${CLAUDE_PLUGIN_ROOT} at runtime also
 * resolves there but env vars aren't guaranteed inside child processes.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const CLAUDE_DIR = path.join(homeDir(), '.claude');
const STATE_FILE = path.join(CLAUDE_DIR, '.si-bootstrap-state');
const UNIFIED_CONFIG = path.join(CLAUDE_DIR, 'session-intelligence.json');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const CHAIN_SH = path.join(PLUGIN_ROOT, 'statusline', 'statusline-chain.sh');
const CONFIG_TEMPLATE = path.join(PLUGIN_ROOT, 'templates', 'session-intelligence.json');
const SESSION_CTX_TEMPLATE = path.join(PLUGIN_ROOT, 'templates', 'session-context.md');
const CLAUDE_MD_RULES_TEMPLATE = path.join(PLUGIN_ROOT, 'templates', 'claude-md-rules.md');
const CLAUDE_MD_MARKER_START = '<!-- BEGIN session-intelligence:rules -->';
const CLAUDE_MD_MARKER_END = '<!-- END session-intelligence:rules -->';

// ─── State helpers ───────────────────────────────────────────────────────────

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8'); }
  catch { /* best effort */ }
}

function notify(msg) {
  // SessionStart hook stdout is surfaced to the user exactly once per install.
  process.stdout.write(`[session-intelligence] ${msg}\n`);
}

// ─── Step 1: seed unified config ─────────────────────────────────────────────

function seedConfig(state) {
  if (fs.existsSync(UNIFIED_CONFIG)) return false;
  if (!fs.existsSync(CONFIG_TEMPLATE)) return false;
  try {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    fs.copyFileSync(CONFIG_TEMPLATE, UNIFIED_CONFIG);
    state.seededConfigAt = new Date().toISOString();
    notify(`seeded default config → ${UNIFIED_CONFIG}`);
    return true;
  } catch (err) {
    notify(`config seed failed: ${err.message}`);
    return false;
  }
}

// ─── Step 2: wire statusline chain ───────────────────────────────────────────

function prepareChainScript(state) {
  // The shipped chain script has __PREV_STATUSLINE__ placeholder. Substitute
  // whatever the user currently has in settings.json → statusLine.command so
  // their existing line is preserved on the first line.
  if (!fs.existsSync(CHAIN_SH)) return null;

  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); }
  catch { /* will be created below */ }

  const currentCmd = typeof settings.statusLine === 'string'
    ? settings.statusLine
    : (settings.statusLine && settings.statusLine.command) || '';

  // Don't chain our own wrapper back into itself.
  const isAlreadyOurs = currentCmd && currentCmd.includes('statusline-chain.sh');

  const instanceChain = path.join(CLAUDE_DIR, 'scripts', 'si-statusline-chain.sh');

  // If our instance exists and matches, skip re-write.
  const prev = state.wiredStatuslinePrev || '';
  if (isAlreadyOurs && fs.existsSync(instanceChain) && prev === currentCmd) {
    return instanceChain;
  }

  let tmpl;
  try { tmpl = fs.readFileSync(CHAIN_SH, 'utf8'); }
  catch { return null; }

  const resolvedPrev = isAlreadyOurs ? prev : currentCmd;
  const rendered = tmpl.replace(/__PREV_STATUSLINE__/g,
    resolvedPrev.replace(/\\/g, '\\\\').replace(/'/g, "'\\''"));
  const intelScript = path.join(PLUGIN_ROOT, 'statusline', 'statusline-intel.js');
  const withIntelPath = rendered.replace(
    /INTEL_SCRIPT=.*$/m,
    `INTEL_SCRIPT="${intelScript}"`,
  );

  try {
    fs.mkdirSync(path.dirname(instanceChain), { recursive: true });
    fs.writeFileSync(instanceChain, withIntelPath, { mode: 0o755 });
    state.wiredStatuslinePrev = resolvedPrev;
    return instanceChain;
  } catch (err) {
    notify(`statusline chain write failed: ${err.message}`);
    return null;
  }
}

function wireStatusline(state) {
  const chain = prepareChainScript(state);
  if (!chain) return false;

  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); }
  catch { /* create */ }

  const current = settings.statusLine && settings.statusLine.command;
  if (current === chain) return false; // already wired

  settings.statusLine = { type: 'command', command: chain, padding: 0 };
  try {
    fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    state.wiredStatuslineAt = new Date().toISOString();
    notify(`wired intel status line (chain preserves existing)`);
    return true;
  } catch (err) {
    notify(`settings.json write failed: ${err.message}`);
    return false;
  }
}

// ─── Step 3: seed session-context.md for the active project ──────────────────

function seedSessionContext(cwd, state) {
  if (!cwd || !fs.existsSync(SESSION_CTX_TEMPLATE)) return false;

  const encoded = cwd.replace(/\//g, '-');
  const projectDir = path.join(CLAUDE_DIR, 'projects', encoded);
  if (!fs.existsSync(projectDir)) return false; // Claude hasn't created it yet

  const target = path.join(projectDir, 'session-context.md');
  if (fs.existsSync(target)) return false;

  try {
    fs.copyFileSync(SESSION_CTX_TEMPLATE, target);
    state.seededContexts = state.seededContexts || {};
    state.seededContexts[encoded] = new Date().toISOString();
    notify(`seeded session-context.md → ${target}`);
    return true;
  } catch { return false; }
}

// ─── Step 4: auto-populate Current Task + Key Files from git activity ────────
//
// If the Current Task block is still placeholder-only, fill it from the last
// commit and the files it touched. This runs every SessionStart but is a
// no-op as soon as the user (or Claude) writes real content — we only
// overwrite placeholder text, never user data.

function isPlaceholderSection(body) {
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return true;
  return lines.every((l) =>
    /^[A-Za-z][A-Za-z0-9_-]*:\s*\([^)]*\)\s*$/.test(l) ||
    /^[-*]\s*\([^)]*\)\s*$/.test(l) ||
    /^[A-Z]+:\s*\([^)]*\)\s*$/.test(l)
  );
}

function runGit(cwd, args) {
  try {
    const { execFileSync } = require('child_process');
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8', timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return ''; }
}

function guessTaskType(subject) {
  const m = subject.match(/^(feat|feature|fix|bugfix|refactor|docs?|test|chore|perf|ci|deploy|release|ship)\b/i);
  if (!m) return 'feature';
  const k = m[1].toLowerCase();
  if (k === 'bugfix') return 'bug-fix';
  if (k === 'fix') return 'bug-fix';
  if (k === 'feature') return 'feature';
  if (k === 'docs' || k === 'doc') return 'docs';
  if (k === 'release' || k === 'ship') return 'deploy';
  return k;
}

function parseIssueFromBranch(branch) {
  if (!branch) return 'none';
  const m = branch.match(/#?(\d{2,6})\b/);
  return m ? `#${m[1]}` : 'none';
}

function buildAutoFilledTask(cwd) {
  const subject = runGit(cwd, ['log', '-1', '--pretty=%s']);
  if (!subject) return null;
  const branch = runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const files = runGit(cwd, ['log', '-1', '--pretty=format:', '--name-only'])
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const type = guessTaskType(subject);
  const issue = parseIssueFromBranch(branch);
  return { subject, type, issue, files, branch };
}

function replaceSection(content, heading, newBody) {
  const re = new RegExp(`(##\\s+${heading}\\s*\\n)([\\s\\S]*?)(?=\\n##\\s|$)`);
  const m = content.match(re);
  if (!m) return content; // heading missing, leave alone
  return content.replace(re, `$1${newBody.trimEnd()}\n`);
}

// ─── Step 5: inject managed block into project CLAUDE.md ─────────────────────
//
// Tells Claude in each repo that a session-context.md exists, to consult it at
// task boundaries, and to update it as work evolves. Content inside the markers
// is overwritten on every upgrade; anything outside is user-owned and never
// touched. If CLAUDE.md doesn't exist, we create it and drop the block at the
// top. If it exists and already has our markers, we refresh between them.

function injectClaudeMdRules(cwd, state) {
  if (!cwd || !fs.existsSync(CLAUDE_MD_RULES_TEMPLATE)) return false;

  let rules;
  try { rules = fs.readFileSync(CLAUDE_MD_RULES_TEMPLATE, 'utf8').trim(); }
  catch { return false; }

  const target = path.join(cwd, 'CLAUDE.md');
  const managed = `${CLAUDE_MD_MARKER_START}\n${rules}\n${CLAUDE_MD_MARKER_END}`;

  let existing = '';
  try { existing = fs.readFileSync(target, 'utf8'); } catch { /* missing */ }

  let next;
  if (!existing) {
    next = managed + '\n';
  } else if (existing.includes(CLAUDE_MD_MARKER_START) && existing.includes(CLAUDE_MD_MARKER_END)) {
    const re = new RegExp(
      `${CLAUDE_MD_MARKER_START.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}[\\s\\S]*?${CLAUDE_MD_MARKER_END.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}`
    );
    next = existing.replace(re, managed);
  } else {
    // First-time injection — prepend so it's visible, keep a blank line gap.
    next = managed + '\n\n' + existing;
  }

  if (next === existing) return false;

  try {
    fs.writeFileSync(target, next, 'utf8');
    const encoded = cwd.replace(/\//g, '-');
    state.injectedClaudeMd = state.injectedClaudeMd || {};
    state.injectedClaudeMd[encoded] = new Date().toISOString();
    notify(`injected session-intelligence rules → ${target}`);
    return true;
  } catch { return false; }
}

function autoFillSessionContext(cwd, state) {
  if (!cwd) return false;
  const encoded = cwd.replace(/\//g, '-');
  const projectDir = path.join(CLAUDE_DIR, 'projects', encoded);
  const target = path.join(projectDir, 'session-context.md');
  if (!fs.existsSync(target)) return false;

  let content;
  try { content = fs.readFileSync(target, 'utf8'); } catch { return false; }

  const taskMatch = content.match(/##\s+Current Task\s*\n([\s\S]*?)(?=\n##\s|$)/);
  if (!taskMatch) return false;
  if (!isPlaceholderSection(taskMatch[1])) return false; // user content — leave it

  const data = buildAutoFilledTask(cwd);
  if (!data) return false; // no commits yet — leave placeholders

  // Skip if we already auto-filled for this exact commit (avoids rewriting the
  // same content every session start).
  const headSha = runGit(cwd, ['rev-parse', 'HEAD']);
  const lastAutoFill = state.autoFilled && state.autoFilled[encoded];
  if (lastAutoFill && lastAutoFill.sha === headSha) return false;

  const taskBody =
    `type: ${data.type} \u2014 ${data.subject}\n` +
    `description: derived from last commit on \`${data.branch || 'HEAD'}\`\n` +
    `issue: ${data.issue}\n`;
  let next = replaceSection(content, 'Current Task', taskBody);

  // Also seed Key Files if still placeholder-only.
  const keyMatch = next.match(/##\s+Key Files\s*\n([\s\S]*?)(?=\n##\s|$)/);
  if (keyMatch && isPlaceholderSection(keyMatch[1]) && data.files.length) {
    const keyBody = data.files.slice(0, 10).map((f) => `- ${f}`).join('\n') + '\n';
    next = replaceSection(next, 'Key Files', keyBody);
  }

  if (next === content) return false;
  try {
    fs.writeFileSync(target, next, 'utf8');
    state.autoFilled = state.autoFilled || {};
    state.autoFilled[encoded] = { sha: headSha, at: new Date().toISOString() };
    notify(`auto-filled session-context.md from HEAD (${headSha.slice(0, 7)} — ${data.type})`);
    return true;
  } catch { return false; }
}

// ─── Main ────────────────────────────────────────────────────────────────────

function readStdinJsonOrEmpty() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function main() {
  const input = readStdinJsonOrEmpty();
  const cwd = input.cwd || input.workspace?.current_dir || process.cwd();

  const state = loadState();
  const didSeedConfig = seedConfig(state);
  const didWire = wireStatusline(state);
  const didSeedCtx = seedSessionContext(cwd, state);
  const didAutoFill = autoFillSessionContext(cwd, state);
  const didInject = injectClaudeMdRules(cwd, state);

  if (didSeedConfig || didWire || didSeedCtx || didAutoFill || didInject) {
    saveState(state);
  }

  process.exit(0);
}

try { main(); } catch (err) {
  // Never block the session on a bootstrap failure.
  process.stderr.write(`[session-intelligence] bootstrap error: ${err.message}\n`);
  process.exit(0);
}
