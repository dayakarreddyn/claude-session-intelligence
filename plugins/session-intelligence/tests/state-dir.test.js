/**
 * Tests for the per-session state-dir helpers — getStateDir + pruneStateDir.
 *
 * Background: per-session state files (compact-zone, cost snapshot, tool
 * counters, ctx-shape, tool-archive) used to live in os.tmpdir(), where macOS
 * aggressively wipes /var/folders/.../T/ — sometimes within hours. A missing
 * state file mid-session re-fired the compact-zone callout as a fresh
 * crossing. Migration moved these to ~/.claude/state/, with a 7-day pruner
 * that runs at SessionStart so the dir doesn't accumulate forever.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { getStateDir, pruneStateDir } = require('../lib/utils');

test('getStateDir returns ~/.claude/state and creates it', () => {
  const dir = getStateDir();
  assert.ok(dir.endsWith(path.join('.claude', 'state')),
    `expected suffix .claude/state, got ${dir}`);
  assert.ok(fs.existsSync(dir), 'directory should exist after getStateDir()');
  assert.ok(fs.statSync(dir).isDirectory(), 'getStateDir target must be a directory');
});

test('pruneStateDir removes only matching files older than maxAgeDays', () => {
  // Use a sandbox dir so we don't disturb the real ~/.claude/state.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'si-state-prune-'));
  try {
    const old = path.join(sandbox, 'claude-compact-state-aaa');
    const fresh = path.join(sandbox, 'claude-compact-state-bbb');
    const unrelated = path.join(sandbox, 'something-else.txt');
    fs.writeFileSync(old, 'x');
    fs.writeFileSync(fresh, 'x');
    fs.writeFileSync(unrelated, 'x');
    // Backdate `old` past the 7-day cutoff (8 days ago).
    const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(old, eightDaysAgo, eightDaysAgo);

    const removed = pruneStateDir(sandbox, /^claude-compact-state-/, 7);
    assert.equal(removed, 1, 'should prune the one old matching file');
    assert.ok(!fs.existsSync(old), 'old matching file gone');
    assert.ok(fs.existsSync(fresh), 'fresh matching file kept');
    assert.ok(fs.existsSync(unrelated), 'non-matching file untouched');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('pruneStateDir handles directories (tool-archive case) recursively', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'si-state-prune-dir-'));
  try {
    const oldDir = path.join(sandbox, 'claude-tool-archive-old');
    fs.mkdirSync(oldDir);
    fs.writeFileSync(path.join(oldDir, 'one.json'), '{}');
    fs.writeFileSync(path.join(oldDir, 'two.json'), '{}');
    const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(oldDir, eightDaysAgo, eightDaysAgo);

    const removed = pruneStateDir(sandbox, /^claude-tool-archive-/, 7);
    assert.equal(removed, 1);
    assert.ok(!fs.existsSync(oldDir), 'directory removed recursively');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('pruneStateDir is a no-op when the dir does not exist', () => {
  const removed = pruneStateDir('/no/such/dir/should/exist', /^claude-/, 7);
  assert.equal(removed, 0, 'missing dir must not throw');
});

test('pruneStateDir rejects nonsense maxAgeDays without throwing', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'si-state-prune-bad-'));
  try {
    fs.writeFileSync(path.join(sandbox, 'claude-x'), '');
    assert.equal(pruneStateDir(sandbox, /^claude-/, 0), 0, 'maxAge=0 → no-op');
    assert.equal(pruneStateDir(sandbox, /^claude-/, -1), 0, 'negative → no-op');
    assert.equal(pruneStateDir(sandbox, /^claude-/, NaN), 0, 'NaN → no-op');
    assert.equal(pruneStateDir(sandbox, /^claude-/, undefined), 0, 'undefined → no-op');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
