/**
 * Tests for lib/token-speed.js — tokens/sec from per-message chunk spans.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { estimateTokenSpeed } = require('../lib/token-speed');

function writeTranscript(rows) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'si-tps-')), 't.jsonl');
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function chunkRows(id, startIso, spanMs, finalOut, chunks = 3) {
  const start = Date.parse(startIso);
  const rows = [];
  for (let i = 0; i < chunks; i++) {
    rows.push({
      type: 'assistant',
      timestamp: new Date(start + (spanMs * i) / (chunks - 1)).toISOString(),
      message: { id, usage: { output_tokens: Math.round((finalOut * (i + 1)) / chunks) } },
    });
  }
  return rows;
}

test('estimateTokenSpeed computes tokens/sec from chunk spans (median of recent turns)', () => {
  const p = writeTranscript([
    // 1000 tokens over 10s = 100 tps
    ...chunkRows('m1', '2026-07-17T10:00:00.000Z', 10000, 1000),
    // 1000 tokens over 5s = 200 tps
    ...chunkRows('m2', '2026-07-17T10:01:00.000Z', 5000, 1000),
    // 1000 tokens over 2s = 500 tps
    ...chunkRows('m3', '2026-07-17T10:02:00.000Z', 2000, 1000),
  ]);
  const est = estimateTokenSpeed(p);
  assert.ok(est, 'estimate returned');
  assert.equal(est.samples, 3);
  assert.ok(Math.abs(est.tps - 200) < 1, `median of 100/200/500 → 200, got ${est.tps}`);
});

test('estimateTokenSpeed skips single-row messages and tiny turns', () => {
  const p = writeTranscript([
    // Single row — no span, no timing signal.
    { type: 'assistant', timestamp: '2026-07-17T10:00:00.000Z', message: { id: 's1', usage: { output_tokens: 900 } } },
    // Big span but trivial output — noise.
    ...chunkRows('s2', '2026-07-17T10:01:00.000Z', 5000, 10),
  ]);
  assert.equal(estimateTokenSpeed(p), null);
});

test('estimateTokenSpeed returns null for missing file', () => {
  assert.equal(estimateTokenSpeed('/nonexistent/t.jsonl'), null);
  assert.equal(estimateTokenSpeed(null), null);
});
