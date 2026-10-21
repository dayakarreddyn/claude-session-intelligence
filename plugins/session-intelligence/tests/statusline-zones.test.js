'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveZones } = require('../statusline/zones');
const { withTempHome } = require('./helpers/statusline-fixture');

const LEARNER = () => ({ adaptive: true, yellow: 1, orange: 2, red: 3 });

test('resolveZones keeps user zones in absolute mode even when the learner is confident', (t) => {
  withTempHome(t);
  const cfg = { zoneMode: 'absolute', zones: { yellow: 100000, orange: 150000, red: 180000 } };
  const z = resolveZones(cfg, { cap: 200000, cwd: '/x', history: [], adaptiveZones: LEARNER });
  assert.deepEqual(z, { yellow: 100000, orange: 150000, red: 180000, source: 'absolute' });
});

test('resolveZones applies the learner in fraction mode', (t) => {
  withTempHome(t);
  const z = resolveZones({}, { cap: 200000, cwd: '/x', history: [], adaptiveZones: LEARNER });
  assert.deepEqual(z, { yellow: 1, orange: 2, red: 3, source: 'adaptive' });
});

test('resolveZones uses fractions of the cap when the learner has no fit', (t) => {
  withTempHome(t);
  const z = resolveZones({}, { cap: 200000, cwd: '/x', history: [], adaptiveZones: () => ({ adaptive: false }) });
  assert.deepEqual(z, { yellow: 40000, orange: 60000, red: 80000, source: 'fraction' });
});
