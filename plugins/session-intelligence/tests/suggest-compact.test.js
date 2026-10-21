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

function calloutRun(sid, model, usage, { env = {}, shape = null } = {}) {
  const { home, state } = sandbox();
  try {
    if (shape) {
      fs.writeFileSync(path.join(state, `claude-ctx-shape-${sid}.jsonl`),
        shape.map((e) => JSON.stringify(e)).join('\n') + '\n');
    }
    const t = writeTranscript(home, [userLine, usageLine(model, usage)]);
    return runHook('si-suggest-compact.js',
      { session_id: sid, transcript_path: t, cwd: home, tool_name: 'Read' }, { home, env });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

test('callout headline carries bucketed fill, window label and auto-compaction point', () => {
  const r = calloutRun('sid-num1', 'claude-opus-5-5', {
    input_tokens: 8000, cache_creation_input_tokens: 0, cache_read_input_tokens: 480000, output_tokens: 50,
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /\[StrategicCompact\] High-risk zone — context at ~45% of a 1M window; auto-compaction at ~967k \(~450k away\)\. Advisory only/);
  assert.doesNotMatch(r.stderr, /spent/);
});

test('callout says 200k window under CLAUDE_CODE_DISABLE_1M_CONTEXT=1 and names the configured window', () => {
  const r = calloutRun('sid-num2', 'claude-opus-5-5', {
    input_tokens: 5000, cache_creation_input_tokens: 0, cache_read_input_tokens: 40000, output_tokens: 50,
  }, { env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '150000' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /\[StrategicCompact\] Caution zone — context at ~20% of a 200k window; auto-compaction at ~150k \(~100k away\)/);
});

test('callout counts large results from the shape log', () => {
  const shape = [0, 1, 2].map((i) => ({
    t: 1000 + i, tok: 1000 * (i + 1), tool: 'Bash', root: 'src', file: null, event: null, chars: 70000, inputHash: `h${i}`,
  }));
  const r = calloutRun('sid-num3', 'claude-opus-5-5', {
    input_tokens: 10000, cache_creation_input_tokens: 0, cache_read_input_tokens: 200000, output_tokens: 50,
  }, { shape });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /3 tool results ≥20K tokens in the last 40 calls\./);
});

test('stablePrefix=true still omits the numbers segment', () => {
  const r = calloutRun('sid-num4', 'claude-opus-5-5', {
    input_tokens: 10000, cache_creation_input_tokens: 0, cache_read_input_tokens: 200000, output_tokens: 50,
  }, { env: { CLAUDE_COMPACT_STABLE_PREFIX: '1' } });
  assert.equal(r.status, 2);
  const head = r.stderr.split('\n').find((l) => l.includes('[StrategicCompact]'));
  assert.ok(head && !head.includes('%'), head);
});

function shapeEntries(events) {
  return events.map((event, i) => JSON.stringify({
    t: 1000 + i, tok: 1000 * (i + 1), tool: 'Bash', root: 'src', file: `src/f${i}.js`, event, chars: 100, inputHash: `p${i}`,
  })).join('\n') + '\n';
}

function phaseRun(events) {
  const { home, state } = sandbox();
  const sid = 'sid-phase';
  fs.writeFileSync(path.join(state, `claude-ctx-shape-${sid}.jsonl`), shapeEntries(events));
  const t = writeTranscript(home, [userLine, usageLine('claude-opus-5-5', {
    input_tokens: 10000, cache_creation_input_tokens: 0, cache_read_input_tokens: 200000, output_tokens: 50,
  })]);
  const r = runHook('si-suggest-compact.js',
    { session_id: sid, transcript_path: t, cwd: home, tool_name: 'Read' }, { home });
  fs.rmSync(home, { recursive: true, force: true });
  return r;
}

test('callout names a fresh phase marker as a compaction boundary', () => {
  const r = phaseRun([null, null, null, 'commit', null]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('A commit just landed — natural compaction boundary; `/compact` now carries the least in-flight state.'), r.stderr);
  assert.match(r.stderr, /\[StrategicCompact\] Caution zone — context at ~/);
});

test('callout omits the boundary line when the newest phase marker is older than 5 entries', () => {
  const r = phaseRun(['push', null, null, null, null, null]);
  assert.equal(r.status, 2);
  assert.equal(r.stderr.includes('natural compaction boundary'), false);
});

test('stablePrefix mode suppresses the phase boundary line', () => {
  const { home, state } = sandbox();
  try {
    const sid = 'sid-phase-stable';
    fs.writeFileSync(path.join(state, `claude-ctx-shape-${sid}.jsonl`), shapeEntries([null, 'commit']));
    fs.writeFileSync(path.join(home, '.claude', 'session-intelligence.json'),
      JSON.stringify({ compact: { stablePrefix: true } }));
    const t = writeTranscript(home, [userLine, usageLine('claude-opus-5-5', {
      input_tokens: 10000, cache_creation_input_tokens: 0, cache_read_input_tokens: 200000, output_tokens: 50,
    })]);
    const r = runHook('si-suggest-compact.js',
      { session_id: sid, transcript_path: t, cwd: home, tool_name: 'Read' }, { home });
    assert.equal(r.status, 2);
    assert.equal(r.stderr.includes('natural compaction boundary'), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('suggest-compact records one cache_hits row per message id across runs', () => {
  const { home } = sandbox();
  try {
    const sid = 'sid-cachehit';
    const t = writeTranscript(home, [userLine, usageLine('claude-opus-5-5', {
      input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 200000, output_tokens: 50,
    })]);
    const payload = { session_id: sid, transcript_path: t, cwd: home, tool_name: 'Read' };
    runHook('si-suggest-compact.js', payload, { home });
    runHook('si-suggest-compact.js', payload, { home });
    const rows = withDb(home, (db) => (db
      ? db.prepare('SELECT message_id, model, ratio, cache_read, context_tokens FROM cache_hits WHERE sid = ?').all(sid)
      : []));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].message_id, 'msg_1');
    assert.equal(rows[0].model, 'claude-opus-5-5');
    assert.equal(rows[0].ratio, 1);
    assert.equal(rows[0].cache_read, 200000);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('callout adds the delegation prompt at 3 or more large results', () => {
  const { largeReadDelegationLine } = require('../lib/shape-signals');
  const shape = [0, 1, 2].map((i) => ({
    t: 1000 + i, tok: 1000 * (i + 1), tool: 'Bash', root: 'src', file: null, event: null, chars: 70000, inputHash: `d${i}`,
  }));
  const r = calloutRun('sid-deleg', 'claude-opus-5-5', {
    input_tokens: 10000, cache_creation_input_tokens: 0, cache_read_input_tokens: 200000, output_tokens: 50,
  }, { shape });
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes(largeReadDelegationLine(3)), r.stderr);
});

test('callout keeps the plain count line below 3 large results', () => {
  const shape = [0, 1].map((i) => ({
    t: 1000 + i, tok: 1000 * (i + 1), tool: 'Bash', root: 'src', file: null, event: null, chars: 70000, inputHash: `e${i}`,
  }));
  const r = calloutRun('sid-deleg2', 'claude-opus-5-5', {
    input_tokens: 10000, cache_creation_input_tokens: 0, cache_read_input_tokens: 200000, output_tokens: 50,
  }, { shape });
  assert.match(r.stderr, /2 tool results ≥20K tokens in the last 40 calls\./);
  assert.doesNotMatch(r.stderr, /Delegate the next wide read/);
});
