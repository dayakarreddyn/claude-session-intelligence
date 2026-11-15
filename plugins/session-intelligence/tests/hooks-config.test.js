/**
 * Guards on hooks/hooks.json — the registrations Claude Code loads for SI.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8')).hooks;

function commandsFor(event) {
  return hooks[event].flatMap((group) => group.hooks);
}

test('SessionStart bootstrap timeout survives parallel teammate launches', () => {
  // 87 hook_cancelled records between 2026-08-15 and 2026-10-19 at timeout=5s,
  // median duration 5.1s, nearly all during CSM teammate launch storms where
  // every teammate runs ~15 SessionStart hooks at once.
  const bootstrap = commandsFor('SessionStart').find((h) => h.command.includes('si-bootstrap.js'));
  assert.ok(bootstrap, 'si-bootstrap.js must be registered on SessionStart');
  assert.ok(bootstrap.timeout >= 15, `bootstrap timeout ${bootstrap.timeout}s is below 15s`);
});

test('every SI hook is a node command resolved through CLAUDE_PLUGIN_ROOT', () => {
  for (const event of Object.keys(hooks)) {
    for (const h of commandsFor(event)) {
      assert.equal(h.type, 'command', `${event}: type`);
      assert.match(h.command, /^node \$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/si-[a-z-]+\.js$/, `${event}: ${h.command}`);
      assert.equal(typeof h.timeout, 'number', `${event}: timeout must be explicit`);
    }
  }
});

test('PreToolUse registers si-prune-output.js on Bash with a numeric timeout', () => {
  const group = hooks.PreToolUse.find((g) => g.hooks.some((h) => h.command.includes('si-prune-output.js')));
  assert.ok(group, 'si-prune-output.js must be registered on PreToolUse');
  assert.equal(group.matcher, 'Bash');
  const h = group.hooks.find((x) => x.command.includes('si-prune-output.js'));
  assert.equal(typeof h.timeout, 'number');
});

test('PostCompact registers si-post-compact.js with matcher * and a numeric timeout', () => {
  const group = hooks.PostCompact.find((g) => g.hooks.some((h) => h.command.includes('si-post-compact.js')));
  assert.ok(group, 'si-post-compact.js must be registered on PostCompact');
  assert.equal(group.matcher, '*');
  const h = group.hooks.find((x) => x.command.includes('si-post-compact.js'));
  assert.equal(typeof h.timeout, 'number');
});
