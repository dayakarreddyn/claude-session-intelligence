'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { listRunningAgents, formatRunningAgents } = require('../lib/running-agents');
const { buildRenderers } = require('../statusline/renderers');
const { makeColors } = require('../statusline/format');
const { withTempHome } = require('./helpers/statusline-fixture');

const NOW = Date.UTC(2026, 10, 15, 15, 0, 0);
const MINUTE_MS = 60_000;

/** Session transcript path plus its sibling `<sid>/subagents` dir, removed after the test. */
function session(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'si-agents-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'sid-1', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  return { transcriptPath: path.join(root, 'sid-1.jsonl'), dir };
}

function addAgent(dir, id, { meta = {}, turns = [], ageMs = 0, raw } = {}) {
  fs.writeFileSync(path.join(dir, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'general-purpose', ...meta }));
  const file = path.join(dir, `agent-${id}.jsonl`);
  const lines = turns.map(([model, effort]) => JSON.stringify({
    type: 'assistant', agentId: id, effort, message: { role: 'assistant', model, content: [] },
  }));
  fs.writeFileSync(file, raw !== undefined ? raw : lines.join('\n') + '\n');
  const at = (NOW - ageMs) / 1000;
  fs.utimesSync(file, at, at);
}

test('lists unfinished agents with the model and effort of their latest assistant turn', (t) => {
  const { transcriptPath, dir } = session(t);
  addAgent(dir, 'a', { turns: [['claude-haiku-5-5', 'low'], ['claude-opus-5-5', 'high']] });
  addAgent(dir, 'b', { meta: { finished: true }, turns: [['claude-fable-5-2', 'xhigh']] });
  assert.deepEqual(listRunningAgents({ transcriptPath, now: NOW }),
    [{ agentType: 'general-purpose', model: 'claude-opus-5-5', effort: 'high' }]);
});

test('drops unfinished agents whose transcript has been silent past the stale window', (t) => {
  const { transcriptPath, dir } = session(t);
  addAgent(dir, 'old', { turns: [['claude-opus-5-5', 'high']], ageMs: 16 * MINUTE_MS });
  addAgent(dir, 'live', { turns: [['claude-opus-5-5', 'high']], ageMs: 14 * MINUTE_MS });
  assert.equal(listRunningAgents({ transcriptPath, now: NOW }).length, 1);
});

test('falls back to the launch metadata before the first assistant turn', (t) => {
  const { transcriptPath, dir } = session(t);
  addAgent(dir, 'new', { meta: { pickedEffortModel: 'claude-fable-5-2' }, turns: [] });
  assert.deepEqual(listRunningAgents({ transcriptPath, now: NOW }),
    [{ agentType: 'general-purpose', model: 'claude-fable-5-2', effort: '' }]);
});

test('tolerates a missing subagents dir, corrupt metadata and corrupt transcript lines', (t) => {
  const { transcriptPath, dir } = session(t);
  assert.deepEqual(listRunningAgents({ transcriptPath: path.join(dir, 'nope.jsonl'), now: NOW }), []);
  assert.deepEqual(listRunningAgents({ transcriptPath: undefined, now: NOW }), []);
  fs.writeFileSync(path.join(dir, 'agent-bad.meta.json'), '{not json');
  fs.writeFileSync(path.join(dir, 'agent-bad.jsonl'), '{}\n');
  addAgent(dir, 'torn', { raw: `{"type":"assis\n${JSON.stringify({ type: 'assistant', effort: 'medium', message: { model: 'claude-sonnet-5-5' } })}\n{"type":"us` });
  assert.deepEqual(listRunningAgents({ transcriptPath, now: NOW }),
    [{ agentType: 'general-purpose', model: 'claude-sonnet-5-5', effort: 'medium' }]);
});

test('formatRunningAgents groups by model and effort, largest group first', () => {
  const a = (model, effort) => ({ agentType: 'x', model, effort });
  assert.equal(formatRunningAgents([
    a('claude-fable-5-2', 'xhigh'), a('claude-opus-5-5', 'high'), a('claude-opus-5-5', 'high'),
  ]), 'opus-5-5·high ×2 · fable-5-2·xhigh');
  assert.equal(formatRunningAgents([a('claude-haiku-5-5-20260101', '')]), 'haiku-5-5');
  assert.equal(formatRunningAgents([a('', 'high')]), '?·high');
  assert.equal(formatRunningAgents([]), '');
});

test('formatRunningAgents folds groups past the third into a +N count of agents', () => {
  const a = (model) => ({ agentType: 'x', model, effort: 'low' });
  assert.equal(formatRunningAgents([a('m1'), a('m1'), a('m2'), a('m3'), a('m4'), a('m5')]),
    'm1·low ×2 · m2·low · m3·low · +2');
});

test('agents cell renders the running agents and vanishes when none are running', (t) => {
  withTempHome(t); // no plugin cache under this HOME, so the loader resolves the repo lib
  const { transcriptPath, dir } = session(t);
  const R = buildRenderers(makeColors(false), { now: () => NOW });
  assert.equal(R.agents({ transcript_path: transcriptPath }, {}), '');
  addAgent(dir, 'a', { turns: [['claude-opus-5-5', 'high']] });
  assert.equal(R.agents({ transcript_path: transcriptPath }, {}), 'agents: opus-5-5·high');
});
