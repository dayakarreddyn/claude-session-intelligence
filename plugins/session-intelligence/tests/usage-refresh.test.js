/**
 * Tests for lib/usage-refresh.js — the detached worker's pure helpers.
 * Network + keychain paths are not exercised here; what matters at this
 * layer is (1) Retry-After parsing and (2) that an error fetch carries the
 * previous cache's good values forward instead of blanking the statusline
 * usage cells for the whole outage.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseRetryAfterMs, buildCachePayload } = require('../lib/usage-refresh');

test('parseRetryAfterMs handles delta-seconds, HTTP-date, and garbage', () => {
  assert.equal(parseRetryAfterMs('3111'), 3111000);
  assert.equal(parseRetryAfterMs(0), 0);
  const inTenMin = new Date(Date.now() + 10 * 60 * 1000).toUTCString();
  const parsed = parseRetryAfterMs(inTenMin);
  assert.ok(parsed > 9 * 60 * 1000 && parsed <= 10 * 60 * 1000, `date form → ~10min, got ${parsed}`);
  assert.equal(parseRetryAfterMs('soon'), null);
  assert.equal(parseRetryAfterMs(undefined), null);
  assert.equal(parseRetryAfterMs(''), null);
});

test('buildCachePayload stamps goodAt on success', () => {
  const out = buildCachePayload({ sessionUsage: 40, weeklyUsage: 55 }, null, 1000);
  assert.equal(out.goodAt, 1000);
  assert.equal(out.sessionUsage, 40);
});

test('buildCachePayload carries last good values through an error', () => {
  const prev = { sessionUsage: 40, sessionResetAt: 'r1', weeklyUsage: 55, weeklyResetAt: 'r2', goodAt: 500, fetchedAt: 500 };
  const out = buildCachePayload({ error: 'rate-limited', retryAfterMs: 3111000 }, prev, 2000);
  assert.equal(out.error, 'rate-limited');
  assert.equal(out.retryAfterMs, 3111000);
  assert.equal(out.sessionUsage, 40, 'good value survives the error');
  assert.equal(out.weeklyUsage, 55);
  assert.equal(out.goodAt, 500, 'goodAt stays at the last SUCCESSFUL fetch');
});

test('buildCachePayload falls back to prev.fetchedAt as goodAt for legacy success caches', () => {
  const prev = { sessionUsage: 30, weeklyUsage: 60, fetchedAt: 700 }; // pre-goodAt cache, no error
  const out = buildCachePayload({ error: 'api-error' }, prev, 2000);
  assert.equal(out.goodAt, 700);
  assert.equal(out.weeklyUsage, 60);
});

test('buildCachePayload chains through consecutive errors without losing values', () => {
  const first = buildCachePayload(
    { error: 'rate-limited' },
    { sessionUsage: 40, weeklyUsage: 55, goodAt: 500, fetchedAt: 500 },
    1000,
  );
  const second = buildCachePayload({ error: 'rate-limited' }, { ...first, fetchedAt: 1000 }, 2000);
  assert.equal(second.sessionUsage, 40, 'values survive error → error');
  assert.equal(second.goodAt, 500, 'goodAt still the original success');
});

test('buildCachePayload with no previous cache is just the error', () => {
  const out = buildCachePayload({ error: 'no-credentials' }, null, 1000);
  assert.equal(out.error, 'no-credentials');
  assert.equal(out.sessionUsage, undefined);
});
