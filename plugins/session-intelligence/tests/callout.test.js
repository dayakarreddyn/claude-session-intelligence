'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { phaseBoundaryLine, clearHandoffHint } = require('../lib/callout');

test('phaseBoundaryLine returns empty for empty or null input', () => {
  assert.equal(phaseBoundaryLine([]), '');
  assert.equal(phaseBoundaryLine(null), '');
});

test('phaseBoundaryLine ignores an event at position 6 of 6', () => {
  const entries = [{ event: 'push' }, {}, {}, {}, {}, {}];
  assert.equal(phaseBoundaryLine(entries), '');
});

test('phaseBoundaryLine names the newest event within the last 5 entries', () => {
  assert.match(phaseBoundaryLine([{}, { event: 'pr' }, {}]), /^A pr just landed — natural compaction boundary/);
});

test('clearHandoffHint wording for 0, 1 and 2 constraints and no handoff', () => {
  assert.equal(clearHandoffHint(true, 0), 'Consider `/clear` with a fresh handoff — SI just saved the current task, restored on the next session start.');
  assert.match(clearHandoffHint(true, 1), /current task and 1 constraint,/);
  assert.match(clearHandoffHint(true, 2), /current task and 2 constraints,/);
  assert.equal(clearHandoffHint(false, 0), 'Consider `/clear` before heavy new work.');
});
