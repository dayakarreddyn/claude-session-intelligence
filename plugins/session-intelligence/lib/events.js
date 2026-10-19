/**
 * Session Intelligence — durable events store (SQLite).
 *
 * Lives at ~/.claude/state/si-events.db. Tracks cross-session telemetry:
 * sessions, compacts, zone transitions, tool-archive events. Powers the
 * /si stats CLI and any future dashboard.
 *
 * Design notes:
 *   - Per-session HOT state (compact-zone, ctx-shape, token-budget) stays
 *     in JSON files — high-frequency writes don't suit a single-writer DB.
 *   - This DB is for AGGREGATABLE events: append-mostly, query-heavy. Hooks
 *     call recordX() alongside their existing file writes.
 *   - WAL mode + synchronous=NORMAL: durable enough for telemetry, fast
 *     enough that hooks stay <50ms. We tolerate ~1 commit-window of loss
 *     on a hard kernel crash.
 *   - All public functions swallow errors and return null/false — hooks
 *     must never crash the tool pipeline because telemetry hiccupped. The
 *     debug log catches the underlying issue.
 *   - Lazy require: better-sqlite3 is a native module. If it failed to
 *     compile (locked-down corp box, fresh Node bump), every helper here
 *     becomes a silent no-op and the JSON-file path keeps working.
 */

const fs = require('fs');
const path = require('path');

let _db = null;
let _dbAttempted = false;
let _dbDisabled = false;
let _dbPathOverride = null; // set by _setDbPathForTest

function getEventsDbPath() {
  if (_dbPathOverride) return _dbPathOverride;
  const { getStateDir } = require('./utils');
  return path.join(getStateDir(), 'si-events.db');
}

function isAvailable() {
  if (_dbDisabled) return false;
  if (_db) return true;
  if (_dbAttempted) return false;
  return openDb() !== null;
}

function openDb() {
  if (_db) return _db;
  if (_dbDisabled || _dbAttempted) return _db;
  _dbAttempted = true;
  try {
    // better-sqlite3 when its native binary matches this Node ABI, otherwise
    // the built-in node:sqlite (Node >= 22.13). See lib/sqlite-driver.js.
    const { openDatabase } = require('./sqlite-driver');
    const opened = openDatabase(getEventsDbPath());
    _db = opened.db;
    _db.pragma('journal_mode = WAL');
    _db.pragma('synchronous = NORMAL');
    _db.pragma('foreign_keys = ON');
    initSchema(_db);
    try {
      const { intelLog } = require('./intel-debug');
      intelLog('events', 'debug', 'sqlite driver', { driver: opened.driver });
    } catch { /* optional */ }
    return _db;
  } catch (err) {
    try {
      const { intelLog } = require('./intel-debug');
      intelLog('events', 'warn', 'sqlite open failed', { err: err && err.message });
    } catch { /* optional */ }
    _dbDisabled = true;
    return null;
  }
}

/** Schema and migrations live in lib/events-migrations.js. */
const { initSchema } = require('./events-migrations');

// ─── Writers ────────────────────────────────────────────────────────────────

function recordSessionStart({ sid, project, cwd, startedAt }) {
  const db = openDb();
  if (!db || !sid) return false;
  try {
    db.prepare(`
      INSERT INTO sessions (sid, project, cwd, started_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET project=excluded.project, cwd=excluded.cwd
    `).run(sid, project || null, cwd || null, startedAt || Date.now());
    return true;
  } catch { return false; }
}

function recordSessionEnd({ sid, endedAt, totalCostUsd, peakTokens, toolCalls }) {
  const db = openDb();
  if (!db || !sid) return false;
  try {
    db.prepare(`
      UPDATE sessions
      SET ended_at = COALESCE(?, ended_at),
          total_cost_usd = COALESCE(?, total_cost_usd),
          peak_tokens = COALESCE(?, peak_tokens),
          tool_calls = COALESCE(?, tool_calls)
      WHERE sid = ?
    `).run(
      endedAt || Date.now(),
      Number.isFinite(totalCostUsd) ? totalCostUsd : null,
      Number.isFinite(peakTokens) ? peakTokens : null,
      Number.isFinite(toolCalls) ? toolCalls : null,
      sid,
    );
    return true;
  } catch { return false; }
}

