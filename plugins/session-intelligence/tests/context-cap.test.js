const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  resolveContextCap, resolveAutoCompactPoint, loadSettingsForCwd,
  isNative1M, fillPctOf, bucketPct, windowLabel,
} = require('../lib/context-cap');

test('resolveContextCap: config override beats everything', () =>
  assert.deepEqual(resolveContextCap({ model: 'claude-opus-5-5', env: {}, configCap: 150000 }), { cap: 150000, source: 'config' }));
test('resolveContextCap: statusline context_window_size beats model id', () =>
  assert.deepEqual(resolveContextCap({ model: 'claude-opus-5-5', env: {}, contextWindowSize: 200000 }), { cap: 200000, source: 'statusline' }));
test('resolveContextCap: CLAUDE_CODE_DISABLE_1M_CONTEXT=1 holds a 1M model to 200000', () =>
  assert.deepEqual(resolveContextCap({ model: 'claude-fable-5-1', env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' } }), { cap: 200000, source: 'env-disable-1m' }));
test('resolveContextCap: CLAUDE_CODE_MAX_CONTEXT_TOKENS applies to unrecognised ids only', () => {
  assert.deepEqual(resolveContextCap({ model: 'gateway-custom-7', env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '400000' } }), { cap: 400000, source: 'env-max-context' });
  assert.equal(resolveContextCap({ model: 'claude-opus-5-5', env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '400000' } }).cap, 1000000);
  assert.equal(resolveContextCap({ model: 'claude-opus-5-5', env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '400000', DISABLE_COMPACT: '1' } }).cap, 400000);
});
test('isNative1M follows the documented list', () => {
  for (const id of ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-4-7', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'Opus 5.5', 'claude-opus-4-6[1m]']) assert.equal(isNative1M(id), true, id);
  for (const id of ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', '']) assert.equal(isNative1M(id), false, id);
});
test('resolveContextCap: unknown id falls back to 200000', () =>
  assert.deepEqual(resolveContextCap({ model: 'mystery', env: {} }), { cap: 200000, source: 'fallback' }));
test('resolveAutoCompactPoint precedence env > modelSettings > settings > default', () => {
  const settings = { autoCompactWindow: 300000, modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 450000 } } };
  assert.deepEqual(resolveAutoCompactPoint({ cap: 1000000, model: 'claude-opus-5-5', env: {}, settings: null }), { point: 967000, source: 'default' });
  assert.deepEqual(resolveAutoCompactPoint({ cap: 200000, model: 'claude-opus-5-5', env: {}, settings: null }), { point: 200000, source: 'default' });
  assert.deepEqual(resolveAutoCompactPoint({ cap: 1000000, model: 'claude-opus-5-5', env: {}, settings }), { point: 450000, source: 'model-settings' });
  assert.deepEqual(resolveAutoCompactPoint({ cap: 1000000, model: 'claude-opus-5-5', env: {}, settings: { modelSettings: { opus: { autoCompactWindow: 420000 } } } }), { point: 420000, source: 'model-settings' }, 'family alias key');
  assert.deepEqual(resolveAutoCompactPoint({ cap: 1000000, model: 'claude-fable-5-1', env: {}, settings }), { point: 300000, source: 'settings' });
  assert.deepEqual(resolveAutoCompactPoint({ cap: 1000000, model: 'claude-opus-5-5', env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' }, settings }), { point: 500000, source: 'env' });
  assert.equal(resolveAutoCompactPoint({ cap: 1000000, model: 'x', env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50' } }).point, 483500);
  assert.equal(resolveAutoCompactPoint({ cap: 200000, model: 'x', env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '900000' } }).point, 200000, 'clamped to cap');
});
test('fillPctOf / bucketPct / windowLabel', () => {
  assert.equal(fillPctOf(480000, 1000000), 48);
  assert.equal(fillPctOf(123456, 1000000), 12.3);
  assert.equal(fillPctOf(100, 0), 0);
  assert.equal(bucketPct(48.9), 45);
  assert.equal(bucketPct(50), 50);
  assert.equal(windowLabel(1000000), '1M');
  assert.equal(windowLabel(200000), '200k');
});
test('loadSettingsForCwd merges user then project then local', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'si-cap-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'proj');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ autoCompactWindow: 100000, other: 1 }));
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), JSON.stringify({ autoCompactWindow: 300000 }));
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ autoCompactWindow: 250000 }));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const s = loadSettingsForCwd(cwd);
    assert.equal(s.autoCompactWindow, 250000);
    assert.equal(s.other, 1);
    fs.writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), '{bad');
    assert.equal(loadSettingsForCwd(cwd).autoCompactWindow, 300000, 'corrupt file skipped');
  } finally {
    process.env.HOME = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
