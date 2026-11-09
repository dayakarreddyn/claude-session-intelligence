'use strict';

/**
 * Session Intelligence — SQLite driver selection.
 *
 * better-sqlite3 ships a prebuilt native binary tied to one Node ABI
 * (NODE_MODULE_VERSION). Hooks run under whatever `node` the project directory
 * resolves to (mise / nvm / asdf), so a binary built for Node 20 refuses to
 * load in a directory pinned to Node 22 and the events store silently went
 * dark there. Node >= 22.13 ships `node:sqlite` built in; this module wraps it
 * in the small better-sqlite3-shaped surface lib/events.js uses and returns
 * whichever driver loads.
 *
 * Override with SI_SQLITE_DRIVER=better-sqlite3 | node:sqlite (default: auto,
 * better-sqlite3 first).
 */

const DRIVER_BETTER = 'better-sqlite3';
const DRIVER_NODE = 'node:sqlite';
const EXPERIMENTAL_SQLITE_RE = /SQLite/;
// better-sqlite3 opens with this busy timeout; node:sqlite opens with 0, which
// makes overlapping hook writes fail instantly instead of waiting.
const BUSY_TIMEOUT_MS = 5000;

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/** node:sqlite returns null-prototype rows; callers expect plain objects. */
function plainRow(row) {
  if (row && typeof row === 'object' && Object.getPrototypeOf(row) === null) {
    return { ...row };
  }
  return row;
}

function defaultLoadBetter() {
  return require('better-sqlite3');
}

/**
 * node:sqlite emits an ExperimentalWarning on first load. Hook stderr is SI's
 * user-visible channel, so the warning is filtered for the duration of the
 * require only; every other warning still reaches the default handler.
 */
function defaultLoadNode() {
  const original = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    const typeArg = typeof rest[0] === 'string' ? rest[0] : (rest[0] && rest[0].type);
    const name = (warning && warning.name) || typeArg;
    const message = String((warning && warning.message) || warning);
    if (name === 'ExperimentalWarning' && EXPERIMENTAL_SQLITE_RE.test(message)) return undefined;
    return original.call(process, warning, ...rest);
  };
  try {
    return require('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
}

class NodeSqliteStatement {
  constructor(statement) {
    this._statement = statement;
  }

  run(...params) {
    return this._statement.run(...params);
  }

  get(...params) {
    return plainRow(this._statement.get(...params));
  }

  all(...params) {
    return this._statement.all(...params).map(plainRow);
  }
}

/** better-sqlite3-compatible facade over node:sqlite's DatabaseSync. */
class NodeSqliteDatabase {
  constructor(DatabaseSync, dbPath) {
    this._db = new DatabaseSync(dbPath);
    this._db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    this._transactionDepth = 0;
  }

  prepare(sql) {
    return new NodeSqliteStatement(this._db.prepare(sql));
  }

  exec(sql) {
    this._db.exec(sql);
    return this;
  }

  pragma(statement, options = {}) {
    if (statement.includes('=')) {
      this._db.exec(`PRAGMA ${statement}`);
      return [];
    }
    const rows = this._db.prepare(`PRAGMA ${statement}`).all().map(plainRow);
    if (!options.simple) return rows;
    const first = rows[0];
    return first ? first[Object.keys(first)[0]] : undefined;
  }

  /** Nested calls use SAVEPOINTs, as better-sqlite3 does, so an inner failure
   *  rolls back only the inner work. */
  transaction(fn) {
    return (...args) => {
      const depth = this._transactionDepth;
      const savepoint = `si_sp_${depth}`;
      const begin = depth === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`;
      const commit = depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`;
      const rollback = depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`;
      this._db.exec(begin);
      this._transactionDepth = depth + 1;
      try {
        const result = fn(...args);
        this._db.exec(commit);
        return result;
      } catch (err) {
        try { this._db.exec(rollback); } catch { /* already rolled back */ }
        throw err;
      } finally {
        this._transactionDepth = depth;
      }
    };
  }

  close() {
    this._db.close();
  }
}

function resolvePreference(prefer) {
  const requested = String(prefer || process.env.SI_SQLITE_DRIVER || 'auto').trim();
  return requested === DRIVER_BETTER || requested === DRIVER_NODE ? requested : 'auto';
}

function noDriverError(failures) {
  return new Error(`no SQLite driver available: ${failures.join('; ')}`);
}

/**
 * Open `dbPath` with the first driver that loads.
 *
 * @param {string} dbPath
 * @param {{ prefer?: string, loadBetter?: Function, loadNode?: Function }} [options]
 *   `loadBetter` / `loadNode` exist for tests; they return the better-sqlite3
 *   constructor and the node:sqlite module respectively.
 * @returns {{ db: object, driver: string }}
 */
function openDatabase(dbPath, options = {}) {
  const prefer = resolvePreference(options.prefer);
  const loadBetter = options.loadBetter || defaultLoadBetter;
  const loadNode = options.loadNode || defaultLoadNode;
  const failures = [];

  if (prefer !== DRIVER_NODE) {
    try {
      const Better = loadBetter();
      return { db: new Better(dbPath), driver: DRIVER_BETTER };
    } catch (err) {
      failures.push(`${DRIVER_BETTER}: ${errorMessage(err)}`);
      if (prefer === DRIVER_BETTER) throw noDriverError(failures);
    }
  }

  try {
    const { DatabaseSync } = loadNode();
    return { db: new NodeSqliteDatabase(DatabaseSync, dbPath), driver: DRIVER_NODE };
  } catch (err) {
    failures.push(`${DRIVER_NODE}: ${errorMessage(err)}`);
  }

  throw noDriverError(failures);
}

module.exports = {
  openDatabase,
  DRIVER_BETTER,
  DRIVER_NODE,
};
