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

test('user_version migration backfills compacts/zone project from sessions via sid', () => {
  const sb = mkSandboxDb();
  try {
    const Sqlite = require('better-sqlite3');
    // First open creates the schema + sets user_version=1 (no rows to backfill).
    assert.equal(events.isAvailable(), true);
    events._resetForTest();

    // Hand-seed rows the way the OLD, disagreeing writers would have: the
    // session has the canonical basename, but compacts/zone have the encoded
    // slug and the cwd leaf respectively. Then force the migration to re-run.
    const raw = new Sqlite(sb.dbPath);
    const now = Date.now();
    raw.prepare('INSERT INTO sessions (sid, project, cwd, started_at) VALUES (?,?,?,?)')
      .run('s1', 'CSM', '/Users/x/DWS/CSM', now);
    raw.prepare('INSERT INTO compacts (sid, project, t, tokens) VALUES (?,?,?,?)')
      .run('s1', '-Users-x-DWS-CSM', now, 100000);
    raw.prepare('INSERT INTO zone_transitions (sid, project, t, to_zone) VALUES (?,?,?,?)')
      .run('s1', 'mm', now, 'red');
    // A row from a subagent sid with no session — must be left untouched.
    raw.prepare('INSERT INTO zone_transitions (sid, project, t, to_zone) VALUES (?,?,?,?)')
      .run('agent-xyz', 'orphan', now, 'orange');
    raw.pragma('user_version = 0');
    raw.close();

    // Re-open through the events module → initSchema runs the backfill.
    events._setDbPathForTest(sb.dbPath);
    assert.equal(events.isAvailable(), true);

    // The single-project filter (the path that was broken) now matches.
    const stats = events.aggregateStats({ sinceDays: 365, project: 'CSM' });
    assert.equal(stats.compacts.n, 1, 'compact row now filters under project=CSM');
    const red = stats.zones.find((z) => z.zone === 'red');
    assert.ok(red && red.n === 1, 'zone transition now filters under project=CSM');

    // Orphan (no session) row keeps its original key.
    const verify = new Sqlite(sb.dbPath);
    const orphan = verify.prepare("SELECT project FROM zone_transitions WHERE sid='agent-xyz'").get();
    verify.close();
    assert.equal(orphan.project, 'orphan', 'sid without a session is left untouched');
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

test('perProject red% denominator is total crossings, not compacts', () => {
  // Regression: renderProjects divided reds by compacts (different event
  // types), so red% could exceed 100%. perProject must expose `crossings`
  // (all zone transitions) so reds/crossings stays bounded at ≤100%.
  const sb = mkSandboxDb();
  try {
    const now = Date.now();
    events.recordSessionStart({ sid: 's1', project: 'p', startedAt: now });
    // Two reds but only one compact — the old reds/compacts math gave 200%.
    events.recordCompact({ sid: 's1', project: 'p', t: now, tokens: 100000 });
    events.recordZoneTransition({ sid: 's1', project: 'p', t: now, toZone: 'yellow' });
    events.recordZoneTransition({ sid: 's1', project: 'p', t: now, toZone: 'red' });
    events.recordZoneTransition({ sid: 's1', project: 'p', t: now, toZone: 'red' });
    const stats = events.aggregateStats({ sinceDays: 30 });
    const p = stats.perProject.find((r) => r.project === 'p');
    assert.ok(p, 'project row present');
    assert.equal(p.reds, 2, 'two red crossings');
    assert.equal(p.crossings, 3, 'three total crossings');
    assert.ok(p.reds <= p.crossings, 'reds never exceed total crossings → red% ≤ 100%');
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
    assert.equal(events.recordAgentInvocation({}), false);
  } finally { cleanup(sb); }
});

test('recordAgentInvocation tracks type, sizes, and error flag', () => {
  const sb = mkSandboxDb();
  try {
    events.recordSessionStart({ sid: 's1', project: 'p', startedAt: Date.now() });
    assert.ok(events.recordAgentInvocation({
      sid: 's1', toolUseId: 'toolu_ag_1',
      subagentType: 'Explore', description: 'find auth code',
      promptChars: 320, responseChars: 4800, t: Date.now(), isError: false,
    }));
    assert.ok(events.recordAgentInvocation({
      sid: 's1', toolUseId: 'toolu_ag_2',
      subagentType: 'Explore', description: 'find routes',
      promptChars: 280, responseChars: 9200, t: Date.now(), isError: false,
    }));
    assert.ok(events.recordAgentInvocation({
      sid: 's1', toolUseId: 'toolu_ag_3',
      subagentType: 'code-reviewer', description: 'review diff',
      promptChars: 150, responseChars: 0, t: Date.now(), isError: true,
    }));
    const stats = events.aggregateStats({ sinceDays: 30 });
    assert.equal(stats.agents.n, 3);
    assert.equal(stats.agents.errors, 1);
    assert.equal(stats.agents.prompt_chars, 750);
    assert.equal(stats.agents.response_chars, 14000);
    const byType = Object.fromEntries(stats.agentTypes.map((t) => [t.type, t.n]));
    assert.equal(byType.Explore, 2);
    assert.equal(byType['code-reviewer'], 1);
  } finally { cleanup(sb); }
});

test('recordAgentInvocation captures model, tokens, duration, cost', () => {
  const sb = mkSandboxDb();
  try {
    events.recordSessionStart({ sid: 's1', project: 'p', startedAt: Date.now() });
    assert.ok(events.recordAgentInvocation({
      sid: 's1', toolUseId: 'toolu_1',
      subagentType: 'Explore', description: 'find x',
      promptChars: 100, responseChars: 2000, durationMs: 12500,
      t: Date.now(), isError: false,
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 1500, outputTokens: 300,
      cacheCreationTokens: 5000, cacheReadTokens: 80000,
      costUsd: 0.0156,
    }));
    assert.ok(events.recordAgentInvocation({
      sid: 's1', toolUseId: 'toolu_2',
      subagentType: 'code-reviewer', description: 'review',
      promptChars: 80, responseChars: 4500, durationMs: 45000,
      t: Date.now(), isError: false,
      model: 'claude-sonnet-4-6',
      inputTokens: 2000, outputTokens: 600,
      cacheCreationTokens: 0, cacheReadTokens: 200000,
      costUsd: 0.075,
    }));
    const stats = events.aggregateStats({ sinceDays: 30 });
    assert.equal(stats.agents.input_tokens, 3500);
    assert.equal(stats.agents.output_tokens, 900);
    assert.equal(stats.agents.cache_read_tokens, 280000);
    assert.equal(stats.agents.total_ms, 57500);
    assert.ok(Math.abs(stats.agents.cost_usd - 0.0906) < 1e-9,
      `cost ${stats.agents.cost_usd}`);
    // agentTypes ranks by cost desc → code-reviewer first
    assert.equal(stats.agentTypes[0].type, 'code-reviewer');
    assert.equal(stats.agentTypes[0].cost_usd, 0.075);
  } finally { cleanup(sb); }
});

test('agent stats respect project filter via session join', () => {
  const sb = mkSandboxDb();
  try {
    const now = Date.now();
    events.recordSessionStart({ sid: 'a', project: 'proj-a', startedAt: now });
    events.recordSessionStart({ sid: 'b', project: 'proj-b', startedAt: now });
    events.recordAgentInvocation({ sid: 'a', subagentType: 'Explore', t: now });
    events.recordAgentInvocation({ sid: 'a', subagentType: 'Explore', t: now });
    events.recordAgentInvocation({ sid: 'b', subagentType: 'code-reviewer', t: now });
    const a = events.aggregateStats({ sinceDays: 7, project: 'proj-a' });
    assert.equal(a.agents.n, 2);
    assert.equal(a.agentTypes.length, 1);
    assert.equal(a.agentTypes[0].type, 'Explore');
    const b = events.aggregateStats({ sinceDays: 7, project: 'proj-b' });
    assert.equal(b.agents.n, 1);
    assert.equal(b.agentTypes[0].type, 'code-reviewer');
  } finally { cleanup(sb); }
});
