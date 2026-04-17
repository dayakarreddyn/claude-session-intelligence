/**
 * Cost estimation from transcript usage blocks.
 *
 * Extracted from statusline-intel.js so multiple hooks can share the same
 * incremental-read cache. Costs are computed by summing per-turn usage
 * across every assistant message in the transcript; each turn's
 * cache_read/cache_creation/input/output is billed separately by Anthropic,
 * so summing is correct.
 *
 * A per-session cache `/tmp/claude-cost-<sid>` stores `{offset, cost}` so
 * subsequent reads only process delta bytes. This matters because the
 * transcript file can grow into the tens of MB over a long session and
 * every hook would re-parse from scratch otherwise.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Per-million-token prices (USD). Loose defaults; the caller can override
// via a config-loaded price list so pricing can be updated without a code
// change.
const DEFAULT_PRICES = {
  input: 15,
  cache_creation: 18.75,
  cache_read: 1.5,
  output: 75,
};

/** Cost of one usage block in USD. */
function costFromUsage(u, prices = DEFAULT_PRICES) {
  if (!u) return 0;
  const per = (n, p) => ((n || 0) / 1_000_000) * p;
  return per(u.input_tokens, prices.input)
       + per(u.cache_creation_input_tokens, prices.cache_creation)
       + per(u.cache_read_input_tokens, prices.cache_read)
       + per(u.output_tokens, prices.output);
}

/**
 * Sum cost across all assistant messages in the transcript. Uses the
 * incremental-offset cache so we don't re-read the whole file on every
 * call. Returns 0 for any failure so callers can degrade silently.
 */
function totalCostFromTranscript(transcriptPath, sessionId, prices = DEFAULT_PRICES) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return 0;

  let stat;
  try { stat = fs.statSync(transcriptPath); } catch { return 0; }

  const sid = String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '');
  const cacheFile = path.join(os.tmpdir(), `claude-cost-${sid}`);

  let cachedOffset = 0;
  let cachedCost = 0;
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cached && typeof cached.offset === 'number' && typeof cached.cost === 'number'
        && cached.offset >= 0 && cached.offset <= stat.size) {
      cachedOffset = cached.offset;
      cachedCost = cached.cost;
    }
  } catch { /* cache miss or corrupt — read from 0 */ }

  // File shrank (rotation / compact) → drop cache, re-read whole thing.
  if (stat.size < cachedOffset) { cachedOffset = 0; cachedCost = 0; }
  if (stat.size === cachedOffset) return cachedCost;

  let newCost = cachedCost;
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
            if (u) newCost += costFromUsage(u, prices);
          } catch { /* invalid line — skip */ }
        }
        newOffset = cachedOffset + lastNl + 1;
      }
    } finally { fs.closeSync(fd); }
  } catch { return cachedCost; }

  try {
    fs.writeFileSync(cacheFile,
      JSON.stringify({ offset: newOffset, cost: newCost }), 'utf8');
  } catch { /* best effort */ }

  return newCost;
}

/**
 * Estimate how much of the current context is "expensive" vs "cache-served".
 * Returns { costPerKTok, cacheRatio, band } where band is 'cheap' / 'normal'
 * / 'expensive'. High cacheRatio = mostly replaying cached content, so
 * compacting saves less; low cacheRatio = actively generating novel tokens,
 * compact earlier to cap cost.
 */
function costBand(usage, prices = DEFAULT_PRICES) {
  if (!usage) return { costPerKTok: 0, cacheRatio: 0, band: 'unknown' };
  const totalTok = (usage.input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0)
    + (usage.cache_read_input_tokens || 0);
  if (totalTok === 0) return { costPerKTok: 0, cacheRatio: 0, band: 'unknown' };

  const cost = costFromUsage(usage, prices);
  const costPerKTok = (cost / totalTok) * 1000;
  const cacheRatio = (usage.cache_read_input_tokens || 0) / totalTok;

  // Boundaries chosen so cache-heavy sessions (>70% cache) register as cheap
  // and novel-work sessions (<30% cache) register as expensive.
  let band = 'normal';
  if (cacheRatio >= 0.7) band = 'cheap';
  else if (cacheRatio < 0.3) band = 'expensive';
  return { costPerKTok, cacheRatio, band };
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
  costFromUsage,
  totalCostFromTranscript,
  costBand,
  formatUsd,
};
