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
const fs = require('node:fs');

const path = require('node:path');
const os = require('node:os');

const {
  analyzeShape, rootDirOf,
  rollupShape, readRollup, rollupFilePath,
  shapeFilePath, appendShape,
  projectRootOf, _resetProjectRootCache,
  sessionStatePath, readSessionState, writeSessionState, resolveSessionCwd,
  formatCompactInjection,
} = require('../lib/context-shape');

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

// ── scoring modes ──────────────────────────────────────────────────────────
// Recency mode must preserve legacy behavior (last 20% → HOT). Frequency
// must classify by call count regardless of when the calls happened. Hybrid
// must pull a high-count mid-recency root OUT of COLD — the exact failure
// mode that prompted the feature (auth/billing read heavily early but not
// in the last 20% token-span).

function scoredEntries(specs) {
  // specs: [{ root, tok, file? }, ...] — returns entry objects ordered by tok.
  return specs
    .slice()
    .sort((a, b) => a.tok - b.tok)
    .map((s) => ({ t: Date.now(), tok: s.tok, tool: 'Read', root: s.root, file: s.file || null, event: null }));
}

test('scoring=recency preserves legacy last-20% HOT boundary', () => {
  // 20 entries. src/recent only in last 20% (tok 17000..20000).
  // src/old only in first 80% (tok 1000..16000). Legacy classifier puts
  // src/recent HOT, src/old NOT HOT.
  const specs = [];
  for (let i = 1; i <= 16; i++) specs.push({ root: 'src/old', tok: i * 1000 });
  for (let i = 17; i <= 20; i++) specs.push({ root: 'src/recent', tok: i * 1000 });
  const result = analyzeShape(scoredEntries(specs), { scoring: 'recency' });
  const hotRoots = result.hot.map((h) => h.root);
  assert.ok(hotRoots.includes('src/recent'), 'recent root is HOT under recency');
  assert.ok(!hotRoots.includes('src/old'), 'old root is not HOT under recency');
});

test('scoring=frequency lifts heavy root even when recency is mid-range', () => {
  // src/heavy: 30 touches spread tok 1000..15000 (mid-recency, NOT in top 20%)
  // src/light: 2 touches at tok 19000, 20000 (top 20%, low count)
  // Under recency: light=HOT, heavy=WARM/COLD.
  // Under frequency: heavy=HOT (count >> light).
  const specs = [];
  for (let i = 0; i < 30; i++) specs.push({ root: 'src/heavy', tok: 1000 + i * 450 });
  specs.push({ root: 'src/light', tok: 19000 });
  specs.push({ root: 'src/light', tok: 20000 });
  const result = analyzeShape(scoredEntries(specs), { scoring: 'frequency' });
  const hotRoots = result.hot.map((h) => h.root);
  assert.ok(hotRoots.includes('src/heavy'),
    'frequency mode classifies the heavy-hitter HOT regardless of recency');
});

test('scoring=hybrid rescues heavy root from COLD even when recency is low', () => {
  // src/billing: 40 touches spread tok 1000..40000 (ends mid-session at 40k).
  // one-off roots fill the last 60% so billing's recency is < HOT cutoff.
  // Under recency: billing=COLD (last touch at 40k, lastTok=100k → recency 0.4).
  // Under hybrid: freq boost lifts billing above WARM cutoff at minimum.
  const specs = [];
  for (let i = 0; i < 40; i++) specs.push({ root: 'services/billing', tok: 1000 + i * 1000 });
  // Fill the rest with varied low-count roots so billing's recency drops.
  for (let i = 0; i < 20; i++) specs.push({ root: `feat/${i}`, tok: 41000 + i * 3000 });
  const entries = scoredEntries(specs);

  const recencyResult = analyzeShape(entries, { scoring: 'recency' });
  const hybridResult = analyzeShape(entries, { scoring: 'hybrid' });

  const recencyBand = (root) => {
    if (recencyResult.hot.find((r) => r.root === root)) return 'hot';
    if (recencyResult.warm.find((r) => r.root === root)) return 'warm';
    if (recencyResult.cold.find((r) => r.root === root)) return 'cold';
    return null;
  };
  const hybridBand = (root) => {
    if (hybridResult.hot.find((r) => r.root === root)) return 'hot';
    if (hybridResult.warm.find((r) => r.root === root)) return 'warm';
    if (hybridResult.cold.find((r) => r.root === root)) return 'cold';
    return null;
  };

  // Under pure recency billing should not land in HOT.
  assert.notEqual(recencyBand('services/billing'), 'hot',
    'sanity: under pure recency the heavy mid-session root is not HOT');
  // Under hybrid the frequency lift should promote it above COLD.
  assert.notEqual(hybridBand('services/billing'), 'cold',
    'hybrid must rescue high-frequency root from COLD classification');
});

