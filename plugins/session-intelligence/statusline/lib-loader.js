'use strict';

// Lazy loaders for ../lib modules plus per-process memos (statusline split, behaviour-neutral move).

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Config ──────────────────────────────────────────────────────────────────
// Unified config lives in ~/.claude/session-intelligence.json. lib/config.js
// merges it with defaults, legacy ~/.claude/statusline-intel.json, and env
// overrides. We only need the statusline slice here.
//
// Two install paths exist: repo-local tests (lib next to script) and user
// install (lib under scripts/hooks/session-intelligence/). Try both.

// The statusline script can sit in three different layouts on disk:
//   1. Repo:     plugins/session-intelligence/statusline/ with ../lib siblings
//   2. Cache:    cache/.../1.0.0/statusline/ with ../lib siblings
//   3. Legacy:   ~/.claude/scripts/ with hooks/session-intelligence/lib/ nested
// The candidate order below walks each layout in turn. The repo/cache path
// (`../lib`) went overlooked for a while, which meant env-var field
// overrides silently no-op'd — now covered.
function resolveLibDir() {
  const candidates = [
    // 1. Plugin cache (canonical when installed via `/plugin install`). This
    //    MUST win over any legacy copies in ~/.claude/scripts/hooks/ — those
    //    diverge on every install.sh rsync because install.sh only populates
    //    LIB_DIR when the plugin is NOT detected. Checking plugin cache first
    //    keeps the standalone ~/.claude/scripts/statusline-intel.js working
    //    even when the legacy lib dir is empty.
    path.join(require('os').homedir(), '.claude', 'plugins', 'cache',
              'session-intelligence', 'session-intelligence', '1.0.0', 'lib'),
    path.join(__dirname, '..', 'lib'),
    path.join(__dirname, 'lib'),
    path.join(__dirname, 'hooks', 'session-intelligence', 'lib'),
    path.join(__dirname, 'session-intelligence', 'lib'),
  ];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'config.js'))) return dir;
    } catch { /* try next */ }
  }
  return null;
}

function loadSharedConfig() {
  const dir = resolveLibDir();
  if (!dir) return null;
  try { return require(path.join(dir, 'config.js')); }
  catch { return null; }
}

function loadUtilsLib() {
  const dir = resolveLibDir();
  if (!dir) return null;
  const p = path.join(dir, 'utils.js');
  try {
    if (fs.existsSync(p)) return require(p);
  } catch { /* optional */ }
  return null;
}

function loadThinkingLib() {
  const dir = resolveLibDir();
  if (!dir) return null;
  const p = path.join(dir, 'thinking.js');
  try {
    if (fs.existsSync(p)) return require(p);
  } catch { /* optional */ }
  return null;
}

function loadCompactHistoryLib() {
  const dir = resolveLibDir();
  if (!dir) return null;
  const p = path.join(dir, 'compact-history.js');
  try {
    if (fs.existsSync(p)) return require(p);
  } catch { /* optional */ }
  return null;
}

function loadContextShapeLib() {
  const dir = resolveLibDir();
  if (!dir) return null;
  const p = path.join(dir, 'context-shape.js');
  try {
    if (fs.existsSync(p)) return require(p);
  } catch { /* optional */ }
  return null;
}

function loadUsageApiLib() {
  const dir = resolveLibDir();
  if (!dir) return null;
  const p = path.join(dir, 'usage-api.js');
  try {
    if (fs.existsSync(p)) return require(p);
  } catch { /* optional */ }
  return null;
}

function loadTokenSpeedLib() {
  const dir = resolveLibDir();
  if (!dir) return null;
  const p = path.join(dir, 'token-speed.js');
  try {
    if (fs.existsSync(p)) return require(p);
  } catch { /* optional */ }
  return null;
}

