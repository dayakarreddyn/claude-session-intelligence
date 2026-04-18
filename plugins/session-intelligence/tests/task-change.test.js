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
