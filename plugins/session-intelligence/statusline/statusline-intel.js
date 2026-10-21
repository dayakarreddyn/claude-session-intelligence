#!/usr/bin/env node
/**
 * Claude Code statusLine — Session Intelligence view (v2)
 *
 * Reads stdin JSON (provided by Claude Code):
 *   { session_id, transcript_path, cwd, model: { display_name }, ... }
 *
 * Prints a configurable single status line. Fields, colors, token source,
 * and zone thresholds are all configurable via:
 *
 *   ~/.claude/statusline-intel.json   — persistent config (takes precedence over defaults)
 *   env vars                          — override config for this session
 *
 * See README.md for the full field catalog.
 *
 * Silent fallback: if anything goes wrong, prints a minimal "claude" so the
 * status line never shows broken.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadSharedConfig, loadThinkingLib, loadCompactHistoryLib, loadTranscriptUsageLib } = require('./lib-loader');
const { makeColors } = require('./format');
const { totalTokensFromUsage, loadEstimate, contextCap, writeCostSnapshot, DEFAULT_PRICES, totalsFromTranscript } = require('./economics');
const { resolveProjectDir, loadCurrentTask, readSessionStartTime } = require('./git-info');
const { resolveZones } = require('./zones');
const { buildRenderers } = require('./renderers');


function loadConfig() {
  const shared = loadSharedConfig();
  if (shared) {
    const full = shared.loadConfig();
    return full.statusline || full;
  }
  // Stand-alone fallback: read legacy file only, no env overrides.
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const legacyPath = path.join(home, '.claude', 'statusline-intel.json');
  const defaults = {
    fields: [
      'tokens', 'compactAge', 'compactCost', 'cwd', 'siHealth',
      'newline',
      'session', 'tools', 'cost', 'deploy', 'cacheHit', 'cacheSaved',
      'newline',
      'branch', 'diffstat', 'activeRoot', 'issue', 'task',
      'newline',
      'model', 'blockUsage', 'weekUsage',
    ],
    tokenSource: 'auto',
    zones: { yellow: 200000, orange: 300000, red: 400000 },
    maxTaskLength: 40,
    maxBranchLength: 28,
    maxCwdLength: 36,
    maxActiveRootLength: 30,
    separator: ' · ',
    colors: true,
    serviceHealth: [],
  };
  try {
    if (fs.existsSync(legacyPath)) {
      const user = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
      return { ...defaults, ...user, zones: { ...defaults.zones, ...(user.zones || {}) } };
    }
  } catch { /* ignore */ }
  return defaults;
}

// ─── stdin ───────────────────────────────────────────────────────────────────

