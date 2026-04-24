#!/usr/bin/env node
/**
 * Claude Code statusLine — Session Intelligence view (v2)
 *
 * Reads stdin JSON (provided by Claude Code):
 *   { session_id, transcript_path, cwd, model: { display_name }, ... }
 *
 * Prints a configurable single status line. Fields, colors, token source,
 * and zone thresholds are all configurable via:
 *
 *   ~/.claude/statusline-intel.json   — persistent config (takes precedence over defaults)
 *   env vars                          — override config for this session
 *
 * See README.md for the full field catalog.
 *
 * Silent fallback: if anything goes wrong, prints a minimal "claude" so the
 * status line never shows broken.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// ─── Config ──────────────────────────────────────────────────────────────────
// Unified config lives in ~/.claude/session-intelligence.json. lib/config.js
// merges it with defaults, legacy ~/.claude/statusline-intel.json, and env
// overrides. We only need the statusline slice here.
//
// Two install paths exist: repo-local tests (lib next to script) and user
// install (lib under scripts/hooks/session-intelligence/). Try both.

// The statusline script can sit in three different layouts on disk:
//   1. Repo:     plugins/session-intelligence/statusline/ with ../lib siblings
//   2. Cache:    cache/.../1.0.0/statusline/ with ../lib siblings
//   3. Legacy:   ~/.claude/scripts/ with hooks/session-intelligence/lib/ nested
// The candidate order below walks each layout in turn. The repo/cache path
// (`../lib`) went overlooked for a while, which meant env-var field
// overrides silently no-op'd — now covered.
function resolveLibDir() {
  const candidates = [
    // 1. Plugin cache (canonical when installed via `/plugin install`). This
    //    MUST win over any legacy copies in ~/.claude/scripts/hooks/ — those
    //    diverge on every install.sh rsync because install.sh only populates
    //    LIB_DIR when the plugin is NOT detected. Checking plugin cache first
    //    keeps the standalone ~/.claude/scripts/statusline-intel.js working
    //    even when the legacy lib dir is empty.
    path.join(require('os').homedir(), '.claude', 'plugins', 'cache',
              'session-intelligence', 'session-intelligence', '1.0.0', 'lib'),
    path.join(__dirname, '..', 'lib'),
    path.join(__dirname, 'lib'),
    path.join(__dirname, 'hooks', 'session-intelligence', 'lib'),
    path.join(__dirname, 'session-intelligence', 'lib'),
  ];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'config.js'))) return dir;
    } catch { /* try next */ }
  }
  return null;
}

function loadSharedConfig() {
  const dir = resolveLibDir();
  if (!dir) return null;
  try { return require(path.join(dir, 'config.js')); }
  catch { return null; }
}

function loadThinkingLib() {
  const dir = resolveLibDir();
  if (!dir) return null;
  const p = path.join(dir, 'thinking.js');
  try {
    if (fs.existsSync(p)) return require(p);
  } catch { /* optional */ }
  return null;
}

function loadCompactHistoryLib() {
  const dir = resolveLibDir();
  if (!dir) return null;
  const p = path.join(dir, 'compact-history.js');
  try {
    if (fs.existsSync(p)) return require(p);
  } catch { /* optional */ }
  return null;
}

function loadUsageApiLib() {
  const dir = resolveLibDir();
  if (!dir) return null;
  const p = path.join(dir, 'usage-api.js');
  try {
    if (fs.existsSync(p)) return require(p);
  } catch { /* optional */ }
  return null;
}

// Cached per-process so blockUsage + weekUsage share one disk read + one
// "should we kick off a background refresh" decision per render.
let _usageCached = undefined;
function loadUsage() {
  if (_usageCached !== undefined) return _usageCached;
  const lib = loadUsageApiLib();
  if (!lib) { _usageCached = null; return null; }
  try { _usageCached = lib.readAndRefreshIfStale(); }
  catch { _usageCached = null; }
  return _usageCached;
}

// Render a usage cell as `<label>:<pct>% · <reset-in duration>`.
// colourMode: 'zone' escalates green→yellow→orange→red at 60/85/95 so a
// soon-to-exhaust quota reads at a glance (weekly, where the signal is
// load-bearing). 'dim' keeps the cell muted to match the rest of the row
// (5h block, where the percent matters less than the countdown).
function _renderUsageCellImpl(label, pctRaw, resetAt, C, colourMode = 'zone') {
  if (typeof pctRaw !== 'number' || !Number.isFinite(pctRaw)) return '';
  const pct = Math.round(pctRaw);
  let resetStr = '';
  if (resetAt) {
    const ms = resetAtMs(resetAt) - Date.now();
    if (Number.isFinite(ms) && ms > 0) resetStr = fmtDuration(ms);
  }
  let head;
  if (colourMode === 'dim') {
    head = `${C.dim}${label}:${pct}%${C.reset}`;
  } else {
    let col = C.green;
    if (pct >= 95) col = C.red;
    else if (pct >= 85) col = C.orange;
    else if (pct >= 60) col = C.yellow;
    head = `${col}${label}:${pct}%${C.reset}`;
  }
  // `r:` prefix on the reset duration keeps the cell self-explanatory.
  // Plain-space separator inside the cell — the outer `·` between fields
  // is the field boundary, so we skip it within a single usage cell.
  return resetStr ? `${head} ${C.dim}r:${resetStr}${C.reset}` : head;
}

