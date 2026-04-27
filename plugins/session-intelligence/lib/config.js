/**
 * Session Intelligence — unified config loader.
 *
 * Reads ~/.claude/session-intelligence.json and merges with defaults. All
 * hooks + statusline go through this so users have one file to edit instead
 * of remembering env vars.
 *
 * Env vars still win as an override for per-session tuning / CI. Legacy
 * ~/.claude/statusline-intel.json is also honoured so existing installs
 * don't break.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Preset shapes for `statusline.preset`. Using a preset is a shortcut that
// sets `fields` without losing the ability to override individual fields —
// if the user sets `statusline.fields` explicitly the preset is ignored.
//
// No emoji / emoji2 in presets: one colour, one signal. The bar is there to
// warn about context pressure; everything else is context FOR that signal.
// Emoji renderers remain in the codebase for users who still want them, but
// default output stays typography-only. See README "Statusline palette".
const STATUSLINE_PRESETS = {
  minimal:  ['tokens'],
  standard: ['model', 'project', 'tokens', 'newline', 'task'],
  // Single-line layout for Claude Code setups that only render one status row
  // (older builds, tight terminals, or specific rendering modes). Packs the
  // highest-signal fields into one bar — zone, compact age, spend, identity,
  // task — at the cost of losing token-flow + cache metrics.
  oneline: [
    'tokens', 'compactAge', 'compactCost', 'model', 'project', 'branch', 'task',
  ],
  // 4-line layout:
  //   Line 1: zone bar · compactAge · compactCost · contextPct — colour-
  //           escalating warning row. contextPct replaces the ccstatusline
  //           `93.0%` signal so we can retire the 1.5s npx spend.
  //   Line 2: session activity + token economics — live "what's happening
  //           right now" row at eye level, just below the warning bar.
  //   Line 3: quota + cwd — Claude Code 5h / 7d usage plus working dir.
  //           Data comes from the cached usage API (180 s TTL, refreshed
  //           by a detached worker so the hot path never blocks on HTTPS).
  //   Line 4: identity / repo / task — dim reference context at the bottom.
  verbose:  [
    'tokens', 'compactAge', 'compactCost', 'cacheHit', 'siHealth',
    'newline',
    'session', 'blockUsage', 'sessionId', 'costSaved', 'tools', 'tokenFlow',
    'newline',
    'branch', 'diffstat', 'cwd', 'activeRoot',
    'newline',
    'model', 'weekUsage', 'outputStyle', 'thinking', 'task',
  ],
  // Token-economics focus — same 4-line skeleton, adds cacheTokens.
  'verbose-cache':  [
    'tokens', 'compactAge', 'compactCost',
    'newline',
    'session', 'sessionId', 'tools', 'costSaved', 'tokenFlow', 'cacheHit', 'cacheTokens',
    'newline',
    'weekUsage', 'blockUsage', 'cwd',
    'newline',
    'model', 'project', 'task',
  ],
};

const DEFAULTS = {
  statusline: {
    // `verbose` is the historical default; empty preset means "follow `fields`
    // exactly as written below." Users can set preset: "minimal" to collapse
    // the line without hand-maintaining the array.
    preset: 'verbose',
    fields: STATUSLINE_PRESETS.verbose.slice(),
    tokenSource: 'auto',
    zones: { yellow: 200000, orange: 300000, red: 400000 },
    maxTaskLength: 40,
    // Middle-truncate the `branch` field at this length so long names like
    // `feat/some-very-long-feature-slug` don't push the last status row past
    // the terminal width and disappear after a resize. Clamp >5 at read time.
    maxBranchLength: 28,
    // cwd field — full path, middle-truncated when it exceeds maxCwdLength.
    // Clamp >8 at read time. `~` is substituted for $HOME before truncation.
    maxCwdLength: 36,
    // activeRoot field — middle-truncated when longer. Clamp >6 at read time.
    maxActiveRootLength: 30,
    // tokens field — bar segment count. Trade-off: longer bar shows finer
    // gradient but eats line width. Clamp [8, 40] at render time.
    maxBarSegments: 14,
    separator: ' · ',
    colors: true,
    serviceHealth: [],
    prices: { input: 15, cache_creation: 18.75, cache_read: 1.5, output: 75 },
    // Minimum recent-thinking tokens to render the `thinking` field. Below
    // this it is noise; above it is a genuine signal that current context
    // is carrying extended-thinking bytes. 0 disables the threshold.
    thinkingMinDisplay: 5000,
    // activeRoot field — when true, render `→.` instead of suppressing the
    // field while Claude is parked at the cwd root or basename(cwd). Default
    // off because the global behaviour is "delta only — don't double up with
    // the cwd block." Flip per-project for repos where a flat root layout
    // means the field would otherwise stay blank all session.
    activeRootShowAtRoot: false,
    // Per-project statusline overrides, keyed by absolute canonical cwd.
    // Mirrors `shape.perProject`. Each block is merged over the top-level
    // statusline config when the active session cwd matches. Example:
    //
    //   "perProject": {
    //     "/Users/me/DWS/CSM": { "activeRootShowAtRoot": true }
    //   }
    //
    // Unknown keys are silently passed through — every key the renderer
    // already reads from `cfg.statusline` is honoured.
    perProject: {},
  },
  compact: {
    threshold: 50,              // tool calls before first advisory
    autoblock: true,            // surface yellow/orange/red suggestion as PostToolUse feedback (non-blocking — legacy key name)
    memoryOffload: true,        // inject a "offload rich detail to auto-memory" directive into pre-compact stdout
    // Re-fire the zone callout after this many extra tokens accumulate while
    // staying in the same at-risk zone. Without this, a single-shot crossing
    // is the only signal — a session that plateaus in orange for 100k+ tokens
    // sees one hint then nothing. 0 disables re-fire (crossings only).
    // Clamped to [5000, 200000] at read time.
    refireEveryTokens: 25000,
    // When true, model-visible pre-compact/zone-crossover output omits
    // per-compact-volatile values (call counts, stale-token estimates,
    // dated filenames, dollar amounts, live token counts). Trades UX
    // detail for a byte-stable prefix that survives as a cache hit for
    // the rest of the post-compact session. On by default — the cache
    // win (read cost −90% for the post-compact prefix) outweighs losing
    // exact counts in the compaction guidance. Set to false or export
    // CLAUDE_COMPACT_STABLE_PREFIX=0 to see the verbose metrics inline.
    stablePrefix: true,
  },
  stopHook: {
    // End-of-session memory-write nudge. Mirrors Anthropic's official
    // memory-tool guidance ("before a session ends, update the progress
    // log") and closes the only memory-write window we don't otherwise
    // cover: short sessions that end without a /compact and without
    // crossing a zone. Disable here or via CLAUDE_SI_STOP_HOOK=0.
    enabled: true,
    // Sessions with fewer than this many PostToolUse records are skipped
    // — a 2-tool-call session has nothing worth recording. Clamp ≥0.
    minToolCalls: 5,
  },
  taskChange: {
    enabled: true,              // detect task-domain changes on UserPromptSubmit
    minTokens: 100000,          // don't bother below this
    sameDomainScore: 0.5,       // score ≥ this → same domain, silent
    differentDomainScore: 0.2,  // score < this → recommend /clear
    prompt: true,
    promptTimeout: 20,
  },
  shape: {
    // How many path segments define a "rootDir" in the shape tracker.
    //   1 → `src`                 (coarser — good for small repos)
    //   2 → `src/auth`            (default — balances feature separation)
    //   3 → `packages/core/src`   (deep — monorepos with packages/*)
    // Clamped 1..5 at read time. See context-shape.js::rootDirOf.
    rootDirDepth: 2,
    // Ring-buffer cap for /tmp/claude-ctx-shape-<sid>.jsonl. 200 is fine
    // for small repos; large monorepos with frequent tool calls need more
    // so the banding window isn't "recent 5 min vs last 30 min". Clamped
    // to [50, 2000] at read time.
    maxEntries: 200,
    // Glob patterns whose files/roots force-bubble into the HOT band
    // regardless of recency. For planning docs, task trackers, and
    // architecture notes that get read heavily early then sit idle — pure
    // recency banding would flag them SAFE TO DROP, but they're the
    // load-bearing intent of the session. Matched against the `file`
    // field of each shape entry and against the `root` itself. Empty by
    // default — opt in per-repo.
    preserveGlobs: [],
    // How HOT/WARM/COLD bands are assigned.
    //   'recency'   → last-touch position (legacy behaviour: last 20% HOT)
    //   'frequency' → log-normalized call count
    //   'hybrid'    → weighted combination (default). Recency dominates so
    //                 active focus still wins, but heavy-hitters like
    //                 auth/billing stop falling into COLD the moment they
    //                 go quiet mid-session.
    // See lib/context-shape.js::combineScore for weights. Invalid values
    // are silently coerced to 'hybrid'.
    scoring: 'hybrid',
    // WARM band lower bound. Score is recency/hybrid-normalised to [0, 1].
    // Defaults to 0.40 (last 60% of session span) so legacy behaviour is
    // preserved. Raise toward HOT_SCORE_CUTOFF (0.80) to tighten WARM when
    // the middle tier is producing no signal — see per-project overrides
    // below for the CSM-only experiment. Clamped to (0, 0.80) at read time.
    warmScoreCutoff: 0.40,
    // Per-project overrides, keyed by absolute canonical cwd (the project
    // root resolved at SessionStart). The hook looks up the canonicalCwd
    // key and merges any matching block over the top of `shape` before
    // passing options to analyzeShape/rollupShape. Example:
    //
    //   "perProject": {
    //     "/Users/me/DWS/CSM": { "warmScoreCutoff": 0.65 }
    //   }
    //
    // Only keys that analyzeShape reads are honoured today:
    //   - warmScoreCutoff
    //   - scoring
    //   - rootDirDepth
    //   - preserveGlobs (merged, not replaced)
    // Unknown keys are silently ignored.
    perProject: {},
    // Accumulate per-root tallies across compacts in a session-scoped
    // rollup file at /tmp/claude-ctx-shape-<sid>.rollup.json. analyzeShape
    // merges the rollup with the current shape log so long-running heavy-
    // hitters keep their frequency signal even after the shape file
    // rotates or the working window shifts. Opt-out if you want pure
    // current-window classification with no historical carry.
    persistAcrossCompacts: true,
    // Git Nexus — derive preserveGlobs automatically from repo commit
    // frequency. Top-N most-touched files in the last `sinceDays` become
    // an implicit allowlist, unioned with user-set `preserveGlobs`. Cheap
    // (one git-log per session, cached 24h). `injectAtStart` is opt-in
    // because session-start context injection is a surprise if the user
    // didn't ask for it.
    gitNexus: {
      enabled: true,        // fold git-frequency into allowlist
      sinceDays: 90,
      limit: 20,
      injectAtStart: false, // emit anchor block via SessionStart additionalContext
      injectLimit: 10,
      // Force-refresh the git-log-backed anchor cache at pre-compact time.
      // Compact is a natural milestone: session commits just landed, so the
      // 24h-TTL cache is likely mid-stale. Refresh keeps the repo graph
      // current before the next session reads it.
      refreshOnCompact: true,
    },
  },
  continue: {
    // Post-compact continuation handoff — pre-compact writes a snapshot of
    // current task + in-flight files + memory follow-ups; the next
    // SessionStart reads it so Claude resumes the thread instead of
    // starting blank. Self-gated: skipped when no directional signal
    // (fresh current-task or unresolved memory follow-up) exists.
    afterCompact: true,
  },
  toolArchive: {
    // PostToolUse hook writes tool_response payloads larger than
    // `thresholdChars` to /tmp/claude-tool-archive-<sid>/<tool_use_id>.json.
    // After /compact wipes them from context, `si expand <id>` (or
    // `node tools/expand.js <id>`) replays the full body. Archive is
    // observational — the model still sees the full result on the call
    // itself; this is purely for retrieval after compaction.
    enabled: true,
    // Archive any tool_response whose string length is at/above this many
    // characters. 4096 ≈ ~1k tokens — aligns with the `>4KB` convention
    // used by alexgreensh/token-optimizer so the two tools don't duplicate
    // archives on the same boundary.
    thresholdChars: 4096,
    // LRU ceiling per session. Older archives are evicted when exceeded.
    maxPerSession: 200,
    // Lazy GC: sweep archives older than this many days on each hook fire.
    ttlDays: 7,
  },
  learn: {
    // When true and adaptive zones (compact-history derived) materially
    // differ from the last time they were shown to the user, the next
    // zone-crossover feedback tacks on a one-line "(zones moved: ...)"
    // hint. Opt-in because silent adaptation is the shipped default —
    // users who want visibility into the learning loop enable this.
    announce: false,
  },
  debug: {
    enabled: false,             // verbose debug logs
    quiet: false,               // suppress everything except errors
  },
};

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function configPath() {
  return path.join(homeDir(), '.claude', 'session-intelligence.json');
}

function legacyStatuslinePath() {
  return path.join(homeDir(), '.claude', 'statusline-intel.json');
}

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    return override === undefined ? base : override;
  }
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = (k in (base || {}))
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // missing file — callers fall back to defaults, no warning needed
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    // Corrupt JSON is *not* equivalent to "file missing" — the user's real
    // config is being silently ignored. Surface it via the debug log (never
    // stderr, which would clutter the hook output the user actually sees).
    try { require('./intel-debug').intelLog('config', 'warn', 'config file parse failed', { file, err: err.message }); }
    catch { /* intel-debug not available yet during early bootstrap */ }
    return null;
  }
}

