/**
 * Tests for hooks/si-task-change.js — specifically that system-generated
 * UserPromptSubmit payloads (background task completions, slash-command
 * artifacts) are NOT scored as user task changes.
 *
 * The hook spawns a child process, so we drive it end-to-end with a minimal
 * JSON payload on stdin and assert exit(0) + no stderr block message.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', 'hooks', 'si-task-change.js');

function runHook(input) {
  return spawnSync('node', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, CLAUDE_SI_DEBUG: '0' },
  });
}

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-taskchange-'));
  // Populate a minimal session-context.md so the hook has a baseline;
  // without one it exits early and any prompt would pass the test trivially.
  fs.writeFileSync(
    path.join(dir, 'session-context.md'),
    '## Current Task\nShip the auth refactor in src/auth.ts and wire new tokens.\n\n' +
    '## Key Files\n- src/auth.ts\n- src/middleware/session.ts\n',
  );
  return dir;
}
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// Each case is a payload that the hook should ignore silently (exit 0,
// no "[TaskChange]" block on stderr). The token budget in the payload
// is high enough to clear the minTokens gate, so if the filter is missing
// these prompts would be scored and likely blocked as "different domain".
const SYSTEM_PROMPTS = [
  {
    name: 'task-notification background completion',
    prompt:
      '<task-notification>\n' +
      '  <task-id>b6j1knzw3</task-id>\n' +
      '  <status>completed</status>\n' +
      '  <summary>Background command completed</summary>\n' +
      '</task-notification>',
  },
  {
    name: 'local-command-caveat + slash-command envelope',
    prompt:
      '<local-command-caveat>Caveat text from the CLI wrapper.</local-command-caveat>\n' +
      '<command-name>/compact</command-name>\n' +
      '<command-message>compact</command-message>\n' +
      '<command-args></command-args>',
  },
  {
    name: 'local-command-stdout',
    prompt:
      '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>',
  },
];

for (const { name, prompt } of SYSTEM_PROMPTS) {
  test(`si-task-change ignores ${name}`, () => {
    const dir = tmpProject();
    try {
      const res = runHook({
        cwd: dir,
        prompt,
        session_id: 'test-session',
        // 500k tokens — well past the default 100k minTokens gate, so any
        // legit user prompt would be scored here.
        transcript_path: '',
      });
      assert.equal(res.status, 0,
        `expected exit 0, got ${res.status}\nstderr:\n${res.stderr}`);
      assert.ok(!/\[TaskChange\]/.test(res.stderr || ''),
        `hook blocked system prompt — stderr:\n${res.stderr}`);
    } finally { cleanup(dir); }
  });
}

test('si-task-change still scores a normal user prompt when token budget is low', () => {
  const dir = tmpProject();
  try {
    const res = runHook({
      cwd: dir,
      prompt: 'refactor the deepgram key loader in src/providers/deepgram.ts please',
      session_id: 'test-session-low',
    });
    // Low token budget → hook exits silently before scoring. This guards
    // against the filter accidentally swallowing real prompts.
    assert.equal(res.status, 0);
    assert.ok(!/\[TaskChange\]/.test(res.stderr || ''));
  } finally { cleanup(dir); }
});

const SHIFT_PROMPT = 'Now please design a gradient colour palette for the marketing landing page hero banner with warm sunset tones and accessible contrast ratios throughout';

function shiftFixture(sid) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'si-tc-home-'));
  const cwd = path.join(home, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  const projectDir = path.join(home, '.claude', 'projects', cwd.replace(/\//g, '-'));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'session-context.md'),
    '## Current Task\nShip the auth refactor in src/auth.ts and wire new tokens.\n\n## Key Files\n- src/auth.ts\n');
  const state = path.join(home, '.claude', 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, `claude-token-budget-${sid}`), '500000');
  const run = () => spawnSync('node', [HOOK], {
    input: JSON.stringify({ cwd, session_id: sid, prompt: SHIFT_PROMPT }),
    encoding: 'utf8', timeout: 5000, env: { ...process.env, HOME: home, CLAUDE_SI_DEBUG: '0' },
  });
  return { home, state, projectDir, run };
}

test('si-task-change still prints the /clear hint when the registry state is unreadable', () => {
  const sid = `tc-badreg-${process.pid}-${Date.now()}`;
  const f = shiftFixture(sid);
  try {
    fs.mkdirSync(path.join(f.state, `claude-constraints-${sid}.json`));
    const res = f.run();
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /\[TaskChange hint\]/);
    assert.match(res.stderr, /`\/clear`/);
  } finally { cleanup(f.home); }
});

test('si-task-change does not rewrite the handoff for a second identical prompt', () => {
  const sid = `tc-twice-${process.pid}-${Date.now()}`;
  const f = shiftFixture(sid);
  try {
    assert.match(f.run().stderr, /fresh handoff/);
    const file = path.join(f.projectDir, '.si-handoff.json');
    const before = { mtime: fs.statSync(file).mtimeMs, body: fs.readFileSync(file, 'utf8') };
    assert.equal(f.run().stderr, '');
    assert.equal(fs.statSync(file).mtimeMs, before.mtime);
    assert.equal(fs.readFileSync(file, 'utf8'), before.body);
  } finally { cleanup(f.home); }
});

test('si-task-change writes a handoff with registry constraints before recommending /clear', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'si-tc-home-'));
  try {
    const cwd = path.join(home, 'proj');
    fs.mkdirSync(cwd, { recursive: true });
    const projectDir = path.join(home, '.claude', 'projects', cwd.replace(/\//g, '-'));
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'session-context.md'),
      '## Current Task\nShip the auth refactor in src/auth.ts and wire new tokens.\n\n## Key Files\n- src/auth.ts\n');
    const state = path.join(home, '.claude', 'state');
    fs.mkdirSync(state, { recursive: true });
    const sid = `tc-clear-${process.pid}-${Date.now()}`; // one-shot prompt-hash file lives in os.tmpdir()
    fs.writeFileSync(path.join(state, `claude-token-budget-${sid}`), '500000');
    fs.writeFileSync(path.join(state, `claude-constraints-${sid}.json`),
      JSON.stringify({ t: 1, items: [{ type: 'Rule', text: 'never touch the migrations folder', source: 'CLAUDE.md' }] }));
    const res = spawnSync('node', [HOOK], {
      input: JSON.stringify({
        cwd, session_id: sid,
        prompt: 'Now please design a gradient colour palette for the marketing landing page hero banner with warm sunset tones and accessible contrast ratios throughout',
      }),
      encoding: 'utf8', timeout: 5000, env: { ...process.env, HOME: home, CLAUDE_SI_DEBUG: '0' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /`\/clear`/);
    assert.match(res.stderr, /fresh handoff/);
    const handoff = JSON.parse(fs.readFileSync(path.join(projectDir, '.si-handoff.json'), 'utf8'));
    assert.match(handoff.currentTask, /auth refactor/);
    assert.deepEqual(handoff.constraints.map((c) => c.text), ['never touch the migrations folder']);
  } finally { cleanup(home); }
});
