/**
 * Tests for lib/context-shape.js shift-detection guard (M2 from the audit).
 *
 * The bug: shift detection used head/tail SHIFT_WINDOW=10 slices regardless
 * of total entry count. For sessions with < 20 entries those slices
 * overlap, producing a trivial jaccard=1 and masking real pivots.
 *
 * The fix gates the shift check on `withRoot.length >= 2 * SHIFT_WINDOW`,
 * returning `shift: null` for small sessions rather than a misleading
 * "no shift" signal.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { analyzeShape } = require('../lib/context-shape');

// Build entries(n, pattern): tokens monotonically increasing, root chosen
// by callback so tests can shape head vs. tail themselves.
function entries(n, pickRoot) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      t: Date.now() - (n - i) * 1000,
      tok: 1000 * (i + 1),
      tool: 'Read',
      root: pickRoot(i),
      event: null,
    });
  }
  return out;
}

test('analyzeShape returns null when fewer than 5 entries with root', () => {
  const few = entries(4, () => 'src');
  assert.equal(analyzeShape(few), null);
});

test('analyzeShape runs banding but skips shift detection when <20 entries', () => {
  // 10 entries: enough for banding (>=5), too few for shift (requires 2*10)
  const small = entries(10, (i) => i < 5 ? 'src/auth' : 'src/billing');
  const result = analyzeShape(small);
  assert.ok(result, 'banding still produced');
  assert.equal(result.shift, null,
    'shift detection skipped on small sessions to avoid overlap artefacts');
  assert.ok(result.hot || result.warm || result.cold, 'bands still populated');
});

test('analyzeShape detects a real shift when windows do not overlap', () => {
  // 30 entries: first 15 in src/auth, last 15 in src/billing. Clean pivot.
  const pivot = entries(30, (i) => i < 15 ? 'src/auth' : 'src/billing');
  const result = analyzeShape(pivot);
  assert.ok(result, 'result produced');
  assert.ok(result.shift, 'shift detected on non-overlapping windows');
  assert.ok(result.shift.from.includes('src/auth'),
    'from list includes the dropped root');
  assert.ok(result.shift.to.includes('src/billing'),
    'to list includes the new root');
});

test('analyzeShape reports no shift when domain is stable across window', () => {
  const stable = entries(40, () => 'src/main');
  const result = analyzeShape(stable);
  assert.ok(result);
  assert.equal(result.shift, null, 'no shift on stable domain');
});

test('analyzeShape handles empty input without throwing', () => {
  assert.equal(analyzeShape([]), null);
  assert.equal(analyzeShape(null), null);
});
