'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assembleUnderCap, HOOK_OUTPUT_CAP_CHARS } = require('../lib/hook-output');

test('cap constant is 10000', () => assert.equal(HOOK_OUTPUT_CAP_CHARS, 10000));

test('assembleUnderCap keeps order and drops optional blocks from the end until under 10000', () => {
  const blocks = [
    { name: 'registry', text: 'R'.repeat(500), required: true },
    { name: 'hints', text: 'H'.repeat(3000) },
    { name: 'shape', text: 'S'.repeat(12000) },
    { name: 'tip', text: 'T'.repeat(100) },
  ];
  const out = assembleUnderCap(blocks);
  assert.deepEqual(out.dropped, ['tip', 'shape']);
  assert.equal(out.overCap, false);
  assert.ok(out.chars < 10000);
  assert.ok(out.text.startsWith('R'.repeat(500)));
  assert.equal(out.chars, out.text.length);
});

test('assembleUnderCap truncates when required blocks alone exceed the cap', () => {
  const out = assembleUnderCap([{ name: 'registry', text: 'R'.repeat(12000), required: true }]);
  assert.equal(out.overCap, true);
  assert.ok(out.chars <= 10000);
  assert.ok(out.text.endsWith('…[truncated]\n'));
});

test('assembleUnderCap returns empty text for empty blocks', () => {
  assert.deepEqual(assembleUnderCap([]), { text: '', dropped: [], chars: 0, overCap: false });
});

test('assembleUnderCap skips empty blocks without reporting them dropped', () => {
  const out = assembleUnderCap([{ name: 'a', text: 'x' }, { name: 'b', text: '' }, { name: 'c', text: 'y' }]);
  assert.equal(out.text, 'xy');
  assert.deepEqual(out.dropped, []);
});

test('assembleUnderCap does not mutate its input', () => {
  const blocks = Object.freeze([Object.freeze({ name: 'a', text: 'x'.repeat(50), required: true })]);
  assert.doesNotThrow(() => assembleUnderCap(blocks, { maxChars: 20 }));
});

test('a fitted registry always leaves at least 6000 chars for optional blocks', () => {
  const { MAX_BLOCK_CHARS } = require('../lib/constraint-registry');
  const heading = '\n# Session Intelligence \u2014 compaction guidance\n'.length;
  assert.ok(HOOK_OUTPUT_CAP_CHARS - MAX_BLOCK_CHARS - heading >= 6000);
});
