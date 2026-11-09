/**
 * Tests for the schema/migration and read-side modules split out of lib/events.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const events = require('../lib/events');
const { openDatabase } = require('../lib/sqlite-driver');
const {
  SCHEMA_VERSION, runMigrations, repriceAgentInvocations, GUARDED_ADD_COLUMNS,
} = require('../lib/events-migrations');
const eventsStats = require('../lib/events-stats');

function mkSandboxDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-events-mig-'));
  const dbPath = path.join(dir, 'si-events.db');
  events._setDbPathForTest(dbPath);
  return { dir, dbPath };
}

function cleanup({ dir }) {
  events._resetForTest();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

test('initSchema lands on SCHEMA_VERSION and runMigrations is idempotent', () => {
  const sb = mkSandboxDb();
  try {
    assert.equal(events.isAvailable(), true);
    events._resetForTest();
    const raw = openDatabase(sb.dbPath).db;
    assert.equal(raw.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    assert.deepEqual(runMigrations(raw), { from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    raw.pragma('user_version = 0');
    assert.deepEqual(runMigrations(raw), { from: 0, to: SCHEMA_VERSION });
    raw.close();
  } finally { cleanup(sb); }
});

test('GUARDED_ADD_COLUMNS lists the six agent_invocations ALTERs plus tool_archives.pruned', () => {
  const agentAlters = GUARDED_ADD_COLUMNS.filter((s) => /^ALTER TABLE agent_invocations ADD COLUMN /.test(s));
  assert.equal(agentAlters.length, 6);
  assert.deepEqual(GUARDED_ADD_COLUMNS.filter((s) => !agentAlters.includes(s)),
    ['ALTER TABLE tool_archives ADD COLUMN pruned INTEGER DEFAULT 0']);
});

test('repriceAgentInvocations reprices rows with model+tokens and skips token-less rows', () => {
  const sb = mkSandboxDb();
  try {
    assert.equal(events.isAvailable(), true);
    events._resetForTest();
    const raw = openDatabase(sb.dbPath).db;
    const ins = raw.prepare(`
      INSERT INTO agent_invocations
        (sid, tool_use_id, subagent_type, t, model, input_tokens, output_tokens,
         cache_creation_tokens, cache_read_tokens, cost_usd)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `);
    ins.run('s1', 'toolu_a', 'Explore', Date.now(), 'claude-opus-4-8', 1000000, 0, 0, 0, 15.0);
    raw.prepare(`
      INSERT INTO agent_invocations (sid, tool_use_id, subagent_type, t, model, cost_usd)
      VALUES (?,?,?,?,?,?)
    `).run('s1', 'toolu_b', 'Explore', Date.now(), 'claude-opus-4-8', 9.99);
    assert.equal(repriceAgentInvocations(raw), 1);
    const a = raw.prepare("SELECT cost_usd FROM agent_invocations WHERE tool_use_id='toolu_a'").get();
    const b = raw.prepare("SELECT cost_usd FROM agent_invocations WHERE tool_use_id='toolu_b'").get();
    raw.close();
    assert.ok(Math.abs(a.cost_usd - 5.0) < 1e-9, `repriced=${a.cost_usd}`);
    assert.equal(b.cost_usd, 9.99);
  } finally { cleanup(sb); }
});

test('events-stats.aggregateStats(db) matches events.aggregateStats(opts) on the same DB', () => {
  const sb = mkSandboxDb();
  try {
    const t = Date.now();
    events.recordSessionStart({ sid: 's1', project: 'proj', cwd: '/x', startedAt: t });
    events.recordCompact({ sid: 's1', project: 'proj', cwd: '/x', t, tokens: 123000, cost: 1.5 });
    const viaWrapper = events.aggregateStats({ sinceDays: 7 });
    assert.ok(viaWrapper, 'wrapper returns stats');
    assert.equal(viaWrapper.compacts.n, 1);
    const raw = openDatabase(sb.dbPath).db;
    const direct = eventsStats.aggregateStats(raw, { sinceDays: 7 });
    const recent = eventsStats.listRecentCompacts(raw, { limit: 5 });
    raw.close();
    assert.deepEqual(direct, viaWrapper);
    assert.deepEqual(recent, events.listRecentCompacts({ limit: 5 }));
  } finally { cleanup(sb); }
});

test('lib/events.js stays under 800 lines after the split', () => {
  const lines = fs.readFileSync(path.join(__dirname, '..', 'lib', 'events.js'), 'utf8').split('\n').length;
  assert.ok(lines < 800, `events.js is ${lines} lines`);
});

test('SCHEMA_VERSION equals the highest MIGRATIONS entry and versions are contiguous', () => {
  const { MIGRATIONS } = require('../lib/events-migrations');
  const versions = MIGRATIONS.map((m) => m.version);
  assert.deepEqual(versions, versions.map((_, i) => i + 1));
  assert.equal(SCHEMA_VERSION, versions[versions.length - 1]);
});

test('v4 migration reprices an Opus 5.5 agent row from the generic Opus rate', () => {
  const sb = mkSandboxDb();
  try {
    assert.equal(events.isAvailable(), true);
    events._resetForTest();
    const raw = openDatabase(sb.dbPath).db;
    raw.prepare(`
      INSERT INTO agent_invocations (sid, tool_use_id, subagent_type, t, model, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens, cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run('s1', 'toolu_o55', 'Explore', Date.now(), 'claude-opus-5-5', 1000000, 0, 0, 0, 5.0);
    raw.pragma('user_version = 3');
    raw.close();
    const reopened = openDatabase(sb.dbPath);
    const { runMigrations: run } = require('../lib/events-migrations');
    assert.deepEqual(run(reopened.db), { from: 3, to: 4 });
    const row = reopened.db.prepare("SELECT cost_usd FROM agent_invocations WHERE tool_use_id='toolu_o55'").get();
    assert.equal(reopened.db.pragma('user_version', { simple: true }), 4);
    reopened.db.close();
    assert.ok(Math.abs(row.cost_usd - 4.0) < 1e-9, `cost=${row.cost_usd}`);
  } finally { cleanup(sb); }
});

test('runMigrations stops at the first failing migration: version stays below it and later ones do not run', () => {
  const box = mkSandboxDb();
  try {
    const { db } = openDatabase(path.join(box.dir, 'inj.db'));
    try {
      db.pragma('user_version = 5');
      let laterRan = false;
      const injected = [
        { version: 6, run: () => { throw new Error('boom'); } },
        { version: 7, run: () => { laterRan = true; } },
      ];
      const r = runMigrations(db, injected);
      assert.equal(r.to, 5);
      assert.equal(laterRan, false);
      assert.equal(Number(db.pragma('user_version', { simple: true })), 5);
    } finally { db.close(); }
  } finally { cleanup(box); }
});
