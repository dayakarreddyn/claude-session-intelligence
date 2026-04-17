/**
 * Compact history + adaptive zones + post-compact snapshot.
 *
 * Three responsibilities in one module because they're tightly coupled:
 *
 *   1. HISTORY (`~/.claude/logs/compact-history.jsonl`) — append-only record
 *      of every /compact the user has ever run, across sessions. Lets us
 *      learn their typical compact-at-tokens and dampen drop suggestions
 *      when past compacts caused regret.
 *
 *   2. ADAPTIVE ZONES — read recent history, compute a yellow/orange/red
 *      set that matches the user's own pattern rather than the static
 *      200k/300k/400k defaults. Bounded: we never stray more than ±30%
 *      from defaults so a degenerate history can't silence the warnings
 *      entirely.
 *
 *   3. SNAPSHOT (`/tmp/claude-compact-snapshot-<sid>.json`) — ephemeral,
 *      per-session. Written by pre-compact so token-budget-tracker can
 *      watch the first 30 post-compact tool calls and detect "regret"
 *      (re-touching a rootDir we marked DROP). Regret count gets stamped
 *      back into the history entry so future adaptive decisions know to
 *      be more conservative.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || os.homedir(),
  '.claude', 'logs',
);
const HISTORY_FILE = path.join(LOG_DIR, 'compact-history.jsonl');

const MAX_HISTORY_READ = 50;
const MAX_HISTORY_KEEP = 200;
const HISTORY_MAX_BYTES = 256 * 1024;

const MIN_SAMPLES_FOR_ADAPTIVE = 5;
const ADAPTIVE_BOUND = 0.3; // ±30% from static defaults
const REGRET_WINDOW_CALLS = 30;
const REGRET_WINDOW_MS = 30 * 60 * 1000; // 30 min

// ── History ──────────────────────────────────────────────────────────────

function ensureLogDir() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }
}

function appendHistory(entry) {
  if (!entry) return;
  ensureLogDir();
  try {
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n');
    const stat = fs.statSync(HISTORY_FILE);
    if (stat.size > HISTORY_MAX_BYTES) {
      const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
      if (lines.length > MAX_HISTORY_KEEP) {
        fs.writeFileSync(HISTORY_FILE, lines.slice(-MAX_HISTORY_KEEP).join('\n') + '\n');
      }
    }
  } catch { /* best effort — history is telemetry, not required for function */ }
}

function readHistory(limit = MAX_HISTORY_READ) {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
    return raw.split('\n').filter(Boolean).slice(-limit)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// ── Percentiles ──────────────────────────────────────────────────────────

function percentiles(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return { p50: at(0.5), p75: at(0.75), p90: at(0.9), count: sorted.length };
}

// ── Adaptive zones ───────────────────────────────────────────────────────

/**
 * Derive yellow/orange/red from recent compact history. Falls back to the
 * passed defaults when there aren't enough samples or the samples are
 * degenerate. The returned object is always in the same shape as `defaults`
 * plus a boolean `adaptive` flag so callers can tell it apart.
 *
 * Regret-rate dampening: if the user's recent compacts had high regret
 * (frequently touched dropped dirs post-compact), we PUSH the orange/red
 * thresholds out rather than pull them in — the signal is "I needed that
 * context", so suggest compaction less eagerly.
 */
function adaptiveZones(history, defaults) {
  const base = defaults || { yellow: 200000, orange: 300000, red: 400000 };
  if (!history || history.length < MIN_SAMPLES_FOR_ADAPTIVE) return { ...base, adaptive: false };

  const tokensAtCompact = history
    .map((h) => h.tokens)
    .filter((n) => Number.isFinite(n) && n > 0);
  if (tokensAtCompact.length < MIN_SAMPLES_FOR_ADAPTIVE) return { ...base, adaptive: false };

  const p = percentiles(tokensAtCompact);

  // Orange = P50 of user's compact points. This is "where they usually
  // pull the trigger". Clamp to ±30% from the static default to avoid
  // runaway drift from a single outlier session.
  const orangeTarget = Math.round(p.p50 * 0.9);
  const orangeMin = Math.round(base.orange * (1 - ADAPTIVE_BOUND));
  const orangeMax = Math.round(base.orange * (1 + ADAPTIVE_BOUND));
  let orange = Math.min(orangeMax, Math.max(orangeMin, orangeTarget));

  // Regret dampening — if recent compacts frequently caused regret, push
  // the threshold OUT so we warn later, giving the user more context budget.
  const recentRegret = history.slice(-10)
    .reduce((sum, h) => sum + (Number.isFinite(h.regretCount) ? h.regretCount : 0), 0);
  const totalCompacts = Math.min(10, history.length);
  const regretRate = totalCompacts > 0 ? recentRegret / totalCompacts : 0;
  if (regretRate >= 1) {
    orange = Math.min(orangeMax, Math.round(orange * 1.1));
  }

  // Yellow hugs orange; red gives headroom above P90.
  const yellow = Math.max(
    Math.round(base.yellow * (1 - ADAPTIVE_BOUND)),
    orange - 80000,
  );
  const red = Math.max(
    orange + 60000,
    Math.min(
      Math.round(base.red * (1 + ADAPTIVE_BOUND)),
      Math.round(p.p90 * 1.1),
    ),
  );

  return {
    yellow, orange, red,
    adaptive: true,
    sampleCount: p.count,
    p50: p.p50,
    p90: p.p90,
    regretRate: Number(regretRate.toFixed(2)),
  };
}

// ── Snapshot (per-session, ephemeral) ────────────────────────────────────

function snapshotPath(sessionId) {
  const sid = String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
  return path.join(os.tmpdir(), `claude-compact-snapshot-${sid}.json`);
}

function writeSnapshot(sessionId, data) {
  try {
    fs.writeFileSync(snapshotPath(sessionId), JSON.stringify(data));
  } catch { /* best effort */ }
}

function readSnapshot(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(snapshotPath(sessionId), 'utf8'));
  } catch { return null; }
}

