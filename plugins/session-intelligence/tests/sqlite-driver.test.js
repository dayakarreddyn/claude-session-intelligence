/**
 * Tests for lib/sqlite-driver — picks better-sqlite3 when its native binary
 * loads, and falls back to Node's built-in node:sqlite when it does not
 * (typically a NODE_MODULE_VERSION mismatch: the prebuilt binary targets one
 * Node ABI, the project directory pins another via mise/nvm).
 *
 * Selection logic is tested with injected loaders so it runs on every Node.
 * Adapter behaviour is tested against the real node:sqlite and skipped where
 * the runtime has none (Node < 22.13).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const driver = require('../lib/sqlite-driver');

// Probe through the driver so the ExperimentalWarning filter applies; a bare
// require('node:sqlite') here would print the warning into the TAP stream.
const hasNodeSqlite = (() => {
  try { driver.openDatabase(':memory:', { prefer: 'node:sqlite' }).db.close(); return true; } catch { return false; }
})();

function abiError() {
  const err = new Error(
    "The module 'better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 115. This version of Node.js requires NODE_MODULE_VERSION 127.",
  );
  err.code = 'ERR_DLOPEN_FAILED';
  return err;
}

// Minimal stand-in for node:sqlite's DatabaseSync, used only to observe
// which driver the selector picked on runtimes that lack node:sqlite.
class StubDatabaseSync {
  constructor(p) { this.path = p; this.closed = false; }
  exec() {}
  prepare() { return { run() { return { changes: 0 }; }, get() { return undefined; }, all() { return []; } }; }
  close() { this.closed = true; }
}

test('falls back to node:sqlite when better-sqlite3 fails with an ABI mismatch', () => {
  const opened = driver.openDatabase('/tmp/si-driver-test.db', {
    prefer: 'auto',
    loadBetter: () => { throw abiError(); },
    loadNode: () => ({ DatabaseSync: StubDatabaseSync }),
  });
  assert.equal(opened.driver, 'node:sqlite');
  assert.equal(typeof opened.db.prepare, 'function');
  assert.equal(typeof opened.db.pragma, 'function');
  assert.equal(typeof opened.db.transaction, 'function');
  opened.db.close();
});

test('prefers better-sqlite3 when it loads', () => {
  let nodeLoaded = false;
  class BetterStub { constructor(p) { this.path = p; } close() {} }
  const opened = driver.openDatabase('/tmp/si-driver-test.db', {
    prefer: 'auto',
    loadBetter: () => BetterStub,
    loadNode: () => { nodeLoaded = true; return { DatabaseSync: StubDatabaseSync }; },
  });
  assert.equal(opened.driver, 'better-sqlite3');
  assert.ok(opened.db instanceof BetterStub);
  assert.equal(nodeLoaded, false, 'node:sqlite must not be touched when better-sqlite3 works');
});

test('SI_SQLITE_DRIVER=node:sqlite skips better-sqlite3 entirely', () => {
  let betterLoaded = false;
  const opened = driver.openDatabase('/tmp/si-driver-test.db', {
    prefer: 'node:sqlite',
    loadBetter: () => { betterLoaded = true; return class {}; },
    loadNode: () => ({ DatabaseSync: StubDatabaseSync }),
  });
  assert.equal(opened.driver, 'node:sqlite');
  assert.equal(betterLoaded, false);
});

test('throws one error naming both failures when neither driver loads', () => {
  assert.throws(
    () => driver.openDatabase('/tmp/si-driver-test.db', {
      prefer: 'auto',
      loadBetter: () => { throw abiError(); },
      loadNode: () => { throw new Error("Cannot find module 'node:sqlite'"); },
    }),
    (err) => /NODE_MODULE_VERSION/.test(err.message) && /node:sqlite/.test(err.message),
  );
});

test('node:sqlite adapter mirrors the better-sqlite3 surface events.js uses', { skip: !hasNodeSqlite }, () => {
  const { db, driver: name } = driver.openDatabase(':memory:', { prefer: 'node:sqlite' });
  assert.equal(name, 'node:sqlite');

  // pragma: set form (contains '=') and read form, including { simple: true }
  db.pragma('journal_mode = MEMORY');
  db.pragma('user_version = 7');
  assert.equal(db.pragma('user_version', { simple: true }), 7);
  assert.deepEqual(db.pragma('user_version'), [{ user_version: 7 }]);

  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
  const ins = db.prepare('INSERT INTO t (name) VALUES (?)');
  assert.equal(ins.run('a').changes, 1);
  ins.run('b');
  assert.deepEqual(db.prepare('SELECT name FROM t ORDER BY id').all().map((r) => r.name), ['a', 'b']);
  assert.equal(db.prepare('SELECT name FROM t WHERE id = ?').get(2).name, 'b');
  assert.equal(db.prepare('SELECT name FROM t WHERE id = ?').get(99), undefined);

  // transaction: commits on success, rolls back when the body throws
  const addMany = db.transaction((names) => { for (const n of names) ins.run(n); return names.length; });
  assert.equal(addMany(['c', 'd']), 2);
  assert.throws(() => db.transaction(() => { ins.run('e'); throw new Error('boom'); })());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get().n, 4);

  db.close();
});

test('loading node:sqlite does not print the ExperimentalWarning to stderr', { skip: !hasNodeSqlite }, () => {
  const mod = path.join(__dirname, '..', 'lib', 'sqlite-driver.js');
  const r = spawnSync(process.execPath, ['-e', `
    const d = require(${JSON.stringify(mod)});
    const { db } = d.openDatabase(':memory:', { prefer: 'node:sqlite' });
    db.exec('SELECT 1'); db.close();
  `], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '', 'hook stderr must stay clean — SI nudges ride on stderr');
});

test('file-backed facade waits out a lock held by another process instead of failing at once', { skip: !hasNodeSqlite }, () => {
  // better-sqlite3 opens with a 5 s busy timeout; node:sqlite opens with 0.
  // Parallel hooks (teammate launch storms) overlap their writes, and the
  // events module swallows write errors, so a 0 timeout drops events silently.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-driver-lock-'));
  const dbPath = path.join(dir, 'lock.db');
  const sentinel = path.join(dir, 'locked');
  const mod = path.join(__dirname, '..', 'lib', 'sqlite-driver.js');
  let holder;
  try {
    const { db } = driver.openDatabase(dbPath, { prefer: 'node:sqlite' });
    db.exec('CREATE TABLE t (v INTEGER)');

    holder = spawn(process.execPath, ['-e', `
      const { openDatabase } = require(${JSON.stringify(mod)});
      const { db } = openDatabase(${JSON.stringify(dbPath)}, { prefer: 'node:sqlite' });
      db.exec('BEGIN IMMEDIATE');
      db.prepare('INSERT INTO t VALUES (1)').run();
      require('fs').writeFileSync(${JSON.stringify(sentinel)}, '1');
      const until = Date.now() + 400; while (Date.now() < until) { /* hold the write lock */ }
      db.exec('COMMIT'); db.close();
    `], { stdio: 'ignore' });

    const deadline = Date.now() + 5000;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(sentinel) && Date.now() < deadline) Atomics.wait(pause, 0, 0, 10);
    assert.ok(fs.existsSync(sentinel), 'lock holder never started');

    const started = Date.now();
    db.prepare('INSERT INTO t VALUES (2)').run(); // must wait for the holder, not throw
    assert.ok(Date.now() - started >= 50, 'write returned without waiting for the lock');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get().n, 2);
    db.close();
  } finally {
    if (holder) holder.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('nested transaction rolls back only the inner work when the outer catches', { skip: !hasNodeSqlite }, () => {
  // better-sqlite3 nests via SAVEPOINT; an inner failure must not leak its
  // partial writes into the outer transaction.
  const { db } = driver.openDatabase(':memory:', { prefer: 'node:sqlite' });
  db.exec('CREATE TABLE t (v INTEGER)');
  const ins = db.prepare('INSERT INTO t VALUES (?)');
  const inner = db.transaction(() => { ins.run(2); throw new Error('inner failed'); });
  const outer = db.transaction(() => {
    ins.run(1);
    try { inner(); } catch { /* outer carries on */ }
    ins.run(3);
  });
  outer();
  assert.deepEqual(db.prepare('SELECT v FROM t ORDER BY v').all().map((r) => r.v), [1, 3]);
  db.close();
});
