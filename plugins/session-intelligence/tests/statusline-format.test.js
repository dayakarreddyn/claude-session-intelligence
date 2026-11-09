'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fmtTokens, fmtTokensTight } = require('../statusline/format');

test('fmtTokens drops trailing zeros and uses M', () => {
  assert.equal(fmtTokens(200000), '200k');
  assert.equal(fmtTokens(175700), '175.7k');
  assert.equal(fmtTokens(1000000), '1M');
  assert.equal(fmtTokens(1500000), '1.5M');
  assert.equal(fmtTokens(999), '999');
});

test('fmtTokensTight drops trailing zeros and uses M', () => {
  assert.equal(fmtTokensTight(1000), '1k');
  assert.equal(fmtTokensTight(1000000), '1M');
  assert.equal(fmtTokensTight(1500000), '1.5M');
  assert.equal(fmtTokensTight(124200), '124k');
});
