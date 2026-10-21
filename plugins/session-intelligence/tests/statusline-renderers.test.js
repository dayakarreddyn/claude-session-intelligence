'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

test('tokenSpeed renders nothing when the transcript yields no speed sample', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-tps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n');
  const R = buildRenderers(makeColors(false), {});
  const input = { transcript_path: transcript, cost: { total_api_duration_ms: 3_600_000 }, context_window: { total_output_tokens: 503_000 } };
  assert.equal(R.tokenSpeed(input, { tokenTotals: { output: 503_000 } }), '');
});
