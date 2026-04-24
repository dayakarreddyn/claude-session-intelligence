/**
 * Tests for lib/compact-history.js — Q2 (cost-band tightening) and Q5
 * (good-compact continuation quality). The existing regret-path tests
 * live elsewhere; this file covers the new behaviours added after the
 * open-question research pass.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

// The module reads $HOME at require-time for the history path, so we
// redirect HOME to a temp dir BEFORE requiring it. Each test cleans its
// own entries from the shared history file but leaves the dir in place.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'si-compact-history-test-'));
process.env.HOME = TMP_HOME;

const compactHistory = require('../lib/compact-history');

function resetHistory() {
  try { fs.unlinkSync(compactHistory.HISTORY_FILE); } catch { /* first run */ }
}

function fakeEntry(overrides) {
  return {
    t: Date.now(),
    sid: 'test',
    cwd: '/tmp/repo',
    tokens: 200000,
    cost: 100,
    hotDirs: [],
    droppedDirs: [],
    hadShift: false,
    regretCount: 0,
    ...overrides,
  };
}

// ── Q2: cost-band tightening ─────────────────────────────────────────────

test('adaptiveZones tightens orange when currentCost exceeds p75', () => {
  resetHistory();
  // Five entries with costs [10, 20, 30, 40, 50] — p75 ≈ 40.
  for (const cost of [10, 20, 30, 40, 50]) {
    compactHistory.appendHistory(fakeEntry({ tokens: 250000, cost }));
  }
  const history = compactHistory.readHistory();
  const defaults = { yellow: 200000, orange: 300000, red: 400000 };

  const cheap = compactHistory.adaptiveZones(history, defaults, { currentCost: 20 });
  const expensive = compactHistory.adaptiveZones(history, defaults, { currentCost: 500 });

  assert.equal(cheap.costTightened, false, 'cheap session should not tighten');
  assert.equal(expensive.costTightened, true, 'expensive session should tighten');
  assert.ok(
    expensive.orange < cheap.orange,
    `expensive.orange (${expensive.orange}) < cheap.orange (${cheap.orange})`,
  );
  // 12% tightening, but clamped by ±30% bound from defaults.
  assert.ok(expensive.orange >= defaults.orange * 0.7);
});

test('adaptiveZones ignores cost opts when history has no cost data', () => {
  resetHistory();
  for (let i = 0; i < 5; i++) {
    compactHistory.appendHistory(fakeEntry({ tokens: 250000, cost: 0 }));
  }
  const history = compactHistory.readHistory();
  const defaults = { yellow: 200000, orange: 300000, red: 400000 };
  const zones = compactHistory.adaptiveZones(history, defaults, { currentCost: 500 });
  assert.equal(zones.costTightened, false);
});

test('adaptiveZones no-ops when currentCost is missing', () => {
  resetHistory();
  for (const cost of [10, 20, 30, 40, 50]) {
    compactHistory.appendHistory(fakeEntry({ tokens: 250000, cost }));
  }
  const zones = compactHistory.adaptiveZones(
    compactHistory.readHistory(),
    { yellow: 200000, orange: 300000, red: 400000 },
    {},
  );
  assert.equal(zones.costTightened, false);
});

// ── Q5: continuation quality ─────────────────────────────────────────────

test('checkPostCompactRegret records positive hits in hotDirs', () => {
  resetHistory();
  const sid = 'test-positive-' + Date.now();
  const now = Date.now();
  compactHistory.writeSnapshot(sid, {
    t: now,
    tokens: 250000,
    cost: 100,
    hotDirs: ['src/auth'],
    droppedDirs: ['tests/legacy'],
    callsSince: 0,
    regretHits: [],
    positiveHits: [],
  });

  const result = compactHistory.checkPostCompactRegret(sid, 'src/auth', {
    toolName: 'Read',
    toolInput: { file_path: '/foo' },
  });
  assert.equal(result.positiveHit, true);
  assert.equal(result.regretHit, false);
  assert.equal(result.weight, 1.0);
});

test('checkPostCompactRegret still records regret hits in droppedDirs', () => {
  resetHistory();
  const sid = 'test-regret-' + Date.now();
  compactHistory.writeSnapshot(sid, {
    t: Date.now(),
    tokens: 250000,
    cost: 100,
    hotDirs: ['src/auth'],
    droppedDirs: ['tests/legacy'],
    callsSince: 0,
    regretHits: [],
    positiveHits: [],
  });
  const result = compactHistory.checkPostCompactRegret(sid, 'tests/legacy', {
    toolName: 'Read',
    toolInput: {},
  });
  assert.equal(result.regretHit, true);
  assert.equal(result.positiveHit, false);
});

