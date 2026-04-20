/**
 * Tests for lib/tool-archive.js — PostToolUse large-response archive.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const toolArchive = require('../lib/tool-archive');

// Each test runs under a unique sid so concurrent runs don't collide and
// so one test can't observe another's fixtures.
function uniqSid(tag) {
  return `test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function cleanup(sid) {
  const dir = toolArchive.archiveDir(sid);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

test('writeArchive persists a full body + index row above threshold', () => {
  const sid = uniqSid('basic');
  try {
    const id = 'toolu_' + 'a'.repeat(40);
    const body = 'x'.repeat(5000); // > 4096 default threshold
    const file = toolArchive.writeArchive(sid, id, { tool_name: 'Read', tool_input: { file_path: '/p' } }, body);
    assert.ok(file, 'should return archive path when body exceeds threshold');
    assert.ok(fs.existsSync(file), 'archive file should exist on disk');

    const rec = toolArchive.readArchive(sid, id);
    assert.equal(rec.id, id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64));
    assert.equal(rec.tool, 'Read');
    assert.equal(rec.chars, 5000);
    assert.equal(rec.body, body);

    const idx = toolArchive.readIndex(sid);
    assert.equal(idx.length, 1);
    assert.equal(idx[0].tool, 'Read');
  } finally { cleanup(sid); }
});

test('writeArchive skips bodies below threshold', () => {
  const sid = uniqSid('below');
  try {
    const id = 'toolu_below';
    const body = 'x'.repeat(100); // well below 4096
    const file = toolArchive.writeArchive(sid, id, { tool_name: 'Bash' }, body);
    assert.equal(file, null);
    assert.equal(toolArchive.readIndex(sid).length, 0);
  } finally { cleanup(sid); }
});

test('writeArchive respects the enabled=false flag', () => {
  const sid = uniqSid('disabled');
  try {
    const id = 'toolu_disabled';
    const body = 'x'.repeat(8000);
    const file = toolArchive.writeArchive(sid, id, {}, body, { enabled: false });
    assert.equal(file, null);
  } finally { cleanup(sid); }
});

test('writeArchive rejects ids with path-traversal characters', () => {
  const sid = uniqSid('traversal');
  try {
    const body = 'x'.repeat(6000);
    const file = toolArchive.writeArchive(sid, '../etc/passwd', {}, body);
    // Sanitizer strips dots + slashes, leaving `etcpasswd`. The file
    // should still land inside the archive dir, not outside it.
    assert.ok(file, 'sanitized id should still be writable');
    const dir = toolArchive.archiveDir(sid);
    assert.ok(file.startsWith(dir + path.sep), `archive path ${file} must stay under ${dir}`);
  } finally { cleanup(sid); }
});

test('writeArchive skips when id is empty after sanitization', () => {
  const sid = uniqSid('emptyid');
  try {
    const body = 'x'.repeat(6000);
    const file = toolArchive.writeArchive(sid, '///', {}, body);
    assert.equal(file, null);
  } finally { cleanup(sid); }
});

test('extractFromPayload handles tool_response, tool_output, output, result', () => {
  const cases = [
    { payload: { tool_use_id: 'a', tool_response: 'AAA' }, want: 'AAA' },
    { payload: { tool_use_id: 'a', tool_output: 'BBB' }, want: 'BBB' },
    { payload: { tool_use_id: 'a', output: 'CCC' }, want: 'CCC' },
    { payload: { tool_use_id: 'a', result: 'DDD' }, want: 'DDD' },
  ];
  for (const c of cases) {
    const { body, id } = toolArchive.extractFromPayload(c.payload);
    assert.equal(id, 'a');
    assert.equal(body, c.want);
  }
});

test('extractFromPayload stringifies non-string bodies', () => {
  const { body } = toolArchive.extractFromPayload({
    tool_use_id: 'x',
    tool_response: { nested: true, val: 42 },
  });
  assert.equal(body, '{"nested":true,"val":42}');
});

test('LRU cap drops oldest archives when exceeded', () => {
  const sid = uniqSid('lru');
  try {
    for (let i = 0; i < 5; i++) {
      toolArchive.writeArchive(sid, `id-${i}`, { tool_name: 'Read' }, 'x'.repeat(5000),
        { maxPerSession: 3 });
    }
    const rows = toolArchive.listArchives(sid);
    assert.equal(rows.length, 3, 'index trimmed to cap');
    assert.deepEqual(rows.map((r) => r.id), ['id-2', 'id-3', 'id-4']);
    // The evicted archive files are gone from disk too.
    assert.equal(fs.existsSync(toolArchive.archiveFile(sid, 'id-0')), false);
    assert.equal(fs.existsSync(toolArchive.archiveFile(sid, 'id-4')), true);
  } finally { cleanup(sid); }
});

test('sweepTtl deletes archives older than the cutoff', () => {
  const sid = uniqSid('ttl');
  try {
    const oldId = 'old-id';
    const newId = 'new-id';
    toolArchive.writeArchive(sid, oldId, { tool_name: 'Read' }, 'x'.repeat(5000));
    toolArchive.writeArchive(sid, newId, { tool_name: 'Read' }, 'y'.repeat(5000));

    // Backdate the "old" record + its index entry to 30 days ago.
    const oldFile = toolArchive.archiveFile(sid, oldId);
    const rec = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
    rec.t = Date.now() - 30 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(oldFile, JSON.stringify(rec));

    // Rewrite index so only the old row is backdated.
    const idxFile = toolArchive.indexFile(sid);
    const rows = fs.readFileSync(idxFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    rows[0].t = rec.t; // old row is first (oldest-first order)
    fs.writeFileSync(idxFile, rows.map(JSON.stringify).join('\n') + '\n');

    const pruned = toolArchive.sweepTtl(sid, 7);
    assert.equal(pruned, 1);
    assert.equal(fs.existsSync(oldFile), false, 'stale archive removed');
    assert.ok(fs.existsSync(toolArchive.archiveFile(sid, newId)), 'fresh archive kept');
  } finally { cleanup(sid); }
});

test('readArchive returns null for unknown id', () => {
  const sid = uniqSid('unknown');
  try {
    assert.equal(toolArchive.readArchive(sid, 'never-written'), null);
  } finally { cleanup(sid); }
});

test('archiveDir is namespaced under os.tmpdir to avoid cross-session collision', () => {
  const dir = toolArchive.archiveDir('abc-123');
  assert.ok(dir.startsWith(os.tmpdir()));
  assert.ok(dir.endsWith('claude-tool-archive-abc-123'));
});
