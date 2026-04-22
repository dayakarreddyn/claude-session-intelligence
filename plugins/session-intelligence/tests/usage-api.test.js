/**
 * Tests for lib/usage-api.js — the sync cache reader + background refresh
 * trigger that powers the blockUsage / weekUsage statusline fields.
 *
 * We don't hit the network here — the refresh worker is tested separately
 * via a mocked keychain/https path when that's worth adding. These tests
 * only cover the cache-shape invariants we care about at the hot path:
 *   - missing file ⇒ null (render empty, never throw)
 *   - corrupt JSON ⇒ null
 *   - fresh data ⇒ stale=false
 *   - aged data ⇒ stale=true
 *   - triggerRefresh respects the lock so concurrent redraws don't fork
 *     a pile of node workers
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const usageApi = require('../lib/usage-api');

// Override the cache path for each test so we don't collide with a real
// usage cache if one happens to exist on the dev box.
function withTempCache(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-usage-test-'));
  const cachePath = path.join(dir, 'cache.json');
  const lockPath = path.join(dir, 'lock.json');

  // Monkey-patch the module paths through module.require's cache.
  // Simpler alternative: re-require a fresh module with TMPDIR override.
  const origTmpdir = os.tmpdir;
  os.tmpdir = () => dir;
  const freshPath = require.resolve('../lib/usage-api');
  delete require.cache[freshPath];
  const fresh = require('../lib/usage-api');

  try {
    body({ dir, cachePath, lockPath, api: fresh });
  } finally {
    os.tmpdir = origTmpdir;
    delete require.cache[freshPath];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('readUsageCache returns null when cache file is missing', () => {
  withTempCache(({ api }) => {
    assert.equal(api.readUsageCache(), null);
  });
});

test('readUsageCache returns null on corrupt JSON', () => {
  withTempCache(({ api }) => {
    fs.writeFileSync(api.cacheFilePath(), '{not json');
    assert.equal(api.readUsageCache(), null);
  });
});

test('readUsageCache returns fresh data with stale=false', () => {
  withTempCache(({ api }) => {
    const payload = {
      sessionUsage: 42,
      sessionResetAt: '2026-04-22T20:00:00Z',
      weeklyUsage: 95,
      weeklyResetAt: '2026-04-29T00:00:00Z',
      fetchedAt: Date.now(),
    };
    fs.writeFileSync(api.cacheFilePath(), JSON.stringify(payload));
    const res = api.readUsageCache();
    assert.equal(res.sessionUsage, 42);
    assert.equal(res.weeklyUsage, 95);
    assert.equal(res.stale, false);
  });
});

test('readUsageCache marks stale when file is older than TTL', () => {
  withTempCache(({ api }) => {
    const payload = { sessionUsage: 10, weeklyUsage: 20 };
    const cachePath = api.cacheFilePath();
    fs.writeFileSync(cachePath, JSON.stringify(payload));
    // Backdate mtime beyond 180s.
    const old = (Date.now() - (api.CACHE_MAX_AGE_MS + 60 * 1000)) / 1000;
    fs.utimesSync(cachePath, old, old);
    const res = api.readUsageCache();
    assert.equal(res.stale, true);
    assert.ok(res.age > api.CACHE_MAX_AGE_MS);
  });
});

test('readUsageCache coerces unexpected types to null without throwing', () => {
  withTempCache(({ api }) => {
    fs.writeFileSync(api.cacheFilePath(), JSON.stringify({
      sessionUsage: 'not a number',
      weeklyUsage: { nested: 'object' },
      weeklyResetAt: 12345,
    }));
    const res = api.readUsageCache();
    assert.equal(res.sessionUsage, null);
    assert.equal(res.weeklyUsage, null);
    // Non-string resetAt passes through; renderer handles the shape.
    assert.equal(res.weeklyResetAt, 12345);
  });
});

test('triggerRefresh returns false when cache is fresh', () => {
  withTempCache(({ api }) => {
    fs.writeFileSync(api.cacheFilePath(), JSON.stringify({
      sessionUsage: 1, weeklyUsage: 2, fetchedAt: Date.now(),
    }));
    assert.equal(api.triggerRefresh(), false);
  });
});

test('triggerRefresh returns false when an active lock exists', () => {
  withTempCache(({ api }) => {
    // Stale cache to normally trigger refresh...
    const cachePath = api.cacheFilePath();
    fs.writeFileSync(cachePath, JSON.stringify({ sessionUsage: 1 }));
    const old = (Date.now() - (api.CACHE_MAX_AGE_MS + 60 * 1000)) / 1000;
    fs.utimesSync(cachePath, old, old);

    // ...but lock is held and fresh → skip.
    fs.writeFileSync(api.lockFilePath(), JSON.stringify({ t: Date.now() }));
    assert.equal(api.triggerRefresh(), false);
  });
});

test('readAndRefreshIfStale returns whatever cache currently holds', () => {
  withTempCache(({ api }) => {
    // First call: no cache → returns null, triggers refresh (spawn may
    // fail silently if the worker path doesn't resolve, which is fine).
    assert.equal(api.readAndRefreshIfStale(), null);

    const payload = { sessionUsage: 5, weeklyUsage: 10, fetchedAt: Date.now() };
    fs.writeFileSync(api.cacheFilePath(), JSON.stringify(payload));
    const res = api.readAndRefreshIfStale();
    assert.equal(res.sessionUsage, 5);
    assert.equal(res.weeklyUsage, 10);
  });
});
