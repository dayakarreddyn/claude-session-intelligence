'use strict';

// Pure formatting helpers: colours, token/USD/duration formatting, truncation, usage cell.

const fs = require('fs');
const path = require('path');

// Render a usage cell as `<label>:<pct>% · <reset-in duration>`.
// colourMode: 'zone' escalates green→yellow→orange→red at 60/85/95 so a
// soon-to-exhaust quota reads at a glance (weekly, where the signal is
// load-bearing). 'dim' keeps the cell muted to match the rest of the row
// (5h block, where the percent matters less than the countdown).
function _renderUsageCellImpl(label, pctRaw, resetAt, C, colourMode = 'zone', stale = false) {
  if (typeof pctRaw !== 'number' || !Number.isFinite(pctRaw)) return '';
  const pct = Math.round(pctRaw);
  let resetStr = '';
  if (resetAt) {
    const ms = resetAtMs(resetAt) - Date.now();
    if (Number.isFinite(ms) && ms > 0) resetStr = fmtDurationTight(ms);
  }
  // `~` marks a value carried over from the last successful fetch while
  // the usage API is erroring (rate-limited etc.) — stale, better than blank.
  const pctStr = `${stale ? '~' : ''}${pct}%`;
  let head;
  if (colourMode === 'dim') {
    head = `${C.dim}${label}:${pctStr}${C.reset}`;
  } else {
    let col = C.green;
    if (pct >= 95) col = C.red;
    else if (pct >= 85) col = C.orange;
    else if (pct >= 60) col = C.yellow;
    head = `${col}${label}:${pctStr}${C.reset}`;
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

function readIntFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch { return 0; }
}

// Fixed-decimal number with insignificant trailing zeros removed (200.0 -> 200, 1.50 -> 1.5).
function trimmed(value, digits) {
  return value.toFixed(digits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function fmtTokens(n) {
  if (n >= 1_000_000_000) return `${trimmed(n / 1_000_000_000, 2)}B`; // 2.42B
  if (n >= 1_000_000) return `${trimmed(n / 1_000_000, 2)}M`;  // 1.25M, 1M
  if (n >= 1_000)     return `${trimmed(n / 1_000, 1)}k`;      // 425.3k, 200k
  return String(n);
}

// Tight token formatter for cells that need every column (bar numerics,
// tokenFlow). Drops decimals when the value is large enough that they read
// as noise — `124k` instead of `124.2k`, `26M` instead of `26.08M`, and
// rolls to B past a billion — `2.4B` instead of `2422M` (10-day sessions
// really do get there).
function fmtTokensTight(n) {
  if (n >= 10_000_000_000) return `${Math.round(n / 1_000_000_000)}B`;
  if (n >= 1_000_000_000)  return `${trimmed(n / 1_000_000_000, 1)}B`;
  if (n >= 10_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n >= 1_000_000)  return `${trimmed(n / 1_000_000, 1)}M`;
  if (n >= 10_000)     return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000)      return `${trimmed(n / 1_000, 1)}k`;
  return String(n);
}

// Compact USD formatter. Drops decimals once the value crosses $10 — at that
// scale the cents are noise, and the cells appear in dim grey alongside other
// numerics where vertical scan beats per-cent precision.
function fmtUsd(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 10) return `$${Math.round(n)}`;
  return `$${n.toFixed(2)}`;
}

// Denser USD for the per-model split, where a long session stacks several
// figures on one line: roll to `k` past $1000 so `$1727` reads `$1.7k`,
// `$12480` reads `$12k`. Small values keep cents.
function fmtUsdShort(n) {
  if (!Number.isFinite(n) || n <= 0) return '$0';
  if (n >= 10000) return `$${Math.round(n / 1000)}k`;
  if (n >= 1000)  return `$${(n / 1000).toFixed(1)}k`;
  if (n >= 10)    return `$${Math.round(n)}`;
  return `$${n.toFixed(2)}`;
}

// Single-letter duration formatter for tight cells (compactAge, session).
// `3hr 23m` -> `3h23m`, `11hr` -> `11h`, `45m` -> `45m`. Spans over 1d
// keep the day component and skip minutes — the precision isn't useful at
// that scale.
function fmtDurationTight(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0m';
  const totalMin = Math.floor(ms / 60000);
  const d = Math.floor(totalMin / (60 * 24));
  const h = Math.floor((totalMin % (60 * 24)) / 60);
  const m = totalMin % 60;
  if (d > 0) return h ? `${d}d${h}h` : `${d}d`;
  if (h > 0) return m ? `${h}h${m}m` : `${h}h`;
  return `${m}m`;
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
}

// Middle-ellipsis truncation. Used by fields where both ends carry signal \u2014
// e.g. branch names like `feat/long-task-slug` (prefix says intent, suffix
// disambiguates) or any path-like string. Falls back to end-truncate when
// `max` is too small to leave room for both halves + the ellipsis.
function truncateMiddle(s, max) {
  if (!s || s.length <= max) return s;
  if (max <= 4) return truncate(s, max);
  const keep = max - 1; // 1 char for ellipsis
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return s.slice(0, head) + '\u2026' + s.slice(s.length - tail);
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

module.exports = {
  renderUsageCell: _renderUsageCellImpl,
  resetAtMs,
  makeColors,
  readIntFile,
  fmtTokens,
  fmtTokensTight,
  fmtUsd,
  fmtUsdShort,
  fmtDurationTight,
  truncate,
  truncateMiddle,
  projectLabel,
  fmtDuration,
};
