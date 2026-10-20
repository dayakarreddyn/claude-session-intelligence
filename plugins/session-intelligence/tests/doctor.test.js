'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const DOCTOR = path.join(__dirname, '..', 'hooks', 'si-doctor.js');

function sandbox(settings) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'si-doctor-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'si-doctor-cwd-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  if (settings) fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(settings));
  return { home, cwd };
}

function run({ home, cwd }, stdin, args = [], env = {}) {
  const cleanEnv = { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: home, ...env };
  for (const k of ['CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_CODE_DISABLE_1M_CONTEXT', 'CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE']) {
    if (!(k in env)) delete cleanEnv[k];
  }
  return spawnSync(process.execPath, [DOCTOR, ...args], { input: JSON.stringify(stdin), env: cleanEnv, encoding: 'utf8' });
}

test('doctor recommends autoCompactWindow on a 1M model with no window configured', () => {
  const sb = sandbox();
  const r = run(sb, { session_id: 'doc1', cwd: sb.cwd, model: 'claude-opus-5-5' });
  assert.match(r.stdout, /Context window/);
  assert.match(r.stdout, /resolved cap {2}— 1,000,000 \(model-id: claude-opus-5-5\)/);
  assert.match(r.stdout, /! autoCompactWindow not set — Claude Code compacts this 1M model at ~967K; recommend 400000–500000 via `\/autocompact 450k` \(saved per model under modelSettings\) or "autoCompactWindow": 450000 in ~\/\.claude\/settings\.json/);
});

test('doctor reports a configured window and its source', () => {
  const sb = sandbox({ modelSettings: { opus: { autoCompactWindow: 450000 } } });
  const r = run(sb, { session_id: 'doc2', cwd: sb.cwd, model: 'claude-opus-5-5' });
  assert.match(r.stdout, /✓ autoCompactWindow {2}— 450000 \(model-settings\)/);
  assert.doesNotMatch(r.stdout, /autoCompactWindow not set/);
});

test('doctor accepts the model via --model', () => {
  const sb = sandbox();
  const r = run(sb, { session_id: 'doc3', cwd: sb.cwd }, ['--model', 'claude-opus-5-5']);
  assert.match(r.stdout, /resolved cap {2}— 1,000,000 \(model-id: claude-opus-5-5\)/);
});

test('doctor gives no window advice on a 200K cap', () => {
  const sb = sandbox();
  const r = run(sb, { session_id: 'doc4', cwd: sb.cwd, model: 'claude-opus-5-5' }, [], { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' });
  assert.match(r.stdout, /resolved cap {2}— 200,000 \(env-disable-1m/);
  assert.doesNotMatch(r.stdout, /autoCompactWindow not set/);
});

test('doctor skips the window section when no model is known', () => {
  const sb = sandbox();
  const r = run(sb, { session_id: 'doc5', cwd: sb.cwd });
  assert.doesNotMatch(r.stdout, /resolved cap/);
});
