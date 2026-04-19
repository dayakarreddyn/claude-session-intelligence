/**
 * Context Shape Tracker
 *
 * A cheap, append-only observer of where Claude's tool calls are *actually*
 * landing — which directories, which files, at what cumulative token cost.
 *
 * Stored as a JSONL file in the OS temp dir:
 *   /tmp/claude-ctx-shape-<sessionId>.jsonl
 *
 * Each line is a snapshot at the moment of a PostToolUse call:
 *   { t: 1714000000, tok: 155432, tool: "Read", root: "src/auth",
 *     file: "src/auth/login.ts", event: null }
 *
 * The file is size-bounded to MAX_ENTRIES lines so it never grows unbounded.
 *
 * The analyzer classifies rootDirs into HOT / WARM / COLD bands by the
 * fraction of the session they were last touched in — HOT dirs are the
 * current focus and should be preserved during compaction, COLD dirs are
 * abandoned tangents and should be dropped.
 *
 * A domain-shift check compares the first N rootDirs in the window with the
 * last N — low Jaccard overlap means the user pivoted (common "I finished
 * feature A, now working on feature B" pattern). Shift is what makes
 * compaction valuable AT ALL — without a shift the context is still live.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_MAX_ENTRIES = 200;
const MAX_ENTRIES_HARD_CEILING = 2000; // above this the byte cap kicks in first anyway
const MAX_ENTRIES_FLOOR = 50;
const MAX_BYTES_PER_ENTRY = 640; // ~empirical — covers typical entry with samples
const SHIFT_WINDOW = 10;
const SHIFT_JACCARD_THRESHOLD = 0.3;
const HOT_FRACTION = 0.2;   // last 20% of token-span → HOT
const WARM_FRACTION = 0.6;  // last 60% → WARM (else COLD)
const MIN_STALE_TO_MENTION = 20000; // don't cite stale bands smaller than this

// Score-based banding for scoring != 'recency'. Cutoffs are intentionally
// mirrors of (1 - HOT_FRACTION) / (1 - WARM_FRACTION) so 'recency' mode
// produces identical HOT/WARM/COLD splits as the legacy last-20% / last-60%
// rule. Changing HOT_FRACTION keeps both pathways aligned.
const HOT_SCORE_CUTOFF = 1 - HOT_FRACTION;   // 0.80
const WARM_SCORE_CUTOFF = 1 - WARM_FRACTION; // 0.40

// Hybrid scoring weights. Tilted toward recency because "what is Claude
// touching NOW" still dominates compaction priority; frequency just lifts
// long-term heavy-hitters (auth, billing, core modules) out of COLD/WARM
// when they aren't in the current 20% tail but have carried the session.
const HYBRID_RECENCY_WEIGHT = 0.6;
const HYBRID_FREQUENCY_WEIGHT = 0.4;

// Rollup caps. 100 roots handles even deep monorepos; above that we evict
// least-frequent. The rollup is an aggregate map (not an entry log), so
// byte growth is linear in unique rootDirs, not tool calls.
const ROLLUP_MAX_ROOTS = 100;
const ROLLUP_SAMPLE_LIMIT = 3;

// Minimal glob → regex. Supports:
//   **       — zero or more path segments (incl. empty)
//   *        — zero or more chars within a segment (no /)
//   ?        — single non-/ char
//   literals — quoted via regex escape
// Intentionally NOT a full minimatch — keeps the module dep-free. Patterns
// compile once per analyze call; cheap enough that caching is not worth
// the complexity.
function compileGlob(pattern) {
  if (typeof pattern !== 'string' || !pattern) return null;

  // Normalise trailing `/**` so `plans/**` matches `plans` itself and
  // anything beneath — otherwise pure recency-banded directory roots
  // (which store as the bare prefix) miss the allowlist.
  let p = pattern;
  let optionalTail = '';
  if (p.endsWith('/**')) {
    p = p.slice(0, -3);
    optionalTail = '(?:/.*)?';
  }

  let re = '^';
  let i = 0;
  while (i < p.length) {
    const ch = p[i];
    if (ch === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') { re += '(?:.*/)?'; i += 3; }
      else                  { re += '.*';        i += 2; }
    } else if (ch === '*') {
      re += '[^/]*'; i++;
    } else if (ch === '?') {
      re += '[^/]';  i++;
    } else if ('.+^$()|{}[]\\'.includes(ch)) {
      re += '\\' + ch; i++;
    } else {
      re += ch; i++;
    }
  }
  re += optionalTail + '$';
  try { return new RegExp(re); } catch { return null; }
}

