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

test('archiveDir is namespaced under getStateDir to avoid cross-session collision', () => {
  const { getStateDir } = require('../lib/utils');
  const dir = toolArchive.archiveDir('abc-123');
  assert.ok(dir.startsWith(getStateDir()),
    `expected archiveDir under ${getStateDir()}, got ${dir}`);
  assert.ok(dir.endsWith('claude-tool-archive-abc-123'));
});

// ─── DB ↔ disk reconciliation ────────────────────────────────────────────────
// writeArchive mirrors each archive into the events DB. Historically the DB row
// outlived its file (LRU/TTL eviction, dir wipe), so /si stats reported phantom
// archives. Point events at a sandbox DB and assert the row count tracks disk.

const events = require('../lib/events');
const BIG = 'z'.repeat(5000); // > 4096 default threshold

function withSandboxDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-archdb-'));
  events._setDbPathForTest(path.join(dir, 'si-events.db'));
  try { fn(); }
  finally {
    events._resetForTest();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test('reconcileDb prunes rows whose files are gone, keeps live ones', () => {
  withSandboxDb(() => {
    const live = uniqSid('rec-live');
    const dead = uniqSid('rec-dead');
    try {
      toolArchive.writeArchive(live, 'toolu_live1', { tool_name: 'Read' }, BIG);
      toolArchive.writeArchive(dead, 'toolu_dead1', { tool_name: 'Bash' }, BIG);
      assert.equal(events.allToolArchiveKeys().length, 2, 'both rows mirrored to DB');

      // Simulate the SessionStart dir-pruner wiping the dead session's dir,
      // leaving its DB row orphaned.
      fs.rmSync(toolArchive.archiveDir(dead), { recursive: true, force: true });

      const pruned = toolArchive.reconcileDb();
      assert.equal(pruned, 1, 'one orphan row pruned');
      const keys = events.allToolArchiveKeys();
      assert.equal(keys.length, 1, 'live row survives');
      assert.equal(keys[0].id, 'toolu_live1');
    } finally { cleanup(live); cleanup(dead); }
  });
});

test('enforceLruCap removes evicted archives from the events DB', () => {
  withSandboxDb(() => {
    const sid = uniqSid('lru-db');
    try {
      for (let i = 0; i < 5; i++) {
        toolArchive.writeArchive(sid, `toolu_lru${i}`, { tool_name: 'Read' }, BIG);
      }
      assert.equal(events.allToolArchiveKeys().length, 5);
      toolArchive.enforceLruCap(sid, 2); // keep 2 newest, evict 3
      assert.equal(toolArchive.readIndex(sid).length, 2, 'index trimmed to cap');
      assert.equal(events.allToolArchiveKeys().length, 2, 'DB rows trimmed in lockstep');
    } finally { cleanup(sid); }
  });
});

test('sweepTtl removes expired archives from the events DB', () => {
  withSandboxDb(() => {
    const sid = uniqSid('ttl-db');
    try {
      toolArchive.writeArchive(sid, 'toolu_old', { tool_name: 'Read' }, BIG);
      toolArchive.writeArchive(sid, 'toolu_new', { tool_name: 'Read' }, BIG);
      // Backdate the old archive's index row past the TTL cutoff.
      const idxFile = toolArchive.indexFile(sid);
      const rows = fs.readFileSync(idxFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
      rows[0].t = Date.now() - 30 * 24 * 60 * 60 * 1000;
      fs.writeFileSync(idxFile, rows.map(JSON.stringify).join('\n') + '\n');

      assert.equal(events.allToolArchiveKeys().length, 2);
      const pruned = toolArchive.sweepTtl(sid, 7);
      assert.equal(pruned, 1);
      const keys = events.allToolArchiveKeys();
      assert.equal(keys.length, 1, 'expired DB row removed');
      assert.equal(keys[0].id, 'toolu_new');
    } finally { cleanup(sid); }
  });
});

test('deleteToolArchives is a no-op on empty input and never throws', () => {
  withSandboxDb(() => {
    assert.equal(events.deleteToolArchives([]), 0);
    assert.equal(events.deleteToolArchives(null), 0);
  });
});

// ─── expand CLI arg parsing — recall-path reliability ─────────────────────
//
// A mis-parsed --sid resolves the wrong session, the archive lookup misses,
// and markArchiveRecalled is never reached — silently zeroing recall stats.

const { parseArgs } = require('../tools/expand');

test('parseArgs accepts --sid=<v> (equals form)', () => {
  const a = parseArgs(['toolu_x', '--sid=abc123']);
  assert.equal(a.flags.sid, 'abc123');
  assert.deepEqual(a.positional, ['toolu_x']);
});

test('parseArgs accepts --sid <v> (space form)', () => {
  const a = parseArgs(['toolu_x', '--sid', 'abc123']);
  assert.equal(a.flags.sid, 'abc123', 'space-form value is consumed, not left positional');
  assert.deepEqual(a.positional, ['toolu_x'], 'sid value must NOT leak into positionals');
});

test('parseArgs does not let --sid swallow a following flag', () => {
  const a = parseArgs(['--sid', '--list']);
  assert.equal(a.flags.sid, true, 'bare --sid before another flag stays boolean');
  assert.equal(a.flags.list, true);
});

test('parseArgs keeps boolean flags boolean (--list, --prune)', () => {
  const a = parseArgs(['--list', '--prune']);
  assert.equal(a.flags.list, true);
  assert.equal(a.flags.prune, true);
  assert.deepEqual(a.positional, []);
});