test('scoring defaults to hybrid when not provided', () => {
  const specs = [];
  for (let i = 0; i < 30; i++) specs.push({ root: 'src/heavy', tok: 1000 + i * 400 });
  specs.push({ root: 'src/light', tok: 20000 });
  specs.push({ root: 'src/light', tok: 21000 });
  // No scoring option → falls back to hybrid internally.
  const result = analyzeShape(scoredEntries(specs));
  assert.ok(result, 'result produced without scoring option');
  const heavy = [...result.hot, ...result.warm, ...result.cold]
    .find((r) => r.root === 'src/heavy');
  assert.ok(heavy, 'heavy root classified');
  assert.ok(Number.isFinite(heavy.score), 'score attached to root info');
  assert.ok(Number.isFinite(heavy.recencyScore), 'recencyScore attached');
  assert.ok(Number.isFinite(heavy.freqScore), 'freqScore attached');
});

// ── persistAcrossCompacts + rollup ──────────────────────────────────────────
// The rollup file captures per-root tallies so subsequent compacts inherit
// long-term frequency. De-dup via rolledThroughTok prevents double-counting.

function cleanupRollup(sid) {
  try { fs.rmSync(rollupFilePath(sid), { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(shapeFilePath(sid), { force: true }); } catch { /* ignore */ }
}

test('rollupShape folds current entries and advances rolledThroughTok', () => {
  const sid = 'rolluptest1';
  cleanupRollup(sid);
  appendShape(sid, { t: 1, tok: 1000, tool: 'Read', root: 'src/auth', file: 'src/auth/a.ts' });
  appendShape(sid, { t: 2, tok: 2000, tool: 'Read', root: 'src/auth', file: 'src/auth/b.ts' });
  appendShape(sid, { t: 3, tok: 3000, tool: 'Read', root: 'src/billing', file: 'src/billing/x.ts' });

  const rollup = rollupShape(sid);
  assert.ok(rollup, 'rollup written');
  assert.equal(rollup.rolledThroughTok, 3000, 'rolledThroughTok advances to max entry tok');
  assert.equal(rollup.roots['src/auth'].count, 2, 'src/auth counted twice');
  assert.equal(rollup.roots['src/billing'].count, 1, 'src/billing counted once');
  cleanupRollup(sid);
});

test('rollupShape is idempotent on re-run (rolledThroughTok gates dup entries)', () => {
  const sid = 'rolluptest2';
  cleanupRollup(sid);
  appendShape(sid, { t: 1, tok: 1000, tool: 'Read', root: 'src/auth' });
  appendShape(sid, { t: 2, tok: 2000, tool: 'Read', root: 'src/auth' });
  rollupShape(sid);
  rollupShape(sid);
  const rollup = readRollup(sid);
  assert.equal(rollup.roots['src/auth'].count, 2, 'second rollup does not re-count old entries');

  // Adding a newer entry then re-rolling up should only add the new one.
  appendShape(sid, { t: 3, tok: 5000, tool: 'Read', root: 'src/auth' });
  rollupShape(sid);
  const after = readRollup(sid);
  assert.equal(after.roots['src/auth'].count, 3, 'new entry increments exactly once');
  assert.equal(after.rolledThroughTok, 5000);
  cleanupRollup(sid);
});

test('analyzeShape with persistAcrossCompacts merges rollup history', () => {
  const sid = 'rolluptest3';
  cleanupRollup(sid);

  // Simulate a past compact having rolled up billing history:
  //   billing: 40 touches across tok 1000..40000
  // Then a new session window sees only a small number of entries in
  // different roots; billing doesn't appear in the live shape at all.
  // Without rollup, billing is invisible. With rollup, billing enters the
  // classification via rollup.roots and hybrid/frequency can lift it.
  const billingEntries = [];
  for (let i = 0; i < 40; i++) {
    billingEntries.push({ t: i, tok: 1000 + i * 1000, tool: 'Read', root: 'services/billing' });
  }
  for (const e of billingEntries) appendShape(sid, e);
  rollupShape(sid);
  // Wipe live shape so only rollup carries history.
  try { fs.rmSync(shapeFilePath(sid), { force: true }); } catch { /* ignore */ }

  // Fresh session entries in a different root, tok range after the rollup.
  const liveEntries = [];
  for (let i = 0; i < 10; i++) {
    liveEntries.push({ t: 100 + i, tok: 50000 + i * 1000, tool: 'Read', root: 'feat/newthing' });
  }

  const withoutPersist = analyzeShape(liveEntries, { scoring: 'frequency' });
  const billingInWithout = [...withoutPersist.hot, ...withoutPersist.warm, ...withoutPersist.cold]
    .some((r) => r.root === 'services/billing');
  assert.equal(billingInWithout, false, 'without persistence, rollup-only root is invisible');

  const withPersist = analyzeShape(liveEntries, {
    scoring: 'frequency',
    persistAcrossCompacts: true,
    sessionId: sid,
  });
  const billingBand = ['hot', 'warm', 'cold'].find((band) =>
    withPersist[band].some((r) => r.root === 'services/billing'));
  assert.ok(billingBand, 'with persistence, rollup root enters classification');
  cleanupRollup(sid);
});

test('analyzeShape with persistence skips entries already rolled up (no double count)', () => {
  const sid = 'rolluptest4';
  cleanupRollup(sid);

  // Populate and roll up 20 entries.
  for (let i = 0; i < 20; i++) {
    appendShape(sid, { t: i, tok: 1000 + i * 1000, tool: 'Read', root: 'src/x' });
  }
  rollupShape(sid);
  // The same 20 entries are still in the shape file. Without dedup, analyze
  // would see count=40. With dedup via rolledThroughTok, it stays at 20.
  const entries = require('../lib/context-shape').readShape(sid);
  assert.equal(entries.length, 20);

  // Need ≥5 live entries past rolledThroughTok for analyzeShape to run
  // (the ≥5 withRoot guard applies to entries after the rollup filter).
  for (let i = 0; i < 6; i++) {
    appendShape(sid, { t: 1000 + i, tok: 30000 + i * 1000, tool: 'Read', root: 'src/y' });
  }
  const result = analyzeShape(require('../lib/context-shape').readShape(sid), {
    persistAcrossCompacts: true, sessionId: sid, scoring: 'frequency',
  });
  const xRoot = [...result.hot, ...result.warm, ...result.cold].find((r) => r.root === 'src/x');
  assert.ok(xRoot, 'src/x present in classification');
  assert.equal(xRoot.count, 20, 'src/x counted exactly once (rollup, not live+rollup)');
  cleanupRollup(sid);
});

// ─── projectRootOf walk-up tests ──────────────────────────────────────────
//
// Walk up from a file toward the filesystem root, stopping at the first
// project-marker or system boundary. Independent of cwd — this is the
// fallback anchor when si-token-budget's cwd resolution fails.

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}
function rmRf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }

