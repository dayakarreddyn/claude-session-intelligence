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

// Per-operation regret weights. Touching a dropped rootDir with a Read is a
// genuine "I lost context, going back for it" signal — weight 1.0. An Edit
// or Write is natural follow-up work after a compact (implementing the
// summarised plan) — weight 0.3. A Bash `git add`/`git commit` inside a
// dropped dir is cleanup — weight 0.1. Weights are read at check time, so
// adjusting them doesn't require a history rewrite.
const REGRET_WEIGHTS = {
  Read: 1.0,
  Grep: 0.7,
  Glob: 0.7,
  Edit: 0.3,
  Write: 0.3,
  NotebookEdit: 0.3,
  Bash: 0.5,
  default: 0.5,
};
const BASH_CLEANUP_PREFIXES = /^\s*git\s+(add|commit|push|status|diff|log)\b|^\s*gh\s+pr\b/;

function regretWeightFor(toolName, toolInput) {
  if (toolName === 'Bash') {
    const cmd = (toolInput && toolInput.command) || '';
    if (typeof cmd === 'string' && BASH_CLEANUP_PREFIXES.test(cmd)) return 0.1;
    return REGRET_WEIGHTS.Bash;
  }
  if (toolName && Object.prototype.hasOwnProperty.call(REGRET_WEIGHTS, toolName)) {
    return REGRET_WEIGHTS[toolName];
  }
  return REGRET_WEIGHTS.default;
}

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
 *
 * Per-cwd bucketing: when `opts.cwd` is passed and the cwd has ≥5 entries
 * of its own, derive from that subset instead of mixing repos. Falls back
 * to the full history otherwise so a new repo still benefits from global
 * learning. Result carries `bucket: 'cwd' | 'global'` for caller logging.
 */
function adaptiveZones(history, defaults, opts) {
  const base = defaults || { yellow: 200000, orange: 300000, red: 400000 };
  const cwd = opts && typeof opts.cwd === 'string' ? opts.cwd : null;

  let bucket = 'global';
  let workingHistory = history;
  if (cwd && Array.isArray(history)) {
    const sameCwd = history.filter((h) => h && h.cwd === cwd);
    if (sameCwd.length >= MIN_SAMPLES_FOR_ADAPTIVE) {
      workingHistory = sameCwd;
      bucket = 'cwd';
    }
  }

  if (!workingHistory || workingHistory.length < MIN_SAMPLES_FOR_ADAPTIVE) {
    return { ...base, adaptive: false, bucket };
  }

  const tokensAtCompact = workingHistory
    .map((h) => h.tokens)
    .filter((n) => Number.isFinite(n) && n > 0);
  if (tokensAtCompact.length < MIN_SAMPLES_FOR_ADAPTIVE) {
    return { ...base, adaptive: false, bucket };
  }

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
  // Use the bucketed history so per-cwd regret doesn't get diluted by other
  // repos' patterns.
  const recentRegret = workingHistory.slice(-10)
    .reduce((sum, h) => sum + (Number.isFinite(h.regretCount) ? h.regretCount : 0), 0);
  const totalCompacts = Math.min(10, workingHistory.length);
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
    bucket,
    sampleCount: p.count,
    p50: p.p50,
    p90: p.p90,
    regretRate: Number(regretRate.toFixed(2)),
  };
}

// ── Announce-on-shift (opt-in) ───────────────────────────────────────────
// Keyed by cwd so per-repo zones announce independently. Announces only
// when the current adaptive zones differ materially from what was last
// shown to the user — "material" = any zone moved by ≥10k tokens. The
// caller sets learn.announce=true in config to opt in.

const ANNOUNCE_FILE = path.join(LOG_DIR, 'adaptive-zones-announced.json');
const ANNOUNCE_MIN_DELTA = 10000;

function readAnnounceState() {
  try { return JSON.parse(fs.readFileSync(ANNOUNCE_FILE, 'utf8')) || {}; }
  catch { return {}; }
}

function writeAnnounceState(state) {
  ensureLogDir();
  try { fs.writeFileSync(ANNOUNCE_FILE, JSON.stringify(state) + '\n'); }
  catch { /* best effort */ }
}

/**
 * Compare current adaptive zones to the last-announced set for this cwd.
 * Returns a short human-readable line when there's a material shift (or
 * no prior announcement). Returns '' when zones are unchanged / static.
 * Side effect: updates the announce state file so the same shift isn't
 * announced twice.
 */
