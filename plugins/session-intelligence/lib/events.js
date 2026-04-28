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
  `);
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

function markArchiveRecalled(toolUseId) {
  const db = openDb();
  if (!db || !toolUseId) return false;
  try {
    db.prepare('UPDATE tool_archives SET recalled = recalled + 1 WHERE tool_use_id = ?').run(toolUseId);
    return true;
  } catch { return false; }
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
      SELECT COUNT(*) AS n, SUM(total_cost_usd) AS cost, AVG(peak_tokens) AS avg_peak
      FROM sessions WHERE started_at >= ? ${projectClause}
    `).get(cutoff, ...projectArgs);

    const compacts = db.prepare(`
      SELECT COUNT(*) AS n, AVG(tokens) AS avg_tokens, AVG(cost) AS avg_cost,
             SUM(had_shift) AS shifts
      FROM compacts WHERE t >= ? ${projectClause}
    `).get(cutoff, ...projectArgs);

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

    const topProjects = project ? null : db.prepare(`
      SELECT project, COUNT(*) AS sessions, SUM(total_cost_usd) AS cost
      FROM sessions WHERE started_at >= ? AND project IS NOT NULL
      GROUP BY project ORDER BY sessions DESC LIMIT 10
    `).all(cutoff);

    return { sessions, compacts, zones, archives, topProjects, sinceDays, project };
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
  aggregateStats,
  listRecentCompacts,
  _setDbPathForTest,
  _resetForTest,
};