test('projectRootOf returns the first ancestor with a marker', () => {
  _resetProjectRootCache();
  const base = mkTempDir('ctx-shape-pr1');
  try {
    fs.mkdirSync(path.join(base, 'repo', 'src', 'auth'), { recursive: true });
    fs.writeFileSync(path.join(base, 'repo', '.git'), 'gitdir: ignored\n');
    const file = path.join(base, 'repo', 'src', 'auth', 'login.ts');
    fs.writeFileSync(file, '// test\n');
    assert.equal(projectRootOf(file), path.join(base, 'repo'));
  } finally { rmRf(base); }
});

test('projectRootOf stops at system boundaries (never returns $HOME)', () => {
  _resetProjectRootCache();
  // No marker anywhere — walking up should return null rather than bubble
  // to $HOME or /. Use a nonexistent path so stat fails, forcing the
  // walk-up branch.
  const nowhere = '/definitely/not/a/real/path/foo.ts';
  assert.equal(projectRootOf(nowhere), null);
});

test('projectRootOf caches per directory — second lookup skips fs walk', () => {
  _resetProjectRootCache();
  const base = mkTempDir('ctx-shape-pr2');
  try {
    fs.mkdirSync(path.join(base, 'a', 'b', 'c'), { recursive: true });
    fs.writeFileSync(path.join(base, 'a', 'package.json'), '{}\n');
    const f1 = path.join(base, 'a', 'b', 'c', 'x.ts');
    const f2 = path.join(base, 'a', 'b', 'c', 'y.ts');
    fs.writeFileSync(f1, '');
    fs.writeFileSync(f2, '');

    const root1 = projectRootOf(f1);
    assert.equal(root1, path.join(base, 'a'));

    // Rip the marker out; cached result should still win.
    fs.unlinkSync(path.join(base, 'a', 'package.json'));
    const root2 = projectRootOf(f2);
    assert.equal(root2, path.join(base, 'a'), 'cached from f1 walk');
  } finally { rmRf(base); }
});