test('upgradeHistoryRegret stamps continuationQuality when window closes', () => {
  resetHistory();
  const t = Date.now();
  // Seed a history entry we can match by t.
  compactHistory.appendHistory(fakeEntry({
    t, tokens: 250000, cost: 100,
    hotDirs: ['src/auth'], droppedDirs: ['tests/legacy'],
  }));
  const sid = 'test-quality-' + t;
  // Snapshot matching the history entry, with 2 positive hits, 1 weak regret.
  compactHistory.writeSnapshot(sid, {
    t,
    tokens: 250000,
    cost: 100,
    hotDirs: ['src/auth'],
    droppedDirs: ['tests/legacy'],
    callsSince: 30, // one more call closes the window (calls=31 > 30)
    positiveHits: [
      { t: t + 1000, root: 'src/auth', tool: 'Read', weight: 1.0 },
      { t: t + 2000, root: 'src/auth', tool: 'Edit', weight: 0.3 },
    ],
    regretHits: [
      { t: t + 3000, root: 'tests/legacy', tool: 'Edit', weight: 0.3 },
    ],
  });
  // Trigger window close via a neutral tool call (rootDir not in either set).
  const result = compactHistory.checkPostCompactRegret(sid, 'other/path', {
    toolName: 'Read', toolInput: {},
  });
  assert.equal(result.windowClosed, true);

  const raw = fs.readFileSync(compactHistory.HISTORY_FILE, 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const stamped = raw.find((e) => e.t === t);
  assert.ok(stamped, 'history entry should be found');
  // positiveWeight=1.3, regretWeight=0.3 → (1.3-0.3)/(1.3+0.3) = 0.625 → 0.63
  assert.equal(stamped.continuationQuality, 0.63);
  assert.equal(stamped.positiveHits, 2);
  assert.equal(stamped.regretCount, 0.3);
});

test('upgradeHistoryRegret skips when no hits on either side', () => {
  resetHistory();
  const t = Date.now();
  compactHistory.appendHistory(fakeEntry({ t }));
  const sid = 'test-skip-' + t;
  compactHistory.writeSnapshot(sid, {
    t, tokens: 250000, cost: 100,
    hotDirs: [], droppedDirs: [], callsSince: 30,
    positiveHits: [], regretHits: [],
  });
  compactHistory.checkPostCompactRegret(sid, null, {});
  const raw = fs.readFileSync(compactHistory.HISTORY_FILE, 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const stamped = raw.find((e) => e.t === t);
  assert.equal(stamped.continuationQuality, undefined);
});

// ── Soft regret (Q1 unblocker): WARM-not-HOT post-compact touches ────────

test('checkPostCompactRegret records softRegret on WARM-only dirs', () => {
  resetHistory();
  const sid = 'test-soft-' + Date.now();
  compactHistory.writeSnapshot(sid, {
    t: Date.now(),
    tokens: 250000,
    cost: 100,
    hotDirs: ['src/auth'],
    warmDirs: ['src/billing'],
    droppedDirs: ['tests/legacy'],
    callsSince: 0,
    regretHits: [],
    softRegretHits: [],
    positiveHits: [],
  });

  const result = compactHistory.checkPostCompactRegret(sid, 'src/billing', {
    toolName: 'Read',
    toolInput: { file_path: '/foo' },
  });
  assert.equal(result.softRegretHit, true, 'WARM touch should fire soft regret');
  assert.equal(result.regretHit, false);
  assert.equal(result.positiveHit, false);
  // Read weight 1.0 × SOFT_REGRET_DAMPEN 0.5 = 0.5
  assert.equal(result.weight, 0.5);
});

test('HOT takes priority over WARM classification', () => {
  resetHistory();
  const sid = 'test-priority-' + Date.now();
  // Same dir listed in both buckets (defensive — shouldn't happen from
  // analyzeShape but upstream callers could do it). HOT wins.
  compactHistory.writeSnapshot(sid, {
    t: Date.now(),
    tokens: 250000,
    cost: 100,
    hotDirs: ['src/auth'],
    warmDirs: ['src/auth'],
    droppedDirs: [],
    callsSince: 0,
    regretHits: [],
    softRegretHits: [],
    positiveHits: [],
  });
  const result = compactHistory.checkPostCompactRegret(sid, 'src/auth', {
    toolName: 'Read', toolInput: {},
  });
  assert.equal(result.positiveHit, true);
  assert.equal(result.softRegretHit, false);
});

test('upgradeHistoryRegret stamps softRegretCount on window close', () => {
  resetHistory();
  const t = Date.now();
  compactHistory.appendHistory(fakeEntry({
    t, tokens: 250000, cost: 100,
    hotDirs: ['src/auth'], warmDirs: ['src/billing'], droppedDirs: [],
  }));
  const sid = 'test-soft-stamp-' + t;
  compactHistory.writeSnapshot(sid, {
    t,
    tokens: 250000,
    cost: 100,
    hotDirs: ['src/auth'],
    warmDirs: ['src/billing'],
    droppedDirs: [],
    callsSince: 30, // one more call closes the window
    softRegretHits: [
      { t: t + 1000, root: 'src/billing', tool: 'Read', weight: 0.5 },
      { t: t + 2000, root: 'src/billing', tool: 'Edit', weight: 0.15 },
    ],
    regretHits: [],
    positiveHits: [],
  });
  // Window-closing neutral call.
  const result = compactHistory.checkPostCompactRegret(sid, 'other/path', {
    toolName: 'Read', toolInput: {},
  });
  assert.equal(result.windowClosed, true);

  const raw = fs.readFileSync(compactHistory.HISTORY_FILE, 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const stamped = raw.find((e) => e.t === t);
  assert.ok(stamped, 'history entry should be found');
  assert.equal(stamped.softRegretCount, 0.65);
  assert.equal(stamped.softRegretHits, 2);
  assert.deepEqual(stamped.softRegretDirs, ['src/billing', 'src/billing']);
  // Soft regret should NOT pollute continuationQuality (parked for later).
  assert.equal(stamped.continuationQuality, undefined);
});

// ── stablePrefix drift check ─────────────────────────────────────────────

test('compareStablePrefixHash reports firstRun on fresh cwd', () => {
  const cwd = '/tmp/si-drift-test-fresh-' + Date.now();
  try { fs.unlinkSync(compactHistory.prefixHashPath(cwd)); } catch { /* first run */ }
  const out = compactHistory.compareStablePrefixHash(cwd, 'hello world');
  assert.equal(out.drifted, false);
  assert.equal(out.firstRun, true);
  assert.ok(out.newHash.length === 64);
});

test('compareStablePrefixHash reports no drift when text unchanged', () => {
  const cwd = '/tmp/si-drift-test-stable-' + Date.now();
  try { fs.unlinkSync(compactHistory.prefixHashPath(cwd)); } catch { /* first run */ }
  compactHistory.compareStablePrefixHash(cwd, 'same text');
  const out = compactHistory.compareStablePrefixHash(cwd, 'same text');
  assert.equal(out.drifted, false);
  assert.equal(out.firstRun, undefined);
});

test('compareStablePrefixHash flags drift when text mutates', () => {
  const cwd = '/tmp/si-drift-test-drift-' + Date.now();
  try { fs.unlinkSync(compactHistory.prefixHashPath(cwd)); } catch { /* first run */ }
  compactHistory.compareStablePrefixHash(cwd, 'version one');
  const out = compactHistory.compareStablePrefixHash(cwd, 'version two');
  assert.equal(out.drifted, true);
  assert.ok(out.prevHash);
  assert.notEqual(out.prevHash, out.newHash);
  assert.ok(Number.isFinite(out.ageSec));
});

test('compareStablePrefixHash keys separately per cwd', () => {
  const a = '/tmp/si-drift-a-' + Date.now();
  const b = '/tmp/si-drift-b-' + Date.now();
  for (const c of [a, b]) {
    try { fs.unlinkSync(compactHistory.prefixHashPath(c)); } catch { /* first run */ }
  }
  compactHistory.compareStablePrefixHash(a, 'text A');
  const out = compactHistory.compareStablePrefixHash(b, 'text B');
  assert.equal(out.firstRun, true, 'second cwd should not inherit first cwd hash');
});

test('normalizePrefixForHash strips autofill sentinel and body', () => {
  const raw = [
    '## Current Task',
    '<!-- si:autofill sha=abc1234 -->',
    'type: feat — something',
    'description: derived from last commit',
    '',
    '## Key Files',
    '<!-- si:autofill sha=abc1234 -->',
    '- README.md',
    '- CLAUDE.md',
    '',
    '## Stable Section',
    'content that should survive',
  ].join('\n');
  const normalized = compactHistory.normalizePrefixForHash(raw);
  assert.ok(!/sha=abc1234/.test(normalized), 'autofill sha stripped');
  assert.ok(!/type: feat/.test(normalized), 'autofilled body stripped');
  assert.ok(!/README\.md/.test(normalized), 'autofilled file list stripped');
  assert.ok(/Stable Section/.test(normalized), 'stable sections preserved');
  assert.ok(/content that should survive/.test(normalized));
});

test('compareStablePrefixHash ignores autofill-only mutations', () => {
  const cwd = '/tmp/si-drift-autofill-' + Date.now();
  try { fs.unlinkSync(compactHistory.prefixHashPath(cwd)); } catch { /* first run */ }
  const build = (sha, task) => [
    '## Current Task',
    `<!-- si:autofill sha=${sha} -->`,
    `type: feat — ${task}`,
    '',
    '## Preserve',
    '- plugins/session-intelligence',
  ].join('\n');
  compactHistory.compareStablePrefixHash(cwd, build('abc1234', 'alpha'));
  const out = compactHistory.compareStablePrefixHash(cwd, build('def5678', 'bravo'));
  assert.equal(out.drifted, false,
    'autofill sha + task body churn should not be treated as drift');
});

test('compareStablePrefixHash flags real drift in stable content with diff preview', () => {
  const cwd = '/tmp/si-drift-real-' + Date.now();
  try { fs.unlinkSync(compactHistory.prefixHashPath(cwd)); } catch { /* first run */ }
  const v1 = [
    '## Preserve',
    '- plugins/session-intelligence',
    '- docs',
  ].join('\n');
  const v2 = [
    '## Preserve',
    '- plugins/session-intelligence',
    '- totally-different',
  ].join('\n');
  compactHistory.compareStablePrefixHash(cwd, v1);
  const out = compactHistory.compareStablePrefixHash(cwd, v2);
  assert.equal(out.drifted, true);
  assert.ok(Array.isArray(out.diff), 'diff preview returned on drift');
  assert.ok(out.diff.length >= 1);
  const first = out.diff[0];
  assert.equal(first.line, 3);
  assert.ok(/docs/.test(first.prev));
  assert.ok(/totally-different/.test(first.next));
});

test('upgradeHistoryRegret stamps postCompactCacheHitRatio when present on snapshot', () => {
  resetHistory();
  const t = Date.now();
  compactHistory.appendHistory(fakeEntry({
    t, tokens: 250000, cost: 100,
    hotDirs: ['src/auth'], droppedDirs: [],
  }));
  const sid = 'test-cachehit-' + t;
  compactHistory.writeSnapshot(sid, {
    t,
    tokens: 250000,
    cost: 100,
    hotDirs: ['src/auth'],
    warmDirs: [],
    droppedDirs: [],
    callsSince: 30,
    positiveHits: [{ t: t + 1, root: 'src/auth', tool: 'Read', weight: 1.0 }],
    regretHits: [],
    softRegretHits: [],
    postCompactCacheMeasured: true,
    postCompactCacheHitRatio: 0.92,
    postCompactCacheRead: 92000,
    postCompactCacheCreation: 8000,
  });
  compactHistory.checkPostCompactRegret(sid, 'other', { toolName: 'Read', toolInput: {} });
  const raw = fs.readFileSync(compactHistory.HISTORY_FILE, 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const stamped = raw.find((e) => e.t === t);
  assert.equal(stamped.postCompactCacheHitRatio, 0.92);
  assert.equal(stamped.postCompactCacheRead, 92000);
  assert.equal(stamped.postCompactCacheCreation, 8000);
});

test('upgradeHistoryRegret skips cache-hit fields when snapshot lacks them', () => {
  resetHistory();
  const t = Date.now();
  compactHistory.appendHistory(fakeEntry({ t, hotDirs: ['src/auth'] }));
  const sid = 'test-nocache-' + t;
  compactHistory.writeSnapshot(sid, {
    t, tokens: 250000, cost: 100,
    hotDirs: ['src/auth'], warmDirs: [], droppedDirs: [],
    callsSince: 30,
    positiveHits: [{ t: t + 1, root: 'src/auth', tool: 'Read', weight: 1.0 }],
    regretHits: [], softRegretHits: [],
  });
  compactHistory.checkPostCompactRegret(sid, 'other', { toolName: 'Read', toolInput: {} });
  const raw = fs.readFileSync(compactHistory.HISTORY_FILE, 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const stamped = raw.find((e) => e.t === t);
  assert.equal(stamped.postCompactCacheHitRatio, undefined);
});

test('adaptiveZones sums softRegretCount into regret rate', () => {
  resetHistory();
  // Five compacts: hard regret = 0 everywhere, but soft regret averages ≥ 1
  // per compact. Without the wire-through, orange would NOT get pushed out.
  for (let i = 0; i < 5; i++) {
    compactHistory.appendHistory(fakeEntry({
      tokens: 260000,
      regretCount: 0,
      softRegretCount: 1.2, // dampened sum; 5 compacts × 1.2 = 6 / 5 compacts = 1.2 rate
    }));
  }
  const defaults = { yellow: 200000, orange: 300000, red: 400000 };
  const zones = compactHistory.adaptiveZones(compactHistory.readHistory(), defaults, {});
  assert.equal(zones.adaptive, true);
  // P50 of 260k → orangeTarget = floor(260000 * 0.9) = 234000.
  // Regret-rate ≥ 1 triggers 10% push-out: 234000 * 1.1 = 257400 (capped to
  // orangeMax = 300k * 1.3 = 390k, so 257400 stands).
  assert.equal(zones.orange, 257400);
  assert.equal(zones.regretRate, 1.2);
});

test('adaptiveZones does not push orange out when regret is zero', () => {
  resetHistory();
  for (let i = 0; i < 5; i++) {
    compactHistory.appendHistory(fakeEntry({
      tokens: 260000,
      regretCount: 0,
      softRegretCount: 0,
    }));
  }
  const zones = compactHistory.adaptiveZones(
    compactHistory.readHistory(),
    { yellow: 200000, orange: 300000, red: 400000 },
    {},
  );
  // No regret push-out: orange stays at orangeTarget = 234000.
  assert.equal(zones.orange, 234000);
  assert.equal(zones.regretRate, 0);
});

test('soft regret only stamps when there were soft hits', () => {
  resetHistory();
  const t = Date.now();
  compactHistory.appendHistory(fakeEntry({
    t, hotDirs: ['src/auth'], warmDirs: [], droppedDirs: [],
  }));
  const sid = 'test-soft-absent-' + t;
  compactHistory.writeSnapshot(sid, {
    t,
    tokens: 250000,
    cost: 100,
    hotDirs: ['src/auth'],
    warmDirs: [],
    droppedDirs: [],
    callsSince: 30,
    positiveHits: [{ t: t + 1, root: 'src/auth', tool: 'Read', weight: 1.0 }],
    regretHits: [],
    softRegretHits: [],
  });
  compactHistory.checkPostCompactRegret(sid, 'other/path', { toolName: 'Read', toolInput: {} });
  const raw = fs.readFileSync(compactHistory.HISTORY_FILE, 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const stamped = raw.find((e) => e.t === t);
  assert.equal(stamped.softRegretCount, undefined, 'no soft regret field when no soft hits');
  assert.equal(stamped.continuationQuality, 1); // positive-only → +1
});

// ── Session-scoped last-compact lookup ────────────────────────────────────

test('lastCompactMsForSession returns most recent t for matching sid', () => {
  resetHistory();
  const base = Date.now() - 10_000;
  compactHistory.appendHistory(fakeEntry({ t: base,      sid: 'sid-A' }));
  compactHistory.appendHistory(fakeEntry({ t: base + 1,  sid: 'sid-B' }));
  compactHistory.appendHistory(fakeEntry({ t: base + 2,  sid: 'sid-A' })); // winner
  compactHistory.appendHistory(fakeEntry({ t: base + 3,  sid: 'sid-B' }));
  assert.equal(compactHistory.lastCompactMsForSession('sid-A'), base + 2);
  assert.equal(compactHistory.lastCompactMsForSession('sid-B'), base + 3);
});

test('lastCompactMsForSession returns null when sid has no compact yet', () => {
  resetHistory();
  compactHistory.appendHistory(fakeEntry({ sid: 'other-sid' }));
  assert.equal(compactHistory.lastCompactMsForSession('fresh-sid'), null);
});

test('lastCompactMsForSession returns null for empty sid', () => {
  resetHistory();
  compactHistory.appendHistory(fakeEntry({ sid: 'whatever' }));
  assert.equal(compactHistory.lastCompactMsForSession(''), null);
  assert.equal(compactHistory.lastCompactMsForSession(undefined), null);
});

test('lastCompactMsForSession accepts pre-read history to avoid double I/O', () => {
  resetHistory();
  const base = Date.now() - 5_000;
  compactHistory.appendHistory(fakeEntry({ t: base,     sid: 'xyz' }));
  compactHistory.appendHistory(fakeEntry({ t: base + 7, sid: 'xyz' }));
  const history = compactHistory.readHistory();
  assert.equal(compactHistory.lastCompactMsForSession('xyz', history), base + 7);
});
