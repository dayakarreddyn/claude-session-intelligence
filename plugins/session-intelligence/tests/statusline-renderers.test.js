'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRenderers } = require('../statusline/renderers');
const { makeColors } = require('../statusline/format');
const { withTempHome } = require('./helpers/statusline-fixture');

test('modelSplit renders $·share per model and never a weekly-remaining estimate', (t) => {
  withTempHome(t);
  const R = buildRenderers(makeColors(false), { loadUsage: () => null });
  const input = { rate_limits: { seven_day: { used_percentage: 20, resets_at: 2e9 } } };
  const ctx = { sessionId: 'rs1', tokenTotals: { byModel: { 'claude-fable-5-1': 12, 'claude-haiku-5-5': 0.01 } } };
  const out = R.modelSplit(input, ctx);
  assert.doesNotMatch(out, /wr:/);
  assert.match(out, /fable-5-1:\$12·100%/);
  assert.doesNotMatch(out, /haiku/);
});