test('projectRootOf returns null for relative paths', () => {
  assert.equal(projectRootOf('relative/path.ts'), null);
  assert.equal(projectRootOf(''), null);
  assert.equal(projectRootOf(null), null);
});

// ─── session-state round-trip ─────────────────────────────────────────────

test('writeSessionState + readSessionState round-trip', () => {
  const sid = 'sessiontest1';
  try { fs.unlinkSync(sessionStatePath(sid)); } catch { /* not present */ }

  writeSessionState(sid, { sessionId: sid, cwd: '/tmp/proj', pid: 1234 });
  const state = readSessionState(sid);
  assert.equal(state.cwd, '/tmp/proj');
  assert.equal(state.pid, 1234);

  fs.unlinkSync(sessionStatePath(sid));
});

test('readSessionState returns {} when missing / malformed', () => {
  assert.deepEqual(readSessionState('nonexistentSID1234'), {});

  const sid = 'sessiontest2';
  fs.writeFileSync(sessionStatePath(sid), 'not json');
  assert.deepEqual(readSessionState(sid), {});
  fs.unlinkSync(sessionStatePath(sid));
});

// ─── resolveSessionCwd priority chain ────────────────────────────────────

test('resolveSessionCwd prefers session state over payload', () => {
  const sid = 'resolvetest1';
  writeSessionState(sid, { sessionId: sid, cwd: '/pinned/by/bootstrap' });
  try {
    const got = resolveSessionCwd({
      sessionId: sid, payloadCwd: '/some/other', filePath: '/unrelated/file.ts',
    });
    assert.equal(got.cwd, '/pinned/by/bootstrap');
    assert.equal(got.source, 'session');
  } finally { fs.unlinkSync(sessionStatePath(sid)); }
});