function matchesAnyGlob(candidate, regexes) {
  if (!candidate || !regexes || regexes.length === 0) return false;
  for (const re of regexes) if (re && re.test(candidate)) return true;
  return false;
}

function compilePreserveGlobs(globs) {
  if (!Array.isArray(globs)) return [];
  return globs.map(compileGlob).filter(Boolean);
}

function shapeFilePath(sessionId) {
  const sid = String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
  return path.join(os.tmpdir(), `claude-ctx-shape-${sid}.jsonl`);
}

// Rollup is the session-scoped persistent tally that survives shape-file
// byte-cap truncation. Same sid normalization; sibling file in /tmp so it
// shares lifetime with the shape log (both die on OS /tmp rotation together,
// which is correct — restarting the session invalidates both).
function rollupFilePath(sessionId) {
  const sid = String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
  return path.join(os.tmpdir(), `claude-ctx-shape-${sid}.rollup.json`);
}

// Session state is the per-session anchor that survives subagent/worktree
// cwd drift. Written by si-bootstrap at SessionStart and refreshed by
// si-token-budget whenever it observes a non-home absolute cwd. Every later
// hook reads rootDirOf with this cwd instead of trusting per-call payloads,
// so entries like /Users/0xd/DWS/CSM/services/auth bucket to services/auth
// even when the PostToolUse payload arrives without a cwd field or with a
// subagent's worktree cwd that doesn't contain the file being read.
function sessionStatePath(sessionId) {
  const sid = String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
  return path.join(os.tmpdir(), `claude-ctx-shape-${sid}.session.json`);
}

// Markers we trust as "this is a project root". Ordered roughly by how
// unambiguous they are — .git is definitive; language manifests are nearly
// as good. If any of these sit in a directory, that directory is the root.
const PROJECT_ROOT_MARKERS = [
  '.git',          // any VCS'd repo — catches everything else
  'package.json',  // Node
  'pyproject.toml',// Python (PEP 518)
  'Cargo.toml',    // Rust
  'go.mod',        // Go modules
  'deno.json',     // Deno
  'pom.xml',       // Maven
  'build.gradle',  // Gradle
  'Gemfile',       // Ruby
];

// Directories we will not walk above — prevents projectRootOf from returning
// $HOME or /. Having `/Users/<name>/.git` for a dotfiles repo is the classic
// failure mode that would poison every shape entry.
function isSystemBoundary(dir) {
  if (!dir || dir === '/' || dir === '.') return true;
  if (dir === os.homedir()) return true;
  // /Users, /home, /root, /tmp, /var, /etc, /usr, /opt — top-level system dirs.
  const parts = dir.split('/').filter(Boolean);
  if (parts.length <= 1) return true;
  return false;
}

// Memoized per-directory cache for projectRootOf. Process-scoped, which is
// fine for hook invocations (each hook is a short-lived subprocess). For
// long-running callers (tests) the cache is bounded by unique directories
// seen; soft-capped to avoid unbounded growth in pathological workloads.
const _projectRootCache = new Map();
const PROJECT_ROOT_CACHE_CAP = 2048;

function cacheProjectRoot(dir, value) {
  if (_projectRootCache.size >= PROJECT_ROOT_CACHE_CAP) {
    // Drop the oldest entry — Map preserves insertion order.
    const firstKey = _projectRootCache.keys().next().value;
    if (firstKey !== undefined) _projectRootCache.delete(firstKey);
  }
  _projectRootCache.set(dir, value);
  return value;
}

/**
 * Walk up from filePath looking for a project-root marker. Returns the
 * discovered root path, or null when no marker is found before the system
 * boundary. Memoized per directory so repeated lookups on files in the same
 * tree do one fs.existsSync per new level only.
 *
 * Works independently of cwd — this is the fallback that keeps shape
 * classification stable when si-token-budget's cwd resolution fails (missing
 * payload.cwd, subagent worktree cwd, etc).
 *
 * @param {string} filePath — absolute path to a file (or any dir under the root)
 * @returns {string|null}
 */
function projectRootOf(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  const norm = filePath.replace(/\\/g, '/').trim();
  if (!norm.startsWith('/')) return null;

  let dir;
  try {
    const stat = fs.statSync(norm);
    dir = stat.isDirectory() ? norm : path.dirname(norm);
  } catch {
    // File may have been deleted since the tool call — walk from its parent.
    dir = path.dirname(norm);
  }

  // Collect the chain so one discovery caches for every ancestor.
  const chain = [];
  while (dir && !isSystemBoundary(dir)) {
    if (_projectRootCache.has(dir)) {
      const hit = _projectRootCache.get(dir);
      for (const d of chain) cacheProjectRoot(d, hit);
      return hit;
    }
    for (const marker of PROJECT_ROOT_MARKERS) {
      try {
        if (fs.existsSync(path.join(dir, marker))) {
          for (const d of chain) cacheProjectRoot(d, dir);
          cacheProjectRoot(dir, dir);
          return dir;
        }
      } catch { /* permission denied — keep walking */ }
    }
    chain.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const d of chain) cacheProjectRoot(d, null);
  return null;
}