function readStdinSync() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function safeParse(raw) {
  try { return raw.trim() ? JSON.parse(raw) : {}; } catch { return {}; }
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  let cfg = loadConfig();
  const input = safeParse(readStdinSync());
  const sessionId = input.session_id || input.sessionId || process.env.CLAUDE_SESSION_ID || 'default';
  const cwd = input.cwd || input.workspace?.current_dir || process.cwd();
  // Apply per-project statusline overrides — without this a perProject block
  // like `/Users/me/DWS/CSM: { activeRootShowAtRoot: true }` is silently
  // ignored and the field stays blank. Falls back gracefully when the
  // shared config module is unavailable (stand-alone fallback path).
  try {
    const shared = loadSharedConfig();
    if (shared && typeof shared.resolveStatuslineForCwd === 'function') {
      const full = (typeof shared.loadConfig === 'function') ? shared.loadConfig() : null;
      if (full) cfg = shared.resolveStatuslineForCwd(full, cwd);
    }
  } catch { /* keep top-level cfg on error */ }
  const C = makeColors(cfg.colors);

  // Prefer adaptive zones (derived from this repo's compact history) over
  // the static config zones so the bar color matches what si-suggest-compact
  // reports. Falls back to config zones when the history lib or file is
  // absent. Silent — failures never break rendering.
  // Base zones are fractions of the resolved window (or absolute, per
  // statusline.zoneMode) via the shared getZoneThresholds; the stand-alone
  // fallback keeps its static `zones`.
  const zoneCap = contextCap(input, cfg).cap;
  let zoneHistory = [];
  let adaptiveZones = null;
  try {
    const compactHistory = loadCompactHistoryLib();
    if (compactHistory && typeof compactHistory.adaptiveZones === 'function') {
      adaptiveZones = compactHistory.adaptiveZones;
      zoneHistory = typeof compactHistory.readHistory === 'function' ? compactHistory.readHistory() : [];
    }
  } catch { /* best effort — keep static zones on error */ }
  const resolvedZones = resolveZones(cfg, { cap: zoneCap, cwd, history: zoneHistory, adaptiveZones });
  cfg = { ...cfg, zones: { yellow: resolvedZones.yellow, orange: resolvedZones.orange, red: resolvedZones.red } };
  const transcriptPath = input.transcript_path || input.transcriptPath;

  // Token source resolution.
  let tokens = 0;
  let usedTranscript = false;
  let usage = null;
  if (cfg.tokenSource !== 'estimate') {
    const usageLib = loadTranscriptUsageLib();
    const latest = usageLib ? usageLib.readLatestUsage(transcriptPath, { sessionId }) : null;
    usage = latest && latest.usage;
    const fromTranscript = totalTokensFromUsage(usage);
    if (fromTranscript > 0) {
      tokens = fromTranscript;
      usedTranscript = true;
    }
  }
  // Estimate tool count always; tokens use the chars/3 estimate only on explicit tokenSource 'estimate'.
  const estimate = loadEstimate(sessionId);
  if (!usedTranscript && cfg.tokenSource === 'estimate') {
    tokens = estimate.tokens;
  }

  // Session duration: prefer Claude Code's authoritative number on stdin
  // (input.cost.total_duration_ms) — it survives transcript rotation and
  // covers resumes correctly. Fall back to the earliest transcript timestamp
  // when the stdin number is absent or zero.
  let sessionDurationMs = 0;
  if (cfg.fields.includes('session')) {
    const officialMs = input.cost && typeof input.cost === 'object'
      ? Number(input.cost.total_duration_ms)
      : Number(input.total_duration_ms);
    if (Number.isFinite(officialMs) && officialMs > 0) {
      sessionDurationMs = officialMs;
    } else {
      const start = readSessionStartTime(transcriptPath);
      if (start) sessionDurationMs = Date.now() - start;
    }
  }

  // Cost — prefer Claude Code's authoritative number when it passes one on
  // stdin (input.cost.total_cost_usd), else fall back to a transcript-based
  // estimate using the user's configured prices. The authoritative number
  // reflects what Anthropic actually billed; the estimate is only correct if
  // the configured price list matches the current model's public pricing.
  //
  // cacheSaved is always transcript-derived — Claude Code doesn't expose a
  // "saved by cache" number on stdin, and the transcript pass is cheap (same
  // incremental offset cache as cost). Only computed when the field is
  // configured to avoid paying for the read when it's unused.
  let costUsd = 0;
  let cacheSavedUsd = 0;
  let tokenTotals = null;
  let officialCostUsd = null;
  const wantCostSaved = cfg.fields.includes('costSaved');
  const wantCost = cfg.fields.includes('cost') || wantCostSaved;
  const wantCacheSaved = cfg.fields.includes('cacheSaved') || wantCostSaved;
  const wantTokenFlow = cfg.fields.includes('tokenFlow');
  const wantCompactCost = cfg.fields.includes('compactCost');
  // Always parse Claude Code's authoritative cost when present — used both
  // by cost cells and by compactCost (subtracts cost-at-compact for a strict
  // subset of session cost). Hoisted out of the want-gates so the snapshot
  // gets written even when only compactCost is in the field list.
  const officialCost = input.cost && typeof input.cost === 'object'
    ? Number(input.cost.total_cost_usd)
    : Number(input.total_cost_usd);
  if (Number.isFinite(officialCost) && officialCost > 0) {
    officialCostUsd = officialCost;
  }
  if (wantCost || wantCacheSaved || wantTokenFlow) {
    if (wantCost && officialCostUsd !== null
        && !wantCacheSaved && !wantTokenFlow) {
      costUsd = officialCostUsd;
    } else {
      tokenTotals = totalsFromTranscript(transcriptPath, sessionId, cfg.prices || DEFAULT_PRICES);
      costUsd = (wantCost && officialCostUsd !== null)
        ? officialCostUsd : tokenTotals.cost;
      cacheSavedUsd = tokenTotals.saved;
    }
  }
  // Persist the latest authoritative cost so PreCompact can stamp
  // `costAtCompactUsd` onto the history entry. Cheap atomic JSON write —
  // ~50 bytes, written at most once per render. Skipped when compactCost
  // isn't configured (no consumer) or no authoritative cost is available
  // (would write a stale value over a good one).
  if (wantCompactCost && officialCostUsd !== null && sessionId) {
    writeCostSnapshot(sessionId, officialCostUsd);
  }

  const projectDir = resolveProjectDir(cwd);
  const staleHours = Number.isFinite(cfg.taskStaleHours) ? cfg.taskStaleHours : 12;
  const taskInfo = cfg.fields.includes('task')
    ? loadCurrentTask(projectDir, cwd, cfg.maxTaskLength || 40, staleHours)
    : { text: '', source: 'none' };

  // Thinking-token estimate — tail-scanned residual from the transcript.
  // Skipped entirely when the field isn't configured, so the extra 512 KB
  // read only runs for users who've opted into the `thinking` field.
  let thinking = { total: 0, turns: 0, recent: 0, lastTurnAgo: null };
  if (cfg.fields.includes('thinking')) {
    const lib = loadThinkingLib();
    if (lib && typeof lib.estimateThinkingTokens === 'function') {
      try { thinking = lib.estimateThinkingTokens(transcriptPath) || thinking; }
      catch { /* degrade silently */ }
    }
  }

  const ctx = {
    cfg,
    taskSource: taskInfo.source,
    tokens,
    tools: estimate.tools,
    task: taskInfo.text,
    sessionDurationMs,
    costUsd,
    cacheSavedUsd,
    officialCostUsd,
    tokenTotals,
    usedTranscript,
    usage,
    thinking,
    sessionId,
  };

  const renderers = buildRenderers(C);
  const sep = `${C.graySep}${cfg.separator}${C.reset}`;

  // Split fields on 'newline' pseudo-field so users can lay out multi-line
  // status bars, e.g. fields: ['emoji','model','project','newline','branch','tokens','cost'].
  const groups = [[]];
  for (const name of cfg.fields) {
    if (name === 'newline') groups.push([]);
    else groups[groups.length - 1].push(name);
  }

  const renderGroup = (group) => {
    const rendered = group
      .map((name) => {
        const fn = renderers[name];
        if (!fn) return { name, text: '' };
        try { return { name, text: fn(input, ctx) || '' }; }
        catch { return { name, text: '' }; }
      })
      .filter((r) => r.text && r.text.length > 0);

    if (rendered.length === 0) return '';

    // Leading emoji (primary OR secondary) sits flush against the next field
    // with a single space, not a bullet separator.
    let leading = '';
    let rest = rendered;
    if (rendered[0].name === 'emoji' || rendered[0].name === 'emoji2') {
      leading = rendered[0].text + ' ';
      rest = rendered.slice(1);
    }
    return leading + rest.map((r) => r.text).join(sep);
  };

  // Render every configured group, INCLUDING empty ones. Dropping empty
  // groups makes the bar height fluctuate as fields pop in/out (task
  // populates, session crosses 1m, deploy breadcrumb ages past the window
  // etc.) — from the user's perspective the prompt above keeps moving up
  // and down. Reserving a blank row per configured group keeps the layout
  // append-only: once a line slot exists, it stays there for the session.
  const firstLineHasEmoji = groups.length > 0 && groups[0][0] === 'emoji';
  const indent = firstLineHasEmoji ? '   ' : '';
  const finalLines = groups.map((group, i) => {
    const rendered = renderGroup(group);
    if (i === 0) return rendered || 'claude';
    if (!rendered) return ' '; // reserve the row slot (whitespace is a visible line)
    const firstField = group[0];
    const leadsWithEmoji = firstField === 'emoji' || firstField === 'emoji2';
    return leadsWithEmoji ? rendered : indent + rendered;
  });

  process.stdout.write(finalLines.join('\n'));
}

if (require.main === module) { try { main(); } catch { process.stdout.write('claude'); } }

module.exports = { main, loadConfig };
