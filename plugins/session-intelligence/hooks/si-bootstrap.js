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

// Debug log surface so silent step failures leave a trail in
// ~/.claude/logs/session-intel-YYYY-MM-DD.log. Bootstrap never writes to
// stderr/stdout for failures (would clutter the user's SessionStart output);
// intelLog is the pressure-valve.
let intelLog = () => {};
try { ({ intelLog } = require('../lib/intel-debug')); } catch { /* optional */ }

// Walks up from cwd until it finds an existing ~/.claude/projects/<encoded>/
// directory. Must match the resolution used by writeHandoff in si-pre-compact
// — otherwise read and write diverge when cwd is a subpath of the repo
// (e.g. plugin dogfooding from a nested dir).
let resolveProjectDir = () => null;
try { ({ resolveProjectDir } = require('../lib/utils')); } catch { /* optional */ }

// Classify an Error as a filesystem-missing/permission case (log at debug)
// vs. a programming error like ReferenceError/TypeError/SyntaxError (log at
// warn — those are real bugs that shouldn't hide below the default log
// threshold). The `err.code` field is populated by fs/subprocess errors
// but absent on V8-thrown programming errors, which gives us a clean
// binary classifier without wiring in an explicit error taxonomy.
function errLogLevel(err) {
  if (!err) return 'debug';
  if (typeof err.code === 'string' && err.code.length > 0) return 'debug';
  return 'warn';
}

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
const AUTOFILL_SENTINEL_RE = /<!--\s*si:autofill\s+sha=([0-9a-f]{4,40})\s*-->/;
// Legacy shape written by bootstrap before the sentinel existed. Matching the
// description line lets us detect a pre-sentinel auto-fill and refresh it once
// instead of treating it as hand-written user content forever.
const LEGACY_AUTOFILL_RE = /^description:\s*derived from last commit on\s+`[^`]+`\s*$/m;

// ─── State helpers ───────────────────────────────────────────────────────────

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}

// Write state via tempfile + atomic rename so a crashed bootstrap never leaves
// a half-written `.si-bootstrap-state` that the next load would silently
// reset to `{}` (wiping every project's autoFill / seededContexts / injected
// record). Paired with acquireStateLock in main() — rename is atomic against
// concurrent readers, the lock is what serialises concurrent mutators.
function saveState(state) {
  const tmp = STATE_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    intelLog('bootstrap', 'warn', 'state save failed', { file: STATE_FILE, err: err.message });
    try { fs.unlinkSync(tmp); } catch { /* tmp may not exist */ }
  }
}

// Advisory cross-process lock on `.si-bootstrap-state`. Without it, two Claude
// Code windows opening in different projects at the same time both loadState,
// both mutate, and the last saveState clobbers the other's per-project
// entries — we'd silently lose autoFill tracking or wiredStatuslinePrev.
//
// Design:
//   * `fs.openSync(lock, 'wx')` is atomic-create — portable without flock(2).
//   * On EEXIST, sleep briefly via Atomics.wait (real sleep, not busy-loop)
//     and retry.
//   * Stale locks (owner crashed before release) are broken after
//     LOCK_STALE_MS so a dead process can't deadlock future sessions.
//   * Absolute timeout LOCK_TOTAL_MS — if we can't acquire in 1s, run
//     without the lock and log a warn. Falling back to the old race is
//     better than hanging a SessionStart.
const LOCK_FILE = STATE_FILE + '.lock';
const LOCK_INTERVAL_MS = 20;
const LOCK_TOTAL_MS = 1000;
const LOCK_STALE_MS = 10_000;

function sleepSync(ms) {
  // Real sleep via shared-buffer wait; doesn't burn CPU like a Date.now() spin.
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { /* SharedArrayBuffer unavailable — fall through, small busy-wait */
    const end = Date.now() + ms;
    while (Date.now() < end) { /* no-op */ }
  }
}

function acquireStateLock() {
  const start = Date.now();
  while (Date.now() - start < LOCK_TOTAL_MS) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      try { fs.writeSync(fd, `${process.pid}\n`); } catch { /* fine */ }
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') {
        intelLog('bootstrap', 'warn', 'lock open failed', { err: err.message });
        return false;
      }
      // Break a stale lock whose owner crashed without cleanup.
      try {
        const stat = fs.statSync(LOCK_FILE);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(LOCK_FILE);
          continue;
        }
      } catch { /* lock vanished between stat and unlink — retry */ }
      sleepSync(LOCK_INTERVAL_MS);
    }
  }
  intelLog('bootstrap', 'warn', 'lock acquire timeout — running unguarded');
  return false;
}

function releaseStateLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch { /* already released or never held */ }
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

// Read the current PREV_STATUSLINE= value from an existing chain script so
// we can preserve whatever the user (or a prior install) set. Parses a line
// of the form `PREV_STATUSLINE='...'` allowing internal escaped quotes.
function readExistingPrevFromChain(chainPath) {
  try {
    const raw = fs.readFileSync(chainPath, 'utf8');
    const m = raw.match(/^\s*PREV_STATUSLINE='((?:[^'\\]|\\.|'\\'')*)'\s*$/m);
    if (!m) return '';
    return m[1].replace(/'\\''/g, "'").replace(/\\(.)/g, '$1');
  } catch { return ''; }
}

// The baked PREV_STATUSLINE gets executed via `bash -c` on every statusline
// redraw. The user's own `statusLine.command` is the intended input, but a
// corrupted or mistakenly-written value (NUL bytes, embedded newlines, runaway
// length) would silently become shell code. Validate before baking.
const MAX_PREV_LEN = 4096;
function sanitizePrevStatusline(cmd) {
  if (typeof cmd !== 'string') return { ok: false, reason: 'not a string' };
  if (cmd.length === 0) return { ok: true, safe: '' };
  if (cmd.length > MAX_PREV_LEN) return { ok: false, reason: `longer than ${MAX_PREV_LEN} chars` };
  if (/[\x00\r\n]/.test(cmd)) return { ok: false, reason: 'contains NUL or newline' };
  return { ok: true, safe: cmd };
}

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

  // Source-of-truth for the "previous" command when we're already wired:
  // (1) whatever the live chain script already has baked in (user may have
  //     edited it by hand), (2) what we recorded last time we wired,
  //     (3) empty. This is the critical fix for "I set PREV_STATUSLINE to
  //     ccstatusline and bootstrap wiped it on the next session".
  const existingBaked = isAlreadyOurs ? readExistingPrevFromChain(instanceChain) : '';
  const recordedPrev = state.wiredStatuslinePrev || '';
  const prev = existingBaked || recordedPrev;

  // If our instance exists, baked-in PREV matches memory, and settings.json
  // already points at us, nothing to do — beyond ensuring the script is 0700.
  // (Older installs rendered 0755; tighten in-place without re-writing the body.)
  if (isAlreadyOurs && fs.existsSync(instanceChain) && prev === recordedPrev) {
    try {
      const { mode } = fs.statSync(instanceChain);
      if ((mode & 0o777) !== 0o700) fs.chmodSync(instanceChain, 0o700);
    } catch { /* not fatal — chain still runs at its current mode */ }
    return instanceChain;
  }

  let tmpl;
  try { tmpl = fs.readFileSync(CHAIN_SH, 'utf8'); }
  catch { return null; }

  const candidatePrev = isAlreadyOurs ? prev : currentCmd;
  const sanitized = sanitizePrevStatusline(candidatePrev);
  if (!sanitized.ok) {
    // A malformed statusLine.command would become shell code via `bash -c`.
    // Refuse to bake it; fall back to an empty prev so the intel line still
    // renders cleanly. Surface in the debug log so the user can investigate.
    notify(`statusline prev rejected (${sanitized.reason}) — preserving empty`);
    intelLog('bootstrap', 'warn', 'prev statusline rejected', {
      reason: sanitized.reason, length: candidatePrev.length,
    });
  }
  const resolvedPrev = sanitized.ok ? sanitized.safe : '';

  // Only substitute the assignment line. The template also uses
  // __PREV_STATUSLINE__ in the safety guard as a "still-unrendered" sentinel;
  // replacing it globally would invert that check and break the chain.
  const escapedPrev = resolvedPrev.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
  const rendered = tmpl.replace(
    /^(\s*PREV_STATUSLINE=)'__PREV_STATUSLINE__'/m,
    `$1'${escapedPrev}'`,
  );
  const intelScript = path.join(PLUGIN_ROOT, 'statusline', 'statusline-intel.js');
  const withIntelPath = rendered.replace(
    /INTEL_SCRIPT=.*$/m,
    `INTEL_SCRIPT="${intelScript}"`,
  );

  try {
    fs.mkdirSync(path.dirname(instanceChain), { recursive: true });
    // Owner-only (0700): the baked PREV_STATUSLINE is the user's own shell
    // command; no other local user should be able to read or re-execute it.
    fs.writeFileSync(instanceChain, withIntelPath, { mode: 0o700 });
    state.wiredStatuslinePrev = resolvedPrev;
    return instanceChain;
  } catch (err) {
    notify(`statusline chain write failed: ${err.message}`);
    intelLog('bootstrap', 'warn', 'chain write failed', { path: instanceChain, err: err.message });
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
  } catch (err) {
    intelLog('bootstrap', 'warn', 'seed session-context failed', { target, err: err.message });
    return false;
  }
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

// Classify a section body so we know whether bootstrap may overwrite it:
//   placeholder   — template-shipped `(hint)` lines, always safe to fill
//   autofilled    — already managed by us; refresh when HEAD SHA differs
//   legacy        — pre-sentinel auto-fill shape; refresh once to adopt sentinel
//   user          — hand-written content, never touch
function classifySection(body, { legacyRefresh = false } = {}) {
  if (isPlaceholderSection(body)) return { mode: 'placeholder' };
  const m = body.match(AUTOFILL_SENTINEL_RE);
  if (m) return { mode: 'autofilled', sha: m[1] };
  if (legacyRefresh && LEGACY_AUTOFILL_RE.test(body)) return { mode: 'legacy' };
  return { mode: 'user' };
}

function runGit(cwd, args) {
  try {
    const { execFileSync } = require('child_process');
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8', timeout: 1500,
      // Capture stderr instead of dropping it. Without this, "git not on
      // PATH" (ENOENT) and "fatal: not a git repository" both look like
      // "git returned empty" — autoFillSessionContext then produces a
      // confusingly empty task with no log trail. Errors go to intelLog
      // at debug since non-git directories are a legitimate use case.
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    intelLog('bootstrap', 'debug', 'runGit failed', {
      cwd, args,
      code: err && err.code,
      status: err && err.status,
      stderr: err && err.stderr && err.stderr.toString().trim().slice(0, 200),
    });
    return '';
  }
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

function parseIssueFromRef(ref) {
  if (!ref) return 'none';
  const m = ref.match(/#?(\d{2,6})\b/);
  return m ? `#${m[1]}` : 'none';
}

