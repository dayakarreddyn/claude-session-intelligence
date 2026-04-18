/**
 * Tests for lib/session-context.js — the shared parser used by handoff.js,
 * si-pre-compact.js, and the statusline. Covers the bugs that motivated
 * the refactor: autofill contamination (C1 from the audit) and placeholder
 * strip drift (H1).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  readSessionContext,
  parseSessionContext,
  stripPlaceholderLines,
  isPlaceholderLine,
  AUTOFILL_SENTINEL_RE,
} = require('../lib/session-context');

// ─── Fixtures ────────────────────────────────────────────────────────────

function tmpProject(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-ctx-test-'));
  if (content != null) {
    fs.writeFileSync(path.join(dir, 'session-context.md'), content);
  }
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ─── isPlaceholderLine / stripPlaceholderLines ──────────────────────────

test('isPlaceholderLine identifies the four template shapes', () => {
  assert.equal(isPlaceholderLine('- (list key files)'), true);
  assert.equal(isPlaceholderLine('* (list key files)'), true);
  assert.equal(isPlaceholderLine('type: (feature | fix | refactor)'), true);
  assert.equal(isPlaceholderLine('PRESERVE: (what must survive)'), true);
  assert.equal(isPlaceholderLine('(one-line hint)'), true);
});

test('isPlaceholderLine preserves real content and structure', () => {
  assert.equal(isPlaceholderLine(''), false);                                // blank
  assert.equal(isPlaceholderLine('## Current Task'), false);                 // header
  assert.equal(isPlaceholderLine('- src/auth.js'), false);                   // real bullet
  assert.equal(isPlaceholderLine('type: feature'), false);                   // real pair
  assert.equal(isPlaceholderLine('Refactor auth (split cookies)'), false);   // trailing parens, not placeholder
  assert.equal(isPlaceholderLine('see (docs/setup.md)'), false);             // parens mid-sentence
});

test('stripPlaceholderLines strips scaffolding but keeps blanks + headers', () => {
  const input = [
    '# Heading',
    '',
    '- (describe what you are doing)',
    '- src/real-file.js',
    'type: (a | b)',
    'type: feature',
    '',
  ].join('\n');
  const stripped = stripPlaceholderLines(input);
  assert.match(stripped, /# Heading/);
  assert.match(stripped, /src\/real-file\.js/);
  assert.match(stripped, /type: feature/);
  assert.doesNotMatch(stripped, /describe what/);
  assert.doesNotMatch(stripped, /type: \(a \| b\)/);
});

test('stripPlaceholderLines tolerates nullish/empty input', () => {
  assert.equal(stripPlaceholderLines(''), '');
  assert.equal(stripPlaceholderLines(null), '');
  assert.equal(stripPlaceholderLines(undefined), '');
});

// ─── parseSessionContext ─────────────────────────────────────────────────

test('parseSessionContext splits on ## headers and strips placeholders', () => {
  const md = [
    '## Current Task',
    'Refactor the auth module',
    '',
    '## Key Files',
    '- (list key files here)',
    '- src/auth.js',
    '',
    '## On Compact',
    'PRESERVE: (what must survive)',
    'PRESERVE: session cookie logic',
  ].join('\n');
  const sections = parseSessionContext(md);
  assert.match(sections['Current Task'], /Refactor the auth module/);
  assert.match(sections['Key Files'], /src\/auth\.js/);
  assert.doesNotMatch(sections['Key Files'], /list key files/);
  assert.match(sections['On Compact'], /session cookie logic/);
  assert.doesNotMatch(sections['On Compact'], /what must survive/);
});

test('parseSessionContext handles empty input without throwing', () => {
  assert.deepEqual(parseSessionContext(''), {});
  assert.deepEqual(parseSessionContext(null), {});
});

// ─── readSessionContext ──────────────────────────────────────────────────

test('readSessionContext returns empty shape when file is missing', () => {
  const dir = tmpProject(null);
  try {
    const got = readSessionContext(dir);
    assert.equal(got.currentTask, '');
    assert.equal(got.keyFiles, '');
    assert.equal(got.mtimeMs, 0);
    assert.equal(got.isAutofill, false);
  } finally { cleanup(dir); }
});

test('readSessionContext returns empty shape when projectDir is null/undefined', () => {
  assert.equal(readSessionContext(null).currentTask, '');
  assert.equal(readSessionContext(undefined).currentTask, '');
});

test('readSessionContext extracts real task and key files', () => {
  const dir = tmpProject([
    '## Current Task',
    'Rework the migration script to handle rollback',
    '',
    '## Key Files',
    '- src/migrate.js',
    '- src/rollback.js',
  ].join('\n'));
  try {
    const got = readSessionContext(dir);
    assert.match(got.currentTask, /migration script/);
    assert.match(got.keyFiles, /src\/migrate\.js/);
    assert.equal(got.isAutofill, false);
    assert.ok(got.mtimeMs > 0);
  } finally { cleanup(dir); }
});

test('readSessionContext masks autofill content to empty', () => {
  const dir = tmpProject([
    '## Current Task',
    '<!-- si:autofill sha=abc1234 -->',
    'type: feature',
    'description: something derived',
    '',
    '## Key Files',
    '- src/foo.js',  // user-authored key-files, no sentinel
  ].join('\n'));
  try {
    const got = readSessionContext(dir);
    assert.equal(got.currentTask, '', 'autofill current task should mask to empty');
    assert.match(got.keyFiles, /src\/foo\.js/, 'non-autofill key-files preserved');
    assert.equal(got.isAutofill, true, 'isAutofill flag set');
  } finally { cleanup(dir); }
});

test('readSessionContext with maskAutofill:false surfaces raw autofill text', () => {
  const dir = tmpProject([
    '## Current Task',
    '<!-- si:autofill sha=abc1234 -->',
    'type: feature',
  ].join('\n'));
  try {
    const got = readSessionContext(dir, { maskAutofill: false });
    assert.match(got.currentTask, /autofill/);
    assert.match(got.currentTask, /type: feature/);
    assert.equal(got.isAutofill, true);
  } finally { cleanup(dir); }
});

test('readSessionContext treats placeholder-only sections as empty', () => {
  const dir = tmpProject([
    '## Current Task',
    '- (describe what you are doing)',
    'type: (feature | fix | refactor)',
    '',
    '## Key Files',
    '- (list files here)',
  ].join('\n'));
  try {
    const got = readSessionContext(dir);
    assert.equal(got.currentTask, '');
    assert.equal(got.keyFiles, '');
    assert.equal(got.isAutofill, false);
  } finally { cleanup(dir); }
});

// ─── AUTOFILL_SENTINEL_RE sanity ─────────────────────────────────────────

test('AUTOFILL_SENTINEL_RE matches a range of SHA lengths', () => {
  assert.match('<!-- si:autofill sha=abcd -->', AUTOFILL_SENTINEL_RE);
  assert.match('<!-- si:autofill sha=abcd1234 -->', AUTOFILL_SENTINEL_RE);
  assert.match('<!-- si:autofill sha=aabbccddeeff00112233445566778899aabbccdd -->', AUTOFILL_SENTINEL_RE);
  assert.doesNotMatch('<!-- si:autofill sha=abc -->', AUTOFILL_SENTINEL_RE);     // too short
  assert.doesNotMatch('<!-- si:autofill sha=xyz1234 -->', AUTOFILL_SENTINEL_RE); // non-hex
  assert.doesNotMatch('<!-- autofill sha=abcd1234 -->', AUTOFILL_SENTINEL_RE);   // missing prefix
});
