const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { normalise } = require('./helpers/statusline-fixture');

const README = path.join(__dirname, '..', '..', '..', 'README.md');
const GOLDEN = path.join(__dirname, 'fixtures', 'statusline', 'golden', 'a_fable_1m_48pct.txt');
const readme = fs.readFileSync(README, 'utf8');

test('README statusline example matches the golden render of a_fable_1m_48pct', () => {
  const match = readme.match(/<!-- statusline-example -->\n```\n([\s\S]*?)\n```/);
  assert.ok(match, 'README has no <!-- statusline-example --> fenced block');
  const golden = fs.readFileSync(GOLDEN, 'utf8');
  // Both sides go through the same normaliser, so temp paths / durations compare equal.
  assert.equal(normalise(match[1]).trim(), normalise(golden).trim());
});

test('README statusline section has no stale claims', () => {
  const stale = ['wr:~', 'four lines', 'sid:82cc15b9', 'first 8 chars', 'longer than 60 chars',
    'compact:1hr 22m ago', '12hr', '1hr12m', '2d4hr', '/tmp/claude-cost-sincecompact-<sid>', 'zero API requests'];
  for (const s of stale) assert.ok(!readme.includes(s), `stale string present: ${s}`);
  const fresh = ['spendLimit', '~s$', 'thinking_tokens', 'six characters', 'claude-cost-<sid>.v5.json'];
  for (const s of fresh) assert.ok(readme.includes(s), `fresh string missing: ${s}`);
});
