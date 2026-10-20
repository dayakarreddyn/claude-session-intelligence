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

// ── cache savings ────────────────────────────────────────────────────────

test('savedFromUsage returns 0 when no cache_read', () => {
  assert.equal(costEst.savedFromUsage({ cache_read_input_tokens: 0 }), 0);
  assert.equal(costEst.savedFromUsage(null), 0);
});

test('savedFromUsage computes delta × tokens / 1M', () => {
  // read=100k, input=15/M, cache_read=1.5/M → delta=13.5 → 100000/1_000_000 * 13.5 = 1.35
  const saved = costEst.savedFromUsage({ cache_read_input_tokens: 100_000 });
  assert.ok(Math.abs(saved - 1.35) < 1e-6, `got ${saved}`);
});

test('totalsFromTranscript dedupes streaming-snapshot duplicates by message.id', () => {
  // Real Claude transcripts emit one row per stream chunk update with the
  // same message.id. Without dedupe the totals were over-counted by the
  // chunk multiplier (4-7× in practice).
  const now = '2026-04-19T18:00:00.000Z';
  const usage = { input_tokens: 1000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 5000, output_tokens: 500 };
  const path_ = writeTranscript([
    { type: 'assistant', timestamp: now, message: { id: 'msg_A', usage } },
    { type: 'assistant', timestamp: now, message: { id: 'msg_A', usage } },
    { type: 'assistant', timestamp: now, message: { id: 'msg_A', usage } },
    { type: 'assistant', timestamp: now, message: { id: 'msg_A', usage } },
    { type: 'assistant', timestamp: now, message: { id: 'msg_B', usage } },
  ]);
  const sid = 'dedupe-test-' + Date.now();
  const out = costEst.totalsFromTranscript(path_, sid);
  // 2 distinct message ids × per-turn savings, not 5
  // saved = (100k × 2) / 1M × 13.5 = 2.7
  assert.ok(Math.abs(out.saved - 2.7) < 1e-6, `expected 2 deduped turns, saved=${out.saved}`);
  fs.unlinkSync(path_);
});

test('totalsFromTranscript accumulates cost + saved incrementally', () => {
  const now = '2026-04-19T18:00:00.000Z';
  const path_ = writeTranscript([
    { type: 'assistant', timestamp: now, message: { usage: {
      input_tokens: 1000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 5000, output_tokens: 500,
    } } },
    { type: 'assistant', timestamp: now, message: { usage: {
      input_tokens: 500, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 1000, output_tokens: 200,
    } } },
  ]);
  const sid = 'totals-test-' + Date.now();
  const out = costEst.totalsFromTranscript(path_, sid);
  // saved = (100k + 50k) / 1M * 13.5 = 2.025
  assert.ok(Math.abs(out.saved - 2.025) < 1e-6, `saved=${out.saved}`);
  // cost > 0
  assert.ok(out.cost > 0);

  // Second call hits the cache — same result, no re-parse needed.
  const out2 = costEst.totalsFromTranscript(path_, sid);
  assert.equal(out2.saved, out.saved);
  assert.equal(out2.cost, out.cost);

  fs.unlinkSync(path_);
});

test('knownPriceForModel covers Claude 5 family and Opus reprice split', () => {
  // Claude 5 family — Fable / Mythos at $10/$50.
  assert.equal(costEst.knownPriceForModel('claude-fable-5').input, 10);
  assert.equal(costEst.knownPriceForModel('claude-fable-5').output, 50);
  assert.equal(costEst.knownPriceForModel('claude-mythos-5').input, 10);
  // Opus 4.5+ repriced to $5/$25.
  assert.equal(costEst.knownPriceForModel('claude-opus-4-8').input, 5);
  assert.equal(costEst.knownPriceForModel('claude-opus-4-8').output, 25);
  assert.equal(costEst.knownPriceForModel('claude-opus-4-5-20251101').input, 5);
  // Opus 4.1 and the dated Opus 4 base id stay on legacy $15/$75.
  assert.equal(costEst.knownPriceForModel('claude-opus-4-1-20250805').input, 15);
  assert.equal(costEst.knownPriceForModel('claude-opus-4-20250514').input, 15);
  // Haiku unchanged.
  assert.equal(costEst.knownPriceForModel('claude-haiku-4-5-20251001').input, 1);
  // Unknown family → null; priceForModel falls back to DEFAULT_PRICES.
  assert.equal(costEst.knownPriceForModel('some-other-model'), null);
  assert.equal(costEst.priceForModel('some-other-model'), costEst.DEFAULT_PRICES);
  assert.equal(costEst.knownPriceForModel(null), null);
});

test('sonnet-5 introductory pricing flips to standard on 2026-09-01', () => {
  const during = Date.parse('2026-07-17T00:00:00Z');
  const after  = Date.parse('2026-09-02T00:00:00Z');
  assert.equal(costEst.knownPriceForModel('claude-sonnet-5', during).input, 2);
  assert.equal(costEst.knownPriceForModel('claude-sonnet-5', during).output, 10);
  assert.equal(costEst.knownPriceForModel('claude-sonnet-5', after).input, 3);
  assert.equal(costEst.knownPriceForModel('claude-sonnet-5', after).output, 15);
  // Non-5 sonnets are date-independent.
  assert.equal(costEst.knownPriceForModel('claude-sonnet-4-6', during).input, 3);
});

