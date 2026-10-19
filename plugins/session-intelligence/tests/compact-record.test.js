const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCompactRecord } = require('../lib/compact-record');

const entries = [{ t: 1, tok: 1580000, tool: 'Read', root: 'src', file: 'src/a.js', event: null }];
const base = { cap: 1000000, entries, cwd: '/r', sessionId: 's', cost: 1.5, costAtCompactUsd: null, analysis: null };

test('buildCompactRecord stamps contextTokens as `tokens`, plus cap/fill/model/trigger and the estimate as toolIoEstimate', () => {
  const latest = { contextTokens: 480000, model: 'claude-fable-5-1', usage: {}, source: 'transcript' };
  const { historyEntry, dbRow, snapshot } = buildCompactRecord({ ...base, latest, trigger: 'auto' });
  assert.equal(historyEntry.tokens, 480000); assert.equal(historyEntry.contextTokens, 480000);
  assert.equal(historyEntry.contextCap, 1000000); assert.equal(historyEntry.fillPct, 48);
  assert.equal(historyEntry.model, 'claude-fable-5-1'); assert.equal(historyEntry.trigger, 'auto');
  assert.equal(historyEntry.toolIoEstimate, 1580000);
  assert.equal(dbRow.tokens, 480000); assert.equal(dbRow.fillPct, 48);
  assert.equal(dbRow.contextCap, 1000000); assert.equal(dbRow.model, 'claude-fable-5-1');
  assert.equal(dbRow.sid, 's'); assert.equal(dbRow.t, historyEntry.t);
  assert.equal(snapshot.tokens, 480000); assert.equal(snapshot.contextCap, 1000000); assert.equal(snapshot.callsSince, 0);
  assert.equal(snapshot.fillPct, 48);
  assert.deepEqual(snapshot.regretHits, []);
});

test('buildCompactRecord with no usage stamps tokens 0 and fillPct 0 (never the estimate)', () => {
  const { historyEntry, dbRow } = buildCompactRecord({ ...base, latest: null, trigger: 'manual' });
  assert.equal(historyEntry.tokens, 0); assert.equal(historyEntry.fillPct, 0);
  assert.equal(historyEntry.toolIoEstimate, 1580000);
  assert.equal(dbRow.tokens, 0); assert.equal(historyEntry.model, null);
});

test('buildCompactRecord derives dirs from analysis, includes costAtCompactUsd only when set, returns fresh objects', () => {
  const analysis = { cold: [{ root: 'a' }], hot: [{ root: 'b' }], warm: [{ root: 'c' }], shift: {} };
  const frozen = Object.freeze({ ...base, entries: Object.freeze([...entries]), analysis });
  const r1 = buildCompactRecord({ ...frozen, latest: null, trigger: null, costAtCompactUsd: 2.5 });
  assert.deepEqual(r1.historyEntry.droppedDirs, ['a']);
  assert.deepEqual(r1.historyEntry.hotDirs, ['b']);
  assert.deepEqual(r1.historyEntry.warmDirs, ['c']);
  assert.equal(r1.historyEntry.hadShift, true);
  assert.equal(r1.historyEntry.costAtCompactUsd, 2.5);
  assert.equal(r1.historyEntry.regretCount, 0);
  const r2 = buildCompactRecord({ ...frozen, latest: null, trigger: null });
  assert.equal('costAtCompactUsd' in r2.historyEntry, false);
  assert.notEqual(r1.historyEntry.hotDirs, r1.dbRow.hotDirs);
});