function clearSnapshot(sessionId) {
  try { fs.rmSync(snapshotPath(sessionId), { force: true }); } catch { /* ignore */ }
}

/**
 * Called from token-budget-tracker after each PostToolUse. Returns
 * `{ regretHit, windowClosed }` so the caller can log appropriately. A
 * regret hit is when the tool call touched a rootDir that was in the
 * snapshot's dropped set. The window closes after N calls OR N minutes
 * since the compact — whichever first.
 */
function checkPostCompactRegret(sessionId, rootDir) {
  const snap = readSnapshot(sessionId);
  if (!snap) return { regretHit: false, windowClosed: true, snapshot: null };

  const now = Date.now();
  const age = now - (snap.t || 0);
  const calls = (snap.callsSince || 0) + 1;

  const windowClosed = calls > REGRET_WINDOW_CALLS || age > REGRET_WINDOW_MS;
  let regretHit = false;

  if (rootDir && Array.isArray(snap.droppedDirs) && snap.droppedDirs.includes(rootDir)) {
    regretHit = true;
    snap.regretHits = (snap.regretHits || []).concat([{ t: now, root: rootDir }]);
  }

  if (windowClosed) {
    // Upgrade the corresponding history entry with final regret count,
    // then clear the snapshot so it doesn't linger.
    upgradeHistoryRegret(snap);
    clearSnapshot(sessionId);
  } else {
    snap.callsSince = calls;
    writeSnapshot(sessionId, snap);
  }

  return { regretHit, windowClosed, snapshot: snap };
}

/**
 * Find the most recent history entry matching the snapshot's compact time
 * and rewrite it with the final regret count. Because the file is JSONL we
 * rewrite from a parsed array — the file is small (P50 a few KB), so this
 * is cheap enough for a once-per-compact update.
 */
function upgradeHistoryRegret(snap) {
  if (!snap || !Number.isFinite(snap.t)) return;
  const regretCount = (snap.regretHits || []).length;
  if (regretCount === 0) return; // nothing to upgrade
  try {
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
    const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
    // Walk backwards looking for the matching compact-time entry.
    for (let i = parsed.length - 1; i >= 0; i--) {
      if (parsed[i] && parsed[i].t === snap.t) {
        parsed[i].regretCount = regretCount;
        parsed[i].regretDirs = (snap.regretHits || []).map((h) => h.root);
        fs.writeFileSync(
          HISTORY_FILE,
          parsed.filter(Boolean).map((o) => JSON.stringify(o)).join('\n') + '\n',
        );
        return;
      }
    }
  } catch { /* best effort */ }
}

module.exports = {
  HISTORY_FILE,
  appendHistory,
  readHistory,
  percentiles,
  adaptiveZones,
  snapshotPath,
  writeSnapshot,
  readSnapshot,
  clearSnapshot,
  checkPostCompactRegret,
  _thresholds: {
    MIN_SAMPLES_FOR_ADAPTIVE,
    ADAPTIVE_BOUND,
    REGRET_WINDOW_CALLS,
    REGRET_WINDOW_MS,
  },
};
