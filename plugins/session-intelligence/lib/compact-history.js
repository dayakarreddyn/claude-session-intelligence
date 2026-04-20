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
const crypto = require('crypto');

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

// Soft regret (WARM-not-HOT dir touches post-compact) is a weaker signal than
// hard regret (DROP dir touches) — the user may have legitimately moved on
// from the warm dir or may have legitimately needed it again. Dampen the
// per-op weight so one soft regret ≪ one hard regret and a handful of soft
// regrets are needed before the signal rivals a single hard regret.
const SOFT_REGRET_DAMPEN = 0.5;

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
  //
  // Sums both hard regret (DROP touches) and soft regret (WARM touches).
  // softRegretCount is stamped pre-dampened (weight = raw * SOFT_REGRET_DAMPEN
  // at hit time), so we don't re-dampen here — just add it in. Soft signal
  // exists because users who compact early (median ~60k) rarely age dirs
  // to COLD, so hard regret alone systematically undercounts.
  const recentRegret = workingHistory.slice(-10)
    .reduce((sum, h) => {
      const hard = Number.isFinite(h.regretCount) ? h.regretCount : 0;
      const soft = Number.isFinite(h.softRegretCount) ? h.softRegretCount : 0;
      return sum + hard + soft;
    }, 0);
  const totalCompacts = Math.min(10, workingHistory.length);
  const regretRate = totalCompacts > 0 ? recentRegret / totalCompacts : 0;
  if (regretRate >= 1) {
    orange = Math.min(orangeMax, Math.round(orange * 1.1));
  }

  // Cost-band tightening — expensive sessions cost more to re-do than to
  // compact, so warn earlier when the running cost exceeds the user's own
  // p75. 12% tightening is empirically ~20-30k tokens on a 200-250k orange,
  // enough to nudge a /compact one "chunk of work" sooner without being
  // disruptive. Opposite-direction of regret-rate; both can apply.
  let costTightened = false;
  const currentCost = opts && Number.isFinite(opts.currentCost) ? opts.currentCost : null;
  if (currentCost !== null && currentCost > 0) {
    const costs = workingHistory
      .map((h) => h.cost)
      .filter((c) => Number.isFinite(c) && c > 0);
    if (costs.length >= MIN_SAMPLES_FOR_ADAPTIVE) {
      const cp = percentiles(costs);
      if (cp && currentCost > cp.p75) {
        orange = Math.max(orangeMin, Math.round(orange * 0.88));
        costTightened = true;
      }
    }
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
    costTightened,
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

// ── stablePrefix drift check ─────────────────────────────────────────────
// When `compact.stablePrefix` is enabled, the text SI emits on PreCompact
// is supposed to be byte-stable across compacts of the same working set —
// that's the whole point of the feature. If it silently mutates (e.g. a
// refactor leaked a timestamp or a call count into the "stable" path), the
// cache-hit promise breaks without any visible error. This helper fingerprints
// the emitted block per-cwd and warns when the fingerprint moves between
// compacts. Writes to /tmp so state is per-machine, never shipped.

const PREFIX_DIR = os.tmpdir();

function prefixHashPath(cwdKey) {
  const safe = crypto.createHash('sha256').update(String(cwdKey || 'default')).digest('hex').slice(0, 16);
  return path.join(PREFIX_DIR, `claude-compact-prefix-${safe}.json`);
}

// Session-context's "Current Task" / "Key Files" sections are auto-filled
// from HEAD by the bootstrap hook and mutate on every commit. They're
// marked with a `<!-- si:autofill sha=<HEAD> -->` sentinel. Hashing them
// as-is guarantees drift between any two compacts that cross a commit —
// which is almost every compact. Strip the autofill block (sentinel +
// the following body until a blank line or next `## ` heading) so the
// drift check only fires on content that's supposed to be stable.
function normalizePrefixForHash(text) {
  if (!text) return '';
  const lines = String(text).split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (/<!--\s*si:autofill\s+sha=[0-9a-f]+\s*-->/i.test(line)) {
      out.push('<!-- si:autofill -->');
      skipping = true;
      continue;
    }
    if (skipping) {
      if (line.trim() === '' || /^##\s/.test(line)) {
        skipping = false;
        out.push(line);
        continue;
      }
      continue; // drop autofilled body from hash input
    }
    out.push(line);
  }
  return out.join('\n');
}

