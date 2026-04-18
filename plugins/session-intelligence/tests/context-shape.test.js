/**
 * Tests for lib/context-shape.js shift-detection guard (M2 from the audit).
 *
 * The bug: shift detection used head/tail SHIFT_WINDOW=10 slices regardless
 * of total entry count. For sessions with < 20 entries those slices
 * overlap, producing a trivial jaccard=1 and masking real pivots.
 *
 * The fix gates the shift check on `withRoot.length >= 2 * SHIFT_WINDOW`,
 * returning `shift: null` for small sessions rather than a misleading
 * "no shift" signal.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { analyzeShape, rootDirOf } = require('../lib/context-shape');

// Build entries(n, pattern): tokens monotonically increasing, root chosen
// by callback so tests can shape head vs. tail themselves.
function entries(n, pickRoot) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      t: Date.now() - (n - i) * 1000,
      tok: 1000 * (i + 1),
      tool: 'Read',
      root: pickRoot(i),
      event: null,
    });
  }
  return out;
}

test('analyzeShape returns null when fewer than 5 entries with root', () => {
  const few = entries(4, () => 'src');
  assert.equal(analyzeShape(few), null);
});

test('analyzeShape runs banding but skips shift detection when <20 entries', () => {
  // 10 entries: enough for banding (>=5), too few for shift (requires 2*10)
  const small = entries(10, (i) => i < 5 ? 'src/auth' : 'src/billing');
  const result = analyzeShape(small);
  assert.ok(result, 'banding still produced');
  assert.equal(result.shift, null,
    'shift detection skipped on small sessions to avoid overlap artefacts');
  assert.ok(result.hot || result.warm || result.cold, 'bands still populated');
});

test('analyzeShape detects a real shift when windows do not overlap', () => {
  // 30 entries: first 15 in src/auth, last 15 in src/billing. Clean pivot.
  const pivot = entries(30, (i) => i < 15 ? 'src/auth' : 'src/billing');
  const result = analyzeShape(pivot);
  assert.ok(result, 'result produced');
  assert.ok(result.shift, 'shift detected on non-overlapping windows');
  assert.ok(result.shift.from.includes('src/auth'),
    'from list includes the dropped root');
  assert.ok(result.shift.to.includes('src/billing'),
    'to list includes the new root');
});

test('analyzeShape reports no shift when domain is stable across window', () => {
  const stable = entries(40, () => 'src/main');
  const result = analyzeShape(stable);
  assert.ok(result);
  assert.equal(result.shift, null, 'no shift on stable domain');
});

test('analyzeShape handles empty input without throwing', () => {
  assert.equal(analyzeShape([]), null);
  assert.equal(analyzeShape(null), null);
});

// ── rootDirOf cwd-awareness (CSM dogfood bug) ──────────────────────────────
// Without cwd stripping, absolute paths under /Users/<name>/ burn both depth
// slots on the home prefix, collapsing every file under that user to a
// single bucket. With cwd stripping, depth counts from the project root —
// which is what makes HOT/DROPPED bands and regret detection meaningful.

test('rootDirOf without cwd: absolute path buckets at home (current broken behavior preserved)', () => {
  // Legacy callers that don't pass cwd still get the old output.
  const root = rootDirOf('/Users/alex/DWS/CSM/frontend/dashboard/App.tsx', 2);
  assert.equal(root, '/Users/alex');
});

test('rootDirOf with cwd: absolute path under cwd buckets from project root', () => {
  const root = rootDirOf(
    '/Users/alex/DWS/CSM/frontend/dashboard/App.tsx',
    2,
    { cwd: '/Users/alex/DWS/CSM' },
  );
  assert.equal(root, 'frontend/dashboard');
});

test('rootDirOf with cwd: file at cwd root returns "."', () => {
  const root = rootDirOf(
    '/Users/alex/DWS/CSM/README.md',
    2,
    { cwd: '/Users/alex/DWS/CSM' },
  );
  assert.equal(root, '.');
});

test('rootDirOf with cwd: exact cwd match returns "."', () => {
  const root = rootDirOf(
    '/Users/alex/DWS/CSM',
    2,
    { cwd: '/Users/alex/DWS/CSM' },
  );
  assert.equal(root, '.');
});

test('rootDirOf with cwd: path OUTSIDE cwd falls back to absolute bucketing', () => {
  // /tmp is not under /Users/alex/DWS/CSM — don't strip anything.
  const root = rootDirOf(
    '/tmp/foo/bar/baz.txt',
    2,
    { cwd: '/Users/alex/DWS/CSM' },
  );
  assert.equal(root, '/tmp/foo');
});

test('rootDirOf with cwd: sibling path with shared prefix does NOT match', () => {
  // /Users/alex/DWS/CSMX must not match cwd /Users/alex/DWS/CSM — requires
  // full path-segment boundary.
  const root = rootDirOf(
    '/Users/alex/DWS/CSMX/foo.ts',
    2,
    { cwd: '/Users/alex/DWS/CSM' },
  );
  assert.equal(root, '/Users/alex');
});

test('rootDirOf with cwd: relative path passthrough unchanged', () => {
  // Relative paths bypass the cwd-strip branch entirely.
  const root = rootDirOf('src/auth/login.ts', 2, { cwd: '/Users/alex/DWS/CSM' });
  assert.equal(root, 'src/auth');
});

test('rootDirOf with cwd: trailing slash on cwd is handled', () => {
  const root = rootDirOf(
    '/Users/alex/DWS/CSM/backend/api/auth.go',
    2,
    { cwd: '/Users/alex/DWS/CSM/' },
  );
  assert.equal(root, 'backend/api');
});

test('rootDirOf with cwd + depth=3: monorepo layer below project root', () => {
  const root = rootDirOf(
    '/Users/alex/DWS/CSM/packages/core/src/auth/login.ts',
    3,
    { cwd: '/Users/alex/DWS/CSM' },
  );
  assert.equal(root, 'packages/core/src');
});
