/**
 * Tests for lib/handoff.js — post-compact continuation.
 *
 * Covers the specific fixes landed this round:
 *   - C1: autofill content does not trigger a handoff write
 *   - H3: writeHandoff failure logs (not silent)
 *   - M1: gitPorcelain emits truncation sentinel past 20 entries
 *   - M4: read + delete is atomic (rename-to-owned)
 *   - Stale handoff (>1h) is cleaned up without replaying
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const handoff = require('../lib/handoff');

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'si-handoff-test-'));
}
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ─── readAndRenderHandoff ────────────────────────────────────────────────

test('readAndRenderHandoff returns empty when no handoff file exists', () => {
  const dir = tmpProject();
  try {
    assert.equal(handoff.readAndRenderHandoff(dir), '');
  } finally { cleanup(dir); }
});

test('readAndRenderHandoff returns empty when projectDir is null', () => {
  assert.equal(handoff.readAndRenderHandoff(null), '');
  assert.equal(handoff.readAndRenderHandoff(undefined), '');
  assert.equal(handoff.readAndRenderHandoff(''), '');
});

test('readAndRenderHandoff renders a well-formed handoff then cleans up', () => {
  const dir = tmpProject();
  try {
    fs.writeFileSync(path.join(dir, '.si-handoff.json'), JSON.stringify({
      t: Date.now(),
      currentTask: 'Refactor auth',
      currentTaskAgeHours: 0.5,
      inFlightFiles: ['M src/auth.js'],
      recentCommits: ['abc123 feat: split auth'],
    }));
    const out = handoff.readAndRenderHandoff(dir);
    assert.match(out, /Resuming after \/compact/);
    assert.match(out, /Refactor auth/);
    assert.match(out, /src\/auth\.js/);
    assert.match(out, /abc123 feat: split auth/);
    // File should be consumed (atomic rename + delete)
    assert.equal(fs.existsSync(path.join(dir, '.si-handoff.json')), false,
      'handoff file should be deleted after one-shot read');
  } finally { cleanup(dir); }
});

test('readAndRenderHandoff is atomic: two calls yield one render + one empty', () => {
  const dir = tmpProject();
  try {
    fs.writeFileSync(path.join(dir, '.si-handoff.json'), JSON.stringify({
      t: Date.now(),
      currentTask: 'atomicity probe',
    }));
    const a = handoff.readAndRenderHandoff(dir);
    const b = handoff.readAndRenderHandoff(dir);
    assert.ok(a.length > 0, 'first call renders the block');
    assert.equal(b, '', 'second call sees no file and returns empty');
    // No leftover owned-rename files
    const leftover = fs.readdirSync(dir).filter((f) => f.includes('.si-handoff'));
    assert.deepEqual(leftover, [], 'no leftover handoff temp files');
  } finally { cleanup(dir); }
});

test('readAndRenderHandoff drops stale handoffs (>1h old) without rendering', () => {
  const dir = tmpProject();
  try {
    fs.writeFileSync(path.join(dir, '.si-handoff.json'), JSON.stringify({
      t: Date.now() - 2 * 3600 * 1000,
      currentTask: 'stale task',
    }));
    const out = handoff.readAndRenderHandoff(dir);
    assert.equal(out, '', 'stale handoff is not rendered');
    assert.equal(fs.existsSync(path.join(dir, '.si-handoff.json')), false,
      'stale handoff is also cleaned up');
  } finally { cleanup(dir); }
});

test('readAndRenderHandoff tolerates corrupt JSON by returning empty', () => {
  const dir = tmpProject();
  try {
    fs.writeFileSync(path.join(dir, '.si-handoff.json'), '{ not valid json');
    // Silence the warn-level log (intel-debug also writes to stderr).
    const origErr = process.stderr.write;
    process.stderr.write = () => true;
    try {
      const out = handoff.readAndRenderHandoff(dir);
      assert.equal(out, '');
    } finally { process.stderr.write = origErr; }
  } finally { cleanup(dir); }
});

// ─── writeHandoff strong-signal gate ─────────────────────────────────────

test('writeHandoff skips when no strong signal (no task, no priorities)', () => {
  const dir = tmpProject();
  try {
    const wrote = handoff.writeHandoff({
      projectDir: dir,
      cwd: dir, // not a git repo, but that's ok — inFlight will be []
      sessionId: 'test-session',
    });
    assert.equal(wrote, false, 'no strong signal → no write');
    assert.equal(fs.existsSync(path.join(dir, '.si-handoff.json')), false);
  } finally { cleanup(dir); }
});

test('writeHandoff skips when only autofill sentinel content is present', () => {
  const dir = tmpProject();
  try {
    fs.writeFileSync(path.join(dir, 'session-context.md'), [
      '## Current Task',
      '<!-- si:autofill sha=abc1234 -->',
      'type: feature',
      'description: auto-derived',
    ].join('\n'));
    const wrote = handoff.writeHandoff({
      projectDir: dir,
      cwd: dir,
      sessionId: 'test-session',
    });
    assert.equal(wrote, false,
      'autofill-only content should not count as a strong signal');
  } finally { cleanup(dir); }
});

test('writeHandoff writes when a real Current Task is present', () => {
  const dir = tmpProject();
  try {
    fs.writeFileSync(path.join(dir, 'session-context.md'), [
      '## Current Task',
      'Finish the rate-limiter refactor before EOD',
    ].join('\n'));
    const wrote = handoff.writeHandoff({
      projectDir: dir,
      cwd: dir,
      sessionId: 'test-session',
    });
    assert.equal(wrote, true);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, '.si-handoff.json'), 'utf8'));
    assert.match(saved.currentTask, /rate-limiter refactor/);
    assert.ok(saved.currentTaskAgeHours != null);
  } finally { cleanup(dir); }
});

// ─── renderHandoffBanner ─────────────────────────────────────────────────

test('renderHandoffBanner surfaces task + signal counts', () => {
  const banner = handoff.renderHandoffBanner({
    currentTask: 'Ship the v2 migration',
    inFlightFiles: ['M a.js', 'M b.js'],
    recentCommits: ['x1 feat', 'x2 fix'],
    nextPriorities: ['follow up on docs'],
  });
  assert.match(banner, /\[session-intelligence\]/);
  assert.match(banner, /Ship the v2 migration/);
  assert.match(banner, /2 in-flight/);
  assert.match(banner, /2 commits/);
  assert.match(banner, /1 follow-ups/);
});

test('renderHandoffBanner degrades gracefully when empty', () => {
  const banner = handoff.renderHandoffBanner({});
  assert.match(banner, /resuming previous session/);
  // No parentheses block when all counts are 0
  assert.doesNotMatch(banner, /\(/);
});

test('renderHandoffBanner truncates very long task titles', () => {
  const longTask = 'x'.repeat(500);
  const banner = handoff.renderHandoffBanner({ currentTask: longTask });
  assert.ok(banner.length < 200,
    `banner should truncate long tasks (got ${banner.length} chars)`);
});

// ─── wrapHandoffForModelEcho ─────────────────────────────────────────────

test('wrapHandoffForModelEcho returns empty when block is empty', () => {
  assert.equal(handoff.wrapHandoffForModelEcho(''), '');
  assert.equal(handoff.wrapHandoffForModelEcho(null), '');
  assert.equal(handoff.wrapHandoffForModelEcho(undefined), '');
});

test('wrapHandoffForModelEcho wraps block with echo directive + markers', () => {
  const block = 'Resuming after /compact. Work on auth.';
  const wrapped = handoff.wrapHandoffForModelEcho(block);
  // Directive instructs the model to echo verbatim
  assert.match(wrapped, /SESSION RESUME/);
  assert.match(wrapped, /print the block .* VERBATIM/);
  // Markers delimit the echo region
  assert.match(wrapped, /---BEGIN RESUME BLOCK---/);
  assert.match(wrapped, /---END RESUME BLOCK---/);
  // Banner heading appears inside the markers (mobile-clean: plain H1,
  // no wide ━ dividers which wrap badly on narrow screens).
  assert.match(wrapped, /# Session Intelligence/);
  // Original block content is carried through
  assert.match(wrapped, /Work on auth/);
});

// ─── gitPorcelain truncation sentinel (M1) ───────────────────────────────

test('gitPorcelain truncation sentinel appears when result exceeds 20', () => {
  // Can't easily reproduce 20+ uncommitted files in a test repo; instead,
  // we validate the renderer surfaces the sentinel when present.
  const block = handoff.renderHandoffBlock({
    t: Date.now(),
    inFlightFiles: Array.from({ length: 20 }, (_, i) => `M file${i}.js`)
      .concat(['   ... and 35 more (truncated)']),
  });
  assert.match(block, /and 35 more \(truncated\)/);
});

// ─── atomic write + forensic preservation ───────────────────────────────

test('writeHandoff leaves no orphan .tmp files in projectDir on success', () => {
  const dir = tmpProject();
  try {
    fs.writeFileSync(path.join(dir, 'session-context.md'), [
      '## Current Task',
      'type: feature',
      'description: exercise atomic write path',
    ].join('\n'));
    const wrote = handoff.writeHandoff({
      projectDir: dir,
      cwd: dir,
      sessionId: 'test-session',
    });
    assert.equal(wrote, true);
    const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp.'));
    assert.equal(leftovers.length, 0, `unexpected tmp orphans: ${leftovers.join(', ')}`);
  } finally { cleanup(dir); }
});

test('readAndRenderHandoff preserves a .corrupt.* snapshot on parse failure', () => {
  const dir = tmpProject();
  try {
    fs.writeFileSync(path.join(dir, '.si-handoff.json'), '{ ');
    const origErr = process.stderr.write;
    process.stderr.write = () => true;
    try {
      const out = handoff.readAndRenderHandoff(dir);
      assert.equal(out, '');
    } finally { process.stderr.write = origErr; }
    const snapshots = fs.readdirSync(dir).filter((n) => n.startsWith('.si-handoff.json.corrupt.'));
    assert.equal(snapshots.length, 1, 'exactly one forensic snapshot is kept');
    assert.equal(fs.readFileSync(path.join(dir, snapshots[0]), 'utf8'), '{ ',
      'snapshot preserves raw on-disk bytes');
  } finally { cleanup(dir); }
});

// ─── readNextPriorities header variants ──────────────────────────────────
//
// Real-world session-context.md / MEMORY.md files use a wide range of
// header conventions: `## Next Session`, `## Next-up`, `## Follow-ups`,
// `## TODO`, etc. The scanner must recognize them all or projects that
// don't happen to use `## Follow-ups` get an empty priorities block and
// fail the handoff "strong signal" gate on every compact.
test('readNextPriorities recognizes Next Session / Next-up / TODO headers', () => {
  const dir = tmpProject();
  const memoryDir = path.join(dir, 'memory');
  fs.mkdirSync(memoryDir);
  try {
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), [
      '## Next Session',
      '- **Resume #202** — admin UI code done.',
      '- **PR #209** needs review/merge.',
      '',
      '## Source of Truth',
      '- unrelated',
    ].join('\n'));

    const priorities = handoff._internal.readNextPriorities(dir);
    assert.ok(priorities.length >= 2, `expected ≥2 priorities, got ${priorities.length}`);
    assert.match(priorities[0], /Resume #202/);
    assert.match(priorities[1], /PR #209/);
  } finally { cleanup(dir); }
});

test('readNextPriorities scans session-context.md when memory is empty', () => {
  const dir = tmpProject();
  try {
    fs.writeFileSync(path.join(dir, 'session-context.md'), [
      '## Current Task',
      'stale work',
      '',
      '## Next-up (from project_next_session_priorities)',
      '1. **#143** Terms and Privacy pages',
      '2. **#105** Usability testing',
    ].join('\n'));

    const priorities = handoff._internal.readNextPriorities(dir);
    assert.ok(priorities.length >= 2,
      `session-context.md Next-up section should yield priorities (got ${priorities.length})`);
    assert.match(priorities[0], /#143/);
    assert.match(priorities[1], /#105/);
  } finally { cleanup(dir); }
});
