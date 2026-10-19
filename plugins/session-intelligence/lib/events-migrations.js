/**
 * Session Intelligence — events DB schema and migrations.
 *
 * Extracted from lib/events.js. Takes an open db handle; never opens one.
 */

'use strict';

const SCHEMA_VERSION = 3;

const GUARDED_ADD_COLUMNS = Object.freeze([
  "ALTER TABLE agent_invocations ADD COLUMN model TEXT",
  "ALTER TABLE agent_invocations ADD COLUMN input_tokens INTEGER",
  "ALTER TABLE agent_invocations ADD COLUMN output_tokens INTEGER",
  "ALTER TABLE agent_invocations ADD COLUMN cache_creation_tokens INTEGER",
  "ALTER TABLE agent_invocations ADD COLUMN cache_read_tokens INTEGER",
  "ALTER TABLE agent_invocations ADD COLUMN cost_usd REAL",
  "ALTER TABLE tool_archives ADD COLUMN pruned INTEGER DEFAULT 0",
]);

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
 *   tool_reruns       — same tool+input repeated within a short call window
 *   agent_invocations — Task tool calls (subagent runs) — type, sizes, duration
 */
function createTables(db) {
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

    CREATE TABLE IF NOT EXISTS tool_reruns (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      sid          TEXT NOT NULL,
      t            INTEGER NOT NULL,
      tool         TEXT,
      input_hash   TEXT,
      gap_calls    INTEGER,
      was_pruned   INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS tool_reruns_sid_idx ON tool_reruns(sid);

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

    CREATE TABLE IF NOT EXISTS session_model_costs (
      sid       TEXT NOT NULL,
      model     TEXT NOT NULL,
      cost_usd  REAL,
      t         INTEGER NOT NULL,
      PRIMARY KEY (sid, model)
    );
    CREATE INDEX IF NOT EXISTS session_model_costs_t_idx ON session_model_costs(t);
  `);
}

function getUserVersion(db) {
  return db.pragma('user_version', { simple: true }) || 0;
}

function addGuardedColumns(db) {
  // Wrapped in try/catch so existing rows aren't disturbed and a half-completed
  // ALTER doesn't crash the open. Each column is independently added.
  for (const sql of GUARDED_ADD_COLUMNS) {
    try { db.exec(sql); } catch { /* column already exists — expected */ }
  }
}

/**
 * Recompute agent_invocations.cost_usd from the current per-model price table.
 * Rows without a model or tokens are skipped. Returns the number of rows repriced.
 */
function repriceAgentInvocations(db) {
  const { priceForModel, costFromUsage } = require('./cost-estimation');
  const rows = db.prepare(`
    SELECT id, model, t, input_tokens, output_tokens,
           cache_creation_tokens, cache_read_tokens
    FROM agent_invocations
    WHERE model IS NOT NULL AND model != ''
      AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL)
  `).all();
  const upd = db.prepare('UPDATE agent_invocations SET cost_usd = ? WHERE id = ?');
  const reprice = db.transaction((all) => {
    for (const r of all) {
      const cost = costFromUsage({
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        cache_creation_input_tokens: r.cache_creation_tokens,
        cache_read_input_tokens: r.cache_read_tokens,
      }, priceForModel(r.model, r.t || Date.now()));
      upd.run(cost, r.id);
    }
  });
  reprice(rows);
  return rows.length;
}

// One-time project-key normalization (user_version 0 -> 1).
// Writers historically disagreed on the `project` value: sessions stored
// the repo-root basename, compacts stored the encoded projects-dir slug, and
// zone_transitions stored the cwd leaf. Backfill compacts + zone_transitions
// from the authoritative sessions.project via sid. Rows whose sid has no
// session (e.g. subagent `agent-*` ids) are left as-is.
function migrateV1(db) {
  db.exec(`
    UPDATE compacts SET project = (
      SELECT s.project FROM sessions s WHERE s.sid = compacts.sid
    ) WHERE EXISTS (
      SELECT 1 FROM sessions s WHERE s.sid = compacts.sid AND s.project IS NOT NULL
    );
    UPDATE zone_transitions SET project = (
      SELECT s.project FROM sessions s WHERE s.sid = zone_transitions.sid
    ) WHERE EXISTS (
      SELECT 1 FROM sessions s WHERE s.sid = zone_transitions.sid AND s.project IS NOT NULL
    );
  `);
}

// One-time cost reprice (user_version 1 -> 2): Opus 4.5+ bills at $5/$25 and
// the Claude 5 family fell through to the Opus default. Token counts are
// authoritative, so recompute cost_usd from the current per-model table.
function migrateV2(db) {
  repriceAgentInvocations(db);
}

// Fill columns (user_version 2 -> 3): the context window and fill percentage
// at the moment of each compact / zone crossing, plus the model and (for zone
// rows) the PostToolUse tool that fired the crossing. Old rows keep NULL.
const V3_COLUMNS = Object.freeze([
  ['compacts', 'context_cap', 'INTEGER'],
  ['compacts', 'fill_pct', 'REAL'],
  ['compacts', 'model', 'TEXT'],
  ['zone_transitions', 'context_cap', 'INTEGER'],
  ['zone_transitions', 'fill_pct', 'REAL'],
  ['zone_transitions', 'model', 'TEXT'],
  ['zone_transitions', 'trigger', 'TEXT'],
]);

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

// Probe before ALTER so each column is added exactly once. A real ALTER
// failure propagates so runMigrations leaves the version unadvanced.
function migrateV3(db) {
  for (const [table, column, type] of V3_COLUMNS) {
    if (!hasColumn(db, table, column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
}

const MIGRATIONS = Object.freeze([
  { version: 1, run: migrateV1 },
  { version: 2, run: migrateV2 },
  { version: 3, run: migrateV3 },
]);

/**
 * Run guarded ADD COLUMNs, then each pending migration in order. Each
 * migration is best-effort in its own try/catch: a failure leaves the version
 * unadvanced so it retries on the next open. Returns { from, to }.
 */
function runMigrations(db) {
  addGuardedColumns(db);
  const from = getUserVersion(db);
  for (const m of MIGRATIONS) {
    try {
      if (getUserVersion(db) < m.version) {
        m.run(db);
        db.pragma(`user_version = ${m.version}`);
      }
    } catch { /* best-effort — the sid-join read path / unpriced rows still work */ }
  }
  return { from, to: getUserVersion(db) };
}

function initSchema(db) {
  createTables(db);
  return runMigrations(db);
}

module.exports = {
  SCHEMA_VERSION,
  GUARDED_ADD_COLUMNS,
  MIGRATIONS,
  initSchema,
  runMigrations,
  repriceAgentInvocations,
};