test('resolveSessionCwd falls back to payload when no session state', () => {
  const sid = 'resolvetest2';
  try { fs.unlinkSync(sessionStatePath(sid)); } catch { /* not present */ }
  const got = resolveSessionCwd({
    sessionId: sid, payloadCwd: '/payload/cwd', filePath: '/file.ts',
  });
  assert.equal(got.cwd, '/payload/cwd');
  assert.equal(got.source, 'payload');
});

test('resolveSessionCwd walks up to projectRoot when cwd unavailable', () => {
  _resetProjectRootCache();
  const base = mkTempDir('ctx-shape-resolve3');
  try {
    fs.mkdirSync(path.join(base, 'repo', 'src'), { recursive: true });
    fs.writeFileSync(path.join(base, 'repo', '.git'), 'gitdir: x\n');
    const f = path.join(base, 'repo', 'src', 'a.ts');
    fs.writeFileSync(f, '');

    const got = resolveSessionCwd({
      sessionId: 'resolvetest3',
      payloadCwd: '',
      filePath: f,
    });
    assert.equal(got.cwd, path.join(base, 'repo'));
    assert.equal(got.source, 'projectRoot');
  } finally { rmRf(base); }
});

test('resolveSessionCwd last-resort is process.cwd() — never empty', () => {
  _resetProjectRootCache();
  const got = resolveSessionCwd({
    sessionId: 'resolvetest4',
    payloadCwd: 'not-absolute',  // ignored (doesn't start with /)
    filePath: '/nowhere/real/file.ts',
  });
  assert.ok(got.cwd.startsWith('/'), 'falls back to process.cwd()');
  assert.equal(got.source, 'processCwd');
});

// ─── analyzeShape canonicalCwd reclassification ──────────────────────────

test('analyzeShape with canonicalCwd rebuckets legacy /Users/<name> roots', () => {
  // Legacy entries written when the hook had no cwd — root=/Users/alex for
  // files that actually live under /Users/alex/DWS/proj.
  const legacy = [];
  for (let i = 0; i < 10; i++) {
    legacy.push({
      t: i, tok: (i + 1) * 1000, tool: 'Read',
      root: '/Users/alex',
      file: `/Users/alex/DWS/proj/services/auth/file${i}.ts`,
      event: null,
    });
  }
  for (let i = 0; i < 5; i++) {
    legacy.push({
      t: 10 + i, tok: (11 + i) * 1000, tool: 'Read',
      root: '/Users/alex',
      file: `/Users/alex/DWS/proj/services/billing/b${i}.ts`,
      event: null,
    });
  }

  const withCanon = analyzeShape(legacy, { canonicalCwd: '/Users/alex/DWS/proj' });
  assert.ok(withCanon, 'analysis produced');
  const allRoots = [...withCanon.hot, ...withCanon.warm, ...withCanon.cold].map((r) => r.root);
  assert.ok(allRoots.includes('services/auth'), 'services/auth emerges after reclassification');
  assert.ok(allRoots.includes('services/billing'), 'services/billing emerges after reclassification');
  assert.ok(!allRoots.includes('/Users/alex'), 'legacy /Users/alex blob is gone');
});

test('analyzeShape without canonicalCwd preserves original roots', () => {
  const legacy = [];
  for (let i = 0; i < 10; i++) {
    legacy.push({
      t: i, tok: (i + 1) * 1000, tool: 'Read',
      root: '/Users/alex',
      file: `/Users/alex/DWS/proj/services/auth/file${i}.ts`,
      event: null,
    });
  }
  const untouched = analyzeShape(legacy);
  assert.ok(untouched);
  const allRoots = [...untouched.hot, ...untouched.warm, ...untouched.cold].map((r) => r.root);
  assert.ok(allRoots.includes('/Users/alex'), 'opt-in gate — legacy root unchanged');
});