test('totalsFromTranscript prices each turn by its own model', () => {
  const now = '2026-07-17T10:00:00.000Z';
  const path_ = writeTranscript([
    // Haiku turn: 1M output at $5/MTok = $5.
    { type: 'assistant', timestamp: now, message: { id: 'pm1', model: 'claude-haiku-4-5-20251001', usage: {
      input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1_000_000,
    } } },
    // Fable turn: 1M output at $50/MTok = $50.
    { type: 'assistant', timestamp: now, message: { id: 'pm2', model: 'claude-fable-5', usage: {
      input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1_000_000,
    } } },
    // Unknown model → falls back to the flat price list arg (default $75/MTok).
    { type: 'assistant', timestamp: now, message: { id: 'pm3', model: 'mystery-model', usage: {
      input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1_000_000,
    } } },
  ]);
  const out = costEst.totalsFromTranscript(path_, 'permodel-test-' + Date.now());
  assert.ok(Math.abs(out.cost - 130) < 1e-6, `expected 5 + 50 + 75 = 130, got ${out.cost}`);
  fs.unlinkSync(path_);
});

test('totalsFromTranscript accumulates per-model cost buckets', () => {
  const now = '2026-07-17T10:00:00.000Z';
  const path_ = writeTranscript([
    { type: 'assistant', timestamp: now, message: { id: 'bm1', model: 'claude-fable-5', usage: {
      input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1_000_000,
    } } }, // $50
    { type: 'assistant', timestamp: now, message: { id: 'bm2', model: 'claude-haiku-4-5-20251001', usage: {
      input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1_000_000,
    } } }, // $5
    { type: 'assistant', timestamp: now, message: { id: 'bm3', model: 'claude-fable-5', usage: {
      input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1_000_000,
    } } }, // $50 more fable
  ]);
  const sid = 'bymodel-test-' + Date.now();
  const out = costEst.totalsFromTranscript(path_, sid);
  assert.ok(Math.abs(out.byModel['claude-fable-5'] - 100) < 1e-6, `fable=${out.byModel['claude-fable-5']}`);
  assert.ok(Math.abs(out.byModel['claude-haiku-4-5-20251001'] - 5) < 1e-6);
  // Cached second read returns the same buckets (round-trips through the v4 cache).
  const out2 = costEst.totalsFromTranscript(path_, sid);
  assert.deepEqual(out2.byModel, out.byModel);
  fs.unlinkSync(path_);
});

test('Claude 5.5-era rows win over family prefixes', () => {
  assert.deepEqual(costEst.knownPriceForModel('claude-fable-5-1'), { input: 10, cache_creation: 12.50, cache_creation_1h: 20, cache_read: 0.25, output: 50 });
  assert.deepEqual(costEst.knownPriceForModel('claude-mythos-5-1'), { input: 10, cache_creation: 12.50, cache_creation_1h: 20, cache_read: 0.25, output: 50 });
  assert.deepEqual(costEst.knownPriceForModel('claude-opus-5-5'), { input: 4, cache_creation: 5, cache_creation_1h: 8, cache_read: 0.20, output: 20 });
  assert.deepEqual(costEst.knownPriceForModel('claude-sonnet-5-5', Date.parse('2026-10-19')), { input: 2, cache_creation: 2.50, cache_creation_1h: 4, cache_read: 0.10, output: 10 });
  assert.equal(costEst.knownPriceForModel('claude-fable-5').cache_read, 1.00, 'Fable 5 row unchanged');
});

test('Haiku 5.5 tiers at 100,000 context tokens', () => {
  const p = costEst.knownPriceForModel('claude-haiku-5-5');
  assert.equal(costEst.costFromUsage({ input_tokens: 100000 }, p), 0.01);
  assert.ok(Math.abs(costEst.costFromUsage({ input_tokens: 100001 }, p) - 0.0500005) < 1e-9);
  assert.equal(costEst.tierFor(p, 50000).input, 0.10);
  assert.equal(costEst.tierFor(p, 150000).input, 0.50);
  assert.equal(costEst.tierFor(costEst.DEFAULT_PRICES, 1).input, costEst.DEFAULT_PRICES.input);
  // savedFromUsage must not NaN on a tiered row.
  assert.ok(Number.isFinite(costEst.savedFromUsage({ cache_read_input_tokens: 200000 }, p)));
});

test('costFromUsage bills 1h cache writes at the 1h rate when the breakdown is present', () => {
  const p = costEst.knownPriceForModel('claude-fable-5-1');
  assert.equal(costEst.costFromUsage({ cache_creation_input_tokens: 1000000, cache_creation: { ephemeral_1h_input_tokens: 1000000, ephemeral_5m_input_tokens: 0 } }, p), 20);
  assert.equal(costEst.costFromUsage({ cache_creation_input_tokens: 1000000 }, p), 12.5);
  assert.equal(costEst.costFromUsage({ cache_creation_input_tokens: 1000000, cache_creation: { ephemeral_1h_input_tokens: 500000 } }, p), 16.25);
  // Rows without a 1h rate fall back to cache_creation x 1.6.
  const old = costEst.knownPriceForModel('claude-fable-5');
  assert.ok(Math.abs(costEst.costFromUsage({ cache_creation_input_tokens: 1000000, cache_creation: { ephemeral_1h_input_tokens: 1000000 } }, old) - 20) < 1e-9);
});
