'use strict';

/**
 * Latest assistant `usage` reader for Claude transcript JSONL files.
 *
 * - Per-session byte-offset cache: each call reads only the bytes appended
 *   since the previous call.
 * - Cold cache: bounded backward scan from EOF (MAX_BACKWARD_CHUNKS chunks).
 * - Returns null when no usage line exists anywhere and no cache is present;
 *   callers must then stay silent rather than estimate.
 * - Never throws.
 */

const fs = require('fs');
const path = require('path');
const { getStateDir } = require('./utils');

const TAIL_CHUNK_BYTES = 524288;
const MAX_BACKWARD_CHUNKS = 8;
const MAX_FORWARD_BYTES = TAIL_CHUNK_BYTES * MAX_BACKWARD_CHUNKS;
const NEWLINE = 0x0a;

function safeId(sessionId) {
  return String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_');
}

function usageCachePath(sessionId) {
  return path.join(getStateDir(), `claude-usage-cache-${safeId(sessionId)}.json`);
}

function peakPath(sessionId) {
  return path.join(getStateDir(), `claude-context-peak-${safeId(sessionId)}`);
}

function contextTokensOf(usage) {
  if (!usage) return 0;
  return (usage.input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0)
    + (usage.cache_read_input_tokens || 0);
}

/** Parse one JSONL line into a usage record, or null when it carries none. */
function parseUsageLine(line) {
  if (!line) return null;
  try {
    const d = JSON.parse(line);
    const msg = d && d.message;
    if (!msg || typeof msg !== 'object' || !msg.usage) return null;
    return {
      contextTokens: contextTokensOf(msg.usage),
      usage: msg.usage,
      model: msg.model || null,
      messageId: msg.id || null,
      timestamp: d.timestamp || null,
    };
  } catch {
    return null;
  }
}

function lastUsageIn(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const rec = parseUsageLine(lines[i]);
    if (rec) return rec;
  }
  return null;
}

function readRange(fd, start, length) {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buf, got, length - got, start + got);
    if (n <= 0) break;
    got += n;
  }
  return got === length ? buf : buf.subarray(0, got);
}

/** Forward read of [offset, size): only complete lines. */
function scanForward(fd, offset, size) {
  const buf = readRange(fd, offset, size - offset);
  const lastNl = buf.lastIndexOf(NEWLINE);
  if (lastNl < 0) return { record: null, nextOffset: offset };
  return {
    record: lastUsageIn(buf.subarray(0, lastNl).toString('utf8')),
    nextOffset: offset + lastNl + 1,
  };
}

/** Cold scan from EOF backwards in bounded chunks, re-joining boundary lines. */
function scanBackward(fd, size) {
  let end = size;
  let carry = Buffer.alloc(0);
  let nextOffset = null;
  for (let i = 0; i < MAX_BACKWARD_CHUNKS && end > 0; i++) {
    const start = Math.max(0, end - TAIL_CHUNK_BYTES);
    const chunk = readRange(fd, start, end - start);
    if (nextOffset === null) {
      const nl = chunk.lastIndexOf(NEWLINE);
      nextOffset = nl >= 0 ? start + nl + 1 : start;
    }
    const buf = Buffer.concat([chunk, carry]);
    const firstNl = start > 0 ? buf.indexOf(NEWLINE) : -1;
    const body = firstNl >= 0 ? buf.subarray(firstNl + 1) : buf;
    carry = firstNl >= 0 ? buf.subarray(0, firstNl) : Buffer.alloc(0);
    if (start > 0 && firstNl < 0) {
      carry = buf; // no boundary yet: whole thing is one partial line
      end = start;
      continue;
    }
    const rec = lastUsageIn(body.toString('utf8'));
    if (rec) return { record: rec, nextOffset };
    end = start;
  }
  return { record: null, nextOffset: nextOffset === null ? size : nextOffset };
}