// Resolve a human-readable label for HEAD. Plain `--abbrev-ref HEAD` returns
// the literal string "HEAD" when detached, which is both ugly in
// session-context.md ("derived from last commit on `HEAD`") and hides any
// issue number that might live in a tag name. Priority:
//   1. branch name (normal case)
//   2. exact-match tag   → "tag v1.2.3"
//   3. any describe       → "detached @ v1.2.3-5-g0abc123"
//   4. short SHA          → "detached @ 0abc123"
function resolveRef(cwd) {
  const branch = runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch && branch !== 'HEAD') return branch;

  const exactTag = runGit(cwd, ['describe', '--tags', '--exact-match', 'HEAD']);
  if (exactTag) return `tag ${exactTag}`;

  const descr = runGit(cwd, ['describe', '--tags', '--always']);
  if (descr) return `detached @ ${descr}`;

  const shortSha = runGit(cwd, ['rev-parse', '--short=7', 'HEAD']);
  return shortSha ? `detached @ ${shortSha}` : '';
}

function buildAutoFilledTask(cwd) {
  const subject = runGit(cwd, ['log', '-1', '--pretty=%s']);
  if (!subject) return null;
  const ref = resolveRef(cwd);
  const files = runGit(cwd, ['log', '-1', '--pretty=format:', '--name-only'])
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const type = guessTaskType(subject);
  const issue = parseIssueFromRef(ref);
  return { subject, type, issue, files, branch: ref };
}

