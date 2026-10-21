'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const STATUSLINE = path.join(__dirname, '..', 'statusline', 'statusline-intel.js');

function setup(contextTokens) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'si-cmp-home-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'session-intelligence.json'),
    JSON.stringify({ statusline: { fields: ['contextPct'] } }));
  let transcript = null;
  if (contextTokens) {
    transcript = path.join(home, 't.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({
      type: 'assistant',
      message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: contextTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 } },
    }) + '\n');
  }
  return { home, transcript };
}

function render({ home, transcript }, env = {}) {
  const input = { session_id: 'cmp1', cwd: home, transcript_path: transcript, model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' } };
  const base = { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: home };
  for (const k of ['CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_CODE_DISABLE_1M_CONTEXT', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE']) delete base[k];
  const r = spawnSync(process.execPath, [STATUSLINE], { input: JSON.stringify(input), env: { ...base, ...env }, encoding: 'utf8' });
  return r.stdout.replace(/\x1b\[[0-9;]*m/g, '');
}

test('contextPct renders against the auto-compaction point, not the full window', () => {
  const out = render(setup(450000), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' });
  assert.match(out, /cmp:90%/);
});

test('contextPct uses the 1M default point of 967K when no window is configured', () => {
  const out = render(setup(483500));
  assert.match(out, /cmp:50%/);
});

test('contextPct is empty without a usage line', () => {
  const out = render(setup(0));
  assert.doesNotMatch(out, /cmp:/);
});

test('no usage line + large chars/3 estimate file: tokens field renders idle, uncoloured by zone', () => {
  const ctx = setup(0);
  fs.writeFileSync(path.join(ctx.home, '.claude', 'session-intelligence.json'),
    JSON.stringify({ statusline: { fields: ['tokens'] } }));
  fs.writeFileSync(path.join(ctx.home, 'claude-token-budget-cmp1'), '3000000');
  const input = { session_id: 'cmp1', cwd: ctx.home, model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' } };
  const r = spawnSync(process.execPath, [STATUSLINE], {
    input: JSON.stringify(input), encoding: 'utf8',
    env: { ...process.env, HOME: ctx.home, USERPROFILE: ctx.home, TMPDIR: ctx.home },
  });
  assert.match(r.stdout, /idle/);
  assert.doesNotMatch(r.stdout, /3\.0M|3000k|\d+%/);
  assert.doesNotMatch(r.stdout, /\x1b\[(?:31|33|91|38;5;\d+)m[^\x1b]*idle/);
});