/** 'default' and empty ids are shared across sessions, so they never cache. */
function isCacheable(sessionId) {
  return Boolean(sessionId) && sessionId !== 'default';
}

function readCache(sessionId) {
  if (!isCacheable(sessionId)) return null;
  try {
    const c = JSON.parse(fs.readFileSync(usageCachePath(sessionId), 'utf8'));
    if (c && typeof c === 'object' && c.usage) return c;
  } catch { /* absent or corrupt — treated as cold */ }
  return null;
}

function writeCache(sessionId, entry) {
  if (!isCacheable(sessionId)) return;
  const file = usageCachePath(sessionId);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(entry));
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function fromCache(cache) {
  return {
    contextTokens: cache.contextTokens || contextTokensOf(cache.usage),
    usage: cache.usage,
    model: cache.model || null,
    messageId: cache.messageId || null,
    timestamp: cache.timestamp || null,
    source: 'cache',
  };
}

function identityOf(transcriptPath, stat) {
  return { transcriptPath, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
}

function sameFile(cache, identity) {
  return Boolean(cache)
    && cache.transcriptPath === identity.transcriptPath
    && cache.ino === identity.ino
    && cache.birthtimeMs === identity.birthtimeMs;
}

function cacheEntry(record, offset, previous, identity) {
  return {
    ...identity,
    offset,
    contextTokens: record.contextTokens,
    usage: record.usage,
    model: record.model,
    messageId: record.messageId,
    timestamp: record.timestamp,
    t: Date.now(),
    lastRecordedMessageId: previous ? previous.lastRecordedMessageId || null : null,
  };
}

function readLatestUsage(transcriptPath, { sessionId } = {}) {
  if (!transcriptPath) return null;
  const cached = readCache(sessionId);
  let fd = null;
  try {
    const stat = fs.statSync(transcriptPath);
    const size = stat.size;
    const identity = identityOf(transcriptPath, stat);
    // A cache from a different file (replaced, rotated, other session) is cold.
    const cache = sameFile(cached, identity) ? cached : null;
    fd = fs.openSync(transcriptPath, 'r');
    const cachedOffset = cache && Number.isFinite(cache.offset) ? cache.offset : 0;
    const stale = cachedOffset > size;
    const warm = cache && !stale && size - cachedOffset <= MAX_FORWARD_BYTES;

    const scan = warm ? scanForward(fd, cachedOffset, size) : scanBackward(fd, size);
    if (scan.record) {
      writeCache(sessionId, cacheEntry(scan.record, scan.nextOffset, stale ? null : cache, identity));
      return { ...scan.record, source: 'transcript' };
    }
    if (cache && !stale) {
      writeCache(sessionId, { ...cache, offset: scan.nextOffset, t: Date.now() });
      return fromCache(cache);
    }
    return null;
  } catch (err) {
    // Only a vanished transcript may be answered from the cache, and only
    // when the cache was written for this very path.
    if (err && err.code === 'ENOENT' && cached && cached.transcriptPath === transcriptPath) {
      return fromCache(cached);
    }
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

function readPeak(sessionId) {
  try {
    const n = parseInt(fs.readFileSync(peakPath(sessionId), 'utf8'), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// Read-modify-write is not atomic; acceptable because the value is a
// monotonic max: a lost race can only under-write by one concurrent call and
// the next call corrects it.
function updatePeak(sessionId, contextTokens) {
  const current = readPeak(sessionId);
  const next = Math.max(current || 0, Number(contextTokens) || 0);
  if (current === null || next > current) {
    try { fs.writeFileSync(peakPath(sessionId), String(next)); } catch { /* best effort */ }
  }
  return next;
}

module.exports = {
  readLatestUsage,
  contextTokensOf,
  usageCachePath,
  peakPath,
  updatePeak,
  readPeak,
  TAIL_CHUNK_BYTES,
  MAX_BACKWARD_CHUNKS,
};