function replaceSection(content, heading, newBody) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(##\\s+${escaped}\\s*\\n)([\\s\\S]*?)(?=\\n##\\s|$)`);
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
  } catch (err) {
    intelLog('bootstrap', 'warn', 'CLAUDE.md inject failed', { target, err: err.message });
    return false;
  }
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
  const taskClass = classifySection(taskMatch[1], { legacyRefresh: true });
  if (taskClass.mode === 'user') return false; // hand-written — never overwrite

  const headSha = runGit(cwd, ['rev-parse', 'HEAD']);
  if (!headSha) return false;
  const shortSha = headSha.slice(0, 7);

  // Already up-to-date for this commit — no-op (also keeps SessionStart quiet).
  if (taskClass.mode === 'autofilled' && taskClass.sha === shortSha) return false;

  const data = buildAutoFilledTask(cwd);
  if (!data) return false; // no commits yet — leave placeholders

  const taskBody =
    `<!-- si:autofill sha=${shortSha} -->\n` +
    `type: ${data.type} \u2014 ${data.subject}\n` +
    `description: derived from last commit on \`${data.branch || 'HEAD'}\`\n` +
    `issue: ${data.issue}\n`;
  let next = replaceSection(content, 'Current Task', taskBody);

  // Refresh Key Files in lockstep if it's still placeholder, already carries
  // our sentinel, or we're upgrading a legacy pre-sentinel auto-fill. Leave
  // genuine user-curated lists alone.
  const keyMatch = next.match(/##\s+Key Files\s*\n([\s\S]*?)(?=\n##\s|$)/);
  if (keyMatch && data.files.length) {
    const keyBody = keyMatch[1];
    const keyClass = classifySection(keyBody);
    const shouldRefresh =
      keyClass.mode === 'placeholder' ||
      keyClass.mode === 'autofilled' ||
      taskClass.mode === 'legacy';
    if (shouldRefresh) {
      const body =
        `<!-- si:autofill sha=${shortSha} -->\n` +
        data.files.slice(0, 10).map((f) => `- ${f}`).join('\n') + '\n';
      next = replaceSection(next, 'Key Files', body);
    }
  }

  if (next === content) return false;
  try {
    fs.writeFileSync(target, next, 'utf8');
    state.autoFilled = state.autoFilled || {};
    state.autoFilled[encoded] = { sha: headSha, at: new Date().toISOString() };
    notify(`auto-filled session-context.md from HEAD (${shortSha} — ${data.type})`);
    return true;
  } catch (err) {
    intelLog('bootstrap', 'warn', 'auto-fill write failed', { target, err: err.message });
    return false;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

function readStdinJsonOrEmpty() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch { return {}; }
}

// ── Git Nexus injection (opt-in) ──────────────────────────────────────────
// When shape.gitNexus.injectAtStart is true, compute the top-N most-touched
// files and emit them as SessionStart additionalContext so Claude starts
// the session knowing "these are your anchors." Cached 24h in /tmp via
// lib/git-nexus.js, so repeated session opens in the same repo don't burn
// git-log over and over. Silent when disabled, non-git, or empty result.
function buildNexusAdditionalContext(cwd) {
  let siCfg = {};
  try { siCfg = require('../lib/config').loadConfig() || {}; }
  catch { return ''; }
  const gitNexusCfg = (siCfg.shape && siCfg.shape.gitNexus) || {};
  if (gitNexusCfg.injectAtStart !== true) return '';

  try {
    const { topTouchedFiles, renderNexusBlock } = require('../lib/git-nexus');
    const anchors = topTouchedFiles(cwd, {
      sinceDays: Number.isFinite(gitNexusCfg.sinceDays) ? gitNexusCfg.sinceDays : 90,
      limit: Number.isFinite(gitNexusCfg.limit) ? gitNexusCfg.limit : 20,
    });
    if (!anchors.length) return '';
    return renderNexusBlock(anchors, {
      limit: Number.isFinite(gitNexusCfg.injectLimit) ? gitNexusCfg.injectLimit : 10,
      sinceDays: Number.isFinite(gitNexusCfg.sinceDays) ? gitNexusCfg.sinceDays : 90,
    });
  } catch (err) {
    intelLog('bootstrap', errLogLevel(err), 'nexus injection failed', {
      err: err && err.message,
      code: err && err.code,
      name: err && err.name,
    });
    return '';
  }
}

// Emit additionalContext via Claude Code's SessionStart hook protocol:
//   { "hookSpecificOutput": { "hookEventName": "SessionStart",
//                             "additionalContext": "..." } }
// Called at the VERY end of main() so bootstrap's stdout side-effects
// (the `[session-intelligence] wired...` line) still reach the user.
// Emitting a single JSON blob after those lines — Claude Code parses the
// LAST JSON object on stdout for hook output, so combine multiple context
// sources (nexus anchors + post-compact handoff) into one payload.
//
// `systemMessage` is the user-visible surface. Unlike PreCompact, Claude
// Code suppresses SessionStart hook stderr when source=compact, so the
// resume banner only lands via systemMessage. additionalContext still
// carries the model-facing copy.
function emitAdditionalContext(textParts, systemMessage) {
  const combined = (Array.isArray(textParts) ? textParts : [textParts])
    .filter((s) => typeof s === 'string' && s.length > 0)
    .join('\n\n');
  if (!combined && !systemMessage) return;
  const out = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: combined,
    },
  };
  if (systemMessage) out.systemMessage = systemMessage;
  process.stdout.write(JSON.stringify(out) + '\n');
}

