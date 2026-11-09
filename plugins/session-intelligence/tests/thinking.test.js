'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { estimateThinkingTokens } = require('../lib/thinking');
const { buildRenderers } = require('../statusline/renderers');
const { makeColors } = require('../statusline/format');

function writeRows(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-thinking-'));
  const p = path.join(dir, 't.jsonl');
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}
function row(id, usage, content) {
  return {
    type: 'assistant',
    timestamp: '2026-10-21T00:00:00.000Z',
    message: { id, role: 'assistant', content, usage },
  };
}
function asst(id, { thinking_tokens }) {
  return row(id, { input_tokens: 32, output_tokens: 1142, output_tokens_details: { thinking_tokens } },
    [{ type: 'thinking', thinking: '', signature: 's' }]);
}
function asstLegacy(id, { output_tokens, text }) {
  return row(id, { input_tokens: 32, output_tokens },
    [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text }]);
}
const pick = (r) => ({ total: r.total, turns: r.turns, exact: r.exact });

test('counts a streamed message once using exact thinking_tokens', () => {
  const p = writeRows([asst('m1', { thinking_tokens: 701 }), asst('m1', { thinking_tokens: 701 }), asst('m1', { thinking_tokens: 701 })]);
  assert.deepEqual(pick(estimateThinkingTokens(p)), { total: 701, turns: 1, exact: true });
});

test('sums exact thinking across messages', () => {
  const p = writeRows([asst('m1', { thinking_tokens: 701 }), asst('m2', { thinking_tokens: 1200 }), asst('m2', { thinking_tokens: 1200 })]);
  const r = estimateThinkingTokens(p);
  assert.deepEqual(pick(r), { total: 1901, turns: 2, exact: true });
  assert.equal(r.recent, 1901);
  assert.equal(r.lastTurnAgo, 0);
});

test('falls back to the residual estimate when the field is absent', () => {
  // 400 visible chars / 4 = 100 tokens; residual = 900 - 100 = 800
  const p = writeRows([asstLegacy('m1', { output_tokens: 900, text: 'x'.repeat(400) })]);
  const r = estimateThinkingTokens(p);
  assert.equal(r.exact, false);
  assert.equal(r.total, 800);
});

test('thinking cell carries ~ when the count is estimated', () => {
  const R = buildRenderers(makeColors(false), {});
  const exact = R.thinking({}, { cfg: { thinkingMinDisplay: 0 }, thinking: { recent: 1901, exact: true } });
  const est = R.thinking({}, { cfg: { thinkingMinDisplay: 0 }, thinking: { recent: 1901, exact: false } });
  assert.doesNotMatch(exact, /~/);
  assert.match(est, /~/);
});