function applyEnvOverrides(cfg) {
  const env = process.env;

  if (env.CLAUDE_STATUSLINE_FIELDS) {
    cfg.statusline.fields = env.CLAUDE_STATUSLINE_FIELDS
      .split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (env.CLAUDE_STATUSLINE_TOKEN_SOURCE) {
    cfg.statusline.tokenSource = env.CLAUDE_STATUSLINE_TOKEN_SOURCE;
  }
  if (env.CLAUDE_STATUSLINE_SEP_INLINE) {
    cfg.statusline.separator = env.CLAUDE_STATUSLINE_SEP_INLINE;
  }
  if (env.NO_COLOR === '1' || env.CLAUDE_STATUSLINE_NO_COLOR === '1') {
    cfg.statusline.colors = false;
  }
  if (env.CLAUDE_STATUSLINE_COMPACT === '1') {
    cfg.statusline.fields = cfg.statusline.fields.filter((f) => f !== 'task');
  }
  // Session-level preset override — wins over config + compact. Useful for
  // temporarily dialing a busy statusline down without editing the file.
  if (env.CLAUDE_STATUSLINE_PRESET && STATUSLINE_PRESETS[env.CLAUDE_STATUSLINE_PRESET]) {
    cfg.statusline.fields = STATUSLINE_PRESETS[env.CLAUDE_STATUSLINE_PRESET].slice();
  }

  if (env.COMPACT_THRESHOLD) {
    const n = parseInt(env.COMPACT_THRESHOLD, 10);
    if (Number.isFinite(n) && n > 0 && n <= 10000) cfg.compact.threshold = n;
  }
  if (env.CLAUDE_COMPACT_AUTOBLOCK === '0') cfg.compact.autoblock = false;
  if (env.CLAUDE_COMPACT_MEMORY_OFFLOAD === '0') cfg.compact.memoryOffload = false;
  if (env.CLAUDE_COMPACT_STABLE_PREFIX === '1') cfg.compact.stablePrefix = true;
  if (env.CLAUDE_COMPACT_STABLE_PREFIX === '0') cfg.compact.stablePrefix = false;

  if (env.CLAUDE_TASK_CHANGE === '0') cfg.taskChange.enabled = false;

  if (env.CLAUDE_SHAPE_ROOT_DIR_DEPTH) {
    const n = parseInt(env.CLAUDE_SHAPE_ROOT_DIR_DEPTH, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 5) cfg.shape.rootDirDepth = n;
  }
  if (env.CLAUDE_SHAPE_SCORING) {
    const v = env.CLAUDE_SHAPE_SCORING;
    if (v === 'recency' || v === 'frequency' || v === 'hybrid') {
      cfg.shape.scoring = v;
    }
  }
  if (env.CLAUDE_SHAPE_PERSIST === '0') cfg.shape.persistAcrossCompacts = false;
  if (env.CLAUDE_SHAPE_PERSIST === '1') cfg.shape.persistAcrossCompacts = true;
  if (env.CLAUDE_LEARN_ANNOUNCE === '1') cfg.learn.announce = true;
  if (env.CLAUDE_LEARN_ANNOUNCE === '0') cfg.learn.announce = false;

  if (env.CLAUDE_TOOL_ARCHIVE === '0') cfg.toolArchive.enabled = false;
  if (env.CLAUDE_TOOL_ARCHIVE === '1') cfg.toolArchive.enabled = true;
  if (env.CLAUDE_TOOL_ARCHIVE_THRESHOLD) {
    const n = parseInt(env.CLAUDE_TOOL_ARCHIVE_THRESHOLD, 10);
    if (Number.isFinite(n) && n > 0 && n <= 10 * 1024 * 1024) cfg.toolArchive.thresholdChars = n;
  }

  if (env.CLAUDE_INTEL_DEBUG === '1') cfg.debug.enabled = true;
  if (env.CLAUDE_INTEL_QUIET === '1') cfg.debug.quiet = true;

  return cfg;
}

/**
 * Load the full config. Order (lowest→highest precedence):
 *   1. Built-in defaults
 *   2. Legacy ~/.claude/statusline-intel.json (statusline keys only)
 *   3. ~/.claude/session-intelligence.json
 *   4. Env var overrides
 */
function loadConfig() {
  let cfg = JSON.parse(JSON.stringify(DEFAULTS));

  const legacy = readJson(legacyStatuslinePath());
  if (legacy) {
    // Legacy file is flat — nest it under statusline.
    cfg.statusline = deepMerge(cfg.statusline, legacy);
  }

  const unified = readJson(configPath());
  if (unified) {
    cfg = deepMerge(cfg, unified);
  }

  // Apply statusline preset unless the user set `fields` explicitly. A preset
  // is a shorthand — explicit `fields` always wins. This runs after merge so
  // an empty-default-values user file can still opt into a preset without
  // maintaining the full fields array by hand.
  const userSetFields = !!(unified && unified.statusline && Array.isArray(unified.statusline.fields));
  const preset = cfg.statusline && cfg.statusline.preset;
  if (!userSetFields && preset && STATUSLINE_PRESETS[preset]) {
    cfg.statusline.fields = STATUSLINE_PRESETS[preset].slice();
  }

  // Coerce typo'd shape.scoring back to hybrid (silent — a warning here
  // would spam the user's status/suggest output on every hook fire).
  if (cfg.shape && !['recency','frequency','hybrid'].includes(cfg.shape.scoring)) {
    cfg.shape.scoring = 'hybrid';
  }

  return applyEnvOverrides(cfg);
}

/** Save a config object back to the unified file (used by /si). */
function saveConfig(cfg) {
  const file = configPath();
  const dir = path.dirname(file);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return file;
}

/**
 * Resolve shape config for a specific project cwd. Merges `shape.perProject[cwd]`
 * on top of the top-level `shape` block. `preserveGlobs` is unioned (project
 * adds to user-global), everything else replaces. Unknown keys ignored.
 *
 * Returns a NEW object — the base shape config is untouched. Callers should
 * feed the result directly into analyzeShape opts.
 */
function resolveShapeForCwd(cfg, cwd) {
  const base = (cfg && cfg.shape) ? cfg.shape : {};
  const overrides = (base.perProject && typeof base.perProject === 'object')
    ? base.perProject[cwd]
    : null;
  if (!overrides || typeof overrides !== 'object') {
    const passthrough = { ...base };
    delete passthrough.perProject;
    return passthrough;
  }
  const merged = { ...base, ...overrides };
  // Union preserveGlobs so a per-project override adds to (not replaces) user-global.
  const baseGlobs = Array.isArray(base.preserveGlobs) ? base.preserveGlobs : [];
  const projGlobs = Array.isArray(overrides.preserveGlobs) ? overrides.preserveGlobs : [];
  if (baseGlobs.length || projGlobs.length) {
    merged.preserveGlobs = [...new Set([...baseGlobs, ...projGlobs])];
  }
  // perProject itself is irrelevant once resolved — strip it to keep the
  // returned object shape tight.
  delete merged.perProject;
  return merged;
}

/**
 * Resolve statusline config for a specific project cwd. Merges
 * `statusline.perProject[cwd]` on top of the top-level `statusline` block.
 * `serviceHealth` is unioned (project adds to user-global) so a project
 * override never silently drops global probes; everything else replaces.
 * Returns a NEW object — the base statusline config is untouched.
 */
function resolveStatuslineForCwd(cfg, cwd) {
  const base = (cfg && cfg.statusline) ? cfg.statusline : {};
  const overrides = (base.perProject && typeof base.perProject === 'object' && cwd)
    ? base.perProject[cwd]
    : null;
  if (!overrides || typeof overrides !== 'object') {
    const passthrough = { ...base };
    delete passthrough.perProject;
    return passthrough;
  }
  const merged = { ...base, ...overrides };
  const baseSvc = Array.isArray(base.serviceHealth) ? base.serviceHealth : [];
  const projSvc = Array.isArray(overrides.serviceHealth) ? overrides.serviceHealth : [];
  if (baseSvc.length || projSvc.length) {
    merged.serviceHealth = [...baseSvc, ...projSvc];
  }
  // zones / prices are nested objects — shallow-merge so a partial override
  // (e.g. only `red`) doesn't wipe the unspecified thresholds.
  if (overrides.zones && typeof overrides.zones === 'object') {
    merged.zones = { ...(base.zones || {}), ...overrides.zones };
  }
  if (overrides.prices && typeof overrides.prices === 'object') {
    merged.prices = { ...(base.prices || {}), ...overrides.prices };
  }
  delete merged.perProject;
  return merged;
}

/**
 * Single source of truth for the {yellow, orange, red} token thresholds.
 * Reads `statusline.zones` (the user-facing knob) and falls back to the
 * built-in defaults. Suggest-compact and the statusline both call this so
 * the bar's colour and the hook's escalation gate stay aligned — without
 * it, customising one didn't move the other and you'd see orange in the
 * bar while the hook still sat at yellow.
 */
function getZoneThresholds(cfg) {
  const fallback = { yellow: 200000, orange: 300000, red: 400000 };
  const z = (cfg && cfg.statusline && cfg.statusline.zones) || {};
  return {
    yellow: Number.isFinite(z.yellow) ? z.yellow : fallback.yellow,
    orange: Number.isFinite(z.orange) ? z.orange : fallback.orange,
    red:    Number.isFinite(z.red)    ? z.red    : fallback.red,
  };
}

/**
 * Clamp shape.maxEntries to [50, 5000]. Out-of-band values silently coerce
 * to the default (200) so a typo can't either starve the analyzer (5 entries)
 * or balloon the shape file to gigabytes. Returns the default when input is
 * absent or non-numeric.
 */
function clampMaxEntries(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 200;
  if (n < 50) return 50;
  if (n > 5000) return 5000;
  return Math.floor(n);
}

/** Dotted getter: get(cfg, "compact.autoblock"). */
function get(cfg, dottedKey) {
  return dottedKey.split('.').reduce(
    (acc, k) => (acc && typeof acc === 'object' ? acc[k] : undefined),
    cfg,
  );
}

/** Dotted setter that returns a NEW object (immutable). */
function set(cfg, dottedKey, value) {
  const keys = dottedKey.split('.');
  const next = JSON.parse(JSON.stringify(cfg));
  let cursor = next;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (cursor[k] === undefined || typeof cursor[k] !== 'object') cursor[k] = {};
    cursor = cursor[k];
  }
  cursor[keys[keys.length - 1]] = value;
  return next;
}

module.exports = {
  DEFAULTS,
  STATUSLINE_PRESETS,
  configPath,
  loadConfig,
  saveConfig,
  get,
  set,
  deepMerge,
  resolveShapeForCwd,
  resolveStatuslineForCwd,
  getZoneThresholds,
  clampMaxEntries,
};
