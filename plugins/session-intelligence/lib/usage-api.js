/**
 * Usage API — surfaces the same 5-hour / 7-day quota numbers ccstatusline
 * exposes via `api.anthropic.com/api/oauth/usage`, but designed for a
 * sync-render statusline: the hot path only reads a disk cache; refreshes
 * happen in a detached child so no redraw is ever blocked on HTTPS or the
 * macOS keychain prompt.
 *
 * Cache: /tmp/claude-usage-cache-<uid>.json  (180s TTL; shared across sessions)
 * Lock:  /tmp/claude-usage-lock-<uid>.json   (30s; prevents concurrent refreshes)
 *
 * Why stay sync on the statusline: statusline-intel.js is a synchronous
 * pipeline (readFileSync(0) → render → write → exit). Converting it to async
 * for one network call would ripple through every field renderer. Cheaper to
 * isolate the async I/O in a separate refresh process.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CACHE_MAX_AGE_MS = 180 * 1000;

function uidSuffix() {
  try { return String(os.userInfo().uid); }
  catch { return 'default'; }
}

function cacheFilePath() {
  return path.join(os.tmpdir(), `claude-usage-cache-${uidSuffix()}.json`);
}

function lockFilePath() {
  return path.join(os.tmpdir(), `claude-usage-lock-${uidSuffix()}.json`);
}

/**
 * Read the cached usage snapshot. Returns null when the cache file is
 * missing, unreadable, or un-parseable. Includes a `stale` boolean so
 * callers can decide whether to trigger a background refresh.
 */
function readUsageCache() {
  const cacheFile = cacheFilePath();
  let stat;
  try { stat = fs.statSync(cacheFile); }
  catch { return null; }

  let data;
  try {
    const raw = fs.readFileSync(cacheFile, 'utf8');
    data = JSON.parse(raw);
  } catch { return null; }
  if (!data || typeof data !== 'object') return null;

  const age = Date.now() - stat.mtimeMs;
  return {
    sessionUsage: typeof data.sessionUsage === 'number' ? data.sessionUsage : null,
    sessionResetAt: data.sessionResetAt || null,
    weeklyUsage: typeof data.weeklyUsage === 'number' ? data.weeklyUsage : null,
    weeklyResetAt: data.weeklyResetAt || null,
    extraUsageEnabled: !!data.extraUsageEnabled,
    extraUsageLimit: typeof data.extraUsageLimit === 'number' ? data.extraUsageLimit : null,
    extraUsageUsed: typeof data.extraUsageUsed === 'number' ? data.extraUsageUsed : null,
    extraUsageUtilization: typeof data.extraUsageUtilization === 'number' ? data.extraUsageUtilization : null,
    error: typeof data.error === 'string' ? data.error : null,
    fetchedAt: typeof data.fetchedAt === 'number' ? data.fetchedAt : null,
    age,
    stale: age > CACHE_MAX_AGE_MS,
  };
}

/**
 * Spawn the refresh worker (usage-refresh.js) in a detached child. Returns
 * true if a worker was spawned, false if skipped (cache fresh, lock held,
 * or spawn failed). Never throws.
 */
function triggerRefresh({ force = false } = {}) {
  const cached = readUsageCache();
  if (!force && cached && !cached.stale && !cached.error) return false;

  // Respect an active lock so we don't spawn a pile of workers when the
  // statusline redraws five times in a second.
  try {
    const lockStat = fs.statSync(lockFilePath());
    if (Date.now() - lockStat.mtimeMs < 30 * 1000) return false;
  } catch { /* no lock — proceed */ }

  try {
    const worker = path.join(__dirname, 'usage-refresh.js');
    if (!fs.existsSync(worker)) return false;
    const child = spawn(process.execPath, [worker], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return true;
  } catch { return false; }
}

/**
 * Convenience: read the cache, schedule a background refresh if stale.
 * Returns whatever the cache currently holds (possibly null).
 */
function readAndRefreshIfStale() {
  const cached = readUsageCache();
  if (!cached || cached.stale || cached.error) triggerRefresh();
  return cached;
}

module.exports = {
  readUsageCache,
  triggerRefresh,
  readAndRefreshIfStale,
  cacheFilePath,
  lockFilePath,
  CACHE_MAX_AGE_MS,
};