/** Test-only. Clear the projectRootOf memoization cache. */
function _resetProjectRootCache() { _projectRootCache.clear(); }

/**
 * Read the session-state file. Returns an empty object on missing / malformed.
 * Shape: { cwd, sessionId, projectRoot, startedAt, lastPayloadCwd }
 */
function readSessionState(sessionId) {
  if (!sessionId) return {};
  try {
    const data = JSON.parse(fs.readFileSync(sessionStatePath(sessionId), 'utf8'));
    if (!data || typeof data !== 'object') return {};
    return data;
  } catch { return {}; }
}

/**
 * Write the session-state file atomically via tempfile + rename. Atomic
 * against concurrent readers — a half-written session-state.json would be
 * worse than none since resolveSessionCwd trusts the first thing it reads.
 */
function writeSessionState(sessionId, data) {
  if (!sessionId || !data || typeof data !== 'object') return;
  const file = sessionStatePath(sessionId);
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* tmp may not exist */ }
  }
}

/**
 * Resolve the best available cwd anchor for rootDirOf. Priority chain:
 *
 *   1. Session state (captured at SessionStart, survives subagent cwd drift)
 *   2. Payload cwd (current PostToolUse call's reported cwd)
 *   3. projectRootOf walk-up from filePath (works even for cross-repo reads)
 *   4. process.cwd() fallback
 *
 * Returns { cwd, source } where source is one of
 * 'session' | 'payload' | 'projectRoot' | 'processCwd' | 'none'. Never
 * returns an empty cwd — at minimum process.cwd() is reported.
 *
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} [opts.payloadCwd]
 * @param {string} [opts.filePath]
 */
function resolveSessionCwd(opts) {
  const { sessionId, payloadCwd, filePath } = opts || {};
  const state = readSessionState(sessionId);
  if (state && typeof state.cwd === 'string' && state.cwd.startsWith('/')) {
    return { cwd: state.cwd, source: 'session' };
  }
  if (typeof payloadCwd === 'string' && payloadCwd.startsWith('/')) {
    return { cwd: payloadCwd, source: 'payload' };
  }
  if (filePath) {
    const root = projectRootOf(filePath);
    if (root) return { cwd: root, source: 'projectRoot' };
  }
  return { cwd: process.cwd(), source: 'processCwd' };
}

/**
 * Reduce an arbitrary file path to a stable "rootDir" signature.
 *
 * Examples at depth=2 (default):
 *   src/auth/login.ts        -> src/auth
 *   tests/browser/spec.ts    -> tests/browser
 *   README.md                -> .
 *   /tmp/foo/bar             -> /tmp/foo
 *
 * Examples at depth=3 (monorepos with packages/*):
 *   packages/core/src/auth/login.ts -> packages/core/src
 *
 * When `opts.cwd` is provided and `filePath` is absolute under `cwd`, the
 * cwd prefix is stripped first so depth-bucketing counts from the project
 * root instead of burning two segments on `/Users/<name>/`. Without this,
 * every file in `/Users/<name>/DWS/REPO/src/auth/...` collapses to
 * `/Users/<name>` at depth=2 — useless for regret detection.
 *
 * Examples with cwd=/Users/alex/DWS/CSM, depth=2:
 *   /Users/alex/DWS/CSM/frontend/dashboard/App.tsx -> frontend/dashboard
 *   /Users/alex/DWS/CSM/backend/api/auth.go        -> backend/api
 *   /tmp/foo/bar (outside cwd)                     -> /tmp/foo
 *
 * depth is clamped to [1, 5]. Invalid / missing → defaults to 2. Going
 * deeper than 3 fragments directories that should cluster (each test file
 * in its own "root" defeats the point); going shallower collapses features
 * into the same root (src/auth and src/billing both become `src`).
 */
