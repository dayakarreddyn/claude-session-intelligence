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
 * depth is clamped to [1, 5]. Invalid / missing → defaults to 2. Going
 * deeper than 3 fragments directories that should cluster (each test file
 * in its own "root" defeats the point); going shallower collapses features
 * into the same root (src/auth and src/billing both become `src`).
 */
function rootDirOf(filePath, depth) {
  if (!filePath || typeof filePath !== 'string') return '';
  const norm = filePath.replace(/\\/g, '/').trim();
  if (!norm) return '';

  let d = Number.isFinite(depth) ? Math.floor(depth) : 2;
  if (d < 1) d = 1;
  if (d > 5) d = 5;

  const isAbs = norm.startsWith('/');
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

/**
 * Classify observation history into HOT / WARM / COLD bands and detect a
 * domain shift. Returns `null` when there isn't enough signal to bother.
 *
 * @param {Array} entries — output of readShape()
 * @param {{ preserveGlobs?: string[] }} [opts] — user-configured
 *   allowlist. Any root or any of its sample files matching one of these
 *   globs force-promotes the root to HOT (tagged `allowlisted: true`),
 *   regardless of recency banding. Intended for planning/docs/task dirs
 *   that get read heavily early and sit idle thereafter.
 */
function analyzeShape(entries, opts) {
  if (!Array.isArray(entries) || entries.length < 5) return null;

  // Only entries with a usable rootDir contribute to banding.
  const withRoot = entries.filter((e) => e && e.root);
  if (withRoot.length < 5) return null;

  const firstTok = withRoot[0].tok || 0;
  const lastTok = withRoot[withRoot.length - 1].tok || firstTok;
  const span = lastTok - firstTok;
  if (span <= 0) return null;

  const hotCutoff  = lastTok - span * HOT_FRACTION;
  const warmCutoff = lastTok - span * WARM_FRACTION;

  const preserveRegexes = compilePreserveGlobs(opts && opts.preserveGlobs);

  // Aggregate per rootDir: first/last token-offset, count, sample file paths.
  const roots = new Map();
  for (const e of withRoot) {
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

  const hot = [], warm = [], cold = [];
  for (const info of roots.values()) {
    if (info.allowlisted)              hot.push(info);
    else if (info.last >= hotCutoff)   hot.push(info);
    else if (info.last >= warmCutoff)  warm.push(info);
    else                               cold.push(info);
  }

  // Sort within each band, most-recent-touched first.
  const byLastDesc = (a, b) => b.last - a.last;
  hot.sort(byLastDesc);
  warm.sort(byLastDesc);
  cold.sort(byLastDesc);

  // Domain shift — Jaccard of rootDir sets at the two ends of the window.
  const head = new Set(withRoot.slice(0, SHIFT_WINDOW).map((e) => e.root));
  const tail = new Set(withRoot.slice(-SHIFT_WINDOW).map((e) => e.root));
  const inter = [...head].filter((r) => tail.has(r));
  const uni = new Set([...head, ...tail]);
  const jaccard = uni.size > 0 ? inter.length / uni.size : 1;
  const shift = jaccard < SHIFT_JACCARD_THRESHOLD
    ? {
        from: [...head].filter((r) => !tail.has(r)).slice(0, 3),
        to: [...tail].filter((r) => !head.has(r)).slice(0, 3),
        jaccard: Number(jaccard.toFixed(2)),
      }
    : null;

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
function formatCompactInjection(analysis) {
  if (!analysis) return '';

  const lines = [];
  lines.push('');
  lines.push('OBSERVED CONTEXT SHAPE (auto-generated from tool usage):');
  lines.push('\u2501'.repeat(50));

  if (analysis.shift) {
    const from = analysis.shift.from.join(', ') || '(earlier context)';
    const to = analysis.shift.to.join(', ') || '(current)';
    lines.push('');
    lines.push(`DOMAIN SHIFT DETECTED: ${from} \u2192 ${to}`);
    lines.push(`(Jaccard overlap ${analysis.shift.jaccard} across recent tool calls)`);
  }

  if (analysis.hot.length) {
    lines.push('');
    lines.push('PRESERVE (recently active, still in use):');
    for (const h of analysis.hot) {
      const files = h.samples.length ? ` — e.g. ${h.samples.slice(0, 2).join(', ')}` : '';
      const tag = h.allowlisted ? ' [allowlisted]' : '';
      lines.push(`  - ${h.root} (${h.count} calls)${tag}${files}`);
    }
  }

  if (analysis.cold.length && analysis.staleTokens >= MIN_STALE_TO_MENTION) {
    lines.push('');
    lines.push(`SAFE TO DROP (untouched for most of the session, ~${Math.round(analysis.staleTokens / 1000)}k tokens):`);
    for (const c of analysis.cold) {
      const files = c.samples.length ? ` — e.g. ${c.samples.slice(0, 2).join(', ')}` : '';
      lines.push(`  - ${c.root} (${c.count} calls earlier)${files}`);
    }
    lines.push('');
    lines.push('Keep only one-line summaries of what happened in the DROP section — the detail is no longer load-bearing.');
  }

  if (analysis.events && analysis.events.length) {
    lines.push('');
    lines.push('PHASE MARKERS OBSERVED:');
    for (const ev of analysis.events) {
      lines.push(`  - ${ev.event} at ~${Math.round((ev.tok || 0) / 1000)}k tokens`);
    }
  }

  lines.push('');
  lines.push('\u2501'.repeat(50));
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
  compileGlob,   // exported for tests
  _thresholds: {
    HOT_FRACTION, WARM_FRACTION, SHIFT_JACCARD_THRESHOLD, MIN_STALE_TO_MENTION,
    DEFAULT_MAX_ENTRIES, MAX_ENTRIES_FLOOR, MAX_ENTRIES_HARD_CEILING,
  },
};
