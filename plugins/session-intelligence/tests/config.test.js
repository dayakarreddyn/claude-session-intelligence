/**
 * Tests for lib/config.js — focused on resolveShapeForCwd, the per-project
 * shape override merger that hooks call to honour `shape.perProject` entries.
 *
 * Regression context: si-token-budget, si-pre-compact, and si-suggest-compact
 * all read shape config to bucket entries / build preserveGlobs. Three of them
 * read top-level shape directly and silently ignored perProject overrides
 * until the 2026-04-25 fix wired resolveShapeForCwd through every hook.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveShapeForCwd,
  resolveStatuslineForCwd,
  getZoneThresholds,
  loadConfig,
  clampMaxEntries,
  DEFAULTS,
} = require('../lib/config');
const { resolveContextCap } = require('../lib/context-cap');

test('resolveShapeForCwd merges perProject override on matching cwd', () => {
  const cfg = {
    shape: {
      rootDirDepth: 2,
      preserveGlobs: ['lib/**'],
      perProject: {
        '/repo/csm': { rootDirDepth: 3, preserveGlobs: ['frontend/**'] },
      },
    },
  };
  const out = resolveShapeForCwd(cfg, '/repo/csm');
  assert.equal(out.rootDirDepth, 3, 'project rootDirDepth wins');
  assert.deepEqual(
    out.preserveGlobs,
    ['lib/**', 'frontend/**'],
    'preserveGlobs unioned (project ADDS to user-global, not REPLACES)',
  );
  assert.equal(out.perProject, undefined, 'perProject stripped from result');
});

test('resolveShapeForCwd falls through to base when no perProject match', () => {
  const cfg = {
    shape: {
      rootDirDepth: 2,
      preserveGlobs: ['lib/**'],
      perProject: { '/repo/csm': { rootDirDepth: 3 } },
    },
  };
  const out = resolveShapeForCwd(cfg, '/repo/other');
  assert.equal(out.rootDirDepth, 2);
  assert.deepEqual(out.preserveGlobs, ['lib/**']);
  assert.equal(out.perProject, undefined,
    'perProject stripped on passthrough so callers never accidentally see siblings');
});

test('resolveShapeForCwd handles missing perProject block gracefully', () => {
  const cfg = { shape: { rootDirDepth: 2, preserveGlobs: [] } };
  const out = resolveShapeForCwd(cfg, '/anywhere');
  assert.equal(out.rootDirDepth, 2);
  assert.deepEqual(out.preserveGlobs, []);
});

test('resolveShapeForCwd handles non-object override safely', () => {
  const cfg = {
    shape: { rootDirDepth: 2, perProject: { '/repo/csm': 'invalid' } },
  };
  const out = resolveShapeForCwd(cfg, '/repo/csm');
  assert.equal(out.rootDirDepth, 2, 'invalid override ignored, base wins');
  assert.equal(out.perProject, undefined);
});

test('resolveShapeForCwd preserves nested gitNexus block from base', () => {
  const cfg = {
    shape: {
      rootDirDepth: 2,
      gitNexus: { enabled: true, sinceDays: 90 },
      perProject: { '/repo/csm': { rootDirDepth: 3 } },
    },
  };
  const out = resolveShapeForCwd(cfg, '/repo/csm');
  assert.deepEqual(out.gitNexus, { enabled: true, sinceDays: 90 },
    'nested config blocks survive the merge');
});

test('DEFAULTS ship zoneMode fraction with 0.20/0.30/0.40 and contextCap 0', () => {
  assert.equal(DEFAULTS.statusline.zoneMode, 'fraction');
  assert.deepEqual(DEFAULTS.statusline.zoneFractions, { yellow: 0.20, orange: 0.30, red: 0.40 });
  assert.equal(DEFAULTS.statusline.contextCap, 0);
});

test("getZoneThresholds: fractions x cap give today's absolutes on 1M and scale on 200K", () => {
  assert.deepEqual(getZoneThresholds({}, { cap: 1000000 }),
    { yellow: 200000, orange: 300000, red: 400000, mode: 'fraction', cap: 1000000 });
  const cap200 = resolveContextCap({ model: 'claude-opus-5-5', env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' } }).cap;
  assert.equal(cap200, 200000);
  assert.deepEqual(getZoneThresholds({}, { cap: cap200 }),
    { yellow: 40000, orange: 60000, red: 80000, mode: 'fraction', cap: 200000 });
});

test('getZoneThresholds: absolute mode honours statusline.zones verbatim', () => {
  const cfg = { statusline: { zoneMode: 'absolute', zones: { yellow: 150000, orange: 250000, red: 350000 } } };
  assert.deepEqual(getZoneThresholds(cfg, { cap: 200000 }),
    { yellow: 150000, orange: 250000, red: 350000, mode: 'absolute', cap: 200000 });
});

test('getZoneThresholds: absolute mode falls back per-key and ignores non-numeric values', () => {
  const out = getZoneThresholds({ statusline: { zoneMode: 'absolute', zones: { yellow: 'oops', orange: 250000, red: NaN } } });
  assert.deepEqual(out, { yellow: 200000, orange: 250000, red: 400000, mode: 'absolute', cap: 1000000 });
});

test('getZoneThresholds: custom fractions apply; zones are ignored in fraction mode', () => {
  const cfg = { statusline: { zoneFractions: { yellow: 0.5 }, zones: { yellow: 1, orange: 2, red: 3 } } };
  assert.deepEqual(getZoneThresholds(cfg, { cap: 200000 }),
    { yellow: 100000, orange: 60000, red: 80000, mode: 'fraction', cap: 200000 });
});

test('getZoneThresholds assumes 1M when cap is omitted, zero or invalid', () => {
  assert.equal(getZoneThresholds({}).cap, 1000000);
  assert.equal(getZoneThresholds({}, { cap: 0 }).cap, 1000000);
  assert.equal(getZoneThresholds({}, { cap: null }).red, 400000);
});

test('getZoneThresholds does not mutate DEFAULTS or the input config', () => {
  const before = JSON.stringify(DEFAULTS.statusline);
  const cfg = { statusline: { zoneMode: 'absolute', zones: { yellow: 1, orange: 2, red: 3 } } };
  const snapshot = JSON.stringify(cfg);
  const a = getZoneThresholds(cfg); a.yellow = 999;
  getZoneThresholds({}, { cap: 200000 });
  assert.equal(JSON.stringify(DEFAULTS.statusline), before);
  assert.equal(JSON.stringify(cfg), snapshot);
});

test('CLAUDE_SI_ZONE_MODE=absolute overrides config; invalid value is ignored', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'si-zm-'));
  const saved = { HOME: process.env.HOME, M: process.env.CLAUDE_SI_ZONE_MODE };
  process.env.HOME = home;
  try {
    process.env.CLAUDE_SI_ZONE_MODE = 'absolute';
    assert.equal(loadConfig().statusline.zoneMode, 'absolute');
    process.env.CLAUDE_SI_ZONE_MODE = 'bogus';
    assert.equal(loadConfig().statusline.zoneMode, 'fraction');
  } finally {
    process.env.HOME = saved.HOME;
    if (saved.M === undefined) delete process.env.CLAUDE_SI_ZONE_MODE; else process.env.CLAUDE_SI_ZONE_MODE = saved.M;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('clampMaxEntries enforces [50, 5000] band', () => {
  assert.equal(clampMaxEntries(200), 200, 'in-band passes through');
  assert.equal(clampMaxEntries(10), 50, 'below floor clamps up');
  assert.equal(clampMaxEntries(99999), 5000, 'above ceiling clamps down');
  assert.equal(clampMaxEntries(undefined), 200, 'missing falls to default');
  assert.equal(clampMaxEntries('not a number'), 200, 'non-numeric falls to default');
  assert.equal(clampMaxEntries(150.7), 150, 'fractional values floor');
});

test('DEFAULTS exposes compact.refireEveryTokens for /si discovery', () => {
  assert.equal(DEFAULTS.compact.refireEveryTokens, 0,
    'new knob must be in DEFAULTS so /si list and config seeding can surface it');
});

test('resolveShapeForCwd does not mutate the input config', () => {
  const cfg = {
    shape: {
      rootDirDepth: 2,
      preserveGlobs: ['lib/**'],
      perProject: { '/repo/csm': { rootDirDepth: 3 } },
    },
  };
  const before = JSON.stringify(cfg);
  resolveShapeForCwd(cfg, '/repo/csm');
  assert.equal(JSON.stringify(cfg), before,
    'callers must be free to call this multiple times without surprises');
});

test('resolveStatuslineForCwd merges perProject override on matching cwd', () => {
  const cfg = {
    statusline: {
      activeRootShowAtRoot: false,
      maxActiveRootLength: 30,
      zones: { yellow: 200000, orange: 300000, red: 400000 },
      serviceHealth: ['https://api.example.com/health'],
      perProject: {
        '/repo/csm': {
          activeRootShowAtRoot: true,
          zones: { red: 500000 },
          serviceHealth: ['https://csm.example.com/health'],
        },
      },
    },
  };
  const out = resolveStatuslineForCwd(cfg, '/repo/csm');
  assert.equal(out.activeRootShowAtRoot, true, 'project flag wins');
  assert.equal(out.maxActiveRootLength, 30, 'unspecified base keys preserved');
  assert.deepEqual(
    out.zones,
    { yellow: 200000, orange: 300000, red: 500000 },
    'zones shallow-merged so a partial override does not wipe siblings',
  );
  assert.deepEqual(
    out.serviceHealth,
    ['https://api.example.com/health', 'https://csm.example.com/health'],
    'serviceHealth unioned so per-project never silently drops global probes',
  );
  assert.equal(out.perProject, undefined, 'perProject stripped from result');
});

test('resolveStatuslineForCwd falls through to base on miss', () => {
  const cfg = {
    statusline: {
      activeRootShowAtRoot: false,
      perProject: { '/repo/csm': { activeRootShowAtRoot: true } },
    },
  };
  const out = resolveStatuslineForCwd(cfg, '/repo/other');
  assert.equal(out.activeRootShowAtRoot, false);
  assert.equal(out.perProject, undefined);
});

test('resolveStatuslineForCwd handles missing statusline block gracefully', () => {
  const out = resolveStatuslineForCwd({}, '/anywhere');
  assert.deepEqual(out, {});
});
