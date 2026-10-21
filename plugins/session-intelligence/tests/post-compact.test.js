/**
 * Tests for hooks/si-post-compact.js — PostCompact telemetry. Spawn-style with
 * a sandbox HOME; the hook must exit 0 and print nothing on every path.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { openDatabase } = require('../lib/sqlite-driver');

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'si-pc-'));
  const cwd = path.join(home, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'state'), { recursive: true });
  return { home, cwd };
}

// compact-history resolves os.tmpdir() per call, so in-process snapshot reads follow TMPDIR.
function withTmpdir(dir, fn) {
  const prev = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev;
  }
}

function writeRegistryState(home, sid, data) {
  fs.writeFileSync(path.join(home, '.claude', 'state', `claude-constraints-${sid}.json`), JSON.stringify(data));
}

function runHook(home, input, raw) {
  return spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'si-post-compact.js')], {
    input: raw !== undefined ? raw : JSON.stringify(input),
    env: { ...process.env, HOME: home, TMPDIR: home }, encoding: 'utf8', timeout: 15000,
  });
}

function outcomeRows(home, sid) {
  const dbPath = path.join(home, '.claude', 'state', 'si-events.db');
  if (!fs.existsSync(dbPath)) return [];
  const { db } = openDatabase(dbPath);
  try { return db.prepare('SELECT * FROM compact_outcomes WHERE sid = ?').all(sid).map((r) => ({ ...r })); }
  finally { db.close(); }
}

test('si-post-compact records retention against the registry state and the trigger', () => {
  const { home, cwd } = sandbox();
  try {
    const sid = 'pc-sid-1';
    writeRegistryState(home, sid, {
      t: 1000,
      items: [{ type: 'Action', text: 'Never rewrite earlier turns' }, { type: 'Process', text: 'Run npm test before every commit' }],
      contextTokens: 480000, contextCap: 1000000, fillPct: 48, model: 'claude-opus-5-5', trigger: 'auto',
    });
    const r = runHook(home, {
      hook_event_name: 'PostCompact', session_id: sid, cwd, trigger: 'auto',
      compact_summary: 'Summary: the plugin must never rewrite earlier turns. ' + 'x'.repeat(100),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    const rows = outcomeRows(home, sid);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.constraints_total, 2);
    assert.equal(row.constraints_retained, 1);
    assert.equal(row.retention, 0.5);
    assert.equal(row.fill_before, 48);
    assert.equal(row.compact_t, 1000, 'falls back to registry state t without snapshot/compacts row');
    assert.equal(row.trigger, 'auto');
    assert.equal(row.context_cap, 1000000);
    assert.equal(row.model, 'claude-opus-5-5');
    assert.equal(row.fill_after, null);
    assert.equal(row.summary_chars, 154);
    assert.deepEqual(JSON.parse(row.missing), ['Run npm test before every commit']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('si-post-compact without a registry state still records summary length with NULL retention', () => {
  const { home, cwd } = sandbox();
  try {
    const sid = 'pc-sid-2';
    withTmpdir(home, () => require('../lib/compact-history').writeSnapshot(sid, { t: 4242, sid }));
    const r = runHook(home, {
      hook_event_name: 'PostCompact', session_id: sid, cwd, trigger: 'manual', compact_summary: 'a short summary',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    const rows = outcomeRows(home, sid);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].summary_chars, 15);
    assert.equal(rows[0].trigger, 'manual');
    assert.equal(rows[0].constraints_total, null);
    assert.equal(rows[0].retention, null);
    assert.equal(rows[0].compact_t, 4242, 'compact_t comes from the snapshot even without registry state');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('si-post-compact exits 0 with no output on malformed or empty stdin', () => {
  const { home } = sandbox();
  try {
    for (const raw of ['not json {{', '', '{}', '[]']) {
      const r = runHook(home, null, raw);
      assert.equal(r.status, 0, `raw=${JSON.stringify(raw)} ${r.stderr}`);
      assert.equal(r.stdout, '');
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('compact_outcomes fill_before/fill_after chain: pre-compact -> post-compact -> post-tool', () => {
  const { home, cwd } = sandbox();
  const sid = 'pc-chain-' + process.pid;
  const snapFile = path.join(home, `claude-compact-snapshot-${sid}.json`);
  try {
    const env = { ...process.env, HOME: home, TMPDIR: home, CLAUDE_SESSION_ID: sid };
    for (const k of ['CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_DISABLE_1M_CONTEXT', 'DISABLE_COMPACT']) delete env[k];
    const usageLine = (id, tokens, ts) => JSON.stringify({
      type: 'assistant', timestamp: ts,
      message: { id, model: 'claude-opus-5-5', role: 'assistant', content: [],
        usage: { input_tokens: tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 } },
    }) + '\n';
    const transcript = path.join(home, 'transcript.jsonl');
    fs.writeFileSync(transcript, usageLine('msg_1', 480000, '2026-10-19T00:00:00Z'));
    const seed = spawnSync(process.execPath, ['-e',
      `require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'events'))}).recordSessionStart({sid:${JSON.stringify(sid)},project:'p',cwd:${JSON.stringify(cwd)},startedAt:1})`],
    { env, encoding: 'utf8' });
    assert.equal(seed.status, 0, seed.stderr);
    const run = (hook, input) => spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', hook)], {
      input: JSON.stringify(input), env, encoding: 'utf8', timeout: 15000 });

    const pre = run('si-pre-compact.js', { session_id: sid, cwd, transcript_path: transcript, trigger: 'auto', hook_event_name: 'PreCompact' });
    assert.equal(pre.status, 0, pre.stderr);
    const post = run('si-post-compact.js', { hook_event_name: 'PostCompact', session_id: sid, cwd, trigger: 'auto', compact_summary: 'summary' });
    assert.equal(post.status, 0, post.stderr);

    // The post-compact turn lands after the snapshot, at 120k tokens.
    const future = new Date(Date.now() + 60000).toISOString();
    fs.appendFileSync(transcript, usageLine('msg_2', 120000, future));
    const tool = run('si-token-budget.js', { session_id: sid, cwd, transcript_path: transcript,
      hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'a.js') }, tool_response: 'x' });
    assert.equal(tool.status, 0, tool.stderr);

    const snap = withTmpdir(home, () => require('../lib/compact-history').readSnapshot(sid));
    assert.ok(snap && Number.isFinite(snap.t), 'pre-compact wrote a snapshot');
    const [row] = outcomeRows(home, sid);
    assert.ok(row, 'outcome row recorded');
    assert.equal(row.compact_t, snap.t);
    assert.equal(row.fill_before, 48);
    assert.equal(row.fill_after, 12);
  } finally {
    fs.rmSync(snapFile, { force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
