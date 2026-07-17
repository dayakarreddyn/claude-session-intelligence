#!/usr/bin/env node
/**
 * Background worker — fetches the Claude usage API and writes a fresh
 * cache for usage-api.js. Spawned detached by triggerRefresh() so the
 * statusline hot path never blocks on keychain reads or HTTPS.
 *
 * Auth source order (first non-empty wins):
 *   1. macOS keychain service "Claude Code-credentials" via `security`
 *   2. ~/.claude/.credentials.json
 *
 * On any failure, writes an error-marker to the cache so the next stale
 * read can render "?" instead of hammering the API on every redraw.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const API_HOST = 'api.anthropic.com';
const API_PATH = '/api/oauth/usage';
const TIMEOUT_MS = 5000;
const LOCK_MAX_AGE_MS = 30 * 1000;

function uidSuffix() {
  try { return String(os.userInfo().uid); }
  catch { return 'default'; }
}

const CACHE_FILE = path.join(os.tmpdir(), `claude-usage-cache-${uidSuffix()}.json`);
const LOCK_FILE  = path.join(os.tmpdir(), `claude-usage-lock-${uidSuffix()}.json`);

function writeLock() {
  try { fs.writeFileSync(LOCK_FILE, JSON.stringify({ t: Date.now() })); }
  catch { /* best effort */ }
}

function clearLock() {
  try { fs.unlinkSync(LOCK_FILE); }
  catch { /* already gone — fine */ }
}

function isLockActive() {
  try {
    const stat = fs.statSync(LOCK_FILE);
    return Date.now() - stat.mtimeMs < LOCK_MAX_AGE_MS;
  } catch { return false; }
}

function writeCache(payload) {
  try {
    const body = { ...payload, fetchedAt: Date.now() };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(body));
  } catch { /* best effort */ }
}

function readToken() {
  if (process.platform === 'darwin') {
    try {
      const raw = execFileSync('security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
        }).trim();
      const parsed = JSON.parse(raw);
      const token = parsed && parsed.claudeAiOauth && parsed.claudeAiOauth.accessToken;
      if (token) return token;
    } catch { /* fall through to credentials file */ }
  }

  try {
    const home = process.env.HOME || os.homedir();
    const credFile = path.join(home, '.claude', '.credentials.json');
    const raw = fs.readFileSync(credFile, 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && parsed.claudeAiOauth && parsed.claudeAiOauth.accessToken) || null;
  } catch { return null; }
}

function fetchUsage(token) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: API_HOST,
      path: API_PATH,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'user-agent': 'session-intelligence-usage/1',
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 429) {
          // Honor the server's backoff hint — usage-api.js suppresses
          // refresh attempts until fetchedAt + retryAfterMs. Without this
          // we re-hit the endpoint every ~30s for the whole outage.
          return resolve({
            error: 'rate-limited',
            retryAfterMs: parseRetryAfterMs(res.headers['retry-after']),
          });
        }
        if (res.statusCode !== 200) return resolve({ error: 'api-error' });
        try {
          const parsed = JSON.parse(body);
          resolve({
            sessionUsage: numOrNull(parsed && parsed.five_hour && parsed.five_hour.utilization),
            sessionResetAt: parsed && parsed.five_hour && parsed.five_hour.resets_at || null,
            weeklyUsage: numOrNull(parsed && parsed.seven_day && parsed.seven_day.utilization),
            weeklyResetAt: parsed && parsed.seven_day && parsed.seven_day.resets_at || null,
            extraUsageEnabled: !!(parsed && parsed.extra_usage && parsed.extra_usage.is_enabled),
            extraUsageLimit: numOrNull(parsed && parsed.extra_usage && parsed.extra_usage.monthly_limit),
            extraUsageUsed: numOrNull(parsed && parsed.extra_usage && parsed.extra_usage.used_credits),
            extraUsageUtilization: numOrNull(parsed && parsed.extra_usage && parsed.extra_usage.utilization),
          });
        } catch { resolve({ error: 'parse-error' }); }
      });
    });
    req.on('error', () => resolve({ error: 'network' }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.end();
  });
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** `Retry-After` is either delta-seconds or an HTTP-date. Null when absent/garbage. */
function parseRetryAfterMs(header) {
  if (header === undefined || header === null || header === '') return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const date = Date.parse(String(header));
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

// Fields worth surviving an API outage — the statusline renders these (with
// a stale marker) instead of blanking the usage cells for the whole outage.
const CARRY_FIELDS = [
  'sessionUsage', 'sessionResetAt', 'weeklyUsage', 'weeklyResetAt',
  'extraUsageEnabled', 'extraUsageLimit', 'extraUsageUsed', 'extraUsageUtilization',
];

/**
 * Build the cache payload for a fetch result. Success stamps `goodAt` (when
 * these numbers were actually true). Errors carry the previous cache's good
 * values forward — `goodAt` survives from the last success (older caches
 * that predate the field fall back to the previous `fetchedAt`).
 * Pure; exported for tests.
 */
function buildCachePayload(result, prev, now = Date.now()) {
  if (!result || !result.error) return { ...result, goodAt: now };
  const carried = {};
  if (prev && typeof prev === 'object') {
    for (const k of CARRY_FIELDS) {
      if (prev[k] !== undefined && prev[k] !== null) carried[k] = prev[k];
    }
    const prevGoodAt = numOrNull(prev.goodAt) ?? (prev.error ? null : numOrNull(prev.fetchedAt));
    if (prevGoodAt !== null) carried.goodAt = prevGoodAt;
  }
  return { ...carried, ...result };
}

function readPrevCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch { return null; }
}

async function main() {
  if (isLockActive()) return;
  writeLock();

  try {
    const token = readToken();
    if (!token) { writeCache(buildCachePayload({ error: 'no-credentials' }, readPrevCache())); return; }

    const result = await fetchUsage(token);
    writeCache(buildCachePayload(result, readPrevCache()));
  } finally {
    clearLock();
  }
}

if (require.main === module) {
  main().catch(() => clearLock());
}

module.exports = { readToken, fetchUsage, parseRetryAfterMs, buildCachePayload };
