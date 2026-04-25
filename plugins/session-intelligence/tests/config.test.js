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

const {
  resolveShapeForCwd,
  getZoneThresholds,
  clampMaxEntries,
  DEFAULTS,
} = require('../lib/config');

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

test('getZoneThresholds reads statusline.zones with defaults', () => {
  assert.deepEqual(
    getZoneThresholds({}),
    { yellow: 200000, orange: 300000, red: 400000 },
    'empty config falls back to built-in defaults',
  );
  assert.deepEqual(
    getZoneThresholds({ statusline: { zones: { yellow: 150000, orange: 250000, red: 350000 } } }),
    { yellow: 150000, orange: 250000, red: 350000 },
    'fully customised zones take precedence',
  );
  assert.deepEqual(
    getZoneThresholds({ statusline: { zones: { orange: 250000 } } }),
    { yellow: 200000, orange: 250000, red: 400000 },
    'partial customisation only overrides specified keys',
  );
});

test('getZoneThresholds ignores non-numeric inputs safely', () => {
  const out = getZoneThresholds({ statusline: { zones: { yellow: 'oops', orange: null, red: NaN } } });
  assert.deepEqual(out, { yellow: 200000, orange: 300000, red: 400000 },
    'invalid values fall through to defaults rather than poisoning the gate');
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
  assert.equal(DEFAULTS.compact.refireEveryTokens, 25000,
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
