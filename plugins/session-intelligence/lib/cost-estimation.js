/**
 * Cost estimation from transcript usage blocks.
 *
 * Extracted from statusline-intel.js so multiple hooks can share the same
 * incremental-read cache. Costs are computed by summing per-turn usage
 * across every assistant message in the transcript; each turn's
 * cache_read/cache_creation/input/output is billed separately by Anthropic,
 * so summing is correct.
 *
 * A per-session cache `<state dir>/claude-cost-<sid>.v5.json` stores `{offset, cost}` so
 * subsequent reads only process delta bytes. This matters because the
 * transcript file can grow into the tens of MB over a long session and
 * every hook would re-parse from scratch otherwise.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_BYTES_PER_PASS = 64 * 1024 * 1024;
const MAX_SEEN_IDS = 5000;

// Per-million-token prices (USD). Loose conservative default (legacy Opus
// rates — an upper bound for any model we don't recognize); the caller can
// override via a config-loaded price list so pricing can be updated without
// a code change.
const DEFAULT_PRICES = {
  input: 15,
  cache_creation: 18.75,
  cache_read: 1.5,
  output: 75,
};

// Per-model price tables (platform.claude.com/docs/en/about-claude/pricing).
// Lookup is by family prefix (the date suffix on model IDs like
// `claude-haiku-4-5-20251001` varies), longest prefix first. Subagents
// commonly run on a different model than the parent (Haiku for Explore-class
// agents, Sonnet for reviewers), so a per-model lookup is needed for honest
// cost. cache_creation is the 5-minute write rate (1.25x input) — what
// Claude Code sessions use.
const PRICING_BY_MODEL = Object.freeze({
  // Claude 5.5-era rows (pricing page 2026-10-19). Explicit rows are longer
  // than their family prefix so they win the longest-prefix match.
  // cache_creation_1h is the 1-hour TTL write rate (2x input).
  'claude-fable-5-1':  Object.freeze({ input: 10, cache_creation: 12.50, cache_creation_1h: 20, cache_read: 0.25, output: 50 }),
  'claude-mythos-5-1': Object.freeze({ input: 10, cache_creation: 12.50, cache_creation_1h: 20, cache_read: 0.25, output: 50 }),
  'claude-opus-5-5':   Object.freeze({ input: 4, cache_creation: 5, cache_creation_1h: 8, cache_read: 0.20, output: 20 }),
  'claude-sonnet-5-5': Object.freeze({ input: 2, cache_creation: 2.50, cache_creation_1h: 4, cache_read: 0.10, output: 10 }),
  // Haiku 5.5 is tiered on the request's total context tokens (see tierFor).
  'claude-haiku-5-5': Object.freeze({ tiers: Object.freeze([
    Object.freeze({ upToContextTokens: 100000, input: 0.10, cache_creation: 0.125, cache_creation_1h: 0.20, cache_read: 0.01, output: 0.50 }),
    Object.freeze({ input: 0.50, cache_creation: 0.625, cache_creation_1h: 1, cache_read: 0.05, output: 2.50 }),
  ]) }),
  // Claude 5 family — Fable 5 / Mythos 5 share pricing.
  'claude-fable':  { input: 10, cache_creation: 12.50, cache_read: 1.00, output: 50 },
  'claude-mythos': { input: 10, cache_creation: 12.50, cache_read: 1.00, output: 50 },
  // Opus 4.5+ repriced to $5/$25 (Nov 2025). Opus 4.1 and the dated Opus 4
  // base id (claude-opus-4-20250514) stay on legacy $15/$75 — pinned with
  // longer prefixes so they win over the family entry below.
  'claude-opus-4-1':    { input: 15, cache_creation: 18.75, cache_read: 1.50, output: 75 },
  'claude-opus-4-2025': { input: 15, cache_creation: 18.75, cache_read: 1.50, output: 75 },
  'claude-opus':   { input: 5,  cache_creation: 6.25,  cache_read: 0.50, output: 25 },
  // Sonnet 5 introductory pricing runs through 2026-08-31; priceForModel
  // swaps to the standard sonnet family entry from 2026-09-01.
  'claude-sonnet-5': { input: 2, cache_creation: 2.50, cache_read: 0.20, output: 10 },
  'claude-sonnet': { input: 3,  cache_creation: 3.75,  cache_read: 0.30, output: 15 },
  'claude-haiku':  { input: 1,  cache_creation: 1.25,  cache_read: 0.10, output: 5  },
});

const SONNET5_INTRO_END_MS = Date.parse('2026-09-01T00:00:00Z');

/**
 * Price table for a recognized model family, or null when the model id
 * matches no known family. `at` (ms epoch) selects date-dependent pricing —
 * pass a row's own timestamp when repricing historical usage.
 */
