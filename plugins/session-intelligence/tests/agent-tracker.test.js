/**
 * End-to-end tests for the si-agent-tracker PostToolUse hook and the
 * si-token-budget writer, spawned as real child processes against an
 * isolated HOME so they hit a throwaway ~/.claude/state.
 *
 * Regressions guarded here:
 *   - Subagent tool arrives as `Agent` in this harness (and `Task` in others).
 *     The tracker must record for BOTH; matching only `Task` silently dropped
 *     every real invocation (agent_invocations stayed empty for 9 days).
 *   - Per-session counters (token-budget, tool-count) must land in
 *     ~/.claude/state, not os.tmpdir() — the writer was the last straggler of
 *     the state-dir migration, so peak_tokens read at session end was null.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const HOOKS = path.join(__dirname, '..', 'hooks');

// Spawn a hook with an isolated HOME so getStateDir()/getEventsDbPath() resolve
// under a sandbox. Returns the sandbox HOME for inspection.
function runHook(hookFile, payload) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'si-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'state'), { recursive: true });
  const r = spawnSync(process.execPath, [path.join(HOOKS, hookFile)], {
    input: JSON.stringify(payload),
    env: { ...process.env, HOME: home, CLAUDE_SESSION_ID: payload.session_id || '' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  return { home, status: r.status };
}

function cleanup(home) {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
}

function agentRows(home, sid) {
  // A skipped tool never opens the DB, so the file legitimately won't exist —
  // treat that as zero recorded rows rather than a failure.
  const dbPath = path.join(home, '.claude', 'state', 'si-events.db');
  if (!fs.existsSync(dbPath)) return [];
  const Sqlite = require('better-sqlite3');
  const db = new Sqlite(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT subagent_type, prompt_chars, response_chars, is_error FROM agent_invocations WHERE sid = ?').all(sid);
  } finally { db.close(); }
}

const agentPayload = (toolName, sid) => ({
  tool_name: toolName,
  session_id: sid,
  cwd: process.cwd(),
  tool_use_id: 'toolu_test_1',
  tool_input: { subagent_type: 'code-reviewer', description: 'review', prompt: 'check this' },
  tool_response: 'review output body',
});

test('agent-tracker records when tool_name is "Agent" (this harness)', () => {
  const { home, status } = runHook('si-agent-tracker.js', agentPayload('Agent', 'sid-agent'));
  try {
    assert.equal(status, 0, 'hook exits 0');
    const rows = agentRows(home, 'sid-agent');
    assert.equal(rows.length, 1, 'one invocation recorded');
    assert.equal(rows[0].subagent_type, 'code-reviewer');
  } finally { cleanup(home); }
});

test('agent-tracker still records when tool_name is "Task" (other builds)', () => {
  const { home } = runHook('si-agent-tracker.js', agentPayload('Task', 'sid-task'));
  try {
    assert.equal(agentRows(home, 'sid-task').length, 1, 'Task name still recorded');
  } finally { cleanup(home); }
});

test('agent-tracker ignores non-subagent tools', () => {
  const { home } = runHook('si-agent-tracker.js', agentPayload('Edit', 'sid-edit'));
  try {
    assert.equal(agentRows(home, 'sid-edit').length, 0, 'Edit must not be recorded');
  } finally { cleanup(home); }
});

test('si-token-budget writes counters to ~/.claude/state, not tmp', () => {
  const sid = 'sid-budget';
  const { home, status } = runHook('si-token-budget.js', {
    session_id: sid,
    tool_name: 'Edit',
    tool_input: { file_path: '/x' },
    transcript_path: '',
  });
  try {
    assert.equal(status, 0, 'hook exits 0');
    const stateDir = path.join(home, '.claude', 'state');
    assert.ok(
      fs.existsSync(path.join(stateDir, `claude-tool-count-${sid}`)),
      'tool-count file must land in ~/.claude/state',
    );
  } finally { cleanup(home); }
});
