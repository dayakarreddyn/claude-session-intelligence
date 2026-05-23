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
  let Sqlite;
  try { Sqlite = require('better-sqlite3'); }
  catch (err) {
    // Native module missing or failed to load — disable for the process.
    // Caller should already be in a try/catch but log for diagnosability.
    try {
      const { intelLog } = require('./intel-debug');
      intelLog('events', 'debug', 'better-sqlite3 unavailable', { err: err && err.message });
    } catch { /* optional */ }
    _dbDisabled = true;
    return null;
  }
  try {
    _db = new Sqlite(getEventsDbPath());
    _db.pragma('journal_mode = WAL');
    _db.pragma('synchronous = NORMAL');
    _db.pragma('foreign_keys = ON');
    initSchema(_db);
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

/**
 * Schema is single-version, additive only. New tables append; new columns
 * use ADD COLUMN guarded by a probe. Drop-and-recreate is never allowed
 * once a release is out — the events DB is durable user data.
 *
 * Tables:
 *   sessions          — one row per Claude Code session lifecycle
 *   compacts          — one row per /compact event (manual or auto)
 *   zone_transitions  — yellow/orange/red callouts from suggest-compact
 *   tool_archives     — large tool-response captures (post-compact recall)
 *   agent_invocations — Task tool calls (subagent runs) — type, sizes, duration
 */
function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid          TEXT PRIMARY KEY,
      project      TEXT,
      cwd          TEXT,
      started_at   INTEGER NOT NULL,
      ended_at     INTEGER,
      total_cost_usd REAL,
      peak_tokens  INTEGER,
      tool_calls   INTEGER
    );
    CREATE INDEX IF NOT EXISTS sessions_project_idx ON sessions(project);
    CREATE INDEX IF NOT EXISTS sessions_started_idx ON sessions(started_at);

    CREATE TABLE IF NOT EXISTS compacts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      sid           TEXT NOT NULL,
      project       TEXT,
      cwd           TEXT,
      t             INTEGER NOT NULL,
      tokens        INTEGER,
      cost          REAL,
      cost_at_compact REAL,
      hot_dirs      TEXT,
      warm_dirs     TEXT,
      dropped_dirs  TEXT,
      had_shift     INTEGER,
      trigger       TEXT
    );
    CREATE INDEX IF NOT EXISTS compacts_sid_idx ON compacts(sid);
    CREATE INDEX IF NOT EXISTS compacts_project_idx ON compacts(project);
    CREATE INDEX IF NOT EXISTS compacts_t_idx ON compacts(t);

    CREATE TABLE IF NOT EXISTS zone_transitions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      sid          TEXT NOT NULL,
      project      TEXT,
      t            INTEGER NOT NULL,
      from_zone    TEXT,
      to_zone      TEXT NOT NULL,
      tokens       INTEGER,
      cost         REAL,
      reason       TEXT
    );
    CREATE INDEX IF NOT EXISTS zone_transitions_sid_idx ON zone_transitions(sid);
    CREATE INDEX IF NOT EXISTS zone_transitions_project_idx ON zone_transitions(project);

    CREATE TABLE IF NOT EXISTS tool_archives (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      sid          TEXT NOT NULL,
      tool_use_id  TEXT NOT NULL,
      tool         TEXT,
      chars        INTEGER,
      t            INTEGER NOT NULL,
      recalled     INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS tool_archives_sid_idx ON tool_archives(sid);
    CREATE INDEX IF NOT EXISTS tool_archives_tuid_idx ON tool_archives(tool_use_id);

    CREATE TABLE IF NOT EXISTS agent_invocations (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      sid            TEXT NOT NULL,
      tool_use_id    TEXT,
      subagent_type  TEXT,
      description    TEXT,
      prompt_chars   INTEGER,
      response_chars INTEGER,
      duration_ms    INTEGER,
      t              INTEGER NOT NULL,
      is_error       INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS agent_invocations_sid_idx ON agent_invocations(sid);
    CREATE INDEX IF NOT EXISTS agent_invocations_t_idx ON agent_invocations(t);
    CREATE INDEX IF NOT EXISTS agent_invocations_type_idx ON agent_invocations(subagent_type);
  `);

  // Additive migration: new columns for derived usage/cost on agent_invocations.
  // Wrapped in try/catch so existing rows aren't disturbed and a half-completed
  // ALTER doesn't crash the open. Each column is independently added.
  const addCols = [
    "ALTER TABLE agent_invocations ADD COLUMN model TEXT",
    "ALTER TABLE agent_invocations ADD COLUMN input_tokens INTEGER",
    "ALTER TABLE agent_invocations ADD COLUMN output_tokens INTEGER",
    "ALTER TABLE agent_invocations ADD COLUMN cache_creation_tokens INTEGER",
    "ALTER TABLE agent_invocations ADD COLUMN cache_read_tokens INTEGER",
    "ALTER TABLE agent_invocations ADD COLUMN cost_usd REAL",
  ];
  for (const sql of addCols) {
    try { db.exec(sql); } catch { /* column already exists — expected */ }
  }
}

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
        (sid, project, cwd, t, tokens, cost, cost_at_compact, hot_dirs, warm_dirs, dropped_dirs, had_shift, trigger)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    );
    return true;
  } catch { return false; }
}

function recordZoneTransition({ sid, project, t, fromZone, toZone, tokens, cost, reason }) {
  const db = openDb();
  if (!db || !sid || !toZone) return false;
  try {
    db.prepare(`
      INSERT INTO zone_transitions
        (sid, project, t, from_zone, to_zone, tokens, cost, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sid, project || null,
      Number.isFinite(t) ? t : Date.now(),
      fromZone || null, toZone,
      Number.isFinite(tokens) ? tokens : null,
      Number.isFinite(cost) ? cost : null,
      reason || null,
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

// ─── Readers ────────────────────────────────────────────────────────────────

function aggregateStats({ sinceDays = 30, project = null } = {}) {
  const db = openDb();
  if (!db) return null;
  try {
    const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
    const projectClause = project ? 'AND project = ?' : '';
    const projectArgs = project ? [project] : [];

    const sessions = db.prepare(`
      SELECT COUNT(*) AS n, SUM(total_cost_usd) AS cost,
             AVG(peak_tokens) AS avg_peak, MAX(peak_tokens) AS max_peak,
             AVG(total_cost_usd) AS avg_cost, SUM(tool_calls) AS tool_calls
      FROM sessions WHERE started_at >= ? ${projectClause}
    `).get(cutoff, ...projectArgs);

    const compacts = db.prepare(`
      SELECT COUNT(*) AS n, AVG(tokens) AS avg_tokens, AVG(cost) AS avg_cost,
             SUM(cost) AS total_cost, SUM(had_shift) AS shifts,
             MIN(tokens) AS min_tokens, MAX(tokens) AS max_tokens
      FROM compacts WHERE t >= ? ${projectClause}
    `).get(cutoff, ...projectArgs);

    // Sorted token list → compute p50/p90 in JS (SQLite has no native percentile).
    const compactTokens = db.prepare(`
      SELECT tokens FROM compacts
      WHERE t >= ? ${projectClause} AND tokens IS NOT NULL
      ORDER BY tokens ASC
    `).all(cutoff, ...projectArgs).map((r) => r.tokens);
    const pct = (arr, p) => {
      if (!arr.length) return null;
      const i = Math.min(arr.length - 1, Math.floor(arr.length * p));
      return arr[i];
    };
    const compactPercentiles = {
      p50: pct(compactTokens, 0.5),
      p90: pct(compactTokens, 0.9),
    };

    const zones = db.prepare(`
      SELECT to_zone AS zone, COUNT(*) AS n
      FROM zone_transitions WHERE t >= ? ${projectClause}
      GROUP BY to_zone ORDER BY n DESC
    `).all(cutoff, ...projectArgs);

    const archives = db.prepare(`
      SELECT COUNT(*) AS n, SUM(recalled) AS recalled, SUM(chars) AS bytes
      FROM tool_archives WHERE t >= ?
        ${project ? 'AND sid IN (SELECT sid FROM sessions WHERE project = ?)' : ''}
    `).get(cutoff, ...projectArgs);

    // Agent (Task tool / subagent) usage. Aggregate totals + top-N by type.
    const agentProjectClause = project
      ? 'AND sid IN (SELECT sid FROM sessions WHERE project = ?)' : '';
    const agents = db.prepare(`
      SELECT COUNT(*) AS n,
             SUM(is_error) AS errors,
             AVG(duration_ms) AS avg_ms,
             SUM(duration_ms) AS total_ms,
             SUM(prompt_chars) AS prompt_chars,
             SUM(response_chars) AS response_chars,
             SUM(input_tokens) AS input_tokens,
             SUM(output_tokens) AS output_tokens,
             SUM(cache_creation_tokens) AS cache_creation_tokens,
             SUM(cache_read_tokens) AS cache_read_tokens,
             SUM(cost_usd) AS cost_usd
      FROM agent_invocations WHERE t >= ? ${agentProjectClause}
    `).get(cutoff, ...projectArgs);
    const agentTypes = db.prepare(`
      SELECT subagent_type AS type, COUNT(*) AS n,
             AVG(duration_ms) AS avg_ms,
             SUM(is_error) AS errors,
             SUM(input_tokens) AS input_tokens,
             SUM(output_tokens) AS output_tokens,
             SUM(cost_usd) AS cost_usd
      FROM agent_invocations
      WHERE t >= ? ${agentProjectClause} AND subagent_type IS NOT NULL
      GROUP BY subagent_type ORDER BY cost_usd DESC NULLS LAST, n DESC LIMIT 10
    `).all(cutoff, ...projectArgs);

    // Per-day series (cost + sessions + compacts). Local-day bucketed.
    // Day key: "YYYY-MM-DD" — small integer-ish key, easy to sort/render.
    const dayKey = (ms) => {
      const d = new Date(ms);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };
    // ISO-ish week key "YYYY-Www" using Monday as week start. Computed by
    // shifting each date back to its Monday and using that day's date as the
    // week label (avoids cross-year ISO-week edge-case complexity for our
    // purposes — we only need stable bucketing within ~1y).
    const weekKey = (ms) => {
      const d = new Date(ms);
      d.setHours(0, 0, 0, 0);
      const dow = (d.getDay() + 6) % 7; // Mon=0..Sun=6
      d.setDate(d.getDate() - dow);
      return dayKey(d.getTime());
    };
    const byDay = new Map();
    const byWeek = new Map();
    const ensureDay = (k) => {
      if (!byDay.has(k)) byDay.set(k, { day: k, cost: 0, sessions: 0, compacts: 0 });
      return byDay.get(k);
    };
    const ensureWeek = (k) => {
      if (!byWeek.has(k)) byWeek.set(k, { week: k, cost: 0, sessions: 0, compacts: 0 });
      return byWeek.get(k);
    };
    const sessionRows = db.prepare(`
      SELECT started_at AS t, total_cost_usd AS cost
      FROM sessions WHERE started_at >= ? ${projectClause}
    `).all(cutoff, ...projectArgs);
    for (const r of sessionRows) {
      const d = ensureDay(dayKey(r.t));
      d.sessions += 1;
      if (Number.isFinite(r.cost)) d.cost += r.cost;
      const w = ensureWeek(weekKey(r.t));
      w.sessions += 1;
      if (Number.isFinite(r.cost)) w.cost += r.cost;
    }
    const compactRows = db.prepare(`
      SELECT t, cost FROM compacts WHERE t >= ? ${projectClause}
    `).all(cutoff, ...projectArgs);
    for (const r of compactRows) {
      const d = ensureDay(dayKey(r.t));
      d.compacts += 1;
      const w = ensureWeek(weekKey(r.t));
      w.compacts += 1;
      // compact cost is already counted in session totals — don't double-add
    }
    // Fill day calendar gaps so the sparkline is honest about idle days.
    // Each entry also carries its share of the window's total spend.
    const totalCostInWindow = sessionRows.reduce(
      (s, r) => s + (Number.isFinite(r.cost) ? r.cost : 0), 0);
    const dailySeries = [];
    const now = new Date();
    for (let i = sinceDays - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const k = dayKey(d.getTime());
      const entry = byDay.get(k) || { day: k, cost: 0, sessions: 0, compacts: 0 };
      entry.pct = totalCostInWindow > 0 ? entry.cost / totalCostInWindow : 0;
      dailySeries.push(entry);
    }
    // Fill week gaps for the same window. Iterate forward from the Monday on
    // or before the cutoff so the bucket alignment is stable across runs.
    const weeklySeries = [];
    const cutoffMonday = (() => {
      const d = new Date(cutoff);
      d.setHours(0, 0, 0, 0);
      const dow = (d.getDay() + 6) % 7;
      d.setDate(d.getDate() - dow);
      return d;
    })();
    for (let cursor = new Date(cutoffMonday); cursor.getTime() <= now.getTime(); cursor.setDate(cursor.getDate() + 7)) {
      const k = weekKey(cursor.getTime());
      const entry = byWeek.get(k) || { week: k, cost: 0, sessions: 0, compacts: 0 };
      entry.pct = totalCostInWindow > 0 ? entry.cost / totalCostInWindow : 0;
      weeklySeries.push(entry);
    }
    // Week-over-week delta on cost (current vs prior). Prior of the very
    // first bucket is undefined → null, rendered as "—".
    for (let i = 0; i < weeklySeries.length; i++) {
      const prev = i > 0 ? weeklySeries[i - 1].cost : null;
      const cur = weeklySeries[i].cost;
      weeklySeries[i].wow = (prev === null || prev <= 0)
        ? null
        : (cur - prev) / prev;
    }

    // Per-project enrichment: sessions, cost, compacts, red-zone count, archive stats.
    // Joins through sid (not project name) because compacts/zone_transitions
    // historically stored the encoded directory slug while sessions store the
    // basename — direct project=project comparisons never matched.
    const perProject = project ? null : db.prepare(`
      SELECT s.project AS project,
             COUNT(DISTINCT s.sid) AS sessions,
             SUM(s.total_cost_usd) AS cost,
             AVG(s.peak_tokens)    AS avg_peak,
             (SELECT COUNT(*) FROM compacts c
                WHERE c.sid IN (SELECT sid FROM sessions WHERE project = s.project)
                  AND c.t >= ?) AS compacts,
             (SELECT COUNT(*) FROM zone_transitions z
                WHERE z.sid IN (SELECT sid FROM sessions WHERE project = s.project)
                  AND z.t >= ? AND z.to_zone = 'red') AS reds,
             (SELECT COUNT(*) FROM zone_transitions z
                WHERE z.sid IN (SELECT sid FROM sessions WHERE project = s.project)
                  AND z.t >= ?) AS crossings,
             (SELECT COUNT(*) FROM tool_archives ta
                WHERE ta.sid IN (SELECT sid FROM sessions WHERE project = s.project)
                  AND ta.t >= ?) AS archives,
             (SELECT SUM(recalled) FROM tool_archives ta
                WHERE ta.sid IN (SELECT sid FROM sessions WHERE project = s.project)
                  AND ta.t >= ?) AS archives_recalled
      FROM sessions s
      WHERE s.started_at >= ? AND s.project IS NOT NULL
      GROUP BY s.project ORDER BY cost DESC NULLS LAST, sessions DESC LIMIT 10
    `).all(cutoff, cutoff, cutoff, cutoff, cutoff, cutoff);

    // Recent compacts — same shape as listRecentCompacts but capped + project-scoped.
    const recentCompacts = db.prepare(`
      SELECT sid, project, t, tokens, cost, had_shift, trigger
      FROM compacts WHERE t >= ? ${projectClause}
      ORDER BY t DESC LIMIT 8
    `).all(cutoff, ...projectArgs);

    return {
      sessions, compacts, compactPercentiles, zones, archives,
      agents, agentTypes,
      topProjects: perProject, perProject, dailySeries, weeklySeries, recentCompacts,
      sinceDays, project,
    };
  } catch { return null; }
}

function listRecentCompacts({ limit = 20, project = null } = {}) {
  const db = openDb();
  if (!db) return [];
  try {
    const projectClause = project ? 'WHERE project = ?' : '';
    const args = project ? [project, limit] : [limit];
    return db.prepare(`
      SELECT sid, project, t, tokens, cost, cost_at_compact, had_shift, trigger
      FROM compacts ${projectClause}
      ORDER BY t DESC LIMIT ?
    `).all(...args);
  } catch { return []; }
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
  allToolArchiveKeys,
  deleteToolArchives,
  recordAgentInvocation,
  aggregateStats,
  listRecentCompacts,
  _setDbPathForTest,
  _resetForTest,
};
