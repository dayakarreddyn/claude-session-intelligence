'use strict';

// Git helpers, project/task resolution, deploy breadcrumb, output style, SI plugin gate, health probe.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { loadSessionContextLib } = require('./lib-loader');
const { truncate } = require('./format');

// ─── Git ─────────────────────────────────────────────────────────────────────

// Shared options for every git subprocess: stderr → ignore so non-git
// cwds don't spew "fatal: not a git repository" to the user's terminal
// every statusline redraw. stdin is closed so git can't block waiting
// for input on weird terminal setups.
const GIT_EXEC_OPTS = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };

function gitBranch(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { ...GIT_EXEC_OPTS, timeout: 1000 }).trim();
  } catch { return ''; }
}

function gitDirtyCount(cwd) {
  try {
    const out = execFileSync('git', ['-C', cwd, 'status', '--porcelain'],
      { ...GIT_EXEC_OPTS, timeout: 1500 });
    return out.split('\n').filter(Boolean).length;
  } catch { return 0; }
}

/**
 * Last commit subject. Used as the auto-refreshing fallback for the `task`
 * field so the status line always reflects what was actually shipped when
 * session-context.md is missing or stale.
 */
function gitLastCommitSubject(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'log', '-1', '--pretty=%s'],
      { ...GIT_EXEC_OPTS, timeout: 1000 }).trim();
  } catch { return ''; }
}

/**
 * Git short diff stat: returns { added, deleted } across tracked working-tree
 * changes vs HEAD. Untracked files are counted by `dirty` (±N) so their
 * existence is visible even without line counts.
 */
function gitDiffStat(cwd) {
  try {
    const tracked = execFileSync('git', ['-C', cwd, 'diff', '--numstat', 'HEAD'],
      { ...GIT_EXEC_OPTS, timeout: 2000 });
    let added = 0, deleted = 0;
    for (const line of tracked.split('\n')) {
      if (!line.trim()) continue;
      const [a, d] = line.split('\t');
      if (a !== '-') added += parseInt(a, 10) || 0;
      if (d !== '-') deleted += parseInt(d, 10) || 0;
    }
    return { added, deleted };
  } catch { return { added: 0, deleted: 0 }; }
}

/**
 * Parse a GH-style issue number from a branch name or the current-task text.
 * Supports: fix/164, fix-164, feat/164-foo, "#164 foo", "issue #164".
 */