function knownPriceForModel(modelId, at = Date.now()) {
  if (!modelId || typeof modelId !== 'string') return null;
  // Match longest family prefix first.
  const keys = Object.keys(PRICING_BY_MODEL).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (!modelId.startsWith(k)) continue;
    if (k === 'claude-sonnet-5' && at >= SONNET5_INTRO_END_MS) {
      return PRICING_BY_MODEL['claude-sonnet'];
    }
    return PRICING_BY_MODEL[k];
  }
  return null;
}

function priceForModel(modelId, at = Date.now()) {
  return knownPriceForModel(modelId, at) || DEFAULT_PRICES;
}

const CACHE_1H_FALLBACK_MULT = 1.6; // 1h write (2x input) over 5m write (1.25x)

/** Flat price object for a context size; non-tiered rows pass through. */
function tierFor(prices, contextTokens) {
  if (!prices || !Array.isArray(prices.tiers)) return prices;
  const n = contextTokens || 0;
  for (const t of prices.tiers) {
    if (t.upToContextTokens === undefined || n <= t.upToContextTokens) return t;
  }
  return prices.tiers[prices.tiers.length - 1];
}

function contextTokensOf(u) {
  return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
}

/** Cost of one usage block in USD. */
function costFromUsage(u, prices = DEFAULT_PRICES) {
  if (!u) return 0;
  const p = tierFor(prices, contextTokensOf(u));
  // Multiply before dividing so round token counts price without float drift.
  const per = (n, rate) => ((n || 0) * rate) / 1_000_000;
  const total = u.cache_creation_input_tokens || 0;
  const oneHour = Math.min(total, Math.max(0, (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0));
  const rate1h = p.cache_creation_1h !== undefined ? p.cache_creation_1h : p.cache_creation * CACHE_1H_FALLBACK_MULT;
  return per(u.input_tokens, p.input)
       + per(total - oneHour, p.cache_creation)
       + per(oneHour, rate1h)
       + per(u.cache_read_input_tokens, p.cache_read)
       + per(u.output_tokens, p.output);
}

/**
 * USD saved by prefix-cache hits on a single turn, vs. the counterfactual of
 * paying the uncached input rate for those same tokens. Positive number when
 * cache fired; 0 when no cache hits on that turn.
 */
function savedFromUsage(u, prices = DEFAULT_PRICES) {
  if (!u) return 0;
  const read = u.cache_read_input_tokens || 0;
  if (read <= 0) return 0;
  const p = tierFor(prices, contextTokensOf(u));
  const delta = (p.input || 0) - (p.cache_read || 0);
  if (delta <= 0) return 0;
  return (read / 1_000_000) * delta;
}

/**
 * Sum cost across all assistant messages in the transcript. Uses the
 * incremental-offset cache so we don't re-read the whole file on every
 * call. Returns 0 for any failure so callers can degrade silently.
 */
function totalCostFromTranscript(transcriptPath, sessionId, prices = DEFAULT_PRICES) {
  const r = totalsFromTranscript(transcriptPath, sessionId, prices);
  return r ? r.cost : 0;
}

/**
 * Cumulative dollars saved by cache hits across the entire session vs. the
 * counterfactual of paying the full input rate. Incremental, shares the
 * same offset cache as totalCostFromTranscript.
 */
function totalCacheSavedFromTranscript(transcriptPath, sessionId, prices = DEFAULT_PRICES) {
  const r = totalsFromTranscript(transcriptPath, sessionId, prices);
  return r ? r.saved : 0;
}

/**
 * Chunked, bounded transcript scanner shared by totalsFromTranscript and
 * costsSinceCompact. Reads `chunkBytes` at a time into ONE reused Buffer,
 * carries the trailing partial line across chunks, and calls onRow(parsed)
 * for every complete JSON line. Once `maxBytesPerPass` bytes have been
 * consumed it stops at the last complete newline and reports partial:true so
 * the next render resumes from the returned offset. Never reads past the
 * size observed at start; an unterminated tail line is left unconsumed.
 */
function scanTranscript(transcriptPath, fromOffset, onRow, opts = {}) {
  const chunkBytes = opts.chunkBytes > 0 ? Math.floor(opts.chunkBytes) : DEFAULT_CHUNK_BYTES;
  const maxBytes = opts.maxBytesPerPass > 0 ? opts.maxBytesPerPass : DEFAULT_MAX_BYTES_PER_PASS;
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(chunkBytes);
    let pos = fromOffset;
    let offset = fromOffset; // just past the last fully processed newline
    let consumed = 0;
    let carry = [];
    let stopped = false;
    const emit = (lineBuf) => {
      if (lineBuf.length === 0) return;
      let row = null;
      try { row = JSON.parse(lineBuf.toString('utf8')); } catch { return; }
      onRow(row);
    };
    while (pos < size) {
      if (consumed >= maxBytes && offset > fromOffset) { stopped = true; break; }
      const want = Math.min(chunkBytes, size - pos);
      const got = fs.readSync(fd, buf, 0, want, pos);
      if (got <= 0) break;
      let start = 0;
      for (let nl = buf.indexOf(0x0A, start); nl >= 0 && nl < got; nl = buf.indexOf(0x0A, start)) {
        const piece = buf.subarray(start, nl);
        emit(carry.length ? Buffer.concat([...carry, piece]) : piece);
        carry = [];
        start = nl + 1;
        offset = pos + nl + 1;
      }
      if (start < got) carry = [...carry, Buffer.from(buf.subarray(start, got))];
      pos += got;
      consumed += got;
    }
    return { offset, partial: stopped };
  } finally { fs.closeSync(fd); }
}