function recordCompact(entry) {
  const db = openDb();
  if (!db || !entry || !entry.sid) return false;
  try {
    db.prepare(`
      INSERT INTO compacts
        (sid, project, cwd, t, tokens, cost, cost_at_compact, hot_dirs, warm_dirs, dropped_dirs, had_shift, trigger,
         context_cap, fill_pct, model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.sid,
      entry.project || null,
      entry.cwd || null,
      Number.isFinite(entry.t) ? entry.t : Date.now(),
      Number.isFinite(entry.tokens) ? entry.tokens : null,
      Number.isFinite(entry.cost) ? entry.cost : null,
      Number.isFinite(entry.costAtCompactUsd) ? entry.costAtCompactUsd : null,
      JSON.stringify(entry.hotDirs || []),
      JSON.stringify(entry.warmDirs || []),
      JSON.stringify(entry.droppedDirs || []),
      entry.hadShift ? 1 : 0,
      entry.trigger || null,
      Number.isFinite(entry.contextCap) ? entry.contextCap : null,
      Number.isFinite(entry.fillPct) ? entry.fillPct : null,
      entry.model || null,
    );
    return true;
  } catch { return false; }
}

function recordZoneTransition({
  sid, project, t, fromZone, toZone, tokens, cost, reason,
  contextCap, fillPct, model, trigger,
}) {
  const db = openDb();
  if (!db || !sid || !toZone) return false;
  try {
    db.prepare(`
      INSERT INTO zone_transitions
        (sid, project, t, from_zone, to_zone, tokens, cost, reason,
         context_cap, fill_pct, model, trigger)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sid, project || null,
      Number.isFinite(t) ? t : Date.now(),
      fromZone || null, toZone,
      Number.isFinite(tokens) ? tokens : null,
      Number.isFinite(cost) ? cost : null,
      reason || null,
      Number.isFinite(contextCap) ? contextCap : null,
      Number.isFinite(fillPct) ? fillPct : null,
      model || null,
      trigger || null,
    );
    return true;
  } catch { return false; }
}

