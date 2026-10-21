'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { withTempHome } = require('./helpers/statusline-fixture');
const { loadEstimate } = require('../statusline/economics');

function withTempTmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-tmp-'));
  const prev = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('loadEstimate reads tool count from the state dir the hook writes to', (t) => {
  const home = withTempHome(t);
  withTempTmpdir(t);
  fs.mkdirSync(path.join(home, '.claude', 'state'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'state', 'claude-tool-count-sidA'), '612');
  fs.writeFileSync(path.join(home, '.claude', 'state', 'claude-token-budget-sidA'), '1500');
  assert.deepEqual(loadEstimate('sidA'), { tokens: 1500, tools: 612, id: 'sidA' });
});

test('loadEstimate still reads a legacy tmpdir file', (t) => {
  withTempHome(t);
  const tmp = withTempTmpdir(t);
  fs.writeFileSync(path.join(tmp, 'claude-tool-count-sidB'), '7');
  assert.equal(loadEstimate('sidB').tools, 7);
});

test('loadEstimate prefers the state dir over a legacy tmpdir file', (t) => {
  const home = withTempHome(t);
  const tmp = withTempTmpdir(t);
  fs.mkdirSync(path.join(home, '.claude', 'state'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'state', 'claude-tool-count-sidC'), '9');
  fs.writeFileSync(path.join(tmp, 'claude-tool-count-sidC'), '3');
  assert.equal(loadEstimate('sidC').tools, 9);
});

test('loadEstimate returns zeros when neither exists', (t) => {
  withTempHome(t);
  withTempTmpdir(t);
  assert.deepEqual(loadEstimate('nope'), { tokens: 0, tools: 0, id: 'nope' });
});