function extractIssueNumber(branch, task) {
  const candidates = [branch || '', task || ''];
  for (const s of candidates) {
    const m = s.match(/#?(\d{2,6})\b/);
    if (m) return `#${m[1]}`;
  }
  return '';
}

// ─── Project memory ──────────────────────────────────────────────────────────

function resolveProjectDir(cwd) {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const projectsDir = path.join(home, '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return null;

  const encoded = cwd.replace(/\//g, '-');
  const direct = path.join(projectsDir, encoded);
  if (fs.existsSync(path.join(direct, 'session-context.md'))) return direct;
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

// Skip unfilled template values like "(bug-fix | feature | test | ...)"
// or "(what you're working on)". Anything wrapped in parens that is still
// the literal placeholder should not leak into the status line.
function isPlaceholder(s) {
  if (!s) return true;
  const t = s.trim();
  if (/^\(.*\)$/.test(t)) return true;           // whole value is (…)
  if (/\|/.test(t) && /^\(/.test(t)) return true; // starts with "(" and has "|"
  return false;
}

// Extract the user-authored task string from session-context.md. Returns
// null when the file is missing, absent, or still placeholder-only — the
// caller then falls back to the git last-commit subject.
//
// When the shared session-context parser is available, delegate to it so
// autofill content (synthesised from last-commit) is treated as absent —
// the statusline's git-last-commit fallback already covers that case and
// presenting the autofilled text would misrepresent its provenance. When
// the shared lib is missing (older install), fall back to the legacy
// inline parser below — behaviourally identical for user-authored tasks.
function readSessionContextTask(projectDir) {
  if (!projectDir) return null;
  const shared = loadSessionContextLib();
  if (shared) {
    const { currentTask, mtimeMs, isAutofill } = shared.readSessionContext(projectDir);
    if (isAutofill || !currentTask) return null;
    const body = currentTask;
    const typeLine = body.match(/^type:\s*(.+)$/m);
    if (typeLine) {
      const raw = typeLine[1].trim();
      if (isPlaceholder(raw)) return null;
      const sep = raw.match(/\s[\u2014-]\s/);
      if (sep) {
        const type = raw.slice(0, sep.index).trim();
        const desc = raw.slice(sep.index + sep[0].length).trim();
        if (type && desc) return { text: `${type} \u2014 ${desc}`, mtimeMs };
        if (type) return { text: type, mtimeMs };
      }
      return { text: raw, mtimeMs };
    }
    const firstLine = body.split('\n').find((l) => l.trim().length > 0) || '';
    if (isPlaceholder(firstLine)) return null;
    const cleaned = firstLine.replace(/^[-*#\s]+/, '').replace(/\*\*/g, '').trim();
    return cleaned ? { text: cleaned, mtimeMs } : null;
  }

  // Legacy path — inline parse when the shared lib isn't on disk yet
  // (e.g. mid-plugin-upgrade). Same placeholder heuristic as before.
  const file = path.join(projectDir, 'session-context.md');
  let content;
  let mtimeMs = 0;
  try {
    content = fs.readFileSync(file, 'utf8');
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch { return null; }

  const match = content.match(/##\s+Current Task\s*([\s\S]*?)(?=\n##\s|$)/);
  if (!match) return null;
  const body = match[1].trim();

  const typeLine = body.match(/^type:\s*(.+)$/m);
  if (typeLine) {
    const raw = typeLine[1].trim();
    if (isPlaceholder(raw)) return null;
    // Split on em-dash or " - " (surrounded by spaces) so hyphens inside
    // values like "bug-fix" stay intact.
    const sep = raw.match(/\s[\u2014-]\s/);
    if (sep) {
      const type = raw.slice(0, sep.index).trim();
      const desc = raw.slice(sep.index + sep[0].length).trim();
      if (type && desc) return { text: `${type} \u2014 ${desc}`, mtimeMs };
      if (type) return { text: type, mtimeMs };
    }
    return { text: raw, mtimeMs };
  }

  const firstLine = body.split('\n').find((l) => l.trim().length > 0) || '';
  if (isPlaceholder(firstLine)) return null;
  const cleaned = firstLine.replace(/^[-*#\s]+/, '').replace(/\*\*/g, '').trim();
  return cleaned ? { text: cleaned, mtimeMs } : null;
}

// Nearest ancestor of cwd (inclusive) holding a session-context.md — some
// projects maintain the file at the repo root by hand instead of (or as
// well as) the ~/.claude/projects/<encoded>/ copy SI seeds. Bounded walk so
// a deep cwd can't turn the statusline hot path into a filesystem crawl.
function findCwdContextDir(cwd) {
  if (!cwd) return null;
  const home = os.homedir();
  let dir = cwd;
  for (let i = 0; i < 8; i++) {
    try { if (fs.existsSync(path.join(dir, 'session-context.md'))) return dir; } catch { /* ignore */ }
    const parent = path.dirname(dir);
    if (!dir || dir === home || parent === dir) break;
    dir = parent;
  }
  return null;
}

// The `task` field answers the question "what am I working on?" in order
// of freshness:
//   1. session-context.md — the FRESHER of the ~/.claude/projects/<encoded>/
//      copy and a repo-root copy under cwd, if real content AND recent
//      (mtime < staleHours). Projects that hand-maintain the repo-root file
//      (long-lived orchestrator sessions) otherwise pin the cell to
//      whatever the projects-dir copy last said — observed 3 months stale.
//   2. Same, flagged as (stale) when older than that.
//   3. Last git commit subject — auto-refreshes every commit so the bar
//      keeps reflecting actual work even when the file is never updated.
//   4. empty.
function loadCurrentTask(projectDir, cwd, maxLen = 40, staleHours = 12) {
  // Clamp: truncate(s, 0 | negative) yields a shorter-by-one string via
  // s.slice(0, max - 1), which is almost-empty junk. Anything <= 3 leaves
  // no room for the single-char ellipsis either. Treat bad input as "use
  // default" rather than producing garbage output.
  const safeMax = Number.isFinite(maxLen) && maxLen > 3 ? Math.floor(maxLen) : 40;
  const fromProj = readSessionContextTask(projectDir);
  const cwdDir = findCwdContextDir(cwd);
  const fromRepo = cwdDir ? readSessionContextTask(cwdDir) : null;
  let fromFile = fromProj;
  if (fromRepo && (!fromProj || fromRepo.mtimeMs > fromProj.mtimeMs)) fromFile = fromRepo;
  if (fromFile && fromFile.text) {
    const ageMs = Date.now() - fromFile.mtimeMs;
    const stale = ageMs > staleHours * 60 * 60 * 1000;
    const marker = stale ? ' (stale)' : '';
    return { text: truncate(fromFile.text + marker, safeMax), source: stale ? 'file-stale' : 'file' };
  }
  const subject = gitLastCommitSubject(cwd);
  if (subject) return { text: truncate(subject, safeMax), source: 'commit' };
  return { text: '', source: 'none' };
}

// ─── Deploy breadcrumb ───────────────────────────────────────────────────────
// Single-line file: "<target> <iso-ts>". Any CI/script can write it:
//   echo "gateway $(date -u +%FT%TZ)" > ~/.claude/logs/deploy-breadcrumb
function readDeployBreadcrumb() {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const file = path.join(home, '.claude', 'logs', 'deploy-breadcrumb');
  try {
    const line = fs.readFileSync(file, 'utf8').trim();
    const [target, ts] = line.split(/\s+/);
    if (!target || !ts) return null;
    const ageMs = Date.now() - new Date(ts).getTime();
    if (!Number.isFinite(ageMs)) return null;
    return { target, ageMs };
  } catch { return null; }
}

// ─── Output style ────────────────────────────────────────────────────────────

function detectOutputStyle(input) {
  // Claude Code emits output_style as either a string or `{name: string}`,
  // and "default" should render blank (no signal). Same handling the prior
  // inline-on-model rendering used.
  const raw = input.output_style ?? input.outputStyle ?? process.env.CLAUDE_OUTPUT_STYLE ?? '';
  let style = '';
  if (typeof raw === 'string') style = raw;
  else if (raw && typeof raw.name === 'string') style = raw.name;
  if (!style || style.toLowerCase() === 'default') return '';
  return style;
}

const SI_PLUGIN_KEY = 'session-intelligence@session-intelligence';

/**
 * Walk up from `cwd` looking for a `.claude/settings*.json` that declares
 * `enabledPlugins`. Returns the gate state for SI:
 *   - 'ok'              → no whitelist found OR SI explicitly enabled
 *   - 'dark-omitted'    → whitelist exists, SI key absent
 *   - 'dark-disabled'   → whitelist exists, SI set to false
 *
 * Project `enabledPlugins` is authoritative when present — Claude Code
 * suppresses every plugin not in the list, including SI's hooks. The
 * statusline still renders (it's wired separately as a statusCommand),
 * which is exactly why this check is the missing self-diagnosis: the
 * bar lights up but the SI-fed fields stay dark, and the user has no
 * way to tell the difference from "nothing's happened yet."
 *
 * Cheap: walks ≤10 ancestors, reads tiny JSON files, no network. Called
 * once per render (statusline is fresh-process per prompt) so we skip
 * the cache layer.
 */
function detectSiPluginGate(cwd) {
  if (!cwd || typeof cwd !== 'string') return 'ok';
  let dir = path.resolve(cwd);
  for (let i = 0; i < 10; i++) {
    for (const fname of ['settings.json', 'settings.local.json']) {
      const p = path.join(dir, '.claude', fname);
      try {
        const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (cfg && cfg.enabledPlugins && typeof cfg.enabledPlugins === 'object') {
          const v = cfg.enabledPlugins[SI_PLUGIN_KEY];
          if (v === true) return 'ok';
          if (v === false) return 'dark-disabled';
          return 'dark-omitted';
        }
      } catch { /* file missing or unreadable — keep walking */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'ok';
}

// ─── Service health cache ────────────────────────────────────────────────────
// Config: serviceHealth: [{ name, url, ttlSec?, timeoutMs? }]
// Cache: /tmp/claude-health-<name>  ->  "<http_code> <epoch_ms>"

function readHealthCache(name) {
  try {
    const safe = String(name || '').replace(/[^a-zA-Z0-9_-]/g, '');
    const file = path.join(os.tmpdir(), `claude-health-${safe}`);
    const raw = fs.readFileSync(file, 'utf8').trim();
    const [status, ts] = raw.split(/\s+/);
    return { status, ts: parseInt(ts, 10) || 0 };
  } catch { return null; }
}

function probeHealthIfStale(svc) {
  const ttlSec = svc.ttlSec || 30;
  const cached = readHealthCache(svc.name);
  if (cached && (Date.now() - cached.ts) < ttlSec * 1000) return cached;
  if (!/^https?:\/\//i.test(svc.url || '')) return cached;

  const safe = String(svc.name || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const cacheFile = path.join(os.tmpdir(), `claude-health-${safe}`);
  const timeoutSec = Math.max(1, Math.floor((svc.timeoutMs || 2000) / 1000));

  // Detached, non-blocking probe — argv-style spawn, no shell interpolation.
  try {
    const { spawn } = require('child_process');
    const curl = spawn('curl', [
      '-s', '-o', '/dev/null',
      '-w', '%{http_code}',
      '--max-time', String(timeoutSec),
      svc.url,
    ], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });

    let out = '';
    curl.stdout.on('data', (c) => { out += c.toString('utf8'); });
    curl.on('close', () => {
      try {
        const code = (out.trim() || 'err').replace(/[^a-zA-Z0-9]/g, '');
        fs.writeFileSync(cacheFile, `${code} ${Date.now()}`, 'utf8');
      } catch { /* best effort */ }
    });
    curl.on('error', () => { /* curl missing — stay silent */ });
    curl.unref();
  } catch { /* best effort */ }

  return cached;
}

// ─── Session duration ────────────────────────────────────────────────────────

function readSessionStartTime(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  try {
    // Scan the head of the transcript for the earliest event with a timestamp.
    // The *literal* first line is often a `permission-mode` marker that has no
    // timestamp field — so we can't just parse line 0. 8 KB covers the first
    // ~20 events which is plenty to catch the session-start hook output.
    const stat = fs.statSync(transcriptPath);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(Math.min(8192, stat.size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      const lines = buf.toString('utf8').split('\n');
      // Don't consume the last slice — it may be a partial line.
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i];
        if (!line) continue;
        try {
          const d = JSON.parse(line);
          const ts = d.timestamp || d.message?.timestamp;
          if (ts) {
            const ms = new Date(ts).getTime();
            if (Number.isFinite(ms)) return ms;
          }
        } catch { /* skip partial/invalid line */ }
      }
    } finally { fs.closeSync(fd); }
  } catch { /* ignore */ }
  return null;
}

module.exports = {
  GIT_EXEC_OPTS,
  gitBranch,
  gitDirtyCount,
  gitLastCommitSubject,
  gitDiffStat,
  extractIssueNumber,
  resolveProjectDir,
  isPlaceholder,
  readSessionContextTask,
  findCwdContextDir,
  loadCurrentTask,
  readDeployBreadcrumb,
  detectOutputStyle,
  SI_PLUGIN_KEY,
  detectSiPluginGate,
  readHealthCache,
  probeHealthIfStale,
  readSessionStartTime,
};
