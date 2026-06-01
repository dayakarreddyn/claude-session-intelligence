/**
 * Tests for the subagent-transcript usage extractor.
 *
 * Each test builds a tiny JSONL fixture in a temp dir shaped like the real
 * `~/.claude/projects/<encoded>/<sid>/subagents/agent-*.jsonl` files so we
 * cover the encoding + lookup path end-to-end without touching real data.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const agentUsage = require('../lib/agent-usage');

function writeTranscript(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function assistantRow({ ts, model, usage, msgId }) {
  return {
    type: 'assistant',
    timestamp: ts,
    message: { id: msgId, model, usage },
  };
}

test('encodeProjectPath replaces /, . with -', () => {
  assert.equal(agentUsage.encodeProjectPath('/Users/x/DWS/CSM'), '-Users-x-DWS-CSM');
  assert.equal(agentUsage.encodeProjectPath('/a.b/c'), '-a-b-c');
  assert.equal(agentUsage.encodeProjectPath(null), null);
});

test('readSubagentTranscript sums usage, picks model, computes duration', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-agent-'));
  try {
    const f = path.join(dir, 'agent-x.jsonl');
    writeTranscript(f, [
      { type: 'user', timestamp: '2026-05-14T10:00:00.000Z', agentId: 'x' },
      assistantRow({
        ts: '2026-05-14T10:00:05.000Z', model: 'claude-haiku-4-5-20251001',
        msgId: 'm1',
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 200, cache_read_input_tokens: 0 },
      }),
      assistantRow({
        ts: '2026-05-14T10:00:15.000Z', model: 'claude-haiku-4-5-20251001',
        msgId: 'm2',
        usage: { input_tokens: 10, output_tokens: 25, cache_creation_input_tokens: 0, cache_read_input_tokens: 200 },
      }),
    ]);
    const r = agentUsage.readSubagentTranscript(f);
    assert.equal(r.model, 'claude-haiku-4-5-20251001');
    assert.equal(r.assistantTurns, 2);
    assert.equal(r.usage.input_tokens, 110);
    assert.equal(r.usage.output_tokens, 75);
    assert.equal(r.usage.cache_creation_input_tokens, 200);
    assert.equal(r.usage.cache_read_input_tokens, 200);
    assert.equal(r.durationMs, 15000);
    // Haiku pricing: in=1, out=5, cc=1.25, cr=0.10 per M
    // cost = 110*1 + 75*5 + 200*1.25 + 200*0.10  all / 1e6
    //      = (110 + 375 + 250 + 20) / 1e6 = 755e-6
    assert.ok(Math.abs(r.costUsd - 755 / 1e6) < 1e-9, `expected ~755e-6 got ${r.costUsd}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('dedupes streaming snapshots by message.id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-agent-'));
  try {
    const f = path.join(dir, 'agent-dupe.jsonl');
    const u = { input_tokens: 100, output_tokens: 50 };
    writeTranscript(f, [
      assistantRow({ ts: '2026-05-14T10:00:00.000Z', model: 'claude-sonnet-4-6', msgId: 'same', usage: u }),
      assistantRow({ ts: '2026-05-14T10:00:00.500Z', model: 'claude-sonnet-4-6', msgId: 'same', usage: u }),
      assistantRow({ ts: '2026-05-14T10:00:01.000Z', model: 'claude-sonnet-4-6', msgId: 'same', usage: u }),
    ]);
    const r = agentUsage.readSubagentTranscript(f);
    assert.equal(r.assistantTurns, 1, 'three streaming snapshots collapse to one turn');
    assert.equal(r.usage.input_tokens, 100);
    assert.equal(r.usage.output_tokens, 50);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('returns null for files with no usage blocks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-agent-'));
  try {
    const f = path.join(dir, 'empty.jsonl');
    writeTranscript(f, [{ type: 'user', timestamp: '2026-05-14T10:00:00.000Z' }]);
    assert.equal(agentUsage.readSubagentTranscript(f), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('findUsageForTask picks newest candidate in window', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'si-agent-find-'));
  try {
    const cwd = '/tmp/fake-project';
    const sid = 'sess-1';
    const dir = agentUsage.subagentsDirFor(cwd, sid, root);
    fs.mkdirSync(dir, { recursive: true });

    const older = path.join(dir, 'agent-older.jsonl');
    const newer = path.join(dir, 'agent-newer.jsonl');
    writeTranscript(older, [
      assistantRow({
        ts: '2026-05-14T09:00:00.000Z',
        model: 'claude-haiku-4-5', msgId: 'a',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ]);
    writeTranscript(newer, [
      assistantRow({
        ts: '2026-05-14T11:00:00.000Z',
        model: 'claude-sonnet-4-6', msgId: 'b',
        usage: { input_tokens: 999, output_tokens: 11 },
      }),
    ]);
    const now = Date.now();
    fs.utimesSync(older, (now - 60_000) / 1000, (now - 60_000) / 1000);
    fs.utimesSync(newer, now / 1000, now / 1000);

    const r = agentUsage.findUsageForTask({ cwd, sid, now, projectsRoot: root });
    assert.ok(r, 'should find a candidate');
    assert.equal(r.model, 'claude-sonnet-4-6', 'newest file wins');
    assert.equal(r.usage.input_tokens, 999);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('findUsageForTask prefers exact parentToolUseId match over mtime', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'si-agent-match-'));
  try {
    const cwd = '/tmp/fake-project';
    const sid = 'sess-2';
    const dir = agentUsage.subagentsDirFor(cwd, sid, root);
    fs.mkdirSync(dir, { recursive: true });

    const matching = path.join(dir, 'agent-match.jsonl');
    const newer = path.join(dir, 'agent-newest.jsonl');
    // matching file: older mtime but has the right parentToolUseId
    writeTranscript(matching, [
      { type: 'user', timestamp: '2026-05-14T10:00:00.000Z', parentToolUseId: 'toolu_target' },
      assistantRow({
        ts: '2026-05-14T10:00:05.000Z',
        model: 'claude-haiku-4-5', msgId: 'a',
        usage: { input_tokens: 42, output_tokens: 7 },
      }),
    ]);
    writeTranscript(newer, [
      assistantRow({
        ts: '2026-05-14T11:00:00.000Z',
        model: 'claude-sonnet-4-6', msgId: 'b',
        usage: { input_tokens: 9999, output_tokens: 1 },
      }),
    ]);
    const now = Date.now();
    fs.utimesSync(matching, (now - 120_000) / 1000, (now - 120_000) / 1000);
    fs.utimesSync(newer, now / 1000, now / 1000);

    const r = agentUsage.findUsageForTask({
      cwd, sid, now, projectsRoot: root,
      parentToolUseId: 'toolu_target',
    });
    assert.ok(r);
    assert.equal(r.usage.input_tokens, 42, 'matched by parentToolUseId, not mtime');
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('listWorkflowAgentTranscripts finds agent files under subagents/workflows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'si-wf-'));
  try {
    const cwd = '/Users/x/DWS/CSM';
    const enc = agentUsage.encodeProjectPath(cwd);
    // Two sessions, each with a workflow run; plus a normal (non-workflow)
    // subagent that must NOT be picked up by the workflow lister.
    const base = path.join(root, enc);
    writeTranscript(
      path.join(base, 'sid-1', 'subagents', 'workflows', 'wf_aaa', 'agent-111.jsonl'),
      [assistantRow({ ts: '2026-06-01T10:00:00.000Z', model: 'claude-opus-4-8', msgId: 'm1', usage: { input_tokens: 100, output_tokens: 2 } })],
    );
    writeTranscript(
      path.join(base, 'sid-2', 'subagents', 'workflows', 'wf_bbb', 'agent-222.jsonl'),
      [assistantRow({ ts: '2026-06-01T11:00:00.000Z', model: 'claude-opus-4-8', msgId: 'm2', usage: { input_tokens: 200, output_tokens: 3 } })],
    );
    writeTranscript(
      path.join(base, 'sid-1', 'subagents', 'agent-999.jsonl'),
      [assistantRow({ ts: '2026-06-01T10:30:00.000Z', model: 'claude-opus-4-8', msgId: 'm3', usage: { input_tokens: 50, output_tokens: 1 } })],
    );

    const list = agentUsage.listWorkflowAgentTranscripts({ cwd, projectsRoot: root });
    const files = list.map((r) => path.basename(r.path)).sort();
    assert.deepEqual(files, ['agent-111.jsonl', 'agent-222.jsonl'], 'only workflow agents, not the plain subagent');
    const byFile = Object.fromEntries(list.map((r) => [path.basename(r.path), r]));
    assert.equal(byFile['agent-111.jsonl'].sid, 'sid-1');
    assert.equal(byFile['agent-111.jsonl'].wfRunId, 'wf_aaa');
    assert.equal(byFile['agent-222.jsonl'].sid, 'sid-2');
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('listWorkflowAgentTranscripts returns [] when no workflow dirs exist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'si-wf-empty-'));
  try {
    assert.deepEqual(agentUsage.listWorkflowAgentTranscripts({ cwd: '/Users/x/DWS/CSM', projectsRoot: root }), []);
    assert.deepEqual(agentUsage.listWorkflowAgentTranscripts({ cwd: null, projectsRoot: root }), []);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