function rootDirOf(filePath, depth, opts) {
  if (!filePath || typeof filePath !== 'string') return '';
  let norm = filePath.replace(/\\/g, '/').trim();
  if (!norm) return '';

  let d = Number.isFinite(depth) ? Math.floor(depth) : 2;
  if (d < 1) d = 1;
  if (d > 5) d = 5;

  // Strip cwd prefix when the path is under it, so depth counts from the
  // project root. Only kicks in for absolute paths with a provided cwd;
  // plain-relative paths and out-of-cwd paths fall through unchanged.
  const cwd = opts && typeof opts.cwd === 'string' ? opts.cwd.replace(/\\/g, '/').replace(/\/+$/, '') : '';
  let isAbs = norm.startsWith('/');
  if (isAbs && cwd && cwd.startsWith('/')) {
    // Exact match (file is at cwd) or prefix with path separator to avoid
    // /Users/alex/DWS/CSMX matching cwd=/Users/alex/DWS/CSM.
    if (norm === cwd) return '.';
    if (norm.startsWith(cwd + '/')) {
      norm = norm.slice(cwd.length + 1);
      isAbs = false;
    }
  }

  const parts = norm.split('/').filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return isAbs ? `/${parts[0]}` : '.';

  const effective = Math.min(d, parts.length);
  const root = parts.slice(0, effective).join('/');
  return isAbs ? `/${root}` : root;
}

function clampMaxEntries(n) {
  if (!Number.isFinite(n)) return DEFAULT_MAX_ENTRIES;
  const floored = Math.max(MAX_ENTRIES_FLOOR, Math.floor(n));
  return Math.min(MAX_ENTRIES_HARD_CEILING, floored);
}

/**
 * Append one observation entry. Truncates to `maxEntries` (default 200,
 * clamped to [50, 2000]) when the file grows past the derived byte cap.
 * Best-effort: failures never propagate.
 *
 * @param {string} sessionId
 * @param {object} entry
 * @param {{ maxEntries?: number }} [opts]
 */
function appendShape(sessionId, entry, opts) {
  if (!sessionId || !entry) return;
  const maxEntries = clampMaxEntries(opts && opts.maxEntries);
  const maxBytes = maxEntries * MAX_BYTES_PER_ENTRY;
  const file = shapeFilePath(sessionId);
  const line = JSON.stringify(entry) + '\n';
  try {
    fs.appendFileSync(file, line);
    const stat = fs.statSync(file);
    if (stat.size > maxBytes) {
      const buf = fs.readFileSync(file, 'utf8');
      const lines = buf.split('\n').filter(Boolean);
      if (lines.length > maxEntries) {
        fs.writeFileSync(file, lines.slice(-maxEntries).join('\n') + '\n');
      }
    }
  } catch { /* best effort — tracker must not break the hook */ }
}