function safeSid(sessionId) {
  return String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '');
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJsonFile(file, value) {
  try { fs.writeFileSync(file, JSON.stringify(value), 'utf8'); } catch { /* best effort */ }
}

function resolveCacheDir(opts) {
  if (opts && opts.cacheDir) return opts.cacheDir;
  try { return require('./utils').getStateDir(); } catch { return os.tmpdir(); }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function trimSeen(seen) {
  const all = Array.from(seen);
  return all.length > MAX_SEEN_IDS ? all.slice(all.length - MAX_SEEN_IDS) : all;
}

function emptyTotals() {
  return { cost: 0, saved: 0, input: 0, output: 0, cached: 0, creation: 0, byModel: {}, partial: false };
}

/**
 * Single incremental pass that accumulates both {cost, saved} plus token
 * totals and per-model cost buckets. State lives in
 * `<cacheDir>/claude-cost-<sid>.v5.json` (default cacheDir: the state dir, which
 * macOS tmpdir cleanup cannot wipe). Falls back to the cached totals on any
 * failure so callers can degrade silently. `partial: true` means the pass hit
 * `maxBytesPerPass` and the next call continues from the persisted offset.
 */
function totalsFromTranscript(transcriptPath, sessionId, prices = DEFAULT_PRICES, opts = {}) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return emptyTotals();
  let stat;
  try { stat = fs.statSync(transcriptPath); } catch { return emptyTotals(); }

  const priceFor = typeof opts.priceFor === 'function' ? opts.priceFor : knownPriceForModel;
  const cacheFile = path.join(resolveCacheDir(opts), `claude-cost-${safeSid(sessionId)}.v5.json`);

  const c = readJsonFile(cacheFile);
  const valid = c && typeof c.offset === 'number' && typeof c.cost === 'number'
    && c.offset >= 0 && c.offset <= stat.size;
  let acc = valid
    ? {
      offset: c.offset, cost: c.cost, saved: num(c.saved), input: num(c.input),
      output: num(c.output), cached: num(c.cached), creation: num(c.creation),
      byModel: c.byModel && typeof c.byModel === 'object' ? { ...c.byModel } : {},
    }
    : { offset: 0, cost: 0, saved: 0, input: 0, output: 0, cached: 0, creation: 0, byModel: {} };
  const seen = new Set(valid && Array.isArray(c.seenIds) ? c.seenIds : []);

  const result = (a, partial) => ({
    cost: a.cost, saved: a.saved, input: a.input, output: a.output,
    cached: a.cached, creation: a.creation, byModel: a.byModel, partial,
  });
  if (stat.size === acc.offset) return result(acc, false);

  const cost = { ...acc, byModel: { ...acc.byModel } };
  const onRow = (d) => {
    const u = d && d.message && d.message.usage;
    if (!u) return;
    // Dedupe streaming snapshots by message.id: one row per stream chunk of
    // the same assistant message would otherwise over-count 4-7x.
    const mid = d.message.id;
    if (mid) {
      if (seen.has(mid)) return;
      seen.add(mid);
    }
    // Per-turn model pricing; `prices` is only the unknown-model fallback.
    const lineModel = d.message.model || 'other';
    const linePrices = priceFor(lineModel) || prices;
    const lineCost = costFromUsage(u, linePrices);
    cost.byModel[lineModel] = (cost.byModel[lineModel] || 0) + lineCost;
    cost.cost += lineCost;
    cost.saved += savedFromUsage(u, linePrices);
    cost.input += u.input_tokens || 0;
    cost.output += u.output_tokens || 0;
    cost.cached += u.cache_read_input_tokens || 0;
    cost.creation += u.cache_creation_input_tokens || 0;
  };

  let scan;
  try { scan = scanTranscript(transcriptPath, acc.offset, onRow, opts); }
  catch { return result(acc, false); }

  cost.offset = scan.offset;
  writeJsonFile(cacheFile, { ...cost, seenIds: trimSeen(seen) });
  return result(cost, scan.partial);
}

