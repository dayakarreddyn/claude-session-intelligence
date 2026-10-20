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

function writeRegistryState(home, sid, data) {
  fs.writeFileSync(path.join(home, '.claude', 'state', `claude-constraints-${sid}.json`), JSON.stringify(data));
}

function runHook(home, input, raw) {
  return spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'si-post-compact.js')], {
    input: raw !== undefined ? raw : JSON.stringify(input),
    env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 15000,
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
    assert.equal(row.compact_t, 1000);
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
