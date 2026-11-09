/**
 * Tests for hooks/si-stop.js side effects that feed /si stats:
 *   - blind subagent rows (background Agent calls) are backfilled from the
 *     completed transcripts, throttled so a chatty session doesn't rescan
 *     every turn;
 *   - the session's cumulative cost is written to the per-day ledger so the
 *     daily trend attributes spend to the day it happened.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const events = require('../lib/events');
const agentUsage = require('../lib/agent-usage');
const { openDatabase } = require('../lib/sqlite-driver');
const { localDayKey } = require('../lib/utils');

const STOP = path.join(__dirname, '..', 'hooks', 'si-stop.js');

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'si-stop-home-'));
  const cwd = '/Users/x/DWS/CSM';
  const enc = cwd.replace(/\//g, '-');
  const projectDir = path.join(home, '.claude', 'projects', enc);
  const stateDir = path.join(home, '.claude', 'state');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  return { home, cwd, enc, projectDir, stateDir, dbPath: path.join(stateDir, 'si-events.db') };
}

function runStop(sb, sid) {
  return spawnSync(process.execPath, [STOP], {
    input: JSON.stringify({ session_id: sid, cwd: sb.cwd }),
    env: { ...process.env, HOME: sb.home, USERPROFILE: sb.home, TMPDIR: sb.home, CLAUDE_SI_DEBUG: '0', CLAUDE_INTEL_QUIET: '1' },
    encoding: 'utf8', timeout: 10000,
  });
}

test('throttleDue is true once per interval and persists its own clock in the marker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-throttle-'));
  try {
    const marker = path.join(dir, 'nested', 'marker');
    const t0 = 1_700_000_000_000;
    assert.equal(agentUsage.throttleDue(marker, 600_000, t0), true, 'first call runs');
    assert.equal(agentUsage.throttleDue(marker, 600_000, t0 + 60_000), false, 'inside the interval waits');
    assert.equal(agentUsage.throttleDue(marker, 600_000, t0 + 660_000), true, 'past the interval runs again');
    assert.equal(agentUsage.throttleDue(marker, 600_000, t0 + 700_000), false, 'and the marker moved forward');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('si-stop backfills a blind subagent row from its completed transcript and writes the day ledger', () => {
  const sb = sandbox();
  const sid = 'stop-sid-1';
  try {
    events._setDbPathForTest(sb.dbPath);
    events.recordSessionStart({ sid, project: 'CSM', cwd: sb.cwd, startedAt: Date.now() });
    assert.ok(events.recordAgentInvocation({
      sid, toolUseId: 'toolu_bg_9', subagentType: 'Explore', description: 'sweep', t: Date.now(),
    }));
    events._resetForTest();

    const tPath = path.join(sb.projectDir, sid, 'subagents', 'agent-900.jsonl');
    fs.mkdirSync(path.dirname(tPath), { recursive: true });
    fs.writeFileSync(tPath, JSON.stringify({
      type: 'assistant', agentId: 'agent-900', parentToolUseId: 'toolu_bg_9',
      timestamp: new Date().toISOString(),
      message: { id: 'm1', model: 'claude-haiku-4-5-20251001',
        usage: { input_tokens: 2000, cache_creation_input_tokens: 100, cache_read_input_tokens: 50000, output_tokens: 400 } },
    }) + '\n');
    fs.writeFileSync(path.join(sb.stateDir, `claude-cost-snapshot-${sid}.json`), JSON.stringify({ total_cost_usd: 12.5 }));

    const r = runStop(sb, sid);
    assert.equal(r.status, 0, r.stderr);

    const db = openDatabase(sb.dbPath).db;
    const agent = db.prepare('SELECT input_tokens, cache_read_tokens, model FROM agent_invocations WHERE tool_use_id = ?').get('toolu_bg_9');
    const ledger = db.prepare('SELECT day, cost FROM session_cost_days WHERE sid = ?').all(sid);
    db.close();
    assert.equal(agent.input_tokens, 2000);
    assert.equal(agent.cache_read_tokens, 50000);
    assert.equal(agent.model, 'claude-haiku-4-5-20251001');
    assert.deepEqual(ledger, [{ day: localDayKey(Date.now()), cost: 12.5 }]);
    assert.ok(fs.existsSync(path.join(sb.stateDir, `claude-agent-reconcile-${sid}`)), 'throttle marker written');
  } finally {
    events._resetForTest();
    fs.rmSync(sb.home, { recursive: true, force: true });
  }
});