function announceAdaptiveShift(zones, cwd) {
  if (!zones || !zones.adaptive) return '';
  const key = String(cwd || 'default');
  const state = readAnnounceState();
  const prev = state[key];

  const changed = !prev
    || Math.abs((prev.yellow || 0) - zones.yellow) >= ANNOUNCE_MIN_DELTA
    || Math.abs((prev.orange || 0) - zones.orange) >= ANNOUNCE_MIN_DELTA
    || Math.abs((prev.red || 0) - zones.red) >= ANNOUNCE_MIN_DELTA;
  if (!changed) return '';

  const fmt = (n) => n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
  const bucket = zones.bucket === 'cwd' ? ' (this repo)' : ' (all repos)';
  let msg;
  if (!prev) {
    msg = `Adaptive zones engaged${bucket}: yellow=${fmt(zones.yellow)}, orange=${fmt(zones.orange)}, red=${fmt(zones.red)} from ${zones.sampleCount} past compacts.`;
  } else {
    msg = `Zones shifted${bucket}: orange ${fmt(prev.orange)}→${fmt(zones.orange)}, red ${fmt(prev.red)}→${fmt(zones.red)} (${zones.sampleCount} compacts).`;
  }

  state[key] = {
    yellow: zones.yellow, orange: zones.orange, red: zones.red,
    sampleCount: zones.sampleCount, t: Date.now(),
  };
  writeAnnounceState(state);
  return msg;
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
 * `{ regretHit, windowClosed, weight }` so the caller can log appropriately.
 * A regret hit is when the tool call touched a rootDir that was in the
 * snapshot's dropped set. The window closes after N calls OR N minutes
 * since the compact — whichever first.
 *
 * `opts.toolName` and `opts.toolInput` let us weight the hit by operation
 * type: a Read on a dropped dir is full regret (1.0); an Edit is partial
 * (0.3, natural follow-up); a `git add` inside it is cleanup (0.1).
 */
function checkPostCompactRegret(sessionId, rootDir, opts) {
  const snap = readSnapshot(sessionId);
  if (!snap) return { regretHit: false, windowClosed: true, snapshot: null, weight: 0 };

  const now = Date.now();
  const age = now - (snap.t || 0);
  const calls = (snap.callsSince || 0) + 1;

  const windowClosed = calls > REGRET_WINDOW_CALLS || age > REGRET_WINDOW_MS;
  let regretHit = false;
  let weight = 0;

  if (rootDir && Array.isArray(snap.droppedDirs) && snap.droppedDirs.includes(rootDir)) {
    const toolName = opts && opts.toolName;
    const toolInput = opts && opts.toolInput;
    weight = regretWeightFor(toolName, toolInput);
    if (weight > 0) {
      regretHit = true;
      snap.regretHits = (snap.regretHits || []).concat([
        { t: now, root: rootDir, tool: toolName || null, weight },
      ]);
    }
  }

  if (windowClosed) {
    upgradeHistoryRegret(snap);
    clearSnapshot(sessionId);
  } else {
    snap.callsSince = calls;
    writeSnapshot(sessionId, snap);
  }

  return { regretHit, windowClosed, snapshot: snap, weight };
}

/**
 * Find the most recent history entry matching the snapshot's compact time
 * and rewrite it with the final regret count. Because the file is JSONL we
 * rewrite from a parsed array — the file is small (P50 a few KB), so this
 * is cheap enough for a once-per-compact update.
 */
function upgradeHistoryRegret(snap) {
  if (!snap || !Number.isFinite(snap.t)) return;
  const hits = snap.regretHits || [];
  if (hits.length === 0) return; // nothing to upgrade
  // regretCount is now a weighted sum. Older entries stored integer counts
  // — adaptiveZones() treats both uniformly because it only checks Number
  // .isFinite and compares to the 1.0 threshold, which is the same "one
  // Read-worth of regret per compact" bar in either scheme.
  const weightedCount = hits.reduce(
    (sum, h) => sum + (Number.isFinite(h.weight) ? h.weight : 1),
    0,
  );
  try {
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
    const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
    for (let i = parsed.length - 1; i >= 0; i--) {
      if (parsed[i] && parsed[i].t === snap.t) {
        parsed[i].regretCount = Number(weightedCount.toFixed(2));
        parsed[i].regretHits = hits.length;
        parsed[i].regretDirs = hits.map((h) => h.root);
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
  announceAdaptiveShift,
  snapshotPath,
  writeSnapshot,
  readSnapshot,
  clearSnapshot,
  checkPostCompactRegret,
  regretWeightFor,
  _thresholds: {
    MIN_SAMPLES_FOR_ADAPTIVE,
    ADAPTIVE_BOUND,
    REGRET_WINDOW_CALLS,
    REGRET_WINDOW_MS,
    ANNOUNCE_MIN_DELTA,
    REGRET_WEIGHTS,
  },
};
