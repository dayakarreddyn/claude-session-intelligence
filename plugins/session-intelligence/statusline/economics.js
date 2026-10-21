'use strict';

// Context cap, token/cost estimation from transcripts, cost snapshots, compact-relative cost.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { resolveLibDir, loadUtilsLib, loadCompactHistoryLib, knownPriceForModelSafe, getCostLibCached } = require('./lib-loader');
const { readIntFile } = require('./format');

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

// The token-budget hook writes under getStateDir() (~/.claude/state); older
// installs wrote to os.tmpdir(). Check the state dir first, then tmpdir.
function estimateDirs() {
  const dirs = [];
  try {
    const utils = loadUtilsLib();
    if (utils && typeof utils.getStateDir === 'function') dirs.push(utils.getStateDir());
  } catch { /* fall back to tmpdir only */ }
  dirs.push(os.tmpdir());
  return dirs;
}

function loadEstimate(sessionId) {
  const dirs = estimateDirs();
  const ids = [sessionId, 'default'].filter(Boolean);
  for (const id of ids) {
    const sid = String(id).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!sid) continue;
    for (const dir of dirs) {
      const budget = path.join(dir, `claude-token-budget-${sid}`);
      const count  = path.join(dir, `claude-tool-count-${sid}`);
      if (fs.existsSync(budget) || fs.existsSync(count)) {
        return { tokens: readIntFile(budget), tools: readIntFile(count), id: sid };
      }
    }
  }
  return { tokens: 0, tools: 0, id: sessionId || 'default' };
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

