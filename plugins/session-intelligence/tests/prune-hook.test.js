/**
 * Spawn tests for si-prune-output (PreToolUse updatedInput, PostToolUse
 * updatedToolOutput) and the si-post-tool dispatcher stdout/merge path.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const HOOKS = path.join(__dirname, '..', 'hooks');
const { openDatabase } = require('../lib/sqlite-driver');
const { rewriteCommand } = require('../lib/prune');

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'si-prune-'));
  fs.mkdirSync(path.join(home, '.claude', 'state'), { recursive: true });
  return home;
}

function runHook(file, payload, home) {
  const clean = { ...process.env };
  for (const k of ['CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_DISABLE_1M_CONTEXT', 'DISABLE_COMPACT', 'CLAUDE_SI_PRUNE', 'CLAUDE_SI_PRUNE_FLOOR']) delete clean[k];
  return spawnSync(process.execPath, [path.join(HOOKS, file)], {
    input: JSON.stringify(payload),
    env: { ...clean, HOME: home, CLAUDE_SESSION_ID: payload.session_id || '' },
    encoding: 'utf8',
    timeout: 20_000,
  });
}

function archiveRow(home, id) {
  const dbPath = path.join(home, '.claude', 'state', 'si-events.db');
  if (!fs.existsSync(dbPath)) return null;
  const { db } = openDatabase(dbPath);
  try { return db.prepare('SELECT * FROM tool_archives WHERE tool_use_id = ?').get(id); } finally { db.close(); }
}

const sid = 'sid-prune';
const readPayload = (id, n) => ({
  hook_event_name: 'PostToolUse', session_id: sid, tool_name: 'Read', tool_use_id: id,
  tool_input: { file_path: '/x' }, tool_response: 'a'.repeat(n),
});

function withHome(fn) {
  const home = sandbox();
  try { return fn(home); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

test('PostToolUse: a 60000-char Read result is replaced by an excerpt and the archive is marked pruned', () => withHome((home) => {
  const r = runHook('si-prune-output.js', readPayload('toolu_01', 60000), home);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.ok(out.hookSpecificOutput.updatedToolOutput.startsWith('[SI pruned: Read result 60,000 chars'));
  assert.ok(r.stdout.length < 10000);
  const file = path.join(home, '.claude', 'state', `claude-tool-archive-${sid}`, 'toolu_01.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).chars, 60000, 'full body archived before pruning');
  assert.equal(archiveRow(home, 'toolu_01').pruned, 1);
}));

test('PostToolUse: object (JSON) tool_response produces no stdout', () => withHome((home) => {
  const r = runHook('si-prune-output.js', {
    hook_event_name: 'PostToolUse', session_id: sid, tool_name: 'mcp__x__y', tool_use_id: 'toolu_02',
    tool_response: { content: [{ type: 'text', text: 'z'.repeat(70000) }] },
  }, home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
}));

test('PostToolUse: below-floor result produces no stdout', () => withHome((home) => {
  const r = runHook('si-prune-output.js', readPayload('toolu_03', 49999), home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
}));

test('PreToolUse: npm test is rewritten via updatedInput with no permissionDecision', () => withHome((home) => {
  const input = { command: 'npm test', description: 'run tests' };
  const r = runHook('si-prune-output.js', { hook_event_name: 'PreToolUse', session_id: sid, tool_name: 'Bash', tool_input: input }, home);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  // Ruling R2: exit-status-preserving subshell wrapper, not a bare pipe suffix.
  assert.equal(out.hookSpecificOutput.updatedInput.command, rewriteCommand('npm test').command);
  assert.match(out.hookSpecificOutput.updatedInput.command, /rc=\$\?; echo "\[exit=\$rc\]"; exit \$rc/);
  assert.equal(out.hookSpecificOutput.updatedInput.description, 'run tests');
  assert.equal('permissionDecision' in out.hookSpecificOutput, false);
  assert.equal(input.command, 'npm test', 'input not mutated');
}));

test('PreToolUse: run_in_background commands and non-Bash tools are left alone', () => withHome((home) => {
  const a = runHook('si-prune-output.js', { hook_event_name: 'PreToolUse', session_id: sid, tool_name: 'Bash', tool_input: { command: 'npm test', run_in_background: true } }, home);
  assert.equal(a.status, 0); assert.equal(a.stdout, '');
  const b = runHook('si-prune-output.js', { hook_event_name: 'PreToolUse', session_id: sid, tool_name: 'Read', tool_input: { command: 'npm test' } }, home);
  assert.equal(b.status, 0); assert.equal(b.stdout, '');
}));

test('hook exits 0 with empty stdout on garbage stdin', () => withHome((home) => {
  const r = spawnSync(process.execPath, [path.join(HOOKS, 'si-prune-output.js')], {
    input: 'not json', env: { ...process.env, HOME: home }, encoding: 'utf8',
  });
  assert.equal(r.status, 0); assert.equal(r.stdout, '');
}));

test('dispatcher forwards the prune JSON on stdout and exits 0', () => withHome((home) => {
  const r = runHook('si-post-tool.js', { ...readPayload('toolu_10', 60000), transcript_path: '' }, home);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput);
}));

function transcript(home, model, readTokens) {
  const file = path.join(home, 'transcript.jsonl');
  const lines = [
    { type: 'user', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', message: { id: 'msg_1', role: 'assistant', model, content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10000, cache_creation_input_tokens: 0, cache_read_input_tokens: readTokens, output_tokens: 5 } } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

test('dispatcher merges a zone callout into additionalContext when prune and crossing coincide', () => withHome((home) => {
  const t = transcript(home, 'claude-opus-5-5', 200000);
  const r = runHook('si-post-tool.js', { ...readPayload('toolu_11', 60000), transcript_path: t, cwd: home }, home);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PostToolUse');
  assert.ok(out.updatedToolOutput);
  assert.match(out.additionalContext, /\[StrategicCompact\]/);
  assert.doesNotMatch(out.additionalContext, /\x1b\[/);
  assert.ok(out.additionalContext.length <= 9000);
}));

test('dispatcher still propagates exit 2 with stderr when nothing was pruned', () => withHome((home) => {
  const t = transcript(home, 'claude-opus-5-5', 200000);
  const r = runHook('si-post-tool.js', { ...readPayload('toolu_12', 100), transcript_path: t, cwd: home }, home);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /\[StrategicCompact\]/);
  assert.equal(r.stdout, '');
}));

function writeCfg(home, cfg) {
  fs.writeFileSync(path.join(home, '.claude', 'session-intelligence.json'), JSON.stringify(cfg));
}
const archiveFile = (home, id) => path.join(home, '.claude', 'state', `claude-tool-archive-${sid}`, `${id}.json`);

test('toolArchive.enabled=false: no prune, no archive file, no pruned row (R9)', () => withHome((home) => {
  writeCfg(home, { toolArchive: { enabled: false } });
  const r = runHook('si-prune-output.js', readPayload('toolu_20', 60000), home);
  assert.equal(r.status, 0); assert.equal(r.stdout, '');
  assert.equal(fs.existsSync(archiveFile(home, 'toolu_20')), false);
  const row = archiveRow(home, 'toolu_20');
  assert.ok(!row || !row.pruned);
}));

test('ttlDays so small the archive is swept at once: no prune, no stdout (maxPerSession/ttlDays <= 0 mean no limit)', () => withHome((home) => {
  writeCfg(home, { toolArchive: { ttlDays: 1e-9 } });
  const r = runHook('si-prune-output.js', readPayload('toolu_21', 60000), home);
  assert.equal(r.status, 0); assert.equal(r.stdout, '');
  const row = archiveRow(home, 'toolu_21');
  assert.ok(!row || !row.pruned);
}));

test('archive write failure (read-only state dir): no prune, exit 0', { skip: process.getuid && process.getuid() === 0 }, () => withHome((home) => {
  const state = path.join(home, '.claude', 'state');
  fs.chmodSync(state, 0o500);
  try {
    const r = runHook('si-prune-output.js', readPayload('toolu_22', 60000), home);
    assert.equal(r.status, 0); assert.equal(r.stdout, '');
  } finally { fs.chmodSync(state, 0o700); }
}));

const readShaped = (id, n) => ({
  hook_event_name: 'PostToolUse', session_id: sid, tool_name: 'Read', tool_use_id: id, tool_input: { file_path: '/x/y.js' },
  tool_response: { type: 'text', file: { filePath: '/x/y.js', content: 'r'.repeat(n), numLines: 1200, startLine: 1, totalLines: 1200 } },
});

test('Read-shaped response: file.content is pruned, shape and other file fields preserved, archive holds the text', () => withHome((home) => {
  const r = runHook('si-prune-output.js', readShaped('toolu_30', 60000), home);
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput;
  assert.equal(o.type, 'text');
  assert.ok(o.file.content.startsWith('[SI pruned: Read result'));
  assert.deepEqual([o.file.filePath, o.file.numLines, o.file.startLine, o.file.totalLines], ['/x/y.js', 1200, 1, 1200]);
  const arch = JSON.parse(fs.readFileSync(archiveFile(home, 'toolu_30'), 'utf8'));
  assert.equal(arch.body, 'r'.repeat(60000), 'archived body is the content text, not the JSON wrapper');
  assert.equal(archiveRow(home, 'toolu_30').pruned, 1);
}));

test('Bash-shaped response: stdout pruned; stderr/interrupted/isImage preserved', () => withHome((home) => {
  const r = runHook('si-prune-output.js', {
    hook_event_name: 'PostToolUse', session_id: sid, tool_name: 'Bash', tool_use_id: 'toolu_23',
    tool_input: { command: 'ls' },
    tool_response: { stdout: 'x'.repeat(60000), stderr: 'warn', interrupted: false, isImage: false },
  }, home);
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput;
  assert.ok(o.stdout.startsWith('[SI pruned: Bash result'));
  assert.deepEqual([o.stderr, o.interrupted, o.isImage], ['warn', false, false]);
}));

test('Read-shaped response survives the dispatcher as an object', () => withHome((home) => {
  const r = runHook('si-post-tool.js', { ...readShaped('toolu_31', 60000), transcript_path: '' }, home);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput.file.content.startsWith('[SI pruned'), true);
}));

test('dispatcher merge carries an object updatedToolOutput alongside additionalContext', () => withHome((home) => {
  const t = transcript(home, 'claude-opus-5-5', 200000);
  const r = runHook('si-post-tool.js', { ...readShaped('toolu_32', 60000), transcript_path: t, cwd: home }, home);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.updatedToolOutput.type, 'text');
  assert.match(out.additionalContext, /\[StrategicCompact\]/);
}));

test('dispatcher omits additionalContext when the merged callout is empty-free path (prune only)', () => withHome((home) => {
  const r = runHook('si-post-tool.js', { ...readPayload('toolu_24', 60000), transcript_path: '' }, home);
  assert.equal(r.status, 0);
  assert.equal('additionalContext' in JSON.parse(r.stdout).hookSpecificOutput, false);
}));
