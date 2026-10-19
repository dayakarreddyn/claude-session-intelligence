/**
 * End-to-end tests for si-suggest-compact (zone gate) and si-stop (peak),
 * spawned as child processes against a sandbox HOME.
 *
 * Guards: zone decisions read the transcript only (never the chars/4
 * cumulative estimate), zone rows carry cap/fill/model/trigger, the peak file
 * is written per call, and si-stop reports peak_tokens from it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const HOOKS = path.join(__dirname, '..', 'hooks');
const { openDatabase } = require('../lib/sqlite-driver');

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'si-home-'));
  const state = path.join(home, '.claude', 'state');
  fs.mkdirSync(state, { recursive: true });
  return { home, state };
}

function runHook(hookFile, payload, { home, env = {} }) {
  const clean = { ...process.env };
  for (const k of ['CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_DISABLE_1M_CONTEXT', 'DISABLE_COMPACT']) delete clean[k];
  return spawnSync(process.execPath, [path.join(HOOKS, hookFile)], {
    input: JSON.stringify(payload),
    env: { ...clean, HOME: home, CLAUDE_SESSION_ID: payload.session_id || '', ...env },
    encoding: 'utf8',
    timeout: 15_000,
  });
}

function withDb(home, fn) {
  const dbPath = path.join(home, '.claude', 'state', 'si-events.db');
  if (!fs.existsSync(dbPath)) return fn(null);
  const { db } = openDatabase(dbPath);
  try { return fn(db); } finally { db.close(); }
}

const zoneRows = (home, sid) => withDb(home, (db) => (db
  ? db.prepare('SELECT to_zone, tokens, context_cap, fill_pct, model, trigger FROM zone_transitions WHERE sid = ?').all(sid)
  : []));

function writeTranscript(dir, lines) {
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

const userLine = { type: 'user', message: { role: 'user', content: 'hello' } };
const usageLine = (model, usage) => ({
  type: 'assistant',
  message: { id: 'msg_1', role: 'assistant', model, content: [{ type: 'text', text: 'hi' }], usage },
});

test('no callout and no zone row when the transcript has no usage, even with a 3,000,000 estimate file', () => {
  const { home, state } = sandbox();
  try {
    const sid = 'sid-nousage';
    fs.writeFileSync(path.join(state, `claude-token-budget-${sid}`), '3000000');
    const t = writeTranscript(home, [userLine, userLine]);
    const r = runHook('si-suggest-compact.js',
      { session_id: sid, transcript_path: t, cwd: home, tool_name: 'Read' }, { home });
    assert.equal(r.status, 0);
    assert.equal(r.stderr.includes('[StrategicCompact]'), false);
    assert.equal(zoneRows(home, sid).length, 0);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('yellow crossing records contextCap/fillPct/model/trigger on the zone row and writes the peak file', () => {
  const { home, state } = sandbox();
  try {
    const sid = 'sid-yellow';
    const t = writeTranscript(home, [userLine, usageLine('claude-opus-5-5', {
      input_tokens: 10000, cache_creation_input_tokens: 0, cache_read_input_tokens: 200000, output_tokens: 50,
    })]);
    const r = runHook('si-suggest-compact.js',
      { session_id: sid, transcript_path: t, cwd: home, tool_name: 'Read' }, { home });
    assert.equal(r.status, 2);
    const row = zoneRows(home, sid)[0];
    assert.deepEqual({ ...row }, {
      to_zone: 'yellow', tokens: 210000, context_cap: 1000000, fill_pct: 21,
      model: 'claude-opus-5-5', trigger: 'Read',
    });
    assert.equal(fs.readFileSync(path.join(state, `claude-context-peak-${sid}`), 'utf8').trim(), '210000');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('si-stop reports peak_tokens from the peak file, not the cumulative estimate', () => {
  const { home, state } = sandbox();
  try {
    const sid = 'sid-stop';
    const cwd = path.join(home, 'proj');
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(path.join(home, '.claude', 'projects', cwd.replace(/\//g, '-')), { recursive: true });
    fs.writeFileSync(path.join(state, `claude-context-peak-${sid}`), '210000');
    fs.writeFileSync(path.join(state, `claude-token-budget-${sid}`), '3000000');
    const seed = spawnSync(process.execPath, ['-e',
      `require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'events'))}).recordSessionStart({sid:${JSON.stringify(sid)},project:'p',cwd:${JSON.stringify(cwd)},startedAt:1})`],
    { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.equal(seed.status, 0, seed.stderr);
    const r = runHook('si-stop.js', { session_id: sid, cwd }, { home });
    assert.equal(r.status, 0, r.stderr);
    const row = withDb(home, (db) => db.prepare('SELECT peak_tokens FROM sessions WHERE sid = ?').get(sid));
    assert.equal(row.peak_tokens, 210000);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('yellow callout names duplicate reads from the shape log', () => {
  const { home, state } = sandbox();
  try {
    const sid = 'sid-dupreads';
    const entry = (i, tool, root, file, chars) => ({
      t: 1000 + i, tok: 1000 * (i + 1), tool, root, file, event: null, chars, inputHash: `h${i}`,
    });
    const entries = [
      entry(0, 'Read', 'src', 'src/a.js', 30000),
      entry(1, 'Read', 'lib', 'lib/b.js', 100),
      entry(2, 'Read', 'src', 'src/a.js', 30000),
      entry(3, 'Read', 'docs', 'docs/c.md', 100),
      entry(4, 'Read', 'hooks', 'hooks/d.js', 100),
      entry(5, 'Read', 'src', 'src/a.js', 30000),
      entry(6, 'Read', 'tests', 'tests/e.js', 100),
      entry(7, 'Read', 'bin', 'bin/f.js', 100),
    ];
    fs.writeFileSync(path.join(state, `claude-ctx-shape-${sid}.jsonl`),
      entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const t = writeTranscript(home, [userLine, usageLine('claude-opus-5-5', {
      input_tokens: 10000, cache_creation_input_tokens: 0, cache_read_input_tokens: 200000, output_tokens: 50,
    })]);
    const r = runHook('si-suggest-compact.js',
      { session_id: sid, transcript_path: t, cwd: home, tool_name: 'Read' }, { home });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Duplicate reads: src\/a\.js ×3 — later reads add no information; prefer the latest copy\./);
    assert.ok(r.stderr.length < 10000);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
