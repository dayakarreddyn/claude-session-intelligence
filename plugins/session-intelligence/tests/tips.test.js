'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pickTip, TIP_POOLS } = require('../lib/tips');

test('pickTip returns a string from the pool for each zone', () => {
  for (const zone of ['yellow', 'orange', 'red', 'compact']) {
    const tip = pickTip(zone, 'abc', { day: '2026-01-01' });
    assert.equal(typeof tip, 'string');
    assert.ok(TIP_POOLS[zone].includes(tip), `tip should come from ${zone} pool`);
  }
});

test('pickTip is deterministic for a given (salt, zone, day)', () => {
  const a = pickTip('orange', 'session-xyz', { day: '2026-04-25' });
  const b = pickTip('orange', 'session-xyz', { day: '2026-04-25' });
  assert.equal(a, b);
});

test('pickTip varies across different days with same salt', () => {
  const seen = new Set();
  for (let d = 1; d <= 30; d++) {
    const day = `2026-04-${String(d).padStart(2, '0')}`;
    seen.add(pickTip('yellow', 'fixed-salt', { day }));
  }
  // 3 tips in the yellow pool — 30 days should hit at least 2 distinct
  // entries unless the hash is pathologically unbalanced. Guard against
  // false green on a stuck picker.
  assert.ok(seen.size >= 2, `expected >=2 distinct tips across 30 days, got ${seen.size}`);
});

test('pickTip returns null for unknown zone', () => {
  assert.equal(pickTip('purple', 'abc'), null);
});

test('pickTip tolerates empty salt', () => {
  const tip = pickTip('red', '', { day: '2026-04-25' });
  assert.ok(TIP_POOLS.red.includes(tip));
});
