const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path');
const { makeHome, render, normalise } = require('./helpers/statusline-fixture');
const PAYLOADS = path.join(__dirname, 'fixtures', 'statusline', 'payloads');
const GOLDEN = path.join(__dirname, 'fixtures', 'statusline', 'golden');
for (const file of fs.readdirSync(PAYLOADS).filter((f) => f.endsWith('.json'))) {
  const name = file.replace(/\.json$/, '');
  test(`golden render: ${name}`, (t) => {
    const home = makeHome(t);
    const payload = JSON.parse(fs.readFileSync(path.join(PAYLOADS, file), 'utf8'));
    const r = render(payload, { home });
    assert.equal(r.status, 0, r.stderr);
    const actual = normalise(r.stdout);
    const goldenPath = path.join(GOLDEN, `${name}.txt`);
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(goldenPath, actual);
    assert.equal(actual, fs.readFileSync(goldenPath, 'utf8'));
  });
}
test('golden renders spawn no usage-refresh worker', (t) => {
  const home = makeHome(t);
  const payload = JSON.parse(fs.readFileSync(path.join(PAYLOADS, 'a_fable_1m_48pct.json'), 'utf8'));
  render(payload, { home });
  assert.equal(fs.existsSync(path.join(home, `claude-usage-lock-${require('os').userInfo().uid}.json`)), false);
});

test('entry file alone (sibling modules missing) still prints claude and exits 0', (t) => {
  const { spawnSync } = require('child_process');
  const home = makeHome(t);
  const lone = path.join(home, 'lone');
  fs.mkdirSync(lone);
  const entry = path.join(lone, 'statusline-intel.js');
  fs.copyFileSync(require('./helpers/statusline-fixture').STATUSLINE, entry);
  const r = spawnSync(process.execPath, [entry], {
    input: '{}', encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: home, NO_COLOR: '1' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'claude');
});
