'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'si-tu-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const {
  readLatestUsage, usageCachePath, updatePeak, readPeak, contextTokensOf,
} = require('../lib/transcript-usage');
const { readTranscriptTokens } = require('../lib/utils');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'si-tu-files-'));
let seq = 0;

function assistant(id, input, create, read, model = 'claude-opus-5-5') {
  return {
    type: 'assistant',
    message: {
      id, model,
      usage: {
        input_tokens: input, cache_creation_input_tokens: create,
        cache_read_input_tokens: read, output_tokens: 7,
      },
    },
    timestamp: '2026-10-19T10:00:00.000Z',
  };
}

function write(lines) {
  const p = path.join(DIR, `t-${seq++}.jsonl`);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

test('readLatestUsage returns the last assistant usage with model and messageId', () => {
  const p = write([
    { type: 'user' },
    assistant('msg_A', 10, 20, 30),
    assistant('msg_B', 1000, 5000, 100000),
    { type: 'user' },
  ]);
  const u = readLatestUsage(p, { sessionId: 'tu-1' });
  assert.equal(u.contextTokens, 1000 + 5000 + 100000);
  assert.equal(u.model, 'claude-opus-5-5');
  assert.equal(u.messageId, 'msg_B');
  assert.equal(u.source, 'transcript');
  assert.equal(u.timestamp, '2026-10-19T10:00:00.000Z');
});

test('readLatestUsage returns null when the transcript has no usage line at all', () => {
  const p = write([{ type: 'user' }, { type: 'file-history-snapshot' }]);
  assert.equal(readLatestUsage(p, { sessionId: 'tu-none' }), null);
});

test('readLatestUsage returns null for a missing path with no cache', () => {
  assert.equal(readLatestUsage(path.join(DIR, 'nope.jsonl'), { sessionId: 'tu-nofile' }), null);
});

test('readLatestUsage finds the usage line behind a single 1.5 MB tool result', () => {
  const p = write([
    assistant('msg_big', 50000, 100000, 100000),
    { type: 'user', content: 'x'.repeat(1.5 * 1024 * 1024) },
  ]);
  assert.equal(readLatestUsage(p, { sessionId: 'tu-big' }).contextTokens, 250000);
});

test('readLatestUsage serves the cache when new bytes carry no usage, and advances the offset', () => {
  const p = write([assistant('msg_C', 1, 2, 3)]);
  const a = readLatestUsage(p, { sessionId: 'tu-cache' });
  fs.appendFileSync(p, JSON.stringify({ type: 'user' }) + '\n');
  const b = readLatestUsage(p, { sessionId: 'tu-cache' });
  assert.equal(b.contextTokens, a.contextTokens);
  assert.equal(b.source, 'cache');
  assert.equal(JSON.parse(fs.readFileSync(usageCachePath('tu-cache'), 'utf8')).offset, fs.statSync(p).size);
});

test('readLatestUsage picks up newly appended usage incrementally', () => {
  const p = write([assistant('msg_D', 1, 2, 3)]);
  readLatestUsage(p, { sessionId: 'tu-inc' });
  fs.appendFileSync(p, JSON.stringify(assistant('msg_E', 100, 200, 300)) + '\n');
  const u = readLatestUsage(p, { sessionId: 'tu-inc' });
  assert.equal(u.contextTokens, 600);
  assert.equal(u.messageId, 'msg_E');
  assert.equal(u.source, 'transcript');
});

test('readLatestUsage ignores a trailing partial line until it completes', () => {
  const p = write([assistant('msg_F', 1, 1, 1)]);
  readLatestUsage(p, { sessionId: 'tu-partial' });
  const full = JSON.stringify(assistant('msg_G', 9, 9, 9));
  fs.appendFileSync(p, full.slice(0, 20));
  assert.equal(readLatestUsage(p, { sessionId: 'tu-partial' }).messageId, 'msg_F');
  fs.appendFileSync(p, full.slice(20) + '\n');
  assert.equal(readLatestUsage(p, { sessionId: 'tu-partial' }).messageId, 'msg_G');
});

test('readLatestUsage restarts from 0 when the file shrank', () => {
  const p = write([assistant('msg_H', 1, 1, 1), assistant('msg_I', 5000, 5000, 5000)]);
  readLatestUsage(p, { sessionId: 'tu-shrink' });
  fs.writeFileSync(p, JSON.stringify(assistant('msg_J', 7, 0, 0)) + '\n');
  const u = readLatestUsage(p, { sessionId: 'tu-shrink' });
  assert.equal(u.contextTokens, 7);
  assert.equal(u.source, 'transcript');
});

test('readLatestUsage returns the cache when the transcript path is missing', () => {
  const p = write([assistant('msg_K', 11, 22, 33)]);
  readLatestUsage(p, { sessionId: 'tu-gone' });
  fs.unlinkSync(p);
  const u = readLatestUsage(p, { sessionId: 'tu-gone' });
  assert.equal(u.contextTokens, 66);
  assert.equal(u.source, 'cache');
});

test('readLatestUsage works without a sessionId (no cache written)', () => {
  const p = write([assistant('msg_L', 1, 2, 3)]);
  assert.equal(readLatestUsage(p).contextTokens, 6);
});

test('contextTokensOf sums the three input fields and is 0 for null', () => {
  assert.equal(contextTokensOf({ input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 99 }), 6);
  assert.equal(contextTokensOf(null), 0);
});

test('updatePeak keeps the max and readPeak returns null when unset', () => {
  assert.equal(readPeak('tu-peak'), null);
  assert.equal(updatePeak('tu-peak', 100), 100);
  assert.equal(updatePeak('tu-peak', 50), 100);
  assert.equal(readPeak('tu-peak'), 100);
});

test('utils.readTranscriptTokens returns 0 for a missing file and contextTokens otherwise', () => {
  assert.equal(readTranscriptTokens(path.join(DIR, 'missing.jsonl')), 0);
  const p = write([assistant('msg_M', 4, 5, 6)]);
  assert.equal(readTranscriptTokens(p, { sessionId: 'tu-util' }), 15);
  const none = write([{ type: 'user' }]);
  assert.equal(readTranscriptTokens(none, { sessionId: 'tu-util2' }), 0);
});