// Post-compact continuation handoff. One-shot: pre-compact wrote the
// file, we render + delete it here. Opt-out via continue.afterCompact=
// false in config.
function buildContinuationAdditionalContext(cwd) {
  let siCfg = {};
  try { siCfg = require('../lib/config').loadConfig() || {}; }
  catch { /* optional */ }
  if (siCfg.continue && siCfg.continue.afterCompact === false) return '';
  try {
    if (!cwd) return '';
    // Walk up (matches writeHandoff's resolver). Bare encode of cwd fails
    // when Claude is opened inside a subpath of the repo — the project
    // dir only exists for the canonical root.
    const projectDir = resolveProjectDir(cwd);
    if (!projectDir) return '';
    const handoff = require('../lib/handoff');
    return handoff.readAndRenderHandoff(projectDir);
  } catch (err) {
    intelLog('bootstrap', errLogLevel(err), 'handoff read failed', {
      err: err && err.message,
      code: err && err.code,
      name: err && err.name,
    });
    return '';
  }
}

function main() {
  const input = readStdinJsonOrEmpty();
  const cwd = input.cwd || input.workspace?.current_dir || process.cwd();

  // Ensure ~/.claude/ exists before we try to drop a lock file into it.
  try { fs.mkdirSync(CLAUDE_DIR, { recursive: true }); } catch { /* ignore */ }
  const locked = acquireStateLock();
  try {
    const state = loadState();
    const didSeedConfig = seedConfig(state);
    const didWire = wireStatusline(state);
    const didSeedCtx = seedSessionContext(cwd, state);
    const didAutoFill = autoFillSessionContext(cwd, state);
    const didInject = injectClaudeMdRules(cwd, state);

    if (didSeedConfig || didWire || didSeedCtx || didAutoFill || didInject) {
      saveState(state);
    }
  } finally {
    if (locked) releaseStateLock();
  }

  // Nexus injection + post-compact continuation handoff run OUTSIDE the
  // lock since they read from cached files / a one-shot project handoff
  // and don't touch shared bootstrap state. Both get combined into a
  // single additionalContext payload — only the last JSON object on
  // stdout is honoured by Claude Code's hook parser.
  const continuation = buildContinuationAdditionalContext(cwd);
  const nexus = buildNexusAdditionalContext(cwd);

  // Surface the resume block to the user on the CLI. Claude Code suppresses
  // SessionStart hook stderr on source=compact (unlike PreCompact), so the
  // user-visible channel is `systemMessage` in the hookSpecificOutput JSON.
  // We still write to stderr for non-compact sessions + operator debugging.
  let systemMessage = '';
  if (continuation) {
    try {
      const { renderHandoffStderr } = require('../lib/handoff');
      const banner = renderHandoffStderr(continuation);
      process.stderr.write(banner);
      systemMessage = banner;
    } catch { /* rendering failure shouldn't block the hook */ }
  }

  emitAdditionalContext([continuation, nexus], systemMessage);

  process.exit(0);
}

try { main(); } catch (err) {
  // Never block the session on a bootstrap failure — but DO make the crash
  // visible. Prior behaviour swallowed ReferenceError/TypeError and exited
  // 0, which is indistinguishable from success to the hook pipeline; that
  // hid a real bug (undefined symbol) for a full dogfood cycle.
  //
  // ENOENT / EACCES on optional files aren't programming bugs; those are
  // already handled inside main() with their own catches. Anything that
  // reaches here escaped those, so treat it as a real crash.
  const msg = err && err.message ? err.message : String(err);
  process.stderr.write(`[session-intelligence] bootstrap error: ${msg}\n`);
  try { intelLog('bootstrap', 'error', 'hook crashed', { err: msg, stack: err && err.stack }); } catch { /* intelLog may be why we crashed */ }
  process.exit(1);
}
