const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('injection template names the real tool-archive dir', () => {
  const t = fs.readFileSync(path.join(__dirname, '..', 'templates', 'claude-md-rules.md'), 'utf8');
  assert.match(t, /~\/\.claude\/state\/claude-tool-archive-<sid>\//);
  assert.doesNotMatch(t, /\$\{TMPDIR\}\/claude-tool-archive/);
});

test('costBand is gone', () => {
  assert.equal(require('../lib/cost-estimation').costBand, undefined);
});