function recordToolArchive({ sid, toolUseId, tool, chars, t }) {
  const db = openDb();
  if (!db || !sid || !toolUseId) return false;
  try {
    db.prepare(`
      INSERT INTO tool_archives (sid, tool_use_id, tool, chars, t)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      sid, toolUseId, tool || null,
      Number.isFinite(chars) ? chars : null,
      Number.isFinite(t) ? t : Date.now(),
    );
    return true;
  } catch { return false; }
}

function recordAgentInvocation({
  sid, toolUseId, subagentType, description,
  promptChars, responseChars, durationMs, t, isError,
  model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, costUsd,
}) {
  const db = openDb();
  if (!db || !sid) return false;
  try {
    db.prepare(`
      INSERT INTO agent_invocations
        (sid, tool_use_id, subagent_type, description,
         prompt_chars, response_chars, duration_ms, t, is_error,
         model, input_tokens, output_tokens,
         cache_creation_tokens, cache_read_tokens, cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sid, toolUseId || null,
      subagentType || null, description || null,
      Number.isFinite(promptChars) ? promptChars : null,
      Number.isFinite(responseChars) ? responseChars : null,
      Number.isFinite(durationMs) ? durationMs : null,
      Number.isFinite(t) ? t : Date.now(),
      isError ? 1 : 0,
      model || null,
      Number.isFinite(inputTokens) ? inputTokens : null,
      Number.isFinite(outputTokens) ? outputTokens : null,
      Number.isFinite(cacheCreationTokens) ? cacheCreationTokens : null,
      Number.isFinite(cacheReadTokens) ? cacheReadTokens : null,
      Number.isFinite(costUsd) ? costUsd : null,
    );
    return true;
  } catch { return false; }
}

/**
 * Backfill agent_invocations from workflow-agent transcripts on disk.
 *
 * The `Workflow` tool fires no PostToolUse hook, so si-agent-tracker never
 * sees workflow-spawned agents. We reconcile them at SessionStart instead:
 * walk every workflow transcript for the project, and insert a row for each
 * agentId not already recorded (dedup keyed on tool_use_id = agentId, so this
 * is safe to re-run every session). Rows are attributed to the launching
 * (parent) session's sid, which already carries the right project for the
 * sid-join used by aggregateStats. Returns the number of new rows inserted.
 */
function reconcileWorkflowAgents({ cwd, projectsRoot } = {}) {
  const db = openDb();
  if (!db || !cwd) return 0;
  let agentUsage;
  try { agentUsage = require('./agent-usage'); } catch { return 0; }

  let transcripts;
  try { transcripts = agentUsage.listWorkflowAgentTranscripts({ cwd, projectsRoot }); }
  catch { return 0; }
  if (!transcripts || !transcripts.length) return 0;

  let inserted = 0;
  try {
    const exists = db.prepare('SELECT 1 FROM agent_invocations WHERE tool_use_id = ? LIMIT 1');
    for (const tr of transcripts) {
      let parsed;
      try { parsed = agentUsage.readSubagentTranscript(tr.path); } catch { continue; }
      if (!parsed || !parsed.agentId) continue;
      if (exists.get(parsed.agentId)) continue; // already recorded — idempotent
      const u = parsed.usage || {};
      const ok = recordAgentInvocation({
        sid: tr.sid,
        toolUseId: parsed.agentId,
        subagentType: 'workflow',
        description: tr.wfRunId || null,
        promptChars: null,
        responseChars: null,
        durationMs: parsed.durationMs,
        t: parsed.lastTs || Date.now(),
        isError: 0,
        model: parsed.model,
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheCreationTokens: u.cache_creation_input_tokens,
        cacheReadTokens: u.cache_read_input_tokens,
        costUsd: parsed.costUsd,
      });
      if (ok) inserted += 1;
    }
  } catch { /* best-effort — partial backfill is fine, next session retries */ }
  return inserted;
}

/**
 * Backfill usage columns on agent_invocations rows the live tracker recorded
 * blind. Agent/Task calls run in the background by default now, so when
 * PostToolUse fires the subagent transcript usually hasn't flushed any usage
 * yet — si-agent-tracker records the row with NULL model/tokens/cost. By the
 * next SessionStart the transcripts are complete; re-read them and fill the
 * gaps by matching transcript.parentToolUseId to the row's tool_use_id.
 *
 * Bounded on both sides: only rows from the last `maxAgeDays` are candidates,
 * and only transcripts modified in that window are parsed. Idempotent — a
 * filled row leaves the candidate set, and rows whose transcript never
 * surfaces (evicted, launched from a subdir cwd) age out of the window.
 * Returns the number of rows updated.
 */
function reconcileSubagentUsage({ cwd, projectsRoot, maxAgeDays = 45 } = {}) {
  const db = openDb();
  if (!db || !cwd) return 0;
  let agentUsage;
  try { agentUsage = require('./agent-usage'); } catch { return 0; }

  const sinceMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let rows;
  try {
    rows = db.prepare(`
      SELECT id, tool_use_id FROM agent_invocations
      WHERE (model IS NULL OR model = '')
        AND tool_use_id IS NOT NULL
        AND t > ?
    `).all(sinceMs);
  } catch { return 0; }
  if (!rows.length) return 0;
  const wanted = new Map(rows.map((r) => [r.tool_use_id, r.id]));

  let transcripts;
  try { transcripts = agentUsage.listPlainSubagentTranscripts({ cwd, projectsRoot, sinceMs }); }
  catch { return 0; }
  if (!transcripts || !transcripts.length) return 0;

  let updated = 0;
  try {
    const upd = db.prepare(`
      UPDATE agent_invocations
      SET model = ?, input_tokens = ?, output_tokens = ?,
          cache_creation_tokens = ?, cache_read_tokens = ?, cost_usd = ?,
          duration_ms = COALESCE(?, duration_ms)
      WHERE id = ?
    `);
    // agentId → tool_use_id pair maps, built lazily one per parent sid.
    // Newer Claude Code builds dropped parentToolUseId from subagent
    // transcripts, so the pairing comes from the parent transcript instead.
    const pairMaps = new Map();
    for (const tr of transcripts) {
      if (!wanted.size) break;
      let parsed;
      try { parsed = agentUsage.readSubagentTranscript(tr.path); } catch { continue; }
      if (!parsed || !parsed.model) continue;
      let toolUseId = parsed.parentToolUseId || null;
      if (!toolUseId && parsed.agentId) {
        let pm = pairMaps.get(tr.sid);
        if (pm === undefined) {
          try {
            pm = agentUsage.mapAgentToolUseIds(
              agentUsage.parentTranscriptPathFor(cwd, tr.sid, projectsRoot),
            );
          } catch { pm = new Map(); }
          pairMaps.set(tr.sid, pm);
        }
        toolUseId = pm.get(parsed.agentId) || null;
      }
      if (!toolUseId) continue;
      const rowId = wanted.get(toolUseId);
      if (rowId === undefined) continue;
      const u = parsed.usage || {};
      const num = (n) => (Number.isFinite(n) ? n : null);
      upd.run(
        parsed.model,
        num(u.input_tokens), num(u.output_tokens),
        num(u.cache_creation_input_tokens), num(u.cache_read_input_tokens),
        num(parsed.costUsd), num(parsed.durationMs),
        rowId,
      );
      wanted.delete(toolUseId);
      updated += 1;
    }
  } catch { /* best-effort — partial backfill is fine, next session retries */ }
  return updated;
}

/**
 * Per-model subagent spend for one session — feeds the statusline
 * modelSplit field so the "all models" line includes agent runs, whose
 * usage lives in their own transcripts and never appears in the parent
 * session transcript. Returns [{ model, cost_usd, n }] (rows with usage
 * only; background agents not yet reconciled contribute nothing until the
 * next SessionStart backfill). Never throws.
 */
function agentModelCosts(sid) {
  const db = openDb();
  if (!db || !sid) return [];
  try {
    return db.prepare(`
      SELECT model, SUM(cost_usd) AS cost_usd, COUNT(*) AS n
      FROM agent_invocations
      WHERE sid = ? AND model IS NOT NULL AND model != '' AND cost_usd IS NOT NULL
      GROUP BY model
    `).all(sid);
  } catch { return []; }
}

/**
 * Upsert the CURRENT per-model transcript spend for a session — written by
 * the statusline each redraw (cheap: one WAL upsert per model). This is the
 * cross-session record that weeklyModelSpend aggregates; parent-session
 * per-model splits exist nowhere else once the transcript ages out.
 */
function upsertSessionModelCosts(sid, byModel) {
  const db = openDb();
  if (!db || !sid || !byModel || typeof byModel !== 'object') return false;
  try {
    const up = db.prepare(`
      INSERT INTO session_model_costs (sid, model, cost_usd, t)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(sid, model) DO UPDATE SET cost_usd = excluded.cost_usd, t = excluded.t
    `);
    const now = Date.now();
    const tx = db.transaction((entries) => {
      for (const [model, cost] of entries) {
        if (!model || !(cost > 0)) continue;
        up.run(sid, model, cost, now);
      }
    });
    tx(Object.entries(byModel));
    return true;
  } catch { return false; }
}

/**
 * Per-model tracked spend over the trailing window: parent-session splits
 * (session_model_costs) + subagent runs (agent_invocations). Feeds the
 * statusline's per-model weekly-remaining estimate. [{ model, cost_usd }],
 * highest spend first. Never throws.
 */
function weeklyModelSpend({ days = 7 } = {}) {
  const db = openDb();
  if (!db) return [];
  try {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return db.prepare(`
      SELECT model, SUM(cost_usd) AS cost_usd FROM (
        SELECT model, cost_usd FROM session_model_costs WHERE t > ? AND cost_usd > 0
        UNION ALL
        SELECT model, cost_usd FROM agent_invocations
        WHERE t > ? AND model IS NOT NULL AND model != '' AND cost_usd > 0
      ) GROUP BY model ORDER BY cost_usd DESC
    `).all(cutoff, cutoff);
  } catch { return []; }
}

function markArchivePruned(toolUseId) {
  const db = openDb();
  if (!db || !toolUseId) return false;
  try {
    db.prepare('UPDATE tool_archives SET pruned = 1 WHERE tool_use_id = ?').run(toolUseId);
    return true;
  } catch { return false; }
}

function markArchiveRecalled(toolUseId) {
  const db = openDb();
  if (!db || !toolUseId) return false;
  try {
    db.prepare('UPDATE tool_archives SET recalled = recalled + 1 WHERE tool_use_id = ?').run(toolUseId);
    return true;
  } catch { return false; }
}

// Every (sid, tool_use_id) pair in the archive table. Used by the disk
// reconciler to find rows whose on-disk file has been evicted/swept so the
// DB stops reporting archives that can no longer be recalled.
function allToolArchiveKeys() {
  const db = openDb();
  if (!db) return [];
  try {
    return db.prepare('SELECT sid, tool_use_id AS id FROM tool_archives').all();
  } catch { return []; }
}

// Batch-delete archive rows by tool_use_id. Called when LRU/TTL eviction or a
// reconcile removes the backing file — keeps the events DB a faithful mirror
// of what's actually retrievable. Chunked to stay under SQLite's variable
// limit. Returns the number of rows deleted.
function deleteToolArchives(ids) {
  const db = openDb();
  if (!db || !Array.isArray(ids) || ids.length === 0) return 0;
  let deleted = 0;
  try {
    const CHUNK = 400;
    const stmt = (n) => db.prepare(
      `DELETE FROM tool_archives WHERE tool_use_id IN (${Array(n).fill('?').join(',')})`,
    );
    const run = db.transaction((batch) => {
      for (let i = 0; i < batch.length; i += CHUNK) {
        const slice = batch.slice(i, i + CHUNK);
        deleted += stmt(slice.length).run(...slice).changes;
      }
    });
    run(ids);
    return deleted;
  } catch { return deleted; }
}

// ─── Readers (bodies in lib/events-stats.js) ───────────────────────────────

function aggregateStats(opts) {
  return require('./events-stats').aggregateStats(openDb(), opts);
}

function listRecentCompacts(opts) {
  return require('./events-stats').listRecentCompacts(openDb(), opts);
}

// Test seam — only used by tests to point the DB at a temp file.
function _setDbPathForTest(p) {
  if (_db) { try { _db.close(); } catch { /* ignore */ } _db = null; }
  _dbAttempted = false;
  _dbDisabled = false;
  _dbPathOverride = p;
}

function _resetForTest() {
  if (_db) { try { _db.close(); } catch { /* ignore */ } _db = null; }
  _dbAttempted = false;
  _dbDisabled = false;
  _dbPathOverride = null;
}

module.exports = {
  isAvailable,
  getEventsDbPath,
  recordSessionStart,
  recordSessionEnd,
  recordCompact,
  recordZoneTransition,
  recordToolArchive,
  markArchiveRecalled,
  markArchivePruned,
  allToolArchiveKeys,
  deleteToolArchives,
  recordAgentInvocation,
  reconcileWorkflowAgents,
  reconcileSubagentUsage,
  agentModelCosts,
  upsertSessionModelCosts,
  weeklyModelSpend,
  aggregateStats,
  listRecentCompacts,
  _setDbPathForTest,
  _resetForTest,
};