// Produce the first few line-level differences so drift warnings point at
// the actual mutation site instead of just hash mismatches. Truncates each
// side to 120 chars so a leaked blob doesn't flood the intel log.
function firstDiffLines(prevText, newText, maxLines = 3) {
  const a = String(prevText || '').split('\n');
  const b = String(newText || '').split('\n');
  const diffs = [];
  const max = Math.max(a.length, b.length);
  const trim = (s) => (s === undefined ? null : s.slice(0, 120));
  for (let i = 0; i < max && diffs.length < maxLines; i++) {
    if (a[i] !== b[i]) {
      diffs.push({ line: i + 1, prev: trim(a[i]), next: trim(b[i]) });
    }
  }
  return diffs.length ? diffs : null;
}

/**
 * Hash the stable-prefix text, compare to the prior recorded hash for this
 * cwd, and record the new hash. Returns:
 *   - { drifted: false, firstRun: true, newHash } when there's no prior
 *   - { drifted: false, newHash } when hash matches the prior
 *   - { drifted: true, prevHash, newHash, ageSec, diff } when it changed
 *
 * The hash input is normalized to strip autofill blocks — see
 * `normalizePrefixForHash`. Prior normalized text is persisted so drift
 * warnings can include a concrete line-level diff preview.
 */
function compareStablePrefixHash(cwdKey, prefixText) {
  const normalized = normalizePrefixForHash(prefixText);
  const newHash = crypto.createHash('sha256').update(normalized).digest('hex');
  const p = prefixHashPath(cwdKey);
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { /* first run or corrupt */ }
  const now = Date.now();
  try {
    fs.writeFileSync(p, JSON.stringify({ hash: newHash, text: normalized, t: now }));
  } catch { /* best effort */ }
  if (!prev || typeof prev.hash !== 'string') {
    return { drifted: false, firstRun: true, newHash };
  }
  if (prev.hash === newHash) {
    return { drifted: false, newHash };
  }
  const ageSec = Number.isFinite(prev.t) ? Math.round((now - prev.t) / 1000) : null;
  const diff = firstDiffLines(prev.text, normalized);
  return { drifted: true, prevHash: prev.hash, newHash, ageSec, diff };
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
 * `{ regretHit, softRegretHit, positiveHit, windowClosed, weight }` so the
 * caller can log appropriately. Three classifications run against the same
 * snapshot, in priority order (DROP > HOT > WARM):
 *
 *   - regret: tool call touched a rootDir the pre-compact analysis marked
 *     as DROP. Weight by operation type (Read=1.0, Edit=0.3, cleanup=0.1).
 *   - positive: tool call touched a rootDir marked HOT. Counts as "compact
 *     freed attention for the stuff we flagged as important" — the Q5
 *     good-compact signal. Same op-type weights as regret.
 *   - softRegret: tool call touched a WARM rootDir (mid-recency, NOT in
 *     hotDirs and NOT in droppedDirs). Weaker signal than hard regret —
 *     the user compacted before WARM dirs aged to COLD, so we can't know
 *     whether we would have dropped them. Dampened by SOFT_REGRET_DAMPEN.
 *     Fixes the Q1 "nothing to regret" blocker: droppedDirs is empty on
 *     most sessions because users compact at median ~60k tokens before
 *     dirs age COLD, so hard regret never fires.
 *
 * The window closes after N calls OR N minutes since the compact. On
 * close, `upgradeHistoryRegret` stamps regretCount, softRegretCount, and
 * continuationQuality back onto the history entry.
 */
function checkPostCompactRegret(sessionId, rootDir, opts) {
  const snap = readSnapshot(sessionId);
  if (!snap) {
    return {
      regretHit: false, softRegretHit: false, positiveHit: false,
      windowClosed: true, snapshot: null, weight: 0,
    };
  }

  const now = Date.now();
  const age = now - (snap.t || 0);
  const calls = (snap.callsSince || 0) + 1;

  const windowClosed = calls > REGRET_WINDOW_CALLS || age > REGRET_WINDOW_MS;
  let regretHit = false;
  let softRegretHit = false;
  let positiveHit = false;
  let weight = 0;

  const toolName = opts && opts.toolName;
  const toolInput = opts && opts.toolInput;

  if (rootDir && Array.isArray(snap.droppedDirs) && snap.droppedDirs.includes(rootDir)) {
    weight = regretWeightFor(toolName, toolInput);
    if (weight > 0) {
      regretHit = true;
      snap.regretHits = (snap.regretHits || []).concat([
        { t: now, root: rootDir, tool: toolName || null, weight },
      ]);
    }
  } else if (rootDir && Array.isArray(snap.hotDirs) && snap.hotDirs.includes(rootDir)) {
    // Positive hit: same weight scheme. A Read in a HOT dir post-compact
    // means the user is doing the work the compact said to focus on.
    weight = regretWeightFor(toolName, toolInput);
    if (weight > 0) {
      positiveHit = true;
      snap.positiveHits = (snap.positiveHits || []).concat([
        { t: now, root: rootDir, tool: toolName || null, weight },
      ]);
    }
  } else if (rootDir && Array.isArray(snap.warmDirs) && snap.warmDirs.includes(rootDir)) {
    // Soft regret: WARM-only touch. Dampened because WARM is a classification
    // we made without knowing where the dir was headed — it might have aged
    // COLD (hard regret) or stayed HOT (positive) if the user hadn't compacted.
    const raw = regretWeightFor(toolName, toolInput);
    weight = raw * SOFT_REGRET_DAMPEN;
    if (weight > 0) {
      softRegretHit = true;
      snap.softRegretHits = (snap.softRegretHits || []).concat([
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

  return { regretHit, softRegretHit, positiveHit, windowClosed, snapshot: snap, weight };
}

/**
 * Find the most recent history entry matching the snapshot's compact time
 * and stamp the post-compact verdict: weighted regretCount AND a
 * continuationQuality score derived from positive vs regret hits.
 *
 * continuationQuality = (positiveWeight − regretWeight) / (positiveWeight
 * + regretWeight). Range [-1, 1]. +1 = all work landed in HOT dirs,
 * none in DROP; -1 = all in DROP. null when neither side fired (empty
 * window — indistinguishable from "user did nothing after compact").
 */
function upgradeHistoryRegret(snap) {
  if (!snap || !Number.isFinite(snap.t)) return;
  const regrets = snap.regretHits || [];
  const positives = snap.positiveHits || [];
  const softRegrets = snap.softRegretHits || [];
  if (regrets.length === 0 && positives.length === 0 && softRegrets.length === 0) {
    return; // nothing to stamp
  }
  // regretCount is a weighted sum. Older entries stored integer counts
  // — adaptiveZones() treats both uniformly because it only checks
  // Number.isFinite and compares to the 1.0 threshold, which is the same
  // "one Read-worth of regret per compact" bar in either scheme.
  const sumWeights = (arr) => arr.reduce(
    (sum, h) => sum + (Number.isFinite(h.weight) ? h.weight : 1), 0);
  const regretWeight = sumWeights(regrets);
  const positiveWeight = sumWeights(positives);
  const softRegretWeight = sumWeights(softRegrets);
  // Soft regret feeds adaptiveZones (summed into regretRate alongside hard
  // regret) but still NOT into continuationQuality — that score is an
  // intent-proxy ("did compact focus attention on the right dirs?"), and
  // WARM touches are too noisy to say yes/no on that question. Keep it
  // out until per-repo data tells us it's high-signal.
  const denom = positiveWeight + regretWeight;
  const continuationQuality = denom > 0
    ? Number(((positiveWeight - regretWeight) / denom).toFixed(2))
    : null;
  try {
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
    const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
    for (let i = parsed.length - 1; i >= 0; i--) {
      if (parsed[i] && parsed[i].t === snap.t) {
        parsed[i].regretCount = Number(regretWeight.toFixed(2));
        parsed[i].regretHits = regrets.length;
        parsed[i].regretDirs = regrets.map((h) => h.root);
        parsed[i].positiveHits = positives.length;
        parsed[i].positiveWeight = Number(positiveWeight.toFixed(2));
        if (softRegrets.length > 0) {
          parsed[i].softRegretCount = Number(softRegretWeight.toFixed(2));
          parsed[i].softRegretHits = softRegrets.length;
          parsed[i].softRegretDirs = softRegrets.map((h) => h.root);
        }
        if (continuationQuality !== null) {
          parsed[i].continuationQuality = continuationQuality;
        }
        // Cache-hit telemetry measured by token-budget from the first
        // post-compact assistant turn. Validates whether stablePrefix is
        // actually getting served from cache — the "verbose metrics for
        // −90% read cost" trade only makes sense if the cache hits.
        if (Number.isFinite(snap.postCompactCacheHitRatio)) {
          parsed[i].postCompactCacheHitRatio = snap.postCompactCacheHitRatio;
          parsed[i].postCompactCacheRead = snap.postCompactCacheRead || 0;
          parsed[i].postCompactCacheCreation = snap.postCompactCacheCreation || 0;
        }
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
  compareStablePrefixHash,
  normalizePrefixForHash,
  prefixHashPath,
  _thresholds: {
    MIN_SAMPLES_FOR_ADAPTIVE,
    ADAPTIVE_BOUND,
    REGRET_WINDOW_CALLS,
    REGRET_WINDOW_MS,
    ANNOUNCE_MIN_DELTA,
    REGRET_WEIGHTS,
    SOFT_REGRET_DAMPEN,
  },
};