// ─── warmScoreCutoff opt ───────────────────────────────────────────────

test('warmScoreCutoff=0.65 demotes mid-score roots from WARM to COLD', () => {
  // Construct three roots with known score bands under recency:
  //   src/hot:   last touch at tok 19000 of 20000 span → recency 0.95 → HOT
  //   src/mid:   last touch at tok 14000 → recency ~0.70 → WARM at 0.40 cutoff
  //   src/cold:  last touch at tok  4000 → recency ~0.20 → COLD at 0.40 cutoff
  // With cutoff raised to 0.65, src/mid (0.70) stays WARM; at 0.75 it falls
  // to COLD. Cutoff of 0.65 keeps mid in WARM; 0.80 (=HOT_CUTOFF boundary)
  // collapses WARM entirely.
  const specs = [];
  for (let i = 0; i < 6; i++) specs.push({ root: 'src/hot',  tok: 18000 + i * 200 });
  for (let i = 0; i < 6; i++) specs.push({ root: 'src/mid',  tok: 13500 + i * 150 });
  for (let i = 0; i < 6; i++) specs.push({ root: 'src/cold', tok:  3000 + i * 250 });
  specs.sort((a, b) => a.tok - b.tok);
  const entries = specs.map((s) => ({
    t: Date.now(), tok: s.tok, tool: 'Read', root: s.root, file: null, event: null,
  }));

  const loose = analyzeShape(entries, { scoring: 'recency' }); // default 0.40
  const tight = analyzeShape(entries, { scoring: 'recency', warmScoreCutoff: 0.75 });

  const warmOf = (r) => r.warm.map((x) => x.root);
  const coldOf = (r) => r.cold.map((x) => x.root);

  assert.ok(warmOf(loose).includes('src/mid'), 'src/mid is WARM at default cutoff');
  assert.ok(!coldOf(loose).includes('src/mid'), 'src/mid is not COLD at default cutoff');

  assert.ok(!warmOf(tight).includes('src/mid'), 'src/mid falls out of WARM at 0.75 cutoff');
  assert.ok(coldOf(tight).includes('src/mid'), 'src/mid becomes COLD at 0.75 cutoff');
});

test('warmScoreCutoff clamps invalid values safely', () => {
  const specs = [];
  for (let i = 0; i < 6; i++) specs.push({ root: 'src/hot',  tok: 18000 + i * 200 });
  for (let i = 0; i < 6; i++) specs.push({ root: 'src/mid',  tok: 13500 + i * 150 });
  specs.sort((a, b) => a.tok - b.tok);
  const entries = specs.map((s) => ({
    t: Date.now(), tok: s.tok, tool: 'Read', root: s.root, file: null, event: null,
  }));

  // Negative / >= HOT_CUTOFF must NOT make HOT or WARM disappear entirely.
  const tooLow = analyzeShape(entries, { scoring: 'recency', warmScoreCutoff: -1 });
  const tooHigh = analyzeShape(entries, { scoring: 'recency', warmScoreCutoff: 2 });
  assert.ok(tooLow && Array.isArray(tooLow.hot));
  assert.ok(tooHigh && Array.isArray(tooHigh.hot));
  // tooHigh clamps just below HOT_CUTOFF (0.80) → everything below HOT
  // becomes COLD; mid (~0.70) must not be WARM anymore.
  assert.ok(!tooHigh.warm.map((x) => x.root).includes('src/mid'));
});

test('rollupShape with canonicalCwd persists reclassified roots', () => {
  const sid = 'rolluprecl';
  cleanupRollup(sid);

  // Write legacy-shape entries via appendShape.
  for (let i = 0; i < 8; i++) {
    appendShape(sid, {
      t: i, tok: (i + 1) * 1000, tool: 'Read',
      root: '/Users/alex',
      file: `/Users/alex/DWS/proj/lib/helpers/utils${i}.ts`,
    });
  }

  const rollup = rollupShape(sid, { canonicalCwd: '/Users/alex/DWS/proj' });
  assert.ok(rollup);
  const keys = Object.keys(rollup.roots);
  assert.ok(keys.includes('lib/helpers'), 'reclassified root persisted');
  assert.ok(!keys.includes('/Users/alex'), 'legacy blob not persisted');
  cleanupRollup(sid);
});