// Context cap resolution lives in lib/context-cap.js (shared with hooks).
function contextCap(input, cfg) {
  input = input || {}; cfg = cfg || {};
  const dir = resolveLibDir(); let lib = null;
  try { lib = dir && require(path.join(dir, 'context-cap.js')); } catch { /* fall through */ }
  return lib ? lib.resolveContextCap({ model: input.model && (input.model.id || input.model.display_name), env: process.env, contextWindowSize: input.context_window && input.context_window.context_window_size, configCap: cfg.contextCap }).cap : 200000;
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
 * Per-session snapshot of Claude Code's authoritative `total_cost_usd`.
 * Statusline writes the latest value on every render that has an authoritative
 * cost; PreCompact reads this at the moment of /compact and stamps it onto
 * the history entry as `costAtCompactUsd`. Letting future statusline renders
 * compute `since-compact = current_total - at_compact` — a strict subset of
 * session cost, instead of the divergent transcript-priced estimate.
 */
function costSnapshotPath(sessionId) {
  const sid = String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
  // Persist under ~/.claude/state/ so macOS tmpdir cleanup doesn't strand
  // PreCompact reading a stale or absent snapshot mid-session. Falls back to
  // os.tmpdir() when utils isn't loadable (partial install).
  let stateDir;
  try {
    const dir = resolveLibDir();
    if (dir) stateDir = require(path.join(dir, 'utils')).getStateDir();
  } catch { /* fall through */ }
  return path.join(stateDir || os.tmpdir(), `claude-cost-snapshot-${sid}.json`);
}

function writeCostSnapshot(sessionId, totalCostUsd) {
  if (!sessionId || !Number.isFinite(totalCostUsd)) return;
  try {
    fs.writeFileSync(
      costSnapshotPath(sessionId),
      JSON.stringify({ t: Date.now(), total_cost_usd: totalCostUsd }),
    );
  } catch { /* best effort */ }
}

function readCostSnapshot(sessionId) {
  try {
    const data = JSON.parse(fs.readFileSync(costSnapshotPath(sessionId), 'utf8'));
    return data && Number.isFinite(data.total_cost_usd) ? data : null;
  } catch { return null; }
}

/**
 * costAtCompactUsd for the current session's most recent compact, or null
 * when the entry doesn't have one (older history written before the field
 * existed) or the session hasn't compacted yet.
 */
function costAtLastCompact(sessionId) {
  if (!sessionId) return null;
  const lib = loadCompactHistoryLib();
  if (!lib || typeof lib.readHistory !== 'function') return null;
  const entries = lib.readHistory(50);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e && e.sid === sessionId && Number.isFinite(e.costAtCompactUsd)) {
      return e.costAtCompactUsd;
    }
  }
  return null;
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
  // v3: per-turn model pricing (each line's message.model is looked up;
  // the flat `prices` arg only covers unknown models). v2 accumulated at
  // one flat price list — mixing modes in one cache would blend pricing.
  // Old v1/v2 cache files are abandoned (TMPDIR cleanup handles eviction).
  const cacheFile = path.join(os.tmpdir(), `claude-cost-sincecompact-${sid}.v3`);

  let cache = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (parsed && parsed.compactMs === compactMs
        && typeof parsed.offset === 'number' && parsed.offset >= 0
        && parsed.offset <= stat.size) {
      cache = parsed;
    }
  } catch { /* miss or stale */ }

  if (!cache) cache = { compactMs, offset: 0, cost: 0, saved: 0, seenIds: [] };
  const seen = new Set(Array.isArray(cache.seenIds) ? cache.seenIds : []);
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
            // Dedupe streaming snapshots: same message.id appears once per
            // stream chunk in the transcript. Without this guard the cost
            // is over-counted by the chunk multiplier (typically 4-7×).
            const mid = d.message && d.message.id;
            if (mid) {
              if (seen.has(mid)) continue;
              seen.add(mid);
            }
            const linePrices = knownPriceForModelSafe(d.message && d.message.model) || prices;
            cache.cost += costFromUsage(u, linePrices);
            cache.saved += savedFromUsage(u, linePrices);
          } catch { /* skip bad line */ }
        }
        cache.offset += lastNl + 1;
      }
    } finally { fs.closeSync(fd); }
  } catch {
    return { cost: cache.cost, saved: cache.saved };
  }

  try {
    cache.seenIds = Array.from(seen);
    fs.writeFileSync(cacheFile, JSON.stringify(cache), 'utf8');
  } catch { /* best effort */ }

  return { cost: cache.cost, saved: cache.saved };
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
  // Tiered rows (Haiku 5.5) and 1h cache writes live in the shared lib.
  if (knownPriceForModelSafe('') === null && getCostLibCached() && typeof getCostLibCached().costFromUsage === 'function') {
    return getCostLibCached().costFromUsage(u, prices);
  }
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
  if (knownPriceForModelSafe('') === null && getCostLibCached() && typeof getCostLibCached().savedFromUsage === 'function') {
    return getCostLibCached().savedFromUsage(u, prices);
  }
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
  // v4: adds per-model cost buckets (byModel) for the modelSplit field.
  // Shares the cache name with lib/cost-estimation.js so both renderers see
  // the same offsets; the version MUST bump in both files together.
  const cacheFile = path.join(os.tmpdir(), `claude-cost-${sid}.v4`);

  let cachedOffset = 0;
  let cachedCost = 0;
  let cachedSaved = 0;
  let cachedInput = 0;
  let cachedOutput = 0;
  let cachedCacheRead = 0;
  let cachedCreation = 0;
  let cachedSeenIds = [];
  let cachedByModel = {};
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
      cachedSeenIds = Array.isArray(cached.seenIds) ? cached.seenIds : [];
      if (cached.byModel && typeof cached.byModel === 'object') cachedByModel = cached.byModel;
    }
  } catch { /* cache miss or corrupt — read from 0 */ }
  const seen = new Set(cachedSeenIds);

  // File shrank (rotation / clear) → drop cache, re-read whole thing.
  if (stat.size < cachedOffset) {
    cachedOffset = 0; cachedCost = 0; cachedSaved = 0;
    cachedInput = 0; cachedOutput = 0; cachedCacheRead = 0; cachedCreation = 0;
    cachedByModel = {};
  }

  // No new bytes — short-circuit the I/O entirely.
  if (stat.size === cachedOffset) {
    return {
      cost: cachedCost, saved: cachedSaved,
      input: cachedInput, output: cachedOutput,
      cached: cachedCacheRead, creation: cachedCreation,
      byModel: cachedByModel,
    };
  }

  let newCost = cachedCost;
  let newSaved = cachedSaved;
  let newInput = cachedInput;
  let newOutput = cachedOutput;
  let newCacheRead = cachedCacheRead;
  let newCreation = cachedCreation;
  let newOffset = cachedOffset;
  const byModel = { ...cachedByModel };
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
              // Dedupe streaming snapshots by message.id (see costsSinceCompact).
              const mid = d.message && d.message.id;
              if (mid) {
                if (seen.has(mid)) continue;
                seen.add(mid);
              }
              const lineModel = (d.message && d.message.model) || 'other';
              const linePrices = knownPriceForModelSafe(lineModel) || prices;
              const lineCost = costFromUsage(u, linePrices);
              byModel[lineModel] = (byModel[lineModel] || 0) + lineCost;
              newCost += lineCost;
              newSaved += savedFromUsage(u, linePrices);
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
      byModel: cachedByModel,
    };
  }

  try {
    fs.writeFileSync(cacheFile, JSON.stringify({
      offset: newOffset, cost: newCost, saved: newSaved,
      input: newInput, output: newOutput,
      cached: newCacheRead, creation: newCreation,
      seenIds: Array.from(seen),
      byModel,
    }), 'utf8');
  } catch { /* best effort */ }

  return {
    cost: newCost, saved: newSaved,
    input: newInput, output: newOutput,
    cached: newCacheRead, creation: newCreation,
    byModel,
  };
}

module.exports = {
  totalTokensFromUsage,
  loadEstimate,
  contextCap,
  lastCompactMsForSession,
  minutesSinceLastCompact,
  costSnapshotPath,
  writeCostSnapshot,
  readCostSnapshot,
  costAtLastCompact,
  costsSinceCompact,
  DEFAULT_PRICES,
  costFromUsage,
  savedFromUsage,
  totalCostFromTranscript,
  totalCacheSavedFromTranscript,
  totalsFromTranscript,
};