/**
 * Cost + cache savings accrued by rows whose timestamp is >= compactMs.
 * Cache `<cacheDir>/claude-cost-sincecompact-<sid>.v4.json` is keyed by
 * compactMs, so a new compact resets it. Same chunked, bounded scan as
 * totalsFromTranscript.
 */
function costsSinceCompact(transcriptPath, sessionId, compactMs, prices = DEFAULT_PRICES, opts = {}) {
  const empty = { cost: 0, saved: 0, partial: false };
  if (!compactMs || !transcriptPath || !fs.existsSync(transcriptPath)) return empty;
  let stat;
  try { stat = fs.statSync(transcriptPath); } catch { return empty; }

  const priceFor = typeof opts.priceFor === 'function' ? opts.priceFor : knownPriceForModel;
  const cacheFile = path.join(resolveCacheDir(opts), `claude-cost-sincecompact-${safeSid(sessionId)}.v4.json`);

  const p = readJsonFile(cacheFile);
  const hit = p && p.compactMs === compactMs && typeof p.offset === 'number'
    && p.offset >= 0 && p.offset <= stat.size;
  const acc = { offset: hit ? p.offset : 0, cost: hit ? num(p.cost) : 0, saved: hit ? num(p.saved) : 0 };
  const seen = new Set(hit && Array.isArray(p.seenIds) ? p.seenIds : []);
  if (stat.size === acc.offset) return { cost: acc.cost, saved: acc.saved, partial: false };

  const sum = { ...acc };
  const onRow = (d) => {
    const u = d && d.message && d.message.usage;
    if (!u) return;
    const ts = d.timestamp ? Date.parse(d.timestamp) : NaN;
    if (!Number.isFinite(ts) || ts < compactMs) return;
    const mid = d.message.id;
    if (mid) {
      if (seen.has(mid)) return;
      seen.add(mid);
    }
    const linePrices = priceFor(d.message.model) || prices;
    sum.cost += costFromUsage(u, linePrices);
    sum.saved += savedFromUsage(u, linePrices);
  };

  let scan;
  try { scan = scanTranscript(transcriptPath, acc.offset, onRow, opts); }
  catch { return { cost: acc.cost, saved: acc.saved, partial: false }; }

  sum.offset = scan.offset;
  writeJsonFile(cacheFile, { compactMs, ...sum, seenIds: trimSeen(seen) });
  return { cost: sum.cost, saved: sum.saved, partial: scan.partial };
}

/**
 * Find the first assistant turn in the transcript whose timestamp is strictly
 * after `sinceTs` (ms since epoch) and return its usage block. Used to measure
 * cache-hit ratio on the first post-compact turn — that number tells us
 * whether `compact.stablePrefix` is actually being served from cache.
 *
 * Non-incremental (reads the whole file). The measurement fires once per
 * compact so the offset-cache machinery isn't worth it.
 */
function firstAssistantUsageAfter(transcriptPath, sinceTs) {
  if (!transcriptPath || !Number.isFinite(sinceTs)) return null;
  let content;
  try { content = fs.readFileSync(transcriptPath, 'utf8'); }
  catch { return null; }
  for (const line of content.split('\n')) {
    if (!line) continue;
    try {
      const d = JSON.parse(line);
      if (!d || d.type !== 'assistant') continue;
      const ts = d.timestamp ? Date.parse(d.timestamp) : NaN;
      if (!Number.isFinite(ts) || ts <= sinceTs) continue;
      const u = d.message && d.message.usage;
      if (u) return u;
    } catch { /* skip malformed line */ }
  }
  return null;
}

/**
 * Ratio of prefix tokens served from cache on a single turn:
 *   cache_read / (cache_read + cache_creation)
 * Returns null when the denominator is zero (turn produced no cacheable
 * prefix — rare, but happens on the very first turn of a session).
 */
function cacheHitRatio(usage) {
  if (!usage) return null;
  const read = usage.cache_read_input_tokens || 0;
  const creation = usage.cache_creation_input_tokens || 0;
  const denom = read + creation;
  if (denom <= 0) return null;
  return read / denom;
}

/** Format a USD amount for terse status-line / message rendering. */
function formatUsd(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 10)  return `$${n.toFixed(1)}`;
  return `$${n.toFixed(2)}`;
}

module.exports = {
  DEFAULT_PRICES,
  PRICING_BY_MODEL,
  knownPriceForModel,
  priceForModel,
  tierFor,
  costFromUsage,
  savedFromUsage,
  totalCostFromTranscript,
  totalCacheSavedFromTranscript,
  totalsFromTranscript,
  costsSinceCompact,
  scanTranscript,
  DEFAULT_CHUNK_BYTES,
  DEFAULT_MAX_BYTES_PER_PASS,
  firstAssistantUsageAfter,
  cacheHitRatio,
  formatUsd,
};
