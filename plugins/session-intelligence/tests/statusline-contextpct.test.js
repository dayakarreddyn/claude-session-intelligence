'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeHome, writeTranscript, writeConfig, render: renderStatusline, stripAnsi } = require('./helpers/statusline-fixture');

const MODEL = { id: 'claude-opus-5-5', display_name: 'Opus 5.5' };

function setup(t, contextTokens, fields = ['contextPct']) {
  const home = makeHome(t);
  writeConfig(home, fields);
  let transcript = null;
  if (contextTokens) {
    transcript = writeTranscript(home, [{
      type: 'assistant',
      message: { id: 'm1', model: MODEL.id, usage: { input_tokens: contextTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 } },
    }]);
  }
  return { home, transcript };
}

function render({ home, transcript }, env = {}, fields = ['contextPct']) {
  const r = renderStatusline(
    { model: MODEL },
    { home, fields, env, name: 'cmp1', transcript: transcript || false, usageCache: false },
  );
  return stripAnsi(r.stdout);
}

test('contextPct renders against the auto-compaction point, not the full window', (t) => {
  const out = render(setup(t, 450000), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' });
  assert.match(out, /cmp:90%/);
});

test('contextPct uses the 1M default point of 967K when no window is configured', (t) => {
  const out = render(setup(t, 483500));
  assert.match(out, /cmp:50%/);
});

test('contextPct is empty without a usage line', (t) => {
  const out = render(setup(t, 0));
  assert.doesNotMatch(out, /cmp:/);
});

test('no usage line + large chars/3 estimate file: tokens field renders idle, uncoloured by zone', (t) => {
  const ctx = setup(t, 0, ['tokens']);
  fs.writeFileSync(path.join(ctx.home, 'claude-token-budget-golden-cmp1'), '3000000');
  const r = renderStatusline({ model: MODEL }, { home: ctx.home, fields: ['tokens'], name: 'cmp1', transcript: false, usageCache: false, env: { NO_COLOR: '' } });
  assert.match(r.stdout, /idle/);
  assert.doesNotMatch(r.stdout, /3\.0M|3000k|\d+%/);
  assert.doesNotMatch(r.stdout, /\x1b\[(?:31|33|91|38;5;\d+)m[^\x1b]*idle/);
});