/** Read the last `limit` entries. Returns [] when missing / unreadable. */
function readShape(sessionId, limit) {
  if (!sessionId) return [];
  const cap = Number.isFinite(limit) ? clampMaxEntries(limit) : MAX_ENTRIES_HARD_CEILING;
  const file = shapeFilePath(sessionId);
  try {
    const buf = fs.readFileSync(file, 'utf8');
    const lines = buf.split('\n').filter(Boolean);
    return lines
      .slice(-cap)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function normalizeScoring(v) {
  if (v === 'recency' || v === 'frequency' || v === 'hybrid') return v;
  return 'hybrid';
}

function combineScore(recency, freq, mode) {
  if (mode === 'recency') return recency;
  if (mode === 'frequency') return freq;
  return HYBRID_RECENCY_WEIGHT * recency + HYBRID_FREQUENCY_WEIGHT * freq;
}

/** Read the rollup file. Returns null on missing / malformed. */
function readRollup(sessionId) {
  if (!sessionId) return null;
  try {
    const data = JSON.parse(fs.readFileSync(rollupFilePath(sessionId), 'utf8'));
    if (!data || typeof data !== 'object') return null;
    // Defensive: guarantee callers never hit undefined roots.
    if (!data.roots || typeof data.roots !== 'object') data.roots = {};
    if (!Number.isFinite(data.rolledThroughTok)) data.rolledThroughTok = 0;
    return data;
  } catch { return null; }
}

function writeRollup(sessionId, data) {
  if (!sessionId || !data) return;
  try { fs.writeFileSync(rollupFilePath(sessionId), JSON.stringify(data)); }
  catch { /* best effort — tracker must not break the hook */ }
}

/**
 * Merge the current shape log into the persistent rollup. Call after
 * analyzeShape in pre-compact so this session's per-root tallies survive
 * shape-file truncation and feed the NEXT compact's classification.
 *
 * Idempotent via `rolledThroughTok`: entries older than the last rolled
 * token position are skipped. Evicts least-frequent roots when the rollup
 * exceeds ROLLUP_MAX_ROOTS (scoped per session so this is a soft cap).
 *
 * When `opts.canonicalCwd` is provided, entries are rebucketed through
 * rootDirOf with that cwd before merging. Ensures the persisted rollup
 * stays consistent with the session's true project root even when some
 * entries were written with a bad cwd (legacy or subagent drift).
 *
 * Returns the updated rollup object (or null on missing sessionId).
 */
function rollupShape(sessionId, opts) {
  if (!sessionId) return null;
  const rawEntries = readShape(sessionId);
  const canonicalCwd = opts && typeof opts.canonicalCwd === 'string' ? opts.canonicalCwd : '';
  const depth = Number.isFinite(opts && opts.rootDirDepth) ? opts.rootDirDepth : 2;
  const entries = canonicalCwd
    ? reclassifyEntries(rawEntries, { cwd: canonicalCwd, depth })
    : rawEntries;
  const rollup = readRollup(sessionId) || { rolledThroughTok: 0, roots: {} };
  const threshold = rollup.rolledThroughTok || 0;
  let maxTok = threshold;

  for (const e of entries) {
    if (!e || !e.root || !Number.isFinite(e.tok)) continue;
    if (e.tok <= threshold) continue;
    if (e.tok > maxTok) maxTok = e.tok;

    const cur = rollup.roots[e.root] || {
      count: 0, first: e.tok, last: e.tok, samples: [], allowlisted: false,
    };
    cur.count += 1;
    cur.first = Math.min(cur.first, e.tok);
    cur.last = Math.max(cur.last, e.tok);
    if (cur.samples.length < ROLLUP_SAMPLE_LIMIT && e.file && !cur.samples.includes(e.file)) {
      cur.samples.push(e.file);
    }
    rollup.roots[e.root] = cur;
  }

  // Evict when over cap — keep highest-count, tiebreak on most-recent.
  const keys = Object.keys(rollup.roots);
  if (keys.length > ROLLUP_MAX_ROOTS) {
    const kept = keys
      .map((k) => ({ k, c: rollup.roots[k].count, l: rollup.roots[k].last }))
      .sort((a, b) => (b.c - a.c) || (b.l - a.l))
      .slice(0, ROLLUP_MAX_ROOTS);
    const next = {};
    for (const { k } of kept) next[k] = rollup.roots[k];
    rollup.roots = next;
  }

  rollup.rolledThroughTok = maxTok;
  rollup.updatedAt = Date.now();
  writeRollup(sessionId, rollup);
  return rollup;
}

/**
 * Rebucket each entry's `root` by re-running rootDirOf against a canonical
 * cwd (and falling back to projectRootOf when the file sits outside it).
 * Heals entries written when the PostToolUse hook had no usable cwd — those
 * land with root=/Users/<name> and would otherwise remain a useless blob on
 * every subsequent analyze pass.
 *
 * Pure: returns new entry objects; never mutates the input array.
 *
 * @param {Array} entries
 * @param {{ cwd: string, depth?: number }} opts
 */
function reclassifyEntries(entries, opts) {
  if (!Array.isArray(entries)) return [];
  const cwd = opts && typeof opts.cwd === 'string' ? opts.cwd : '';
  if (!cwd.startsWith('/')) return entries;
  const depth = Number.isFinite(opts && opts.depth) ? opts.depth : 2;

  return entries.map((e) => {
    if (!e || !e.file) return e;
    const file = String(e.file);
    if (!file.startsWith('/')) return e;
    let next = rootDirOf(file, depth, { cwd });
    // File outside session cwd — fall back to its own project root so a
    // cross-repo Read still classifies somewhere useful.
    if (next && /^\/Users\/[^/]+$/.test(next)) {
      const pr = projectRootOf(file);
      if (pr && pr !== cwd) {
        const alt = rootDirOf(file, depth, { cwd: pr });
        if (alt && !/^\/Users\/[^/]+$/.test(alt)) next = alt;
      }
    }
    if (!next || next === e.root) return e;
    return { ...e, root: next };
  });
}

/**
 * Classify observation history into HOT / WARM / COLD bands and detect a
 * domain shift. Returns `null` when there isn't enough signal to bother.
 *
 * @param {Array} entries — output of readShape()
 * @param {{ preserveGlobs?: string[], scoring?: 'recency'|'frequency'|'hybrid',
 *           persistAcrossCompacts?: boolean, sessionId?: string,
 *           canonicalCwd?: string, rootDirDepth?: number }} [opts]
 *
 *   - preserveGlobs: user-configured allowlist. Any root or any of its
 *     sample files matching one of these globs force-promotes the root to
 *     HOT (tagged `allowlisted: true`), regardless of score banding.
 *   - scoring: 'recency' (legacy: last touch within top 20% of span → HOT),
 *     'frequency' (log-normalized call count), or 'hybrid' (default,
 *     weighted combination). Hybrid lifts long-running heavy-hitters that
 *     pure recency misclassifies as COLD the moment they're quiet.
 *   - persistAcrossCompacts + sessionId: when both present, merge the
 *     session's persistent rollup into the roots map so history across
 *     compacts influences banding. Requires sessionId so the rollup file
 *     can be located.
 *   - canonicalCwd: when provided, every entry's root is re-derived using
 *     rootDirOf(file, depth, {cwd: canonicalCwd}) before banding. Heals
 *     legacy entries that landed with root=/Users/<name> because the hook
 *     ran without a usable cwd.
 *   - warmScoreCutoff: override the default WARM_SCORE_CUTOFF (0.40).
 *     Raising it narrows the WARM band toward HOT so mid-recency dirs fall
 *     to COLD/DROP instead — useful for per-project tuning when WARM is
 *     producing no signal. Clamped to (0, HOT_SCORE_CUTOFF).
 */
function analyzeShape(entries, opts) {
  if (!Array.isArray(entries) || entries.length < 5) return null;

  const canonicalCwd = opts && typeof opts.canonicalCwd === 'string' ? opts.canonicalCwd : '';
  const depth = Number.isFinite(opts && opts.rootDirDepth) ? opts.rootDirDepth : 2;
  const working = canonicalCwd
    ? reclassifyEntries(entries, { cwd: canonicalCwd, depth })
    : entries;

  // Only entries with a usable rootDir contribute to banding.
  const withRoot = working.filter((e) => e && e.root);
  if (withRoot.length < 5) return null;

  const firstTok = withRoot[0].tok || 0;
  const lastTok = withRoot[withRoot.length - 1].tok || firstTok;
  const span = lastTok - firstTok;
  if (span <= 0) return null;

  const preserveRegexes = compilePreserveGlobs(opts && opts.preserveGlobs);
  const scoring = normalizeScoring(opts && opts.scoring);
  const persist = !!(opts && opts.persistAcrossCompacts && opts.sessionId);
  const sessionId = persist ? opts.sessionId : null;

  // Per-project WARM cutoff override. Clamped to (0, HOT_SCORE_CUTOFF) so a
  // misconfigured value can never swallow HOT or produce a negative band.
  const rawWarmCutoff = opts && opts.warmScoreCutoff;
  const warmCutoff = Number.isFinite(rawWarmCutoff)
    ? Math.min(HOT_SCORE_CUTOFF - 0.001, Math.max(0.01, rawWarmCutoff))
    : WARM_SCORE_CUTOFF;

  // Rollup snapshot read once; its rolledThroughTok tells us which live
  // entries are already counted in rollup (skip them to prevent double-count).
  const rollup = persist ? readRollup(sessionId) : null;
  const rolledThroughTok = rollup ? (rollup.rolledThroughTok || 0) : 0;

  // Aggregate per rootDir: first/last token-offset, count, sample file paths.
  const roots = new Map();
  for (const e of withRoot) {
    if (persist && e.tok <= rolledThroughTok) continue;

    const cur = roots.get(e.root) || {
      root: e.root, first: e.tok, last: e.tok, count: 0, samples: [],
      allowlisted: false,
    };
    cur.first = Math.min(cur.first, e.tok);
    cur.last  = Math.max(cur.last, e.tok);
    cur.count += 1;
    if (cur.samples.length < 3 && e.file && !cur.samples.includes(e.file)) {
      cur.samples.push(e.file);
    }
    // Allowlist check — match either the root itself or any file under it.
    // Idempotent: once set, no need to recompute.
    if (!cur.allowlisted && preserveRegexes.length) {
      if (matchesAnyGlob(e.root, preserveRegexes)
          || (e.file && matchesAnyGlob(e.file, preserveRegexes))) {
        cur.allowlisted = true;
      }
    }
    roots.set(e.root, cur);
  }

  // Merge rollup history into the roots map. Roots that appear only in
  // rollup (no current-session touches) still get classified — their
  // recency will be low so frequency/hybrid is what surfaces them.
  if (rollup && rollup.roots) {
    for (const [root, info] of Object.entries(rollup.roots)) {
      if (!info || !Number.isFinite(info.count)) continue;
      const cur = roots.get(root) || {
        root,
        first: Number.isFinite(info.first) ? info.first : firstTok,
        last: Number.isFinite(info.last) ? info.last : firstTok,
        count: 0,
        samples: [],
        allowlisted: !!info.allowlisted,
      };
      if (Number.isFinite(info.first)) cur.first = Math.min(cur.first, info.first);
      if (Number.isFinite(info.last))  cur.last  = Math.max(cur.last, info.last);
      cur.count += info.count;
      for (const s of (Array.isArray(info.samples) ? info.samples : [])) {
        if (cur.samples.length < 3 && !cur.samples.includes(s)) cur.samples.push(s);
      }
      cur.allowlisted = cur.allowlisted || !!info.allowlisted;
      // Re-check preserveGlobs against rollup-only roots too.
      if (!cur.allowlisted && preserveRegexes.length && matchesAnyGlob(root, preserveRegexes)) {
        cur.allowlisted = true;
      }
      roots.set(root, cur);
    }
  }

  // Score every root. recencyScore normalizes last-touch position within
  // the session's live span (rollup-only roots land near 0 here — they're
  // old). freqScore is log-normalized against the winning count so a root
  // with 100 calls doesn't drown out one with 20 (both score high).
  const rootsArr = [...roots.values()];
  let maxCount = 0;
  for (const r of rootsArr) if (r.count > maxCount) maxCount = r.count;
  const logMax = Math.log1p(maxCount);

  for (const r of rootsArr) {
    const recencyScore = span > 0
      ? Math.max(0, Math.min(1, (r.last - firstTok) / span))
      : 1;
    const freqScore = logMax > 0 ? Math.log1p(r.count) / logMax : 0;
    r.recencyScore = Number(recencyScore.toFixed(3));
    r.freqScore = Number(freqScore.toFixed(3));
    r.score = Number(combineScore(recencyScore, freqScore, scoring).toFixed(3));
  }

  const hot = [], warm = [], cold = [];
  for (const info of rootsArr) {
    if (info.allowlisted)                     hot.push(info);
    else if (info.score >= HOT_SCORE_CUTOFF)  hot.push(info);
    else if (info.score >= warmCutoff)        warm.push(info);
    else                                      cold.push(info);
  }

  // Sort within each band by score desc, tiebreak on most-recent.
  const byScoreDesc = (a, b) => (b.score - a.score) || (b.last - a.last);
  hot.sort(byScoreDesc);
  warm.sort(byScoreDesc);
  cold.sort(byScoreDesc);

  // Domain shift — Jaccard of rootDir sets at the two ends of the window.
  // Requires withRoot.length >= 2 * SHIFT_WINDOW so head and tail don't
  // overlap; on smaller sessions an overlapping slice trivially produces
  // jaccard=1 and masks real pivots. Sub-threshold sessions report `null`
  // shift rather than a misleading "no shift" signal.
  let shift = null;
  if (withRoot.length >= 2 * SHIFT_WINDOW) {
    const head = new Set(withRoot.slice(0, SHIFT_WINDOW).map((e) => e.root));
    const tail = new Set(withRoot.slice(-SHIFT_WINDOW).map((e) => e.root));
    const inter = [...head].filter((r) => tail.has(r));
    const uni = new Set([...head, ...tail]);
    const jaccard = uni.size > 0 ? inter.length / uni.size : 1;
    if (jaccard < SHIFT_JACCARD_THRESHOLD) {
      shift = {
        from: [...head].filter((r) => !tail.has(r)).slice(0, 3),
        to: [...tail].filter((r) => !head.has(r)).slice(0, 3),
        jaccard: Number(jaccard.toFixed(2)),
      };
    }
  }

  // Rough "stale tokens" estimate = fraction of calls landing in COLD dirs.
  const totalCalls = withRoot.length;
  const coldCalls = cold.reduce((s, c) => s + c.count, 0);
  const staleTokens = Math.floor(span * coldCalls / totalCalls);

  // Phase-break events (git commit / push / PR) in the observation window —
  // these are strong "safe to snapshot here" markers for compaction.
  const events = entries
    .filter((e) => e && e.event)
    .slice(-5)
    .map((e) => ({ event: e.event, tok: e.tok }));

  return {
    hot: hot.slice(0, 5),
    warm: warm.slice(0, 5),
    cold: cold.slice(0, 5),
    shift,
    staleTokens,
    totalSpan: span,
    totalCalls,
    events,
  };
}

/**
 * Short one-liner suitable for stderr in si-suggest-compact.js. Designed to
 * ride under the existing "ORANGE ZONE (315k)" zone header, so it should
 * read like a diagnosis, not a second alert.
 *
 * Returns '' when analysis is null or boring (nothing useful to add).
 */
function draftMessage(analysis) {
  if (!analysis) return '';
  const parts = [];
  if (analysis.shift) {
    const from = analysis.shift.from.join(',') || '(earlier context)';
    const to = analysis.shift.to.join(',') || '(current)';
    parts.push(`shifted ${from} \u2192 ${to}`);
  }
  if (analysis.cold.length && analysis.staleTokens >= MIN_STALE_TO_MENTION) {
    const dirs = analysis.cold.slice(0, 3).map((c) => c.root).join(', ');
    parts.push(`~${Math.round(analysis.staleTokens / 1000)}k stale in ${dirs}`);
  }
  if (analysis.hot.length) {
    const dirs = analysis.hot.slice(0, 3).map((h) => h.root).join(', ');
    parts.push(`hot: ${dirs}`);
  }
  return parts.join(' \u00b7 ');
}

/**
 * Structured hints for si-pre-compact.js to inject into the compaction prompt.
 * This is what gets baked into the model's compaction instructions — so
 * wording here goes straight into Claude Code's compaction pipeline.
 */
function formatCompactInjection(analysis, opts = {}) {
  if (!analysis) return '';

  // `stablePrefix` trades detail for cache-hit stability. This block
  // becomes part of the post-compact prefix; any per-compact-volatile
  // token (counts, stale-token estimates, Jaccard, phase-marker token
  // positions) forces a cache miss every time the user re-compacts the
  // same project. Stable mode emits only the names that survive across
  // compacts of the same working set.
  const stable = !!opts.stablePrefix;

  // Plain markdown headings — render cleanly on both the CLI terminal and
  // the Claude mobile client. The earlier 50×━ divider bars wrapped to
  // multiple lines on narrow screens and leaked ANSI dim codes as visible
  // "[2m"/"[22m" text, so we drop bars and rely on ## headings + single
  // blank lines for structure.
  const lines = [''];
  lines.push('## OBSERVED CONTEXT SHAPE (auto-generated from tool usage)');

  if (analysis.shift) {
    const from = analysis.shift.from.join(', ') || '(earlier context)';
    const to = analysis.shift.to.join(', ') || '(current)';
    const jac = stable ? '' : ` (Jaccard ${analysis.shift.jaccard})`;
    lines.push('');
    lines.push(`**Domain shift:** ${from} \u2192 ${to}${jac}`);
  }

  if (analysis.hot.length) {
    lines.push('');
    lines.push('**Preserve** (recently active, still in use):');
    for (const h of analysis.hot) {
      const files = h.samples.length ? ` \u2014 e.g. ${h.samples.slice(0, 2).join(', ')}` : '';
      const tag = h.allowlisted ? ' [allowlisted]' : '';
      const count = stable ? '' : ` (${h.count} calls)`;
      lines.push(`- ${h.root}${count}${tag}${files}`);
    }
  }

  if (analysis.cold.length && analysis.staleTokens >= MIN_STALE_TO_MENTION) {
    lines.push('');
    const header = stable
      ? '**Safe to drop:**'
      : `**Safe to drop** (~${Math.round(analysis.staleTokens / 1000)}k stale tokens):`;
    lines.push(header);
    for (const c of analysis.cold) {
      const files = c.samples.length ? ` \u2014 e.g. ${c.samples.slice(0, 2).join(', ')}` : '';
      const count = stable ? '' : ` (${c.count} calls earlier)`;
      lines.push(`- ${c.root}${count}${files}`);
    }
    lines.push('');
    lines.push('Keep only one-line summaries in the DROP section \u2014 detail is no longer load-bearing.');
  }

  if (analysis.events && analysis.events.length) {
    lines.push('');
    lines.push('**Phase markers:**');
    for (const ev of analysis.events) {
      const at = stable ? '' : ` at ~${Math.round((ev.tok || 0) / 1000)}k tokens`;
      lines.push(`- ${ev.event}${at}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

module.exports = {
  rootDirOf,
  appendShape,
  readShape,
  analyzeShape,
  draftMessage,
  formatCompactInjection,
  shapeFilePath, // exported for tests / cleanup
  rollupFilePath, // exported for tests / cleanup
  rollupShape,    // exported for pre-compact hook
  readRollup,     // exported for tests
  compileGlob,    // exported for tests
  projectRootOf,
  sessionStatePath,
  readSessionState,
  writeSessionState,
  resolveSessionCwd,
  _resetProjectRootCache, // test-only
  _thresholds: {
    HOT_FRACTION, WARM_FRACTION, SHIFT_JACCARD_THRESHOLD, MIN_STALE_TO_MENTION,
    DEFAULT_MAX_ENTRIES, MAX_ENTRIES_FLOOR, MAX_ENTRIES_HARD_CEILING,
    HOT_SCORE_CUTOFF, WARM_SCORE_CUTOFF,
    HYBRID_RECENCY_WEIGHT, HYBRID_FREQUENCY_WEIGHT,
    ROLLUP_MAX_ROOTS,
    PROJECT_ROOT_MARKERS,
  },
};
