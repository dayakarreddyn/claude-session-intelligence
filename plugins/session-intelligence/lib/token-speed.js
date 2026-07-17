/**
 * Output-token generation speed (tokens/sec) from the transcript tail.
 *
 * The transcript writes one row per stream-chunk update, all sharing the
 * assistant message's id with a growing usage block. For one message the
 * span (last chunk ts − first chunk ts) is pure generation wall-clock —
 * no tool execution or user latency inside it — so
 * `final output_tokens / span` is an honest turn-level speed.
 *
 * Messages flushed as a single row (span 0) carry no timing and are
 * skipped. The estimate is the median of the last few usable turns so one
 * throttled or bursty turn doesn't whipsaw the cell.
 */

'use strict';

const fs = require('fs');

const TAIL_BYTES = 512 * 1024;
const MIN_SPAN_MS = 800;   // sub-second spans quantize too coarsely to trust
const MIN_OUT_TOKENS = 50; // tiny turns divide noise by noise
const SAMPLE_TURNS = 3;

/**
 * @returns {{ tps: number, samples: number } | null} median speed across
 * the most recent usable turns, or null when nothing in the tail is usable.
 */
function estimateTokenSpeed(transcriptPath, opts = {}) {
  const tailBytes = opts.tailBytes || TAIL_BYTES;
  const minSpanMs = opts.minSpanMs !== undefined ? opts.minSpanMs : MIN_SPAN_MS;
  const minOut = opts.minOut !== undefined ? opts.minOut : MIN_OUT_TOKENS;
  const sampleTurns = opts.sampleTurns || SAMPLE_TURNS;

  if (!transcriptPath) return null;
  let stat;
  try { stat = fs.statSync(transcriptPath); } catch { return null; }

  let text;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const start = Math.max(0, stat.size - tailBytes);
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
      // Drop the first line when we started mid-file — it's a partial row.
      if (start > 0) {
        const nl = text.indexOf('\n');
        text = nl >= 0 ? text.slice(nl + 1) : '';
      }
    } finally { fs.closeSync(fd); }
  } catch { return null; }

  // message.id → { firstTs, lastTs, out, order } across its chunk rows.
  const byMsg = new Map();
  let order = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (!d || d.type !== 'assistant') continue;
    const m = d.message;
    if (!m || !m.id || !m.usage) continue;
    const ts = d.timestamp ? Date.parse(d.timestamp) : NaN;
    if (!Number.isFinite(ts)) continue;
    const out = m.usage.output_tokens || 0;
    const cur = byMsg.get(m.id);
    if (!cur) {
      byMsg.set(m.id, { firstTs: ts, lastTs: ts, out, order: order++ });
    } else {
      if (ts < cur.firstTs) cur.firstTs = ts;
      if (ts > cur.lastTs) cur.lastTs = ts;
      if (out > cur.out) cur.out = out;
    }
  }

  const usable = [];
  for (const v of byMsg.values()) {
    const spanMs = v.lastTs - v.firstTs;
    if (spanMs >= minSpanMs && v.out >= minOut) {
      usable.push({ order: v.order, tps: v.out / (spanMs / 1000) });
    }
  }
  if (!usable.length) return null;

  usable.sort((a, b) => a.order - b.order);
  const recent = usable.slice(-sampleTurns).map((u) => u.tps).sort((a, b) => a - b);
  const mid = Math.floor(recent.length / 2);
  const tps = recent.length % 2 ? recent[mid] : (recent[mid - 1] + recent[mid]) / 2;
  return { tps, samples: recent.length };
}

module.exports = { estimateTokenSpeed };