// ─── formatCompactInjection: stablePrefix mode ─────────────────────────
// The pre-compact block becomes the post-compact prefix, so any per-compact
// volatile value (call counts, stale-token estimate, Jaccard, phase token
// positions) busts prompt-cache on every subsequent compact of the same
// project. Stable mode must strip those without dropping names.

function makeAnalysis(overrides = {}) {
  // staleTokens must clear MIN_STALE_TO_MENTION (20k) or the cold band
  // is silently suppressed — that threshold is orthogonal to the
  // stable-prefix behavior under test.
  return {
    shift: { from: ['a'], to: ['b'], jaccard: 0.25 },
    hot: [
      { root: 'src/auth', count: 47, allowlisted: false, samples: ['src/auth/login.ts'] },
      { root: 'src/api',  count: 12, allowlisted: true,  samples: [] },
    ],
    cold: [
      { root: 'tests/fixtures', count: 30, samples: ['tests/fixtures/users.json'] },
    ],
    staleTokens: 35000,
    events: [
      { event: 'commit', tok: 123000 },
    ],
    ...overrides,
  };
}

test('formatCompactInjection default mode includes counts + staleTokens + Jaccard', () => {
  const out = formatCompactInjection(makeAnalysis());
  assert.match(out, /\(47 calls\)/);
  assert.match(out, /\(12 calls\)/);
  assert.match(out, /\(30 calls earlier\)/);
  assert.match(out, /~35k stale tokens/);
  assert.match(out, /Jaccard 0\.25/);
  assert.match(out, /commit at ~123k tokens/);
});

test('formatCompactInjection stablePrefix strips every per-compact volatile value', () => {
  const out = formatCompactInjection(makeAnalysis(), { stablePrefix: true });
  // Names + allowlist tag must still be present — that's the signal.
  assert.match(out, /src\/auth/);
  assert.match(out, /src\/api/);
  assert.match(out, /\[allowlisted\]/);
  assert.match(out, /tests\/fixtures/);
  assert.match(out, /commit/);
  // Volatile fragments must be gone.
  assert.ok(!/\bcalls\b/.test(out), 'no call-count tallies');
  assert.ok(!/stale tokens/.test(out), 'no stale-token estimate');
  assert.ok(!/Jaccard/.test(out), 'no Jaccard coefficient');
  assert.ok(!/~\d+k tokens/.test(out), 'no phase-marker token positions');
});

test('formatCompactInjection stablePrefix output is byte-identical across changing counts', () => {
  // Same working set, different per-compact counts — the stable prefix
  // must hash the same so the post-compact prefix stays cache-warm.
  const a = formatCompactInjection(makeAnalysis({
    hot: [{ root: 'src/auth', count: 47, allowlisted: false, samples: ['src/auth/login.ts'] }],
    cold: [{ root: 'tests/fixtures', count: 30, samples: ['tests/fixtures/users.json'] }],
    staleTokens: 35000,
    events: [{ event: 'commit', tok: 123000 }],
    shift: null,
  }), { stablePrefix: true });
  const b = formatCompactInjection(makeAnalysis({
    hot: [{ root: 'src/auth', count: 9999, allowlisted: false, samples: ['src/auth/login.ts'] }],
    cold: [{ root: 'tests/fixtures', count: 1, samples: ['tests/fixtures/users.json'] }],
    staleTokens: 90000,
    events: [{ event: 'commit', tok: 999000 }],
    shift: null,
  }), { stablePrefix: true });
  assert.equal(a, b);
});