// Per-session subagent spend by model, from the events DB. Lazy + cached
// per process; returns [] when the lib or DB is unavailable so the
// statusline never blocks on sqlite. Subagents bill in their own
// transcripts — without this the modelSplit line only ever showed the
// parent conversation's model.
let _eventsLibCached = undefined;
function loadEventsLib() {
  if (_eventsLibCached !== undefined) return _eventsLibCached;
  _eventsLibCached = null;
  const dir = resolveLibDir();
  if (!dir) return null;
  try {
    const p = path.join(dir, 'events.js');
    if (fs.existsSync(p)) _eventsLibCached = require(p);
  } catch { _eventsLibCached = null; }
  return _eventsLibCached;
}

let _agentCostsCached = undefined;
function agentModelCostsSafe(sid) {
  if (_agentCostsCached !== undefined) return _agentCostsCached;
  _agentCostsCached = [];
  if (!sid) return _agentCostsCached;
  const events = loadEventsLib();
  try {
    if (events && typeof events.agentModelCosts === 'function') {
      _agentCostsCached = events.agentModelCosts(sid) || [];
    }
  } catch { _agentCostsCached = []; }
  return _agentCostsCached;
}

// Per-model price lookup from lib/cost-estimation.js — keeps the pricing
// table in ONE place. Optional like every lib load here: when absent, the
// accumulators fall back to the flat `prices` argument for every turn.
let _costLibCached = undefined;
function knownPriceForModelSafe(modelId) {
  if (_costLibCached === undefined) {
    const dir = resolveLibDir();
    _costLibCached = null;
    if (dir) {
      const p = path.join(dir, 'cost-estimation.js');
      try { if (fs.existsSync(p)) _costLibCached = require(p); }
      catch { _costLibCached = null; }
    }
  }
  if (!_costLibCached || typeof _costLibCached.knownPriceForModel !== 'function') return null;
  try { return _costLibCached.knownPriceForModel(modelId); }
  catch { return null; }
}

// Cached per-process so blockUsage + weekUsage share one disk read + one
// "should we kick off a background refresh" decision per render.
let _usageCached = undefined;
function loadUsage() {
  if (_usageCached !== undefined) return _usageCached;
  const lib = loadUsageApiLib();
  if (!lib) { _usageCached = null; return null; }
  try { _usageCached = lib.readAndRefreshIfStale(); }
  catch { _usageCached = null; }
  return _usageCached;
}

// Shared session-context parser — same placeholder + autofill rules the
// handoff reader and pre-compact hint formatter use. Loaded lazily so a
// missing lib dir just falls back to the legacy inline parser below.
function loadSessionContextLib() {
  const dir = resolveLibDir();
  if (!dir) return null;
  const p = path.join(dir, 'session-context.js');
  try {
    if (fs.existsSync(p)) return require(p);
  } catch { /* optional */ }
  return null;
}

// ─── Token sources ───────────────────────────────────────────────────────────

function loadTranscriptUsageLib() {
  const dir = resolveLibDir();
  if (!dir) return null;
  try { return require(path.join(dir, 'transcript-usage.js')); }
  catch { return null; }
}

// Live read of the cost-lib memo (set as a side effect of knownPriceForModelSafe);
// economics.js cannot read this module's private `let` directly.
function getCostLibCached() {
  return _costLibCached;
}

// Test-only: drop the per-process memos so a test can re-run a loader.
function resetForTests() {
  _eventsLibCached = undefined;
  _agentCostsCached = undefined;
  _costLibCached = undefined;
  _usageCached = undefined;
}

module.exports = {
  resolveLibDir,
  loadSharedConfig,
  loadUtilsLib,
  loadThinkingLib,
  loadCompactHistoryLib,
  loadContextShapeLib,
  loadUsageApiLib,
  loadTokenSpeedLib,
  loadEventsLib,
  agentModelCostsSafe,
  knownPriceForModelSafe,
  loadUsage,
  loadSessionContextLib,
  loadTranscriptUsageLib,
  getCostLibCached,
  resetForTests,
};