// Parse either ISO-8601 or epoch-seconds reset timestamps. The usage API
// has returned both shapes over time — accept either to stay compatible.
function resetAtMs(resetAt) {
  if (typeof resetAt === 'number') {
    return resetAt > 1e12 ? resetAt : resetAt * 1000;
  }
  if (typeof resetAt === 'string') {
    const parsed = Date.parse(resetAt);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

// Shared session-context parser — same placeholder + autofill rules the
// handoff reader and pre-compact hint formatter use. Loaded lazily so a
// missing lib dir just falls back to the legacy inline parser below.
function loadSessionContextLib() {
  const dir = resolveLibDir();
  if (!dir) return null;
  const p = path.join(dir, 'session-context.js');
  try {
    if (fs.existsSync(p)) return require(p);
  } catch { /* optional */ }
  return null;
}

function loadConfig() {
  const shared = loadSharedConfig();
  if (shared) {
    const full = shared.loadConfig();
    return full.statusline || full;
  }
  // Stand-alone fallback: read legacy file only, no env overrides.
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const legacyPath = path.join(home, '.claude', 'statusline-intel.json');
  const defaults = {
    fields: [
      'tokens', 'compactAge', 'compactCost',
      'newline',
      'emoji2', 'session', 'tools', 'cost', 'deploy', 'tokenFlow', 'cacheHit', 'cacheSaved',
      'newline',
      'emoji', 'model', 'project', 'branch', 'issue', 'diffstat', 'task',
    ],
    tokenSource: 'auto',
    zones: { yellow: 200000, orange: 300000, red: 400000 },
    maxTaskLength: 40,
    separator: ' · ',
    colors: true,
    serviceHealth: [],
  };
  try {
    if (fs.existsSync(legacyPath)) {
      const user = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
      return { ...defaults, ...user, zones: { ...defaults.zones, ...(user.zones || {}) } };
    }
  } catch { /* ignore */ }
  return defaults;
}

// ─── Colors ──────────────────────────────────────────────────────────────────

function makeColors(enabled) {
  const code = (c) => (enabled ? c : '');
  return {
    reset:  code('\x1b[0m'),
    dim:    code('\x1b[2m'),
    bold:   code('\x1b[1m'),
    green:  code('\x1b[32m'),
    yellow: code('\x1b[33m'),
    orange: code('\x1b[38;5;208m'),
    red:    code('\x1b[31m'),
    blue:   code('\x1b[34m'),
    gray:   code('\x1b[90m'),
    // Near-invisible 256-colour grey for field separators only. Keeping
    // `·` barely legible makes the actual field content pop without losing
    // the visual break between cells.
    graySep: code('\x1b[38;5;237m'),
    cyan:   code('\x1b[36m'),
    magenta: code('\x1b[35m'),
  };
}

// ─── stdin ───────────────────────────────────────────────────────────────────

function readStdinSync() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function safeParse(raw) {
  try { return raw.trim() ? JSON.parse(raw) : {}; } catch { return {}; }
}

// ─── Token sources ───────────────────────────────────────────────────────────

/**
 * Parse the tail of a Claude Code transcript jsonl and return the most recent
 * assistant message's usage block. Usage is the authoritative context size.
 */
function readTranscriptUsage(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

  try {
    const stat = fs.statSync(transcriptPath);
    const SCAN_BYTES = Math.min(stat.size, 512 * 1024); // 512 KB tail
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(SCAN_BYTES);
      fs.readSync(fd, buf, 0, SCAN_BYTES, stat.size - SCAN_BYTES);
      const text = buf.toString('utf8');
      const lines = text.split('\n').filter(Boolean);

      // Walk backwards for most recent assistant message with usage
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const d = JSON.parse(lines[i]);
          const msg = d && d.message;
          if (msg && typeof msg === 'object' && msg.usage) {
            return msg.usage;
          }
        } catch { /* partial line on boundary */ }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* silent */ }
  return null;
}

/**
 * Total context size in tokens from a usage block.
 * cache_read is counted because it's in the context window, just billed cheaper.
 */
function totalTokensFromUsage(u) {
  if (!u) return 0;
  return (
    (u.input_tokens || 0) +
    (u.cache_creation_input_tokens || 0) +
    (u.cache_read_input_tokens || 0)
  );
}

function readIntFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch { return 0; }
}

