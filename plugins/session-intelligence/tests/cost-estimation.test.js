/**
 * Tests for lib/cost-estimation.js — focuses on the post-compact cache-hit
 * telemetry helpers (firstAssistantUsageAfter, cacheHitRatio). The cost
 * summing path already has coverage through statusline integration tests.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const costEst = require('../lib/cost-estimation');

function writeTranscript(lines) {
  const p = path.join(os.tmpdir(), `si-cost-test-${Date.now()}-${Math.random()}.jsonl`);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

test('firstAssistantUsageAfter returns first assistant turn after threshold', () => {
  const before = '2026-04-19T18:00:00.000Z';
  const after1 = '2026-04-19T18:00:05.000Z';
  const after2 = '2026-04-19T18:00:10.000Z';
  const path_ = writeTranscript([
    { type: 'assistant', timestamp: before, message: { usage: { cache_read_input_tokens: 1, cache_creation_input_tokens: 9 } } },
    { type: 'user', timestamp: after1 },
    { type: 'assistant', timestamp: after1, message: { usage: { cache_read_input_tokens: 50, cache_creation_input_tokens: 50 } } },
    { type: 'assistant', timestamp: after2, message: { usage: { cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } } },
  ]);
  const threshold = Date.parse('2026-04-19T18:00:02.000Z');
  const u = costEst.firstAssistantUsageAfter(path_, threshold);
  assert.ok(u);
  assert.equal(u.cache_read_input_tokens, 50);
  fs.unlinkSync(path_);
});

test('firstAssistantUsageAfter returns null when no assistant turn after threshold', () => {
  const path_ = writeTranscript([
    { type: 'assistant', timestamp: '2026-04-19T18:00:00.000Z', message: { usage: { cache_read_input_tokens: 1 } } },
  ]);
  const u = costEst.firstAssistantUsageAfter(path_, Date.parse('2026-04-19T19:00:00.000Z'));
  assert.equal(u, null);
  fs.unlinkSync(path_);
});

test('firstAssistantUsageAfter skips non-assistant records and malformed lines', () => {
  const path_ = writeTranscript([
    { type: 'user', timestamp: '2026-04-19T18:00:01.000Z' },
    { type: 'file-history-snapshot', timestamp: '2026-04-19T18:00:02.000Z' },
    { type: 'assistant', timestamp: '2026-04-19T18:00:03.000Z', message: { usage: { cache_read_input_tokens: 42, cache_creation_input_tokens: 8 } } },
  ]);
  const u = costEst.firstAssistantUsageAfter(path_, Date.parse('2026-04-19T18:00:00.000Z'));
  assert.equal(u.cache_read_input_tokens, 42);
  fs.unlinkSync(path_);
});

test('firstAssistantUsageAfter returns null for missing path', () => {
  assert.equal(costEst.firstAssistantUsageAfter(null, 0), null);
  assert.equal(costEst.firstAssistantUsageAfter('/nonexistent/path', 0), null);
});

test('cacheHitRatio computes read / (read + creation)', () => {
  assert.equal(costEst.cacheHitRatio({ cache_read_input_tokens: 90, cache_creation_input_tokens: 10 }), 0.9);
  assert.equal(costEst.cacheHitRatio({ cache_read_input_tokens: 0, cache_creation_input_tokens: 100 }), 0);
  assert.equal(costEst.cacheHitRatio({ cache_read_input_tokens: 100, cache_creation_input_tokens: 0 }), 1);
});

test('cacheHitRatio returns null when both inputs are zero', () => {
  assert.equal(costEst.cacheHitRatio({ cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }), null);
  assert.equal(costEst.cacheHitRatio(null), null);
});
