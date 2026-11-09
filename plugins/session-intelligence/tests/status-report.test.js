'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const REPORT = path.join(__dirname, '..', 'hooks', 'si-status-report.js');

function run(contextTokens, sid) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'si-sr-home-'));
  const state = path.join(home, '.claude', 'state');
  fs.mkdirSync(state, { recursive: true });
  // A 3,000,000 estimate on disk must never drive the zone.
  fs.writeFileSync(path.join(state, `claude-token-budget-${sid}`), '3000000');
  const lines = contextTokens
    ? [JSON.stringify({ type: 'assistant', message: { id: 'm', model: 'claude-opus-5-5', usage: { input_tokens: contextTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })]
    : [JSON.stringify({ type: 'user', message: { content: 'hi' } })];
  const transcript = path.join(home, 't.jsonl');
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
  const env = { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: home };
  for (const k of ['CLAUDE_CODE_DISABLE_1M_CONTEXT', 'CLAUDE_CODE_MAX_CONTEXT_TOKENS']) delete env[k];
  const input = JSON.stringify({ session_id: sid, transcript_path: transcript, model: 'claude-opus-5-5' });
  return spawnSync(process.execPath, [REPORT], { input, env, encoding: 'utf8' }).stdout;
}

test('status report derives the zone from the real usage and the resolved cap', () => {
  const out = run(450000, 'sr1');
  assert.match(out, /450\.0k.*\(red zone\)/);
});

test('status report shows no zone for a session without a usage line', () => {
  const out = run(0, 'sr2');
  assert.doesNotMatch(out, /\(\w+ zone\)/);
  assert.doesNotMatch(out, /3\.00M/);
});
