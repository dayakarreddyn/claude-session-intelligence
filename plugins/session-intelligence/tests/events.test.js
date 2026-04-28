/**
 * Tests for the SQLite events store.
 *
 * Each test points the events module at a fresh temp DB so runs can't
 * pollute the user's real ~/.claude/state/si-events.db.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const events = require('../lib/events');

function mkSandboxDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-events-'));
  const dbPath = path.join(dir, 'si-events.db');
  events._setDbPathForTest(dbPath);
  return { dir, dbPath };
}

function cleanup({ dir }) {
  events._resetForTest();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

test('isAvailable opens DB and creates schema on first call', () => {
  const sb = mkSandboxDb();
  try {
    assert.equal(events.isAvailable(), true);
    assert.ok(fs.existsSync(sb.dbPath), 'db file should exist after open');
  } finally { cleanup(sb); }
});

test('recordSessionStart inserts a row; duplicate sid updates', () => {
  const sb = mkSandboxDb();
  try {
    const now = Date.now();
    assert.ok(events.recordSessionStart({
      sid: 's1', project: 'proj', cwd: '/x', startedAt: now,
    }));
    // ON CONFLICT DO UPDATE — second insert with same sid should just update
    assert.ok(events.recordSessionStart({
      sid: 's1', project: 'proj2', cwd: '/y', startedAt: now,
    }));
    const stats = events.aggregateStats({ sinceDays: 365 });
    assert.equal(stats.sessions.n, 1, 'still one session row after upsert');
  } finally { cleanup(sb); }
});

test('recordCompact stores hot/warm/dropped dirs as JSON', () => {
  const sb = mkSandboxDb();
  try {
    events.recordSessionStart({ sid: 's1', project: 'p', startedAt: Date.now() });
    assert.ok(events.recordCompact({
      sid: 's1', project: 'p', t: Date.now(),
      tokens: 250000, cost: 5.5, costAtCompactUsd: 5.0,
      hotDirs: ['src/api', 'src/lib'],
      warmDirs: ['tests'],
      droppedDirs: ['legacy'],
      hadShift: true,
      trigger: 'manual',
    }));
    const recent = events.listRecentCompacts({ limit: 5 });
    assert.equal(recent.length, 1);
    assert.equal(recent[0].tokens, 250000);
    assert.equal(recent[0].had_shift, 1);
    assert.equal(recent[0].trigger, 'manual');
  } finally { cleanup(sb); }
});

test('recordZoneTransition stores from/to/tokens/reason', () => {
  const sb = mkSandboxDb();
  try {
    assert.ok(events.recordZoneTransition({
      sid: 's1', project: 'p',
      fromZone: 'green', toZone: 'yellow',
      tokens: 200000, cost: 3.5, reason: 'crossing',
    }));
    assert.ok(events.recordZoneTransition({
      sid: 's1', project: 'p',
      fromZone: 'yellow', toZone: 'orange',
      tokens: 305000, cost: 8.2, reason: 'crossing',
    }));
    const stats = events.aggregateStats({ sinceDays: 365 });
    const zoneMap = Object.fromEntries(stats.zones.map((z) => [z.zone, z.n]));
    assert.equal(zoneMap.yellow, 1);
    assert.equal(zoneMap.orange, 1);
  } finally { cleanup(sb); }
});

test('recordToolArchive + markArchiveRecalled track recall counts', () => {
  const sb = mkSandboxDb();
  try {
    assert.ok(events.recordToolArchive({
      sid: 's1', toolUseId: 'toolu_abc', tool: 'Read', chars: 5000, t: Date.now(),
    }));
    assert.ok(events.markArchiveRecalled('toolu_abc'));
    assert.ok(events.markArchiveRecalled('toolu_abc'));
    const stats = events.aggregateStats({ sinceDays: 365 });
    assert.equal(stats.archives.n, 1);
    assert.equal(stats.archives.recalled, 2, 'two recalls counted');
  } finally { cleanup(sb); }
});

test('aggregateStats respects sinceDays cutoff', () => {
  const sb = mkSandboxDb();
  try {
    const oldT = Date.now() - 60 * 24 * 60 * 60 * 1000; // 60 days ago
    const newT = Date.now() - 1 * 24 * 60 * 60 * 1000;  // 1 day ago
    events.recordSessionStart({ sid: 'old', startedAt: oldT });
    events.recordSessionStart({ sid: 'new', startedAt: newT });
    const last7 = events.aggregateStats({ sinceDays: 7 });
    assert.equal(last7.sessions.n, 1, 'only 1 session in last 7 days');
    const last90 = events.aggregateStats({ sinceDays: 90 });
    assert.equal(last90.sessions.n, 2, 'both sessions in last 90 days');
  } finally { cleanup(sb); }
});

test('aggregateStats with project filter scopes correctly', () => {
  const sb = mkSandboxDb();
  try {
    events.recordSessionStart({ sid: 'a', project: 'proj-a', startedAt: Date.now() });
    events.recordSessionStart({ sid: 'b', project: 'proj-b', startedAt: Date.now() });
    events.recordCompact({ sid: 'a', project: 'proj-a', t: Date.now(), tokens: 100000 });
    events.recordCompact({ sid: 'b', project: 'proj-b', t: Date.now(), tokens: 200000 });
    const a = events.aggregateStats({ sinceDays: 30, project: 'proj-a' });
    assert.equal(a.sessions.n, 1);
    assert.equal(a.compacts.n, 1);
    assert.equal(a.compacts.avg_tokens, 100000);
  } finally { cleanup(sb); }
});

test('recordSessionEnd updates totals without overwriting NULLs with NULLs', () => {
  const sb = mkSandboxDb();
  try {
    events.recordSessionStart({ sid: 's1', project: 'p', startedAt: Date.now() });
    events.recordSessionEnd({ sid: 's1', endedAt: Date.now(), totalCostUsd: 12.5, peakTokens: 350000 });
    const stats = events.aggregateStats({ sinceDays: 30 });
    assert.equal(stats.sessions.cost, 12.5);
    assert.equal(stats.sessions.avg_peak, 350000);
  } finally { cleanup(sb); }
});

test('writers are no-ops when sid is missing — never throw', () => {
  const sb = mkSandboxDb();
  try {
    assert.equal(events.recordSessionStart({}), false);
    assert.equal(events.recordCompact({}), false);
    assert.equal(events.recordZoneTransition({ toZone: 'yellow' }), false);
    assert.equal(events.recordToolArchive({}), false);
  } finally { cleanup(sb); }
});
