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
const { openDatabase } = require('../lib/sqlite-driver');

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
    // First open creates the schema + sets user_version=1 (no rows to backfill).
    assert.equal(events.isAvailable(), true);
    events._resetForTest();

    // Hand-seed rows the way the OLD, disagreeing writers would have: the
    // session has the canonical basename, but compacts/zone have the encoded
    // slug and the cwd leaf respectively. Then force the migration to re-run.
    const raw = openDatabase(sb.dbPath).db;
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
    const verify = openDatabase(sb.dbPath).db;
    const orphan = verify.prepare("SELECT project FROM zone_transitions WHERE sid='agent-xyz'").get();
    verify.close();
    assert.equal(orphan.project, 'orphan', 'sid without a session is left untouched');
  } finally { cleanup(sb); }
});

test('reconcileWorkflowAgents backfills workflow agents + dedups + attributes by sid', () => {
  const sb = mkSandboxDb();
  const agentUsage = require('../lib/agent-usage');
  const projRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'si-wf-recon-'));
  try {
    const cwd = '/Users/x/DWS/CSM';
    const enc = agentUsage.encodeProjectPath(cwd);
    // The launching session must exist so the sid-join attributes the agent
    // row to project=CSM.
    events.recordSessionStart({ sid: 'sid-1', project: 'CSM', cwd, startedAt: Date.now() });

    const wfAgent = path.join(projRoot, enc, 'sid-1', 'subagents', 'workflows', 'wf_aaa', 'agent-111.jsonl');
    fs.mkdirSync(path.dirname(wfAgent), { recursive: true });
    fs.writeFileSync(wfAgent, JSON.stringify({
      type: 'assistant',
      agentId: 'agent-111',
      timestamp: '2026-06-01T10:00:00.000Z',
      message: {
        id: 'm1', model: 'claude-opus-4-8',
        usage: { input_tokens: 13890, cache_creation_input_tokens: 19028, cache_read_input_tokens: 0, output_tokens: 1 },
      },
    }) + '\n');

    // First reconcile inserts the row.
    assert.equal(events.reconcileWorkflowAgents({ cwd, projectsRoot: projRoot }), 1);
    // Second reconcile is idempotent — agentId already recorded.
    assert.equal(events.reconcileWorkflowAgents({ cwd, projectsRoot: projRoot }), 0);

    // It lands in the agent stats, attributed to project=CSM, typed 'workflow'.
    const stats = events.aggregateStats({ sinceDays: 3650, project: 'CSM' });
    assert.equal(stats.agents.n, 1, 'workflow agent counted under project=CSM');
    assert.equal(stats.agents.input_tokens, 13890);
    const wf = stats.agentTypes.find((a) => a.type === 'workflow');
    assert.ok(wf && wf.n === 1, 'subagent_type recorded as workflow');
    assert.ok(stats.agents.cost_usd > 0, 'cost computed from opus pricing');
  } finally {
    events._resetForTest();
    try { fs.rmSync(projRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    cleanup(sb);
  }
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

test('reconcileSubagentUsage backfills blind tracker rows by parentToolUseId', () => {
  const sb = mkSandboxDb();
  const agentUsage = require('../lib/agent-usage');
  const projRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'si-plain-recon-'));
  try {
    const cwd = '/Users/x/DWS/CSM';
    const enc = agentUsage.encodeProjectPath(cwd);
    events.recordSessionStart({ sid: 'sid-1', project: 'CSM', cwd, startedAt: Date.now() });

    // What si-agent-tracker records for a background-run agent: the row
    // exists but the transcript hadn't flushed, so usage columns are NULL.
    assert.ok(events.recordAgentInvocation({
      sid: 'sid-1', toolUseId: 'toolu_bg_1',
      subagentType: 'Explore', description: 'sweep', t: Date.now(),
    }));

    // By next SessionStart the transcript is complete on disk.
    const tPath = path.join(projRoot, enc, 'sid-1', 'subagents', 'agent-777.jsonl');
    fs.mkdirSync(path.dirname(tPath), { recursive: true });
    fs.writeFileSync(tPath, JSON.stringify({
      type: 'assistant',
      agentId: 'agent-777',
      parentToolUseId: 'toolu_bg_1',
      timestamp: '2026-07-17T09:00:00.000Z',
      message: {
        id: 'm1', model: 'claude-haiku-4-5-20251001',
        usage: { input_tokens: 2000, cache_creation_input_tokens: 100, cache_read_input_tokens: 50000, output_tokens: 400 },
      },
    }) + '\n');

    assert.equal(events.reconcileSubagentUsage({ cwd, projectsRoot: projRoot }), 1);
    // Second run: the row is filled, nothing left to reconcile.
    assert.equal(events.reconcileSubagentUsage({ cwd, projectsRoot: projRoot }), 0);

    const stats = events.aggregateStats({ sinceDays: 30, project: 'CSM' });
    assert.equal(stats.agents.n, 1);
    assert.equal(stats.agents.input_tokens, 2000);
    assert.equal(stats.agents.cache_read_tokens, 50000);
    assert.ok(stats.agents.cost_usd > 0, 'cost filled from haiku pricing');
  } finally {
    events._resetForTest();
    try { fs.rmSync(projRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    cleanup(sb);
  }
});

test('user_version 2 migration reprices agent costs from the per-model table', () => {
  const sb = mkSandboxDb();
  try {
    // First open creates schema and lands on the current user_version.
    assert.equal(events.isAvailable(), true);
    events._resetForTest();

    // Seed a row costed at the old flat Opus table ($15/MTok input), then
    // rewind user_version so the reprice migration re-runs on next open.
    const raw = openDatabase(sb.dbPath).db;
    raw.prepare(`
      INSERT INTO agent_invocations
        (sid, tool_use_id, subagent_type, t, model, input_tokens, output_tokens,
         cache_creation_tokens, cache_read_tokens, cost_usd)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run('s1', 'toolu_rp_1', 'Explore', Date.now(), 'claude-opus-4-8', 1000000, 0, 0, 0, 15.0);
    // A row without tokens must be left untouched.
    raw.prepare(`
      INSERT INTO agent_invocations (sid, tool_use_id, subagent_type, t, model, cost_usd)
      VALUES (?,?,?,?,?,?)
    `).run('s1', 'toolu_rp_2', 'Explore', Date.now(), 'claude-opus-4-8', 9.99);
    raw.pragma('user_version = 1');
    raw.close();

    events._setDbPathForTest(sb.dbPath);
    assert.equal(events.isAvailable(), true);

    const verify = openDatabase(sb.dbPath).db;
    const repriced = verify.prepare("SELECT cost_usd FROM agent_invocations WHERE tool_use_id='toolu_rp_1'").get();
    const untouched = verify.prepare("SELECT cost_usd FROM agent_invocations WHERE tool_use_id='toolu_rp_2'").get();
    const ver = verify.pragma('user_version', { simple: true });
    verify.close();
    // 1M input tokens at Opus 4.8's real $5/MTok — was $15 under the old table.
    assert.ok(Math.abs(repriced.cost_usd - 5.0) < 1e-9, `repriced=${repriced.cost_usd}`);
    assert.equal(untouched.cost_usd, 9.99, 'token-less row not touched');
    assert.ok(ver >= 2, 'user_version advanced');
  } finally { cleanup(sb); }
});

test('reconcileSubagentUsage pairs via parent transcript when parentToolUseId is absent', () => {
  const sb = mkSandboxDb();
  const agentUsage = require('../lib/agent-usage');
  const projRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'si-pair-recon-'));
  try {
    const cwd = '/Users/x/DWS/CSM';
    const enc = agentUsage.encodeProjectPath(cwd);
    events.recordSessionStart({ sid: 'sid-9', project: 'CSM', cwd, startedAt: Date.now() });
    assert.ok(events.recordAgentInvocation({
      sid: 'sid-9', toolUseId: 'toolu_pair_1',
      subagentType: 'Explore', t: Date.now(),
    }));

    // Modern (2.1.x) subagent transcript: has agentId but NO parentToolUseId.
    const tPath = path.join(projRoot, enc, 'sid-9', 'subagents', 'agent-zzz9.jsonl');
    fs.mkdirSync(path.dirname(tPath), { recursive: true });
    fs.writeFileSync(tPath, JSON.stringify({
      type: 'assistant', agentId: 'zzz9', timestamp: '2026-07-17T09:00:00.000Z',
      message: { id: 'm1', model: 'claude-fable-5',
        usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 100000 } },
    }) + '\n');
    // Parent transcript carries the pairing via the launch ack.
    fs.writeFileSync(path.join(projRoot, enc, 'sid-9.jsonl'), JSON.stringify({
      type: 'user', message: { content: [{
        type: 'tool_result', tool_use_id: 'toolu_pair_1',
        content: [{ type: 'text', text: 'Async agent launched successfully. agentId: zzz9 (internal)' }],
      }] },
    }) + '\n');

    assert.equal(events.reconcileSubagentUsage({ cwd, projectsRoot: projRoot }), 1);
    const stats = events.aggregateStats({ sinceDays: 30, project: 'CSM' });
    assert.equal(stats.agents.input_tokens, 1000);
    // 100k output tokens at Fable's $50/MTok = $5.01 with the input cents.
    assert.ok(Math.abs(stats.agents.cost_usd - 5.01) < 1e-6, `cost=${stats.agents.cost_usd}`);
  } finally {
    events._resetForTest();
    try { fs.rmSync(projRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    cleanup(sb);
  }
});

test('agentModelCosts aggregates per-model subagent spend for one session', () => {
  const sb = mkSandboxDb();
  try {
    const now = Date.now();
    events.recordSessionStart({ sid: 's1', project: 'p', startedAt: now });
    events.recordAgentInvocation({ sid: 's1', toolUseId: 't1', subagentType: 'Explore', t: now,
      model: 'claude-opus-4-8', inputTokens: 1000, outputTokens: 100, costUsd: 0.5 });
    events.recordAgentInvocation({ sid: 's1', toolUseId: 't2', subagentType: 'Explore', t: now,
      model: 'claude-opus-4-8', inputTokens: 1000, outputTokens: 100, costUsd: 0.25 });
    events.recordAgentInvocation({ sid: 's1', toolUseId: 't3', subagentType: 'reviewer', t: now,
      model: 'claude-haiku-4-5-20251001', costUsd: 0.05 });
    // Blind row (no usage yet) and another session's row must not appear.
    events.recordAgentInvocation({ sid: 's1', toolUseId: 't4', subagentType: 'bg', t: now });
    events.recordAgentInvocation({ sid: 's2', toolUseId: 't5', subagentType: 'x', t: now,
      model: 'claude-fable-5', costUsd: 9.9 });
    const rows = events.agentModelCosts('s1');
    const byModel = Object.fromEntries(rows.map((r) => [r.model, r.cost_usd]));
    assert.ok(Math.abs(byModel['claude-opus-4-8'] - 0.75) < 1e-9);
    assert.ok(Math.abs(byModel['claude-haiku-4-5-20251001'] - 0.05) < 1e-9);
    assert.equal(rows.length, 2);
    assert.deepEqual(events.agentModelCosts(null), []);
  } finally { cleanup(sb); }
});

test('upsertSessionModelCosts + weeklyModelSpend aggregate parent and agent spend', () => {
  const sb = mkSandboxDb();
  try {
    const now = Date.now();
    events.recordSessionStart({ sid: 's1', project: 'p', startedAt: now });
    // Parent-session splits — second upsert replaces, not accumulates.
    assert.ok(events.upsertSessionModelCosts('s1', { 'claude-fable-5': 50 }));
    assert.ok(events.upsertSessionModelCosts('s1', { 'claude-fable-5': 78, 'claude-opus-4-8': 2 }));
    // Agent spend joins the weekly view.
    events.recordAgentInvocation({ sid: 's1', toolUseId: 'a1', subagentType: 'Explore', t: now,
      model: 'claude-opus-4-8', costUsd: 0.5 });
    const week = events.weeklyModelSpend();
    const byModel = Object.fromEntries(week.map((r) => [r.model, r.cost_usd]));
    assert.ok(Math.abs(byModel['claude-fable-5'] - 78) < 1e-9, `fable=${byModel['claude-fable-5']}`);
    assert.ok(Math.abs(byModel['claude-opus-4-8'] - 2.5) < 1e-9, `opus=${byModel['claude-opus-4-8']}`);
    assert.equal(week[0].model, 'claude-fable-5', 'sorted by spend desc');
    // Old rows age out of the window.
    const raw = openDatabase(sb.dbPath).db;
    raw.prepare('UPDATE session_model_costs SET t = ? WHERE model = ?')
      .run(now - 10 * 24 * 60 * 60 * 1000, 'claude-fable-5');
    raw.close();
    const week2 = events.weeklyModelSpend();
    assert.ok(!week2.find((r) => r.model === 'claude-fable-5'), 'aged-out row excluded');
  } finally { cleanup(sb); }
});

// --- Schema v3: fill columns ------------------------------------------------

const V3_COMPACT_COLS = ['context_cap', 'fill_pct', 'model'];
const V3_ZONE_COLS = ['context_cap', 'fill_pct', 'model', 'trigger'];

function tableCols(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

// Rewind a freshly created DB to its pre-v3 shape (v3 columns dropped) so the
// next open exercises the real ALTER TABLE path, with legacy rows seeded.
function seedPreV3Db(sb, userVersion) {
  assert.equal(events.isAvailable(), true);
  events._resetForTest();
  const raw = openDatabase(sb.dbPath).db;
  for (const c of V3_COMPACT_COLS) raw.exec(`ALTER TABLE compacts DROP COLUMN ${c}`);
  for (const c of V3_ZONE_COLS) raw.exec(`ALTER TABLE zone_transitions DROP COLUMN ${c}`);
  const now = Date.now();
  raw.prepare('INSERT INTO sessions (sid, project, cwd, started_at) VALUES (?,?,?,?)')
    .run('s1', 'CSM', '/x/CSM', now);
  raw.prepare('INSERT INTO compacts (sid, project, t, tokens) VALUES (?,?,?,?)')
    .run('s1', '-x-CSM', now, 100000);
  raw.prepare('INSERT INTO zone_transitions (sid, project, t, to_zone) VALUES (?,?,?,?)')
    .run('s1', 'mm', now, 'red');
  raw.pragma(`user_version = ${userVersion}`);
  raw.close();
  events._setDbPathForTest(sb.dbPath);
}

test('v3 migration adds fill columns to a user_version 2 DB and leaves old rows NULL', () => {
  const sb = mkSandboxDb();
  try {
    seedPreV3Db(sb, 2);
    assert.equal(events.isAvailable(), true);
    events._resetForTest();
    const verify = openDatabase(sb.dbPath).db;
    try {
      const compactCols = tableCols(verify, 'compacts');
      const zoneCols = tableCols(verify, 'zone_transitions');
      for (const c of V3_COMPACT_COLS) assert.equal(compactCols.filter((n) => n === c).length, 1, `compacts.${c} once`);
      for (const c of V3_ZONE_COLS) assert.equal(zoneCols.filter((n) => n === c).length, 1, `zone_transitions.${c} once`);
      assert.equal(verify.prepare('SELECT fill_pct FROM compacts').get().fill_pct, null);
      assert.equal(verify.prepare('SELECT fill_pct FROM zone_transitions').get().fill_pct, null);
      assert.ok(verify.pragma('user_version', { simple: true }) >= 3);
    } finally { verify.close(); }
  } finally { cleanup(sb); }
});

test('v3 migration from user_version 0 runs v1, v2 and v3 in one open', () => {
  const sb = mkSandboxDb();
  try {
    seedPreV3Db(sb, 0);
    assert.equal(events.isAvailable(), true);
    events._resetForTest();
    const verify = openDatabase(sb.dbPath).db;
    try {
      // v1: disagreeing project keys backfilled from sessions.
      assert.equal(verify.prepare('SELECT project FROM compacts').get().project, 'CSM');
      assert.equal(verify.prepare('SELECT project FROM zone_transitions').get().project, 'CSM');
      // v3: fill columns present, old rows NULL.
      assert.ok(V3_COMPACT_COLS.every((c) => tableCols(verify, 'compacts').includes(c)));
      assert.ok(V3_ZONE_COLS.every((c) => tableCols(verify, 'zone_transitions').includes(c)));
      assert.equal(verify.prepare('SELECT fill_pct FROM compacts').get().fill_pct, null);
      assert.equal(verify.pragma('user_version', { simple: true }), require('../lib/events-migrations').SCHEMA_VERSION);
    } finally { verify.close(); }
  } finally { cleanup(sb); }
});

test('v3 migration is a no-op on a second open (no duplicate columns, rows kept)', () => {
  const sb = mkSandboxDb();
  try {
    seedPreV3Db(sb, 2);
    assert.equal(events.isAvailable(), true);
    events._resetForTest();
    const first = openDatabase(sb.dbPath).db;
    const before = { c: tableCols(first, 'compacts'), z: tableCols(first, 'zone_transitions') };
    first.close();
    events._setDbPathForTest(sb.dbPath);
    assert.equal(events.isAvailable(), true);
    events._resetForTest();
    const second = openDatabase(sb.dbPath).db;
    try {
      assert.deepEqual(tableCols(second, 'compacts'), before.c);
      assert.deepEqual(tableCols(second, 'zone_transitions'), before.z);
      assert.equal(second.prepare('SELECT COUNT(*) AS n FROM compacts').get().n, 1);
    } finally { second.close(); }
  } finally { cleanup(sb); }
});

test('recordCompact stores contextCap/fillPct/model; aggregateStats splits fill p50 by trigger', () => {
  const sb = mkSandboxDb();
  try {
    const now = Date.now();
    events.recordSessionStart({ sid: 's1', project: 'p', startedAt: now });
    events.recordCompact({ sid: 's1', project: 'p', t: now, tokens: 480000, contextCap: 1000000, fillPct: 48, model: 'claude-opus-5-5', trigger: 'auto' });
    events.recordCompact({ sid: 's1', project: 'p', t: now + 1, tokens: 300000, contextCap: 1000000, fillPct: 30, model: 'claude-opus-5-5', trigger: 'manual' });
    const s = events.aggregateStats({ sinceDays: 30 });
    assert.deepEqual(s.compactFill, { auto: { n: 1, p50: 48 }, manual: { n: 1, p50: 30 } });
    const latest = events.listRecentCompacts({ limit: 1 })[0];
    assert.equal(latest.fill_pct, 30);
    assert.equal(latest.context_cap, 1000000);
    assert.equal(latest.model, 'claude-opus-5-5');
    assert.equal(s.recentCompacts[0].fill_pct, 30);
  } finally { cleanup(sb); }
});

test('compactFill is empty-safe and ignores rows without fill_pct', () => {
  const sb = mkSandboxDb();
  try {
    const now = Date.now();
    events.recordCompact({ sid: 's1', project: 'p', t: now, tokens: 1, trigger: 'auto' });
    events.recordCompact({ sid: 's1', project: 'p', t: now + 1, tokens: 2, fillPct: Number.NaN, trigger: 'manual' });
    const s = events.aggregateStats({ sinceDays: 30 });
    assert.deepEqual(s.compactFill, { auto: { n: 0, p50: null }, manual: { n: 0, p50: null } });
    assert.equal(events.listRecentCompacts({ limit: 1 })[0].fill_pct, null);
  } finally { cleanup(sb); }
});

test('recordZoneTransition stores contextCap/fillPct/model/trigger', () => {
  const sb = mkSandboxDb();
  try {
    events.recordZoneTransition({ sid: 's1', project: 'p', fromZone: 'green', toZone: 'yellow', tokens: 210000, reason: 'crossing', contextCap: 1000000, fillPct: 21, model: 'claude-fable-5-1', trigger: 'Read' });
    events._resetForTest();
    const verify = openDatabase(sb.dbPath).db;
    try {
      const row = verify.prepare('SELECT context_cap, fill_pct, model, trigger, reason FROM zone_transitions').get();
      assert.deepEqual({ ...row }, { context_cap: 1000000, fill_pct: 21, model: 'claude-fable-5-1', trigger: 'Read', reason: 'crossing' });
    } finally { verify.close(); }
  } finally { cleanup(sb); }
});

test('markArchivePruned flags the archive and aggregateStats reports archives.pruned', () => {
  const sb = mkSandboxDb();
  try {
    assert.ok(events.recordToolArchive({ sid: 's1', toolUseId: 'toolu_p1', tool: 'Read', chars: 60000, t: Date.now() }));
    assert.ok(events.recordToolArchive({ sid: 's1', toolUseId: 'toolu_p2', tool: 'Read', chars: 5000, t: Date.now() }));
    assert.equal(events.aggregateStats({ sinceDays: 365 }).archives.pruned || 0, 0);
    assert.ok(events.markArchivePruned('toolu_p1'));
    const stats = events.aggregateStats({ sinceDays: 365 });
    assert.equal(stats.archives.pruned, 1);
    assert.equal(stats.archives.n, 2);
  } finally { cleanup(sb); }
});

test('recordRerun stores a re-run and aggregateStats reports reruns.n', () => {
  const sb = mkSandboxDb();
  try {
    assert.ok(events.recordRerun({ sid: 's1', t: Date.now(), tool: 'Bash', inputHash: 'x', gapCalls: 11, wasPruned: false }));
    assert.ok(events.recordRerun({ sid: 's1', t: Date.now(), tool: 'Bash', inputHash: 'x', gapCalls: 3, wasPruned: true }));
    const stats = events.aggregateStats({ sinceDays: 365 });
    assert.equal(stats.reruns.n, 2);
    assert.equal(stats.reruns.pruned, 1);
    assert.equal(events.recordRerun({}), false);
  } finally { cleanup(sb); }
});

test('stampCompactOutcomeAfter fills fill_after on the matching compact_t', () => {
  const sb = mkSandboxDb();
  try {
    assert.ok(events.recordCompactOutcome({ sid: 's', t: 2000, compactT: 1000, trigger: 'manual', summaryChars: 10, fillBefore: 48 }));
    assert.equal(events.aggregateStats({ sinceDays: 36500 }).outcomes.avg_fill_after, null);
    assert.equal(events.stampCompactOutcomeAfter({ sid: 's', compactT: 999, fillAfter: 1 }), false, 'non-matching key updates nothing');
    assert.equal(events.stampCompactOutcomeAfter({ sid: 's', compactT: 1000, fillAfter: 9.5 }), true);
    const o = events.aggregateStats({ sinceDays: 36500 }).outcomes;
    assert.equal(o.avg_fill_after, 9.5);
    assert.equal(o.n, 1);
    assert.equal(o.avg_summary_chars, 10);
    assert.equal(o.avg_fill_before_manual, 48);
    assert.equal(o.avg_fill_before_auto, null);
  } finally { cleanup(sb); }
});

test('aggregateStats outcomes averages retention and splits fill_before by trigger', () => {
  const sb = mkSandboxDb();
  try {
    const now = Date.now();
    events.recordCompactOutcome({ sid: 'a', t: now, compactT: 1, trigger: 'auto', summaryChars: 100, retention: 1, fillBefore: 40 });
    events.recordCompactOutcome({ sid: 'b', t: now, compactT: 2, trigger: 'auto', summaryChars: 300, retention: 0.5, fillBefore: 60 });
    events.recordCompactOutcome({ sid: 'c', t: now, compactT: 3, trigger: 'manual', summaryChars: 200, fillBefore: 20 });
    const o = events.aggregateStats({ sinceDays: 30 }).outcomes;
    assert.equal(o.n, 3);
    assert.equal(o.avg_retention, 0.75);
    assert.equal(o.avg_summary_chars, 200);
    assert.equal(o.avg_fill_before_auto, 50);
    assert.equal(o.avg_fill_before_manual, 20);
    assert.equal(events.recordCompactOutcome({}), false);
    assert.equal(events.stampCompactOutcomeAfter({ sid: 'a' }), false);
  } finally { cleanup(sb); }
});

test('recordCacheHit ignores duplicates and aggregateStats averages per model', () => {
  const sb = mkSandboxDb();
  try {
    const base = { sid: 's1', t: Date.now(), model: 'claude-opus-5-5', cacheRead: 1, cacheCreation: 1, contextTokens: 2 };
    events.recordCacheHit({ ...base, messageId: 'm1', ratio: 0.5 });
    events.recordCacheHit({ ...base, messageId: 'm1', ratio: 0.9 });
    events.recordCacheHit({ ...base, messageId: 'm2', ratio: 1 });
    const stats = events.aggregateStats({ sinceDays: 365 });
    assert.deepEqual(stats.cacheHits, [{ model: 'claude-opus-5-5', n: 2, avg_ratio: 0.75 }]);
  } finally { cleanup(sb); }
});

test('reconcileCompactHistory inserts missing (sid, t) rows and is idempotent', () => {
  const sb = mkSandboxDb();
  try {
    const now = Date.now();
    events.recordSessionStart({ sid: 'a', project: 'P', startedAt: now });
    events.recordCompact({ sid: 'a', t: now - 2000, tokens: 100000 });
    const entries = [
      { sid: 'a', t: now - 2000, tokens: 100000 },
      { sid: 'a', t: now - 1000, contextTokens: 300000, fillPct: 30, contextCap: 1000000, trigger: 'manual', cwd: '/r' },
    ];
    assert.equal(events.reconcileCompactHistory(entries), 1);
    assert.equal(events.reconcileCompactHistory(entries), 0);
    assert.equal(events.aggregateStats({ sinceDays: 3650 }).compacts.n, 2);
  } finally { cleanup(sb); }
});

test('compacts total_cost sums each session\'s last cumulative cost, not every row', () => {
  const sb = mkSandboxDb();
  try {
    const now = Date.now();
    events.recordCompact({ sid: 'a', t: now - 2000, tokens: 1, cost: 10 });
    events.recordCompact({ sid: 'a', t: now - 1000, tokens: 1, cost: 25 });
    events.recordCompact({ sid: 'b', t: now - 500, tokens: 1, cost: 5 });
    assert.equal(events.aggregateStats({ sinceDays: 30 }).compacts.total_cost, 30);
  } finally { cleanup(sb); }
});

test('recordCompact and recordZoneTransition take the canonical project from the sessions row', () => {
  const sb = mkSandboxDb();
  try {
    const now = Date.now();
    events.recordSessionStart({ sid: 's', project: 'CSM', cwd: '/x/CSM', startedAt: now });
    events.recordCompact({ sid: 's', project: 'dashboard', t: now, tokens: 1 });
    events.recordZoneTransition({ sid: 's', project: 'mm', toZone: 'red', tokens: 1 });
    const stats = events.aggregateStats({ sinceDays: 30, project: 'CSM' });
    assert.equal(stats.compacts.n, 1);
    assert.equal(stats.zones.find((z) => z.zone === 'red').n, 1);
  } finally { cleanup(sb); }
});

test('recordCompact for an unknown sid creates a minimal sessions row so per-project tables see it', () => {
  const sb = mkSandboxDb();
  try {
    const now = Date.now();
    events.recordCompact({ sid: 'orphan', project: 'ReelCuts', cwd: '/r', t: now, tokens: 1 });
    const row = events.aggregateStats({ sinceDays: 30 }).perProject.find((p) => p.project === 'ReelCuts');
    assert.equal(row.compacts, 1);
  } finally { cleanup(sb); }
});

test('recordAgentInvocation prices a row from tokens when costUsd is absent; unpriced rows are counted', () => {
  const sb = mkSandboxDb();
  try {
    const now = Date.now();
    events.recordAgentInvocation({ sid: 's', toolUseId: 't', subagentType: 'x', t: now, model: 'claude-opus-5-5', inputTokens: 1000000 });
    events.recordAgentInvocation({ sid: 's', toolUseId: 'u', subagentType: 'x', t: now });
    const agents = events.aggregateStats({ sinceDays: 30 }).agents;
    assert.ok(Math.abs(agents.cost_usd - 4.0) < 1e-9);
    assert.equal(agents.unpriced, 1);
  } finally { cleanup(sb); }
});
