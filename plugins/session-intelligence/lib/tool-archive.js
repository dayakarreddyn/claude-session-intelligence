/**
 * Session Intelligence — tool-response archive.
 *
 * When a tool call returns a large payload (Read on a big file, Bash log
 * dump, Grep with many matches), the body sits in the context window until
 * /compact erases it. After compaction, if the model wants the detail back,
 * it has to re-run the tool — paying tokens + wall time a second time.
 *
 * This module captures those bodies by `tool_use_id` on PostToolUse, so a
 * later `si expand <id>` call (or the `tools/expand.js` CLI) replays the
 * exact payload from disk instead of re-fetching.
 *
 * Design:
 *   - Archive dir per session: ${tmpdir()}/claude-tool-archive-<sid>/
 *   - One file per archive:    <tool_use_id>.json
 *   - Append-only index:       index.jsonl (one line per archive)
 *   - LRU eviction when count > maxPerSession (drop oldest by index order)
 *   - Lazy TTL sweep on write — archives older than ttlDays are removed
 *
 * Observational only. We don't modify the tool pipeline or truncate what
 * the model sees on the initial call; the post-compact retrieval path is
 * the value prop.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULTS = {
  enabled: true,
  thresholdChars: 4096,
  maxPerSession: 200,
  ttlDays: 7,
};

function sanitizeSid(sid) {
  const s = String(sid || 'default').replace(/[^a-zA-Z0-9_-]/g, '');
  return s || 'default';
}

function sanitizeId(id) {
  // tool_use_id is typically `toolu_...` from the API but we defend against
  // anything — a path-traversal attempt in this field would let us write
  // outside the archive dir.
  const s = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return s.slice(0, 64) || null;
}

function tempRoot() { return os.tmpdir(); }

function archiveDir(sid) {
  return path.join(tempRoot(), `claude-tool-archive-${sanitizeSid(sid)}`);
}

function archiveFile(sid, id) {
  const safeId = sanitizeId(id);
  if (!safeId) return null;
  return path.join(archiveDir(sid), `${safeId}.json`);
}

function indexFile(sid) {
  return path.join(archiveDir(sid), 'index.jsonl');
}

function ensureDirSync(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
}

/** Best-effort preview — first 160 chars, newlines collapsed, for listings. */
function makePreview(body) {
  if (!body) return '';
  return String(body).slice(0, 160).replace(/\s+/g, ' ').trim();
}

/**
 * Extract the usable body + id from a PostToolUse hook payload. Claude Code
 * has varied the field names across versions — we check every known spelling
 * rather than lock to one and break on a schema tweak.
 */
function extractFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return { id: null, body: '', toolName: '', toolInput: null };

  const id = payload.tool_use_id || payload.toolUseId || payload.tool_call_id || null;
  const toolName = payload.tool_name || payload.toolName || '';
  const toolInput = payload.tool_input || payload.toolInput || null;

  const raw = payload.tool_response !== undefined ? payload.tool_response
            : payload.tool_output   !== undefined ? payload.tool_output
            : payload.output        !== undefined ? payload.output
            : payload.result        !== undefined ? payload.result
            : '';
  const body = typeof raw === 'string' ? raw : safeStringify(raw);

  return { id, body, toolName, toolInput };
}

function safeStringify(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * Write an archive. Returns the archive path on success, or null when
 * skipped (body under threshold, missing id, disabled). Side effects are
 * swallowed — callers are hooks and must never fail the pipeline.
 */
function writeArchive(sid, id, meta, body, opts) {
  const cfg = { ...DEFAULTS, ...(opts || {}) };
  if (!cfg.enabled) return null;

  const safeSid = sanitizeSid(sid);
  const safeId = sanitizeId(id);
  if (!safeId) return null;

  const str = typeof body === 'string' ? body : safeStringify(body);
  if (!str || str.length < cfg.thresholdChars) return null;

  const dir = archiveDir(safeSid);
  ensureDirSync(dir);

  const file = path.join(dir, `${safeId}.json`);
  const record = {
    id: safeId,
    sid: safeSid,
    tool: (meta && meta.tool_name) || '',
    tool_input: (meta && meta.tool_input) || null,
    t: Date.now(),
    chars: str.length,
    body: str,
  };

  try {
    fs.writeFileSync(file, JSON.stringify(record), 'utf8');
  } catch {
    return null;
  }

  try {
    const line = JSON.stringify({
      id: safeId,
      t: record.t,
      tool: record.tool,
      chars: record.chars,
      preview: makePreview(str),
    }) + '\n';
    fs.appendFileSync(indexFile(safeSid), line, 'utf8');
  } catch { /* index is best-effort */ }

  // LRU eviction on write — cheap because we only touch the index, not all
  // archives. readIndex caps at maxPerSession * 4 so runaway index growth
  // doesn't blow up memory.
  try { enforceLruCap(safeSid, cfg.maxPerSession); } catch { /* ignore */ }

  // Lazy TTL sweep — capped so we don't stall the hook when a stale session
  // has thousands of archives.
  try { sweepTtl(safeSid, cfg.ttlDays); } catch { /* ignore */ }

  return file;
}

/**
 * Read a single archive by id from a specific session. Returns null when
 * missing. The full record (including body) is returned.
 */
function readArchive(sid, id) {
  const file = archiveFile(sid, id);
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Read the index for a session as an ordered array (oldest first). Lines
 * that fail to parse are skipped silently — a truncated tail write from a
 * crashed hook shouldn't poison the whole list.
 */
function readIndex(sid) {
  const file = indexFile(sid);
  if (!fs.existsSync(file)) return [];
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return raw.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

/** Summarise archives for a session — each entry is an index row + exists flag. */
function listArchives(sid) {
  const idx = readIndex(sid);
  return idx.map((row) => ({
    ...row,
    exists: fs.existsSync(archiveFile(sid, row.id) || ''),
  }));
}

/**
 * Keep only the `cap` newest archives for a session. Drops older files and
 * rewrites the index. No-op when under cap or cap is non-positive.
 */
function enforceLruCap(sid, cap) {
  if (!Number.isFinite(cap) || cap <= 0) return;
  const idx = readIndex(sid);
  if (idx.length <= cap) return;
  // Oldest first; drop the leading (idx.length - cap) rows.
  const drop = idx.slice(0, idx.length - cap);
  const keep = idx.slice(idx.length - cap);
  for (const row of drop) {
    const f = archiveFile(sid, row.id);
    if (f) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
  }
  try {
    fs.writeFileSync(indexFile(sid),
      keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''),
      'utf8');
  } catch { /* index rewrite best-effort */ }
}

/** Remove archives older than ttlDays. Returns the count pruned. */
function sweepTtl(sid, ttlDays) {
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) return 0;
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  const idx = readIndex(sid);
  const keep = [];
  let pruned = 0;
  for (const row of idx) {
    if (Number.isFinite(row.t) && row.t < cutoff) {
      const f = archiveFile(sid, row.id);
      if (f) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
      pruned += 1;
    } else {
      keep.push(row);
    }
  }
  if (pruned > 0) {
    try {
      fs.writeFileSync(indexFile(sid),
        keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''),
        'utf8');
    } catch { /* ignore */ }
  }
  return pruned;
}

module.exports = {
  DEFAULTS,
  archiveDir,
  archiveFile,
  indexFile,
  extractFromPayload,
  writeArchive,
  readArchive,
  readIndex,
  listArchives,
  enforceLruCap,
  sweepTtl,
};