function loadEstimate(sessionId) {
  const tmp = os.tmpdir();
  const ids = [sessionId, 'default'].filter(Boolean);
  for (const id of ids) {
    const sid = String(id).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!sid) continue;
    const budget = path.join(tmp, `claude-token-budget-${sid}`);
    const count  = path.join(tmp, `claude-tool-count-${sid}`);
    if (fs.existsSync(budget) || fs.existsSync(count)) {
      return { tokens: readIntFile(budget), tools: readIntFile(count), id: sid };
    }
  }
  return { tokens: 0, tools: 0, id: sessionId || 'default' };
}

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
    const cleaned = firstLine.replace(/^[-*#\s]+/, '').trim();
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
  const cleaned = firstLine.replace(/^[-*#\s]+/, '').trim();
  return cleaned ? { text: cleaned, mtimeMs } : null;
}

// The `task` field answers the question "what am I working on?" in order
// of freshness:
//   1. session-context.md, if real content AND recent (mtime < staleHours).
//   2. session-context.md flagged as (stale) when older than that.
//   3. Last git commit subject — auto-refreshes every commit so the bar
//      keeps reflecting actual work even when the file is never updated.
//   4. empty.
function loadCurrentTask(projectDir, cwd, maxLen = 40, staleHours = 12) {
  // Clamp: truncate(s, 0 | negative) yields a shorter-by-one string via
  // s.slice(0, max - 1), which is almost-empty junk. Anything <= 3 leaves
  // no room for the single-char ellipsis either. Treat bad input as "use
  // default" rather than producing garbage output.
  const safeMax = Number.isFinite(maxLen) && maxLen > 3 ? Math.floor(maxLen) : 40;
  const fromFile = readSessionContextTask(projectDir);
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

// ─── Formatting helpers ──────────────────────────────────────────────────────

/**
 * Claude's effective context cap for the active model.
 *
 *   1. Explicit `statusline.contextCap` in config wins (escape hatch).
 *   2. Legacy `[1m]` / `-1m` marker in the model id → 1M.
 *   3. Any Opus 4.x / 5.x or Sonnet 4.x — 1M. Newer Claude Code builds
 *      dropped the `[1m]` marker once 1M became the default for these
 *      models, so key off the family name instead.
 *   4. Fallback 200k.
 */
function contextCap(input, cfg) {
  if (cfg && Number.isFinite(cfg.contextCap) && cfg.contextCap > 0) {
    return cfg.contextCap;
  }
  const id = String(
    (input && input.model && (input.model.id || input.model.display_name)) || ''
  ).toLowerCase();
  if (/\[1m\]|-1m|\b1m\b|1000k|1000000/.test(id)) return 1000000;
  if (/opus[\s-]?[4-9]|sonnet[\s-]?[4-9]/.test(id)) return 1000000;
  return 200000;
}

/**
 * Render a Unicode progress bar as a segmented gradient. Each filled slot
 * is coloured by the zone the tokens AT THAT SLOT POSITION belong to
 * (green → yellow → orange → red), so zone boundaries are visible even
 * mid-fill. Empty slots stay dim. This replaces the prior mono-colour fill
 * (whole bar = current zone's colour) that made zone progression invisible
 * until the bar flipped wholesale.
 *
 * `zoneColorName` is no longer used for the fill — it's accepted for
 * source compatibility with callers that still pass it. Unfilled tail
 * colour is always dim.
 *
 * Returns an ANSI-coloured string of visible width `width`.
 */
function renderContextBar(used, cap, zones, C, _zoneColorName, width) {
  const w = Math.max(8, Math.min(40, width || 20));
  const ratio = cap > 0 ? Math.max(0, Math.min(1, used / cap)) : 0;
  const filled = Math.round(ratio * w);
  if (cap <= 0) {
    return `${C.dim}${'▱'.repeat(w)}${C.reset}`;
  }
  let out = '';
  let prevColor = '';
  for (let i = 0; i < filled; i++) {
    // Classify each slot by the tokens at its upper edge so a slot that
    // crosses a zone threshold takes the new zone's colour (visual bias
    // toward "this is the zone you've reached").
    const slotTokens = ((i + 1) / w) * cap;
    const color = C[zoneFor(slotTokens, zones).color] || C.reset;
    if (color !== prevColor) {
      out += `${C.reset}${color}`;
      prevColor = color;
    }
    out += '▰';
  }
  out += `${C.reset}${C.dim}${'▱'.repeat(w - filled)}${C.reset}`;
  return out;
}

function zoneFor(tokens, zones) {
  if (tokens >= zones.red)    return { name: 'red',    color: 'red',    icon: '▰▰▰▰' };
  if (tokens >= zones.orange) return { name: 'orange', color: 'orange', icon: '▰▰▰▱' };
  if (tokens >= zones.yellow) return { name: 'yellow', color: 'yellow', icon: '▰▰▱▱' };
  return { name: 'green', color: 'green', icon: '▰▱▱▱' };
}

function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;  // 1.25M
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;      // 425.3k
  return String(n);
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
}

function projectLabel(cwd) {
  if (!cwd) return '';
  const name = path.basename(cwd);
  return name || cwd;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0m';
  const totalMin = Math.floor(ms / 60000);
  const d = Math.floor(totalMin / (60 * 24));
  const h = Math.floor((totalMin % (60 * 24)) / 60);
  const m = totalMin % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}hr`);
  // Skip minutes once the span exceeds a day — the extra precision isn't
  // actionable at those scales and `1d 5hr 32m` starts to feel busy.
  if (m && !d) parts.push(`${m}m`);
  return parts.join(' ') || '0m';
}

// ─── Compaction ──────────────────────────────────────────────────────────────

// Session-scoped. Returns the ms timestamp of the most recent /compact this
// session has performed (via compact-history.jsonl), or null when there's
// been no compact in this sid yet. A global compaction-log mtime was used
// here previously — it surfaced OTHER sessions' compacts and confused the
// "compact ago" and "cost since compact" signals in tabs that hadn't
// compacted at all.
function lastCompactMsForSession(sessionId) {
  if (!sessionId) return null;
  const lib = loadCompactHistoryLib();
  if (!lib || typeof lib.lastCompactMsForSession !== 'function') return null;
  return lib.lastCompactMsForSession(sessionId);
}

function minutesSinceLastCompact(sessionId) {
  const ms = lastCompactMsForSession(sessionId);
  return ms === null ? null : Math.floor((Date.now() - ms) / 60000);
}

/**
 * Cost + cache-savings accrued since the last /compact IN THIS SESSION.
 * Returns zeroes when the session hasn't compacted yet — the cell renders
 * empty in that case, same as compactAge. Scans transcript JSONL lines
 * whose `timestamp` is >= the session's last-compact timestamp.
 * Incrementally cached under /tmp keyed by sessionId + compactMs — when
 * the session compacts again, the cache resets automatically.
 */
function costsSinceCompact(transcriptPath, sessionId, prices = DEFAULT_PRICES) {
  const empty = { cost: 0, saved: 0 };
  const compactMs = lastCompactMsForSession(sessionId);
  if (!compactMs) return empty;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return empty;

  let stat;
  try { stat = fs.statSync(transcriptPath); } catch { return empty; }

  const sid = String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '');
  const cacheFile = path.join(os.tmpdir(), `claude-cost-sincecompact-${sid}`);

  let cache = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (parsed && parsed.compactMs === compactMs
        && typeof parsed.offset === 'number' && parsed.offset >= 0
        && parsed.offset <= stat.size) {
      cache = parsed;
    }
  } catch { /* miss or stale */ }

  if (!cache) cache = { compactMs, offset: 0, cost: 0, saved: 0 };
  if (stat.size === cache.offset) return { cost: cache.cost, saved: cache.saved };

  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const bytesToRead = stat.size - cache.offset;
      const buf = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buf, 0, bytesToRead, cache.offset);
      const lastNl = buf.lastIndexOf(0x0A);
      if (lastNl >= 0) {
        const text = buf.slice(0, lastNl).toString('utf8');
        for (const line of text.split('\n')) {
          if (!line) continue;
          try {
            const d = JSON.parse(line);
            const u = d && d.message && d.message.usage;
            if (!u) continue;
            const ts = d.timestamp ? Date.parse(d.timestamp) : NaN;
            if (!Number.isFinite(ts) || ts < compactMs) continue;
            cache.cost += costFromUsage(u, prices);
            cache.saved += savedFromUsage(u, prices);
          } catch { /* skip bad line */ }
        }
        cache.offset += lastNl + 1;
      }
    } finally { fs.closeSync(fd); }
  } catch {
    return { cost: cache.cost, saved: cache.saved };
  }

  try { fs.writeFileSync(cacheFile, JSON.stringify(cache), 'utf8'); }
  catch { /* best effort */ }

  return { cost: cache.cost, saved: cache.saved };
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
  return input.output_style || input.outputStyle || process.env.CLAUDE_OUTPUT_STYLE || '';
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

// ─── Intelligent emoji ───────────────────────────────────────────────────────
// Priority (first match wins):
//   🔥 red zone
//   ⚠️  orange zone
//   🚀 deploy breadcrumb < 15 min old
//   🐛 task mentions bug/fix/issue
//   🏗️ task mentions build/feat/add
//   ✏️  dirty working tree mid-task
//   🟡 yellow zone
//   ✨ clean idle — tree clean + green zone + idle task
//   🟢 fallback green
function pickEmoji(ctx, input) {
  const zone = zoneFor(ctx.tokens, ctx.cfg.zones).name;
  if (zone === 'red') return '🔥';
  if (zone === 'orange') return '⚠️';

  const deploy = readDeployBreadcrumb();
  if (deploy && deploy.ageMs < 15 * 60 * 1000) return '🚀';

  const task = (ctx.task || '').toLowerCase();
  if (/\b(bug|fix|issue|error|crash)\b/.test(task)) return '🐛';
  if (/\b(build|feat|add|implement|create)\b/.test(task)) return '🏗️';
  if (/\b(refactor|cleanup|simpl)\b/.test(task)) return '🧹';
  if (/\b(test|spec)\b/.test(task)) return '🧪';
  if (/\b(deploy|ship|release)\b/.test(task)) return '🚀';
  if (/\b(doc|readme)\b/.test(task)) return '📝';

  const dirty = gitDirtyCount(input.cwd || process.cwd());
  if (dirty > 0) return '✏️';

  if (zone === 'yellow') return '🟡';

  if (/\b(idle|done|clean|ended|ready)\b/.test(task)) return '✨';
  return '🟢';
}

/**
 * Second-line emoji — reflects activity signals (tools/time/cost/deploy),
 * not state. Priority order:
 *   🚀 very recent deploy (<5min)
 *   💸 cost above threshold (default $3)
 *   🕐 long session (>2h)
 *   🔧 heavy tool use (>100 calls)
 *   📊 default (metrics/stats)
 */
function pickEmojiSecond(ctx) {
  const deploy = readDeployBreadcrumb();
  if (deploy && deploy.ageMs < 5 * 60 * 1000) return '🚀';

  if (ctx.costUsd && ctx.costUsd >= 3) return '💸';
  if (ctx.sessionDurationMs && ctx.sessionDurationMs > 2 * 60 * 60 * 1000) return '🕐';
  if (ctx.tools && ctx.tools > 100) return '🔧';

  return '📊';
}

// ─── Field renderers ─────────────────────────────────────────────────────────
// Each renderer returns a string (possibly with ANSI) or '' to skip.

function buildRenderers(C) {
  return {
    /** Intelligent leading emoji — picks based on zone, dirty tree, task intent, deploy. */
    emoji: (input, ctx) => pickEmoji(ctx, input),

    /** Activity-aware emoji for line 2 (tools/time/cost/deploy). */
    emoji2: (_input, ctx) => pickEmojiSecond(ctx),

    // Colour policy (see README "Statusline palette"): line 1 is all dim
    // except `tokens`, which is the one signal worth a colour because the
    // whole bar exists to warn about context pressure. Every other field is
    // context FOR that signal — making them bright just adds noise.
    model: (input) => {
      const m = input.model?.display_name || input.model?.id || 'claude';
      // output_style is the named output mode (concise, explanatory, etc.) —
      // NOT the reasoning effort / thinking budget. Claude Code exposes it as
      // either a string or {name: string}. Case-insensitive compare against
      // "default" because observed payloads use both casings. Guard non-string
      // .name so a malformed object can't leak "[object Object]".
      const styleRaw = input.output_style;
      let style = '';
      if (typeof styleRaw === 'string') style = styleRaw;
      else if (styleRaw && typeof styleRaw.name === 'string') style = styleRaw.name;
      if (style && style.toLowerCase() !== 'default') {
        return `${C.dim}${m} · ${style}${C.reset}`;
      }
      return `${C.dim}${m}${C.reset}`;
    },

    project: (input) => `${C.dim}${projectLabel(input.cwd)}${C.reset}`,

    branch: (input) => {
      const b = gitBranch(input.cwd);
      return b ? `${C.dim}${b}${C.reset}` : '';
    },

    dirty: (input) => {
      const n = gitDirtyCount(input.cwd);
      if (n === 0) return '';
      return `${C.yellow}\u00b1${n}${C.reset}`;
    },

    tokens: (input, ctx) => {
      const t = ctx.tokens;
      const zone = zoneFor(t, ctx.cfg.zones);
      const color = C[zone.color] || C.reset;
      const sourceTag = ctx.cfg.tokenSource === 'estimate' || !ctx.usedTranscript
        ? `${C.dim}~${C.reset}` : '';
      // Idle bar: skip the fill bar entirely, just show the zone icon.
      if (t <= 0) {
        return `${color}${sourceTag}${zone.icon} idle${C.reset}`;
      }
      const cap = contextCap(input, ctx.cfg);
      const bar = renderContextBar(t, cap, ctx.cfg.zones, C, zone.color, 20);
      const used = fmtTokens(t);
      const total = cap >= 1000000 ? '1M' : fmtTokens(cap);
      const pct = cap > 0 ? Math.round((t / cap) * 100) : 0;
      return `${bar}${C.reset} ${color}${sourceTag}${used}${C.reset}${C.dim}/${total} (${pct}%)${C.reset}`;
    },

    zone: (input, ctx) => {
      const zone = zoneFor(ctx.tokens, ctx.cfg.zones);
      return `${C[zone.color] || ''}${zone.name}${C.reset}`;
    },

    tools: (_input, ctx) => {
      if (ctx.tools <= 0) return '';
      const label = ctx.tools === 1 ? 'tool' : 'tools';
      return `${C.dim}${ctx.tools} ${label}${C.reset}`;
    },

    session: (_input, ctx) => {
      if (!ctx.sessionDurationMs) return '';
      return `${C.dim}${fmtDuration(ctx.sessionDurationMs)}${C.reset}`;
    },

    /**
     * Recent thinking-token estimate. Renders only when the tail-window
     * estimate crosses `statusline.thinkingMinDisplay` so an idle bar stays
     * quiet. Dim — thinking is context for the tokens field, not its own
     * zone alert.
     */
    thinking: (_input, ctx) => {
      const recent = ctx.thinking && ctx.thinking.recent;
      if (!recent) return '';
      const minDisplay = Number.isFinite(ctx.cfg.thinkingMinDisplay)
        ? ctx.cfg.thinkingMinDisplay : 5000;
      if (recent < minDisplay) return '';
      return `${C.dim}think:${fmtTokens(recent)}${C.reset}`;
    },

    task: (_input, ctx) => {
      if (!ctx.task) return '';
      // Line 2 stays dim/grey so the status bar has one loud voice (tokens +
      // compact alerts on line 1) and one quiet voice (the context on line 2).
      // Keyword colouring here competed with the real signal and made the bar
      // look carnival-bright. See statusline colour policy in README.
      return `${C.dim}${ctx.task}${C.reset}`;
    },

    /**
     * Short session id (first 8 chars of the UUID) — handy when you have
     * multiple Claude Code windows open and want to tell them apart on
     * the status line. Hidden when no session id is present.
     */
    sessionId: (input, _ctx) => {
      const sid = input.session_id || input.sessionId || '';
      if (!sid) return '';
      const short = String(sid).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8);
      return short ? `${C.dim}sid:${short}${C.reset}` : '';
    },

    cost: (_input, ctx) => {
      if (!ctx.costUsd) return '';
      return `${C.dim}$${ctx.costUsd.toFixed(2)}${C.reset}`;
    },

    /**
     * Combined cost + cache-savings: `c$0.45 / s$1.23`. Merges what used to be
     * two adjacent fields (`cost` + `cacheSaved`) into one token-economics
     * cell so line 2 stays compact. Omits either side when zero; hides
     * entirely when both are zero.
     */
    costSaved: (_input, ctx) => {
      const cost = ctx.costUsd || 0;
      const saved = ctx.cacheSavedUsd || 0;
      const parts = [];
      if (cost > 0) parts.push(`c$${cost.toFixed(2)}`);
      if (saved >= 0.1) parts.push(`s$${saved.toFixed(2)}`);
      if (!parts.length) return '';
      return `${C.dim}${parts.join(' / ')}${C.reset}`;
    },

    /**
     * Live prompt-cache hit ratio from the latest assistant turn's usage
     * block: cache_read / (cache_read + cache_creation). Shown as `cache:92%`.
     * Colour-gated: dim green ≥70% (good hit rate), dim yellow 30-70%
     * (mediocre), dim red <30% (cache mostly missing — the stablePrefix
     * feature isn't paying off). Empty when there's no cacheable prefix on
     * the latest turn (first turn of a session).
     */
    cacheHit: (_input, ctx) => {
      const u = ctx.usage;
      if (!u) return '';
      const read = u.cache_read_input_tokens || 0;
      const creation = u.cache_creation_input_tokens || 0;
      const denom = read + creation;
      if (denom <= 0) return '';
      const ratio = read / denom;
      const pct = Math.round(ratio * 100);
      // Dim colour tier so line 3 stays visually quiet; just enough accent
      // to catch a bad hit rate out of the corner of the eye.
      let tier = C.dim;
      if (ratio >= 0.7) tier = `${C.dim}${C.green}`;
      else if (ratio < 0.3) tier = `${C.dim}${C.red}`;
      else tier = `${C.dim}${C.yellow}`;
      return `${tier}cache:${pct}%${C.reset}`;
    },

    /**
     * Per-turn prefix breakdown: `prefix:<read>k/<creation>k` where read is
     * served from cache and creation is the new-to-cache portion of this
     * turn's prompt. A low read + high creation on a stable working set is
     * the warning sign stablePrefix is leaking a volatile value somewhere.
     */
    cacheTokens: (_input, ctx) => {
      const u = ctx.usage;
      if (!u) return '';
      const read = u.cache_read_input_tokens || 0;
      const creation = u.cache_creation_input_tokens || 0;
      if (read + creation <= 0) return '';
      return `${C.dim}prefix:${fmtTokens(read)}/${fmtTokens(creation)}${C.reset}`;
    },

    /**
     * Cumulative USD saved across the session by prefix-cache hits versus the
     * counterfactual of paying the uncached input rate. Hidden when savings
     * are trivially small — under $0.10 isn't worth a whole field.
     */
    cacheSaved: (_input, ctx) => {
      if (!ctx.cacheSavedUsd || ctx.cacheSavedUsd < 0.1) return '';
      return `${C.dim}saved:$${ctx.cacheSavedUsd.toFixed(2)}${C.reset}`;
    },

    /**
     * Cumulative token flow across the session, format matching ccstatusline
     * and Claude Code's own context-window summary so both surfaces agree
     * on the same numbers. `<total> ↓<in> ↑<out> c<cached>`:
     *   total = input + cache_creation + cache_read + output  (all tokens
     *           Anthropic billed for at any rate)
     *   ↓ in  = input_tokens                                  (fresh, uncached
     *           input — what you paid the full input rate for)
     *   ↑ out = output_tokens                                 (model output)
     *   c     = cache_read + cache_creation                   (all cache
     *           activity — reads served AND first-time writes)
     * Invariant: in + out + c = total, so the three components partition the
     * session's token spend cleanly. Hidden when no transcript data yet.
     */
    tokenFlow: (_input, ctx) => {
      const t = ctx.tokenTotals;
      if (!t) return '';
      const total = t.input + t.output + t.cached + t.creation;
      if (total <= 0) return '';
      const cacheActivity = t.cached + t.creation;
      return `${C.dim}t:${fmtTokens(total)} ↓${fmtTokens(t.input)} ↑${fmtTokens(t.output)} c${fmtTokens(cacheActivity)}${C.reset}`;
    },

    /**
     * Git diff-stat: (+N,-M) across all uncommitted changes in HEAD + untracked.
     * Skipped silently when clean. All dim — see colour policy above.
     */
    diffstat: (input, _ctx) => {
      const s = gitDiffStat(input.cwd);
      if (!s.added && !s.deleted) return '';
      return `${C.gray}(${C.green}+${s.added}${C.gray},${C.red}-${s.deleted}${C.gray})${C.reset}`;
    },

    /** GH issue number (#164) parsed from branch or current task. */
    issue: (input, ctx) => {
      const branch = gitBranch(input.cwd);
      const iss = extractIssueNumber(branch, ctx.task);
      return iss ? `${C.dim}${iss}${C.reset}` : '';
    },

    /** Minutes since last compaction event IN THIS SESSION (pre-compact
     *  hook writes compact-history.jsonl keyed by session id). Empty when
     *  the current session hasn't compacted yet — a global last-compact
     *  age would surface other tabs' compacts and misrepresent this run.
     *  The only line-2 field that escalates colour — red is reserved for
     *  the "you should compact now" alert so it stands out against the
     *  otherwise dim second line:
     *    <120m  dim  — fresh enough, no action
     *    >=120m red  — overdue, compact strongly suggested */
    compactAge: (input, _ctx) => {
      const sid = input.session_id || input.sessionId || '';
      const mins = minutesSinceLastCompact(sid);
      if (mins === null) return '';
      const label = fmtDuration(mins * 60 * 1000);
      const color = mins >= 120 ? C.red : C.dim;
      return `${color}compact:${label} ago${C.reset}`;
    },

    /** Cost + cache-savings accrued since last /compact. Pairs with
     *  compactAge to answer "how much has this post-compact run cost so
     *  far, and how much is the prefix cache earning me." Hidden when
     *  both are trivially small (<$0.10) or when no compact has happened
     *  yet. Always dim — volume signal, not a warning. */
    compactCost: (input, ctx) => {
      const { cost, saved } = costsSinceCompact(
        input.transcript_path || input.transcriptPath || '',
        input.session_id || input.sessionId || '',
        ctx.cfg.prices || DEFAULT_PRICES,
      );
      const parts = [];
      if (cost >= 0.01) parts.push(`c$${cost.toFixed(2)}`);
      if (saved >= 0.1) parts.push(`s$${saved.toFixed(2)}`);
      if (!parts.length) return '';
      return `${C.dim}${parts.join(' / ')}${C.reset}`;
    },

    /** Percentage of the context window consumed. Replaces ccstatusline's
     *  `93.0%` signal so we can retire the 1.5 s `npx` spend. Uses zones.red
     *  as the 100% reference — matches the token-bar cap. Zone-colored:
     *    <60% green · 60-85% yellow · 85-95% orange · >=95% red */
    contextPct: (_input, ctx) => {
      const max = (ctx.cfg.zones && ctx.cfg.zones.red) || 400000;
      if (!ctx.tokens || ctx.tokens <= 0) return '';
      const pct = Math.round((ctx.tokens / max) * 100);
      let col = C.green;
      if (pct >= 95) col = C.red;
      else if (pct >= 85) col = C.orange;
      else if (pct >= 60) col = C.yellow;
      return `${col}ctx:${pct}%${C.reset}`;
    },

    /** Claude Code 5-hour block usage + time until reset. Data from the
     *  cached usage API (180 s TTL, refreshed by a detached worker). Shown
     *  as `5h:47% · 3hr 12m` — percent then "resets in" duration. Empty
     *  when the cache is absent or has an error marker. */
    blockUsage: (_input, _ctx) => {
      const u = loadUsage();
      if (!u || typeof u.sessionUsage !== 'number') return '';
      return _renderUsageCellImpl('b', u.sessionUsage, u.sessionResetAt, C, 'dim');
    },

    /** Weekly (7-day) usage + time until reset. Same shape as blockUsage
     *  with a `w` prefix. Format: `w:31% · r:4d 12hr`. */
    weekUsage: (_input, _ctx) => {
      const u = loadUsage();
      if (!u || typeof u.weeklyUsage !== 'number') return '';
      return _renderUsageCellImpl('w', u.weeklyUsage, u.weeklyResetAt, C, 'zone');
    },

    /** Full working directory, ccstatusline-style. Collapses $HOME to `~`
     *  and middle-truncates when longer than 60 chars (keeps the leaf dir,
     *  which carries most of the signal). Dim — reference context only. */
    cwd: (input, _ctx) => {
      const raw = input.cwd || '';
      if (!raw) return '';
      const home = os.homedir();
      let display = raw;
      if (raw === home) display = '~';
      else if (raw.startsWith(home + '/')) display = '~' + raw.slice(home.length);
      const MAX = 60;
      if (display.length > MAX) {
        const leaf = path.basename(display);
        const room = MAX - leaf.length - 2; // for `…/`
        if (room > 0) display = display.slice(0, room) + '…/' + leaf;
        else display = '…/' + leaf;
      }
      return `${C.dim}${display}${C.reset}`;
    },

    /** Last deploy target + how fresh, read from ~/.claude/logs/deploy-breadcrumb.
     *  Always dim — the interesting signal about a fresh deploy already shows
     *  up as the 🚀 line-2 emoji (see pickEmojiSecond). The text itself is
     *  just reference context and shouldn't fight for attention. */
    deploy: (_input, _ctx) => {
      const b = readDeployBreadcrumb();
      if (!b) return '';
      const mins = Math.floor(b.ageMs / 60000);
      const when = mins < 1 ? 'now' : mins < 60 ? `${mins}m ago` : `${Math.floor(mins / 60)}h${mins % 60}m ago`;
      return `${C.dim}deploy:${b.target} ${when}${C.reset}`;
    },

    /** Output style indicator — explanatory, default, etc. */
    outputStyle: (input, _ctx) => {
      const s = detectOutputStyle(input);
      return s ? `${C.blue}style:${s}${C.reset}` : '';
    },

    /** Colored dot per configured service URL; polls in background, reads cache. */
    health: (_input, ctx) => {
      const services = (ctx.cfg.serviceHealth || []);
      if (!services.length) return '';
      const dots = services.map((svc) => {
        const cached = probeHealthIfStale(svc);
        if (!cached) return `${C.gray}○${C.reset}`;
        const code = cached.status;
        const ok = /^2\d\d$/.test(code);
        const redirect = /^3\d\d$/.test(code);
        const color = ok ? C.green : (redirect ? C.yellow : C.red);
        return `${color}●${C.reset}`;
      });
      return `${C.dim}[${C.reset}${dots.join('')}${C.dim}]${C.reset}`;
    },
  };
}

// ─── Cost estimation ─────────────────────────────────────────────────────────
// Prices are per million tokens. Kept loose — user can override via config.
const DEFAULT_PRICES = {
  // Claude Opus 4.x approximations (USD per 1M tokens)
  input: 15,
  cache_creation: 18.75,
  cache_read: 1.5,
  output: 75,
};

function costFromUsage(u, prices = DEFAULT_PRICES) {
  if (!u) return 0;
  const per = (n, p) => ((n || 0) / 1_000_000) * p;
  return per(u.input_tokens, prices.input)
       + per(u.cache_creation_input_tokens, prices.cache_creation)
       + per(u.cache_read_input_tokens, prices.cache_read)
       + per(u.output_tokens, prices.output);
}

// USD saved by a single turn's cache-read hits vs. paying the uncached input
// rate for the same tokens. Used by the line-3 `cacheSaved` field + summed
// incrementally by totalCostFromTranscript into the same /tmp/claude-cost
// cache (extended with a `saved` property — older caches are backward-
// compatible since the missing field is treated as 0).
function savedFromUsage(u, prices = DEFAULT_PRICES) {
  if (!u) return 0;
  const read = u.cache_read_input_tokens || 0;
  if (read <= 0) return 0;
  const delta = (prices.input || 0) - (prices.cache_read || 0);
  if (delta <= 0) return 0;
  return (read / 1_000_000) * delta;
}

/**
 * Cumulative session cost: sum per-turn usage across every assistant message
 * in the transcript. Each turn's cache_read/cache_creation/input/output is
 * billed separately by Anthropic, so summing is correct.
 *
 * Keyed by sessionId, cached as `{offset, cost}` in /tmp. On each call we
 * read only the bytes between the cached offset and stat.size — a handful of
 * KB per turn instead of the full multi-MB transcript. The old `(size, mtime)`
 * cache only helped when the transcript hadn't changed, i.e. never during
 * active use, so it read and re-parsed the entire file on every keypress.
 */
function totalCostFromTranscript(transcriptPath, sessionId, prices = DEFAULT_PRICES) {
  return totalsFromTranscript(transcriptPath, sessionId, prices).cost;
}

function totalCacheSavedFromTranscript(transcriptPath, sessionId, prices = DEFAULT_PRICES) {
  return totalsFromTranscript(transcriptPath, sessionId, prices).saved;
}

/**
 * Single incremental pass returning both {cost, saved}. Keeps one /tmp cache
 * file per session keyed by sessionId. Shares the cache with the lib
 * implementation so both renderers see the same offsets.
 */
function totalsFromTranscript(transcriptPath, sessionId, prices = DEFAULT_PRICES) {
  const empty = { cost: 0, saved: 0, input: 0, output: 0, cached: 0, creation: 0 };
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return empty;

  let stat;
  try { stat = fs.statSync(transcriptPath); } catch { return empty; }

  const sid = String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '');
  const cacheFile = path.join(os.tmpdir(), `claude-cost-${sid}`);

  let cachedOffset = 0;
  let cachedCost = 0;
  let cachedSaved = 0;
  let cachedInput = 0;
  let cachedOutput = 0;
  let cachedCacheRead = 0;
  let cachedCreation = 0;
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cached && typeof cached.offset === 'number' && typeof cached.cost === 'number'
        && cached.offset >= 0 && cached.offset <= stat.size) {
      cachedOffset = cached.offset;
      cachedCost = cached.cost;
      cachedSaved = typeof cached.saved === 'number' ? cached.saved : 0;
      cachedInput = typeof cached.input === 'number' ? cached.input : 0;
      cachedOutput = typeof cached.output === 'number' ? cached.output : 0;
      cachedCacheRead = typeof cached.cached === 'number' ? cached.cached : 0;
      cachedCreation = typeof cached.creation === 'number' ? cached.creation : 0;
    }
  } catch { /* cache miss or corrupt — read from 0 */ }

  // File shrank (rotation / clear) → drop cache, re-read whole thing.
  if (stat.size < cachedOffset) {
    cachedOffset = 0; cachedCost = 0; cachedSaved = 0;
    cachedInput = 0; cachedOutput = 0; cachedCacheRead = 0; cachedCreation = 0;
  }

  // No new bytes — short-circuit the I/O entirely.
  if (stat.size === cachedOffset) {
    return {
      cost: cachedCost, saved: cachedSaved,
      input: cachedInput, output: cachedOutput,
      cached: cachedCacheRead, creation: cachedCreation,
    };
  }

  let newCost = cachedCost;
  let newSaved = cachedSaved;
  let newInput = cachedInput;
  let newOutput = cachedOutput;
  let newCacheRead = cachedCacheRead;
  let newCreation = cachedCreation;
  let newOffset = cachedOffset;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const bytesToRead = stat.size - cachedOffset;
      const buf = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buf, 0, bytesToRead, cachedOffset);
      const lastNl = buf.lastIndexOf(0x0A);
      if (lastNl >= 0) {
        const text = buf.slice(0, lastNl).toString('utf8');
        for (const line of text.split('\n')) {
          if (!line) continue;
          try {
            const d = JSON.parse(line);
            const u = d && d.message && d.message.usage;
            if (u) {
              newCost += costFromUsage(u, prices);
              newSaved += savedFromUsage(u, prices);
              newInput += u.input_tokens || 0;
              newOutput += u.output_tokens || 0;
              newCacheRead += u.cache_read_input_tokens || 0;
              newCreation += u.cache_creation_input_tokens || 0;
            }
          } catch { /* invalid line — skip */ }
        }
        newOffset = cachedOffset + lastNl + 1;
      }
    } finally { fs.closeSync(fd); }
  } catch {
    return {
      cost: cachedCost, saved: cachedSaved,
      input: cachedInput, output: cachedOutput,
      cached: cachedCacheRead, creation: cachedCreation,
    };
  }

  try {
    fs.writeFileSync(cacheFile, JSON.stringify({
      offset: newOffset, cost: newCost, saved: newSaved,
      input: newInput, output: newOutput,
      cached: newCacheRead, creation: newCreation,
    }), 'utf8');
  } catch { /* best effort */ }

  return {
    cost: newCost, saved: newSaved,
    input: newInput, output: newOutput,
    cached: newCacheRead, creation: newCreation,
  };
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

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  const cfg = loadConfig();
  const C = makeColors(cfg.colors);
  const input = safeParse(readStdinSync());
  const sessionId = input.session_id || input.sessionId || process.env.CLAUDE_SESSION_ID || 'default';
  const cwd = input.cwd || input.workspace?.current_dir || process.cwd();

  // Prefer adaptive zones (derived from this repo's compact history) over
  // the static config zones so the bar color matches what si-suggest-compact
  // reports. Falls back to config zones when the history lib or file is
  // absent. Silent — failures never break rendering.
  try {
    const compactHistory = loadCompactHistoryLib();
    if (compactHistory && typeof compactHistory.adaptiveZones === 'function') {
      const history = typeof compactHistory.readHistory === 'function' ? compactHistory.readHistory() : [];
      const adaptive = compactHistory.adaptiveZones(history, cfg.zones, { bucket: 'cwd', cwd });
      if (adaptive && adaptive.adaptive) {
        cfg.zones = { yellow: adaptive.yellow, orange: adaptive.orange, red: adaptive.red };
      }
    }
  } catch { /* best effort — keep static zones on error */ }
  const transcriptPath = input.transcript_path || input.transcriptPath;

  // Token source resolution.
  let tokens = 0;
  let usedTranscript = false;
  let usage = null;
  if (cfg.tokenSource !== 'estimate') {
    usage = readTranscriptUsage(transcriptPath);
    const fromTranscript = totalTokensFromUsage(usage);
    if (fromTranscript > 0) {
      tokens = fromTranscript;
      usedTranscript = true;
    }
  }
  // Estimate tool count always; tokens fall through to estimate when transcript absent or disabled.
  const estimate = loadEstimate(sessionId);
  if (!usedTranscript && cfg.tokenSource !== 'transcript') {
    tokens = estimate.tokens;
  }

  // Session duration: prefer Claude Code's authoritative number on stdin
  // (input.cost.total_duration_ms) — it survives transcript rotation and
  // covers resumes correctly. Fall back to the earliest transcript timestamp
  // when the stdin number is absent or zero.
  let sessionDurationMs = 0;
  if (cfg.fields.includes('session')) {
    const officialMs = input.cost && typeof input.cost === 'object'
      ? Number(input.cost.total_duration_ms)
      : Number(input.total_duration_ms);
    if (Number.isFinite(officialMs) && officialMs > 0) {
      sessionDurationMs = officialMs;
    } else {
      const start = readSessionStartTime(transcriptPath);
      if (start) sessionDurationMs = Date.now() - start;
    }
  }

  // Cost — prefer Claude Code's authoritative number when it passes one on
  // stdin (input.cost.total_cost_usd), else fall back to a transcript-based
  // estimate using the user's configured prices. The authoritative number
  // reflects what Anthropic actually billed; the estimate is only correct if
  // the configured price list matches the current model's public pricing.
  //
  // cacheSaved is always transcript-derived — Claude Code doesn't expose a
  // "saved by cache" number on stdin, and the transcript pass is cheap (same
  // incremental offset cache as cost). Only computed when the field is
  // configured to avoid paying for the read when it's unused.
  let costUsd = 0;
  let cacheSavedUsd = 0;
  let tokenTotals = null;
  const wantCostSaved = cfg.fields.includes('costSaved');
  const wantCost = cfg.fields.includes('cost') || wantCostSaved;
  const wantCacheSaved = cfg.fields.includes('cacheSaved') || wantCostSaved;
  const wantTokenFlow = cfg.fields.includes('tokenFlow');
  if (wantCost || wantCacheSaved || wantTokenFlow) {
    const officialCost = input.cost && typeof input.cost === 'object'
      ? Number(input.cost.total_cost_usd)
      : Number(input.total_cost_usd);
    if (wantCost && Number.isFinite(officialCost) && officialCost > 0
        && !wantCacheSaved && !wantTokenFlow) {
      costUsd = officialCost;
    } else {
      tokenTotals = totalsFromTranscript(transcriptPath, sessionId, cfg.prices || DEFAULT_PRICES);
      costUsd = (wantCost && Number.isFinite(officialCost) && officialCost > 0)
        ? officialCost : tokenTotals.cost;
      cacheSavedUsd = tokenTotals.saved;
    }
  }

  const projectDir = resolveProjectDir(cwd);
  const staleHours = Number.isFinite(cfg.taskStaleHours) ? cfg.taskStaleHours : 12;
  const taskInfo = cfg.fields.includes('task')
    ? loadCurrentTask(projectDir, cwd, cfg.maxTaskLength || 40, staleHours)
    : { text: '', source: 'none' };

  // Thinking-token estimate — tail-scanned residual from the transcript.
  // Skipped entirely when the field isn't configured, so the extra 512 KB
  // read only runs for users who've opted into the `thinking` field.
  let thinking = { total: 0, turns: 0, recent: 0, lastTurnAgo: null };
  if (cfg.fields.includes('thinking')) {
    const lib = loadThinkingLib();
    if (lib && typeof lib.estimateThinkingTokens === 'function') {
      try { thinking = lib.estimateThinkingTokens(transcriptPath) || thinking; }
      catch { /* degrade silently */ }
    }
  }

  const ctx = {
    cfg,
    taskSource: taskInfo.source,
    tokens,
    tools: estimate.tools,
    task: taskInfo.text,
    sessionDurationMs,
    costUsd,
    cacheSavedUsd,
    tokenTotals,
    usedTranscript,
    usage,
    thinking,
  };

  const renderers = buildRenderers(C);
  const sep = `${C.graySep}${cfg.separator}${C.reset}`;

  // Split fields on 'newline' pseudo-field so users can lay out multi-line
  // status bars, e.g. fields: ['emoji','model','project','newline','branch','tokens','cost'].
  const groups = [[]];
  for (const name of cfg.fields) {
    if (name === 'newline') groups.push([]);
    else groups[groups.length - 1].push(name);
  }

  const renderGroup = (group) => {
    const rendered = group
      .map((name) => {
        const fn = renderers[name];
        if (!fn) return { name, text: '' };
        try { return { name, text: fn(input, ctx) || '' }; }
        catch { return { name, text: '' }; }
      })
      .filter((r) => r.text && r.text.length > 0);

    if (rendered.length === 0) return '';

    // Leading emoji (primary OR secondary) sits flush against the next field
    // with a single space, not a bullet separator.
    let leading = '';
    let rest = rendered;
    if (rendered[0].name === 'emoji' || rendered[0].name === 'emoji2') {
      leading = rendered[0].text + ' ';
      rest = rendered.slice(1);
    }
    return leading + rest.map((r) => r.text).join(sep);
  };

  // Render every configured group, INCLUDING empty ones. Dropping empty
  // groups makes the bar height fluctuate as fields pop in/out (task
  // populates, session crosses 1m, deploy breadcrumb ages past the window
  // etc.) — from the user's perspective the prompt above keeps moving up
  // and down. Reserving a blank row per configured group keeps the layout
  // append-only: once a line slot exists, it stays there for the session.
  const firstLineHasEmoji = groups.length > 0 && groups[0][0] === 'emoji';
  const indent = firstLineHasEmoji ? '   ' : '';
  const finalLines = groups.map((group, i) => {
    const rendered = renderGroup(group);
    if (i === 0) return rendered || 'claude';
    if (!rendered) return ' '; // reserve the row slot (whitespace is a visible line)
    const firstField = group[0];
    const leadsWithEmoji = firstField === 'emoji' || firstField === 'emoji2';
    return leadsWithEmoji ? rendered : indent + rendered;
  });

  process.stdout.write(finalLines.join('\n'));
}

try { main(); } catch { process.stdout.write('claude'); }
