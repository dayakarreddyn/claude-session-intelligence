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
  verbose:  [
    'model', 'project', 'branch', 'diffstat', 'tokens',
    'newline',
    'tools', 'session', 'cost', 'task',
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
    maxTaskLength: 60,
    separator: ' · ',
    colors: true,
    serviceHealth: [],
    prices: { input: 15, cache_creation: 18.75, cache_read: 1.5, output: 75 },
  },
  compact: {
    threshold: 50,              // tool calls before first advisory
    autoblock: true,            // surface orange/red suggestion as PostToolUse feedback (non-blocking — legacy key name)
  },
  taskChange: {
    enabled: true,              // detect task-domain changes on UserPromptSubmit
    minTokens: 100000,          // don't bother below this
    sameDomainScore: 0.5,       // score ≥ this → same domain, silent
    differentDomainScore: 0.2,  // score < this → recommend /clear
    prompt: true,
    promptTimeout: 20,
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

  if (env.CLAUDE_TASK_CHANGE === '0') cfg.taskChange.enabled = false;

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
};
