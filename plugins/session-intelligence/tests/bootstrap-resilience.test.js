'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BOOTSTRAP = path.join(__dirname, '..', 'hooks', 'si-bootstrap.js');

test('STALE_TEMP_PREFIX_RE sweeps usage-cache, context-peak and constraints state files', () => {
  const src = fs.readFileSync(BOOTSTRAP, 'utf8');
  const m = src.match(/const STALE_TEMP_PREFIX_RE = (\/.*\/);/);
  assert.ok(m, 'regex literal found');
  const re = new Function(`return ${m[1]};`)();
  for (const name of ['claude-usage-cache-abc.json', 'claude-context-peak-abc', 'claude-constraints-abc.json', 'claude-tool-archive-abc', 'claude-cost-abc.v5.json', 'claude-cost-sincecompact-abc.v4.json', 'claude-cost-snapshot-abc']) {
    assert.ok(re.test(name), name);
  }
  assert.equal(re.test('claude-unrelated-abc'), false);
});

test('bootstrap exits 0 and still emits additionalContext with corrupt resume-advice input', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'si-boot-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  try {
    const r = spawnSync(process.execPath, [BOOTSTRAP], {
      input: JSON.stringify({
        session_id: 'boot-res', cwd: home, source: 'resume',
        prompt_cache_likely_expired: true, seconds_since_last_response: 'x', estimated_cache_write_usd: {},
      }),
      env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: home },
      encoding: 'utf8', timeout: 60_000,
    });
    assert.equal(r.status, 0, `status=${r.status} stderr=${r.stderr}`);
    const lines = r.stdout.trim().split('\n');
    const out = JSON.parse(lines[lines.length - 1]);
    assert.match(out.hookSpecificOutput.additionalContext, /Resume notice/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
