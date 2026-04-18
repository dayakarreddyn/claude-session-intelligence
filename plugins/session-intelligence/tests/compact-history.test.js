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
