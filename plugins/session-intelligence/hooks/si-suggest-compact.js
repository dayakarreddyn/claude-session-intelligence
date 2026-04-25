#!/usr/bin/env node
/**
 * Strategic Compact Suggester (PostToolUse, non-blocking)
 *
 * Cross-platform (Windows, macOS, Linux)
 *
 * Runs on PostToolUse. Emits suggestions to compact the context at logical
 * intervals without blocking any tool call — the tool already ran, we're
 * just surfacing a heads-up for the next assistant turn.
 *
 * Why PostToolUse, non-blocking:
 * - Blocking on PreToolUse interrupts the current task. Users hit it mid-
 *   edit, lose momentum, and the "this tool call was blocked" wording reads
 *   like an error. Suggestions should inform, not interrupt.
 * - PostToolUse exit 2 surfaces stderr to the assistant as hook feedback,
 *   which is what we want: the model sees "context is filling up, consider
 *   /compact" on its next turn and can react at a natural pause.
 *
 * Why still manual (not auto-compact):
 * - Auto-compact happens at arbitrary points, often mid-task
 * - Strategic compacting preserves context through logical phases
 * - Compact after exploration, before execution
 * - Compact after completing a milestone, before starting next
 *
 * Token zones (from Thariq's research on 1M context):
 * - Green  (<200k): free zone, continue normally
 * - Yellow (200-300k): caution, good time to compact between tasks
 * - Orange (300-400k): context rot zone, compact soon
 * - Red    (>400k): urgent, compact immediately
 */

const fs = require('fs');
const path = require('path');

// Resolve SI lib dir. Source layout: ../lib (sibling of hooks/).
// Installed layout: ./session-intelligence/lib (bundled under ECC scripts/hooks/).
// context-shape.js is SI-only, so we use it as the sentinel that distinguishes
// the full SI bundle from ECC's partial lib dir (which has utils/intel-debug
// but none of the SI-specific modules).
function resolveSiLibDir() {
  const candidates = [
    path.join(__dirname, '..', 'lib'),
    path.join(__dirname, 'session-intelligence', 'lib'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'context-shape.js'))) return dir;
  }
  return candidates[0];
}
const SI_LIB = resolveSiLibDir();

const {
  getTempDir,
  writeFile,
  readStdinJson,
  readTranscriptTokens,
  resolveProjectDir,
} = require(path.join(SI_LIB, 'utils'));
const { intelLog } = require(path.join(SI_LIB, 'intel-debug'));
const { readShape, analyzeShape, draftMessage, readSessionState } = require(path.join(SI_LIB, 'context-shape'));
let compactHistory = null;
try { compactHistory = require(path.join(SI_LIB, 'compact-history')); } catch { /* optional */ }
let costEst = null;
try { costEst = require(path.join(SI_LIB, 'cost-estimation')); } catch { /* optional */ }
let pickTip = null;
try { pickTip = require(path.join(SI_LIB, 'tips')).pickTip; } catch { /* optional */ }

// Load unified config; env overrides already baked in by loadConfig().
function loadSiConfig() {
  try { return require(path.join(SI_LIB, 'config')).loadConfig(); }
  catch { return { compact: { threshold: 50, autoblock: true } }; }
}

async function main() {
  const fullCfg = loadSiConfig();
  const cfg = fullCfg.compact || {};
  const learnCfg = fullCfg.learn || {};
  // Read stdin early so we can resolve cwd before applying perProject overrides.
  const stdinInput = readStdinJson();
  const stdinCwd = (stdinInput && (stdinInput.cwd
    || (stdinInput.workspace && stdinInput.workspace.current_dir))) || process.cwd();
  // Apply per-project shape override so preserveGlobs/gitNexus/rootDirDepth
  // pick up the project-specific entries. Without this, shape diagnosis ran
  // with top-level config even when perProject overrides were defined.
  let shapeCfg = fullCfg.shape || {};
  try {
    const cfgMod = require(path.join(SI_LIB, 'config'));
    if (cfgMod.resolveShapeForCwd) {
      shapeCfg = cfgMod.resolveShapeForCwd(fullCfg, stdinCwd);
    }
  } catch { /* fall back to top-level shape */ }
  const userGlobs = Array.isArray(shapeCfg.preserveGlobs) ? shapeCfg.preserveGlobs : [];

  // ANSI styling for zone-crossover advisories. Two layers:
  //   - foreground zone colour for the headline (bright + bold), so a
  //     dim terminal scroll still registers the alert
  //   - dark-grey background wrapping around the whole block so it
  //     visually reads as a callout / code block distinct from the rest
  //     of the conversation
  //
  // Respects:
  //   - NO_COLOR env (universal convention)
  //   - statusline.colors=false in user config (same flag the bar uses)
  //
  // Background rendering depends on the terminal / UI — if the host
  // ignores the 48;5;N codes, the foreground colour still comes through,
  // so the alert never disappears entirely.
  const colorsEnabled = process.env.NO_COLOR !== '1'
    && (!fullCfg.statusline || fullCfg.statusline.colors !== false);
  const ANSI = {
    reset:  colorsEnabled ? '\x1b[0m'          : '',
    bold:   colorsEnabled ? '\x1b[1m'          : '',
    yellow: colorsEnabled ? '\x1b[1;33m'       : '',         // bold bright yellow
    orange: colorsEnabled ? '\x1b[1;38;5;208m' : '',         // bold 256-color orange
    red:    colorsEnabled ? '\x1b[1;31m'       : '',         // bold bright red
    bg:     colorsEnabled ? '\x1b[48;5;236m'   : '',         // subtle dark-grey BG
    dim:    colorsEnabled ? '\x1b[2;38;5;250m' : '',         // dim light-grey FG for body
  };
  function paintZone(zoneName, text) {
    const code = ANSI[zoneName] || ANSI.bold;
    return code ? `${code}${text}${ANSI.reset}` : text;
  }
  // Render a multi-line block as a "callout": each line gets the dark
  // grey background with a 2-space left pad, so the block reads as one
  // cohesive surface even across multiple lines. Headline line keeps the
  // zone colour on top of the BG; body lines use dim light-grey FG.
  function renderCallout(headlineZone, headline, bodyLines) {
    if (!colorsEnabled) {
      // Plaintext fallback: single-line concat, same shape as before.
      return [headline, ...bodyLines].join(' ');
    }
    const pad = '  ';
    const padded = (text, fg) => `${ANSI.bg}${pad}${fg || ''}${text}${ANSI.reset}`;
    const headlineCode = ANSI[headlineZone] || ANSI.bold;
    const lines = [
      padded(headline, headlineCode),
      ...bodyLines.map((l) => padded(l, ANSI.dim)),
    ];
    return lines.join('\n');
  }

  // Git-nexus allowlist is resolved lazily — cached 24h, so the cost of the
  // `git log` is amortised across every suggest-compact fire in a session.
  // Same inputs as pre-compact so both hooks see the same HOT band.
  const gitNexusCfg = shapeCfg.gitNexus || {};
  let preserveGlobs = userGlobs;
  if (gitNexusCfg.enabled !== false) {
    try {
      const { topTouchedFiles, toPreserveGlobs } = require(path.join(SI_LIB, 'git-nexus'));
      const anchors = topTouchedFiles(stdinCwd, {
        sinceDays: Number.isFinite(gitNexusCfg.sinceDays) ? gitNexusCfg.sinceDays : 90,
        limit: Number.isFinite(gitNexusCfg.limit) ? gitNexusCfg.limit : 20,
      });
      preserveGlobs = [...userGlobs, ...toPreserveGlobs(anchors)];
    } catch { /* optional — fall back to user globs */ }
  }
  const rawSid = (stdinInput && (stdinInput.session_id || stdinInput.sessionId))
    || process.env.CLAUDE_SESSION_ID
    || 'default';
  const sessionId = String(rawSid).replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
  const counterFile = path.join(getTempDir(), `claude-tool-count-${sessionId}`);
  const budgetFile = path.join(getTempDir(), `claude-token-budget-${sessionId}`);
  intelLog('suggest-compact', 'debug', 'hook fired',
    { sessionId, preserveGlobs: preserveGlobs.length });
  const threshold = Number.isFinite(cfg.threshold) && cfg.threshold > 0 && cfg.threshold <= 10000
    ? cfg.threshold
    : 50;

  // Tool counting is now owned by si-token-budget.js (PostToolUse with
  // wider matcher). We only READ the count here to drive threshold warnings.
  let count = 0;
  try {
    const raw = fs.readFileSync(counterFile, 'utf8').trim();
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) count = parsed;
  } catch { /* no count yet — tracker hasn't run */ }

  // Token budget — prefer the authoritative count from the transcript's latest
  // assistant-message usage block (same source the status line reads). Fall
  // back to the tracker estimate when the transcript isn't available or the
  // hook runs before any assistant reply. The tracker estimate only counts
  // tool I/O and misses messages/prompts/thinking, so it can severely
  // under-report on long sessions.
  let tokenBudget = 0;
  let tokenSource = 'none';
  const transcriptPath = stdinInput && stdinInput.transcript_path;
  const transcriptTokens = readTranscriptTokens(transcriptPath);
  if (transcriptTokens > 0) {
    tokenBudget = transcriptTokens;
    tokenSource = 'transcript';
  } else {
    try {
      const raw = fs.readFileSync(budgetFile, 'utf8').trim();
      const parsed = parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        tokenBudget = parsed;
        tokenSource = 'estimate';
      }
    } catch { /* no budget file yet — tracker hasn't run */ }
  }
  intelLog('suggest-compact', 'debug', 'token budget resolved',
    { tokenBudget, tokenSource });

  // Session cost — surfaced in the escalation message and fed into
  // adaptiveZones so expensive sessions compact earlier (Q2 cost-band
  // tightening). Pulled from transcript usage; 0 when transcript isn't
  // available.
  let sessionCost = 0;
  try {
    if (costEst && transcriptPath) {
      sessionCost = costEst.totalCostFromTranscript(
        transcriptPath, sessionId, costEst.DEFAULT_PRICES);
    }
  } catch { /* best effort */ }

  // Zones: prefer adaptive thresholds derived from the user's own compact
  // history when ≥5 samples are available. Otherwise fall back to the
  // static 200/300/400k defaults. adaptiveZones() is bounded ±30% from the
  // defaults so a noisy history can't silence the warnings entirely.
  //
  // Per-cwd bucketing: when this repo has ≥5 of its own compacts, zones
  // derive from those alone; otherwise cross-project history is used so
  // new repos still benefit from global learning.
  //
  // Cost-band: when sessionCost exceeds the user's historical p75 cost,
  // orange tightens by 12% — expensive sessions warrant earlier warnings.
  const cwdForZones = (stdinInput && (stdinInput.cwd || (stdinInput.workspace && stdinInput.workspace.current_dir))) || process.cwd();
  // Single source of truth — same thresholds the statusline paints with.
  // Avoids the misalignment where `statusline.zones` was customised but the
  // hook's hardcoded {200k,300k,400k} fell out of sync.
  let baseZones;
  try {
    const cfgMod = require(path.join(SI_LIB, 'config'));
    baseZones = cfgMod.getZoneThresholds
      ? cfgMod.getZoneThresholds(fullCfg)
      : { yellow: 200000, orange: 300000, red: 400000 };
  } catch {
    baseZones = { yellow: 200000, orange: 300000, red: 400000 };
  }
  let zonesCfg = baseZones;
  try {
    if (compactHistory) {
      zonesCfg = compactHistory.adaptiveZones(
        compactHistory.readHistory(),
        baseZones,
        { cwd: cwdForZones, currentCost: sessionCost });
    }
  } catch { /* keep static */ }

  const zone = getZone(tokenBudget, zonesCfg);
  const budgetStr = tokenBudget > 0 ? ` (~${formatTokens(tokenBudget)} tokens, ${zone} zone)` : '';

  // Tool-call milestones — kept as observability signals only. Used to
  // emit via `log()` (raw stderr), but those one-liners competed with the
  // rich zone callout below and were easy to miss in scrollback. Intel log
  // is the right surface for "useful for debugging hook behaviour, but not
  // worth surfacing to the model on every milestone."
  if (count === threshold) {
    intelLog('suggest-compact', 'debug', 'tool-call milestone',
      { count, threshold, tokenBudget, zone });
  } else if (count > threshold && (count - threshold) % 25 === 0) {
    intelLog('suggest-compact', 'debug', 'tool-call checkpoint',
      { count, tokenBudget, zone });
  }

  // Surface the zone escalation to the assistant via PostToolUse exit 2
  // (stderr becomes hook feedback on the next turn — does NOT block the
  // tool that just ran). Two emit paths:
  //   1. ZONE CROSSING — first time we hit orange/red in this session.
  //   2. PERIODIC RE-FIRE — same zone but tokens grew by ≥ refireEveryTokens
  //      since the last emit. Without this, a session that crosses orange
  //      at 305k and stays in orange for the next 100k tokens would only
  //      see ONE callout the entire time. The re-fire keeps the nudge
  //      present as the user keeps adding context.
  //
  // Disable the assistant-feedback channel with compact.autoblock=false.
  // Tune the re-fire interval with compact.refireEveryTokens (default 25k);
  // set to 0 to disable re-fire (only emit on zone crossings).
  // Diagnostic log when the zone gate is skipped — used to be silent, which
  // hid the "no transcript_path AND no budget tracker" wrapper-CLI failure
  // mode where the hook ran but produced no callout.
  if (tokenBudget === 0) {
    intelLog('suggest-compact', 'info', 'zone gate skipped (tokenBudget=0)', {
      hasTranscript: !!transcriptPath,
      tokenSource,
      sessionId,
    });
  }
  if (tokenBudget > 0 && cfg.autoblock !== false) {
    const stateFile = path.join(getTempDir(), `claude-compact-state-${sessionId}`);
    const rank = { green: 0, yellow: 1, orange: 2, red: 3 };
    // State is JSON: { zone, tok }. Read tolerantly — older builds wrote
    // a bare zone string, so plaintext fallback is treated as { zone, tok: 0 }
    // (tok=0 means "we don't know the last emit level, allow re-fire").
    let lastZone = 'green';
    let lastEmitTok = 0;
    try {
      const raw = fs.readFileSync(stateFile, 'utf8').trim();
      if (raw.startsWith('{')) {
        const parsed = JSON.parse(raw);
        if (parsed && rank[parsed.zone] !== undefined) lastZone = parsed.zone;
        if (parsed && Number.isFinite(parsed.tok)) lastEmitTok = parsed.tok;
      } else if (rank[raw] !== undefined) {
        lastZone = raw;
      }
    } catch { /* no prior state or unparsable */ }

    // Refire interval — clamp to a sane band so a typo can't either flood
    // every tool call (1 token) or silence the feature for a million-token
    // session (1B). Default 25k is roughly 8% of the 300k orange floor.
    const rawRefire = Number.isFinite(cfg.refireEveryTokens) ? cfg.refireEveryTokens : 25000;
    const refireEvery = rawRefire <= 0
      ? 0
      : Math.max(5000, Math.min(rawRefire, 200000));

    // Yellow now joins the rich callout — used to be a silent one-line log,
    // which meant a long session that plateaued in yellow saw no diagnosis,
    // tip, or memory-offload nudge for the entire run.
    const crossedUp = rank[zone] > rank[lastZone] && rank[zone] >= rank.yellow;
    const stayedAtRisk = rank[zone] === rank[lastZone] && rank[zone] >= rank.yellow;
    const grewEnough = refireEvery > 0
      && stayedAtRisk
      && (tokenBudget - lastEmitTok) >= refireEvery;
    const escalated = crossedUp || grewEnough;
    if (escalated) {
      // Persist zone + the token level we emitted at, so the next call can
      // gate re-fire on absolute token growth (independent of tool-call rate).
      try { writeFile(stateFile, JSON.stringify({ zone, tok: tokenBudget })); }
      catch { /* best effort */ }

      // Grounded diagnosis — what's actually in the context right now?
      // token-budget-tracker has been writing observation entries per tool
      // call. analyzeShape returns null when there isn't enough signal to
      // bother (short sessions, no file paths), which we handle below.
      // Reclassify against the session-pinned cwd so subagent/payload drift
      // doesn't poison the shape diagnosis with /Users/<name> blobs.
      let canonicalCwd = '';
      try {
        const state = readSessionState(sessionId);
        if (state && typeof state.cwd === 'string' && state.cwd.startsWith('/')) {
          canonicalCwd = state.cwd;
        }
      } catch { /* best effort */ }
      // Re-resolve shape against canonicalCwd in case the bootstrap-pinned
      // session cwd differs from the stdin cwd (subagent worktrees, payload
      // drift). Falls back to the earlier shapeCfg when unavailable.
      let canonicalShape = shapeCfg;
      try {
        const cfgMod = require(path.join(SI_LIB, 'config'));
        if (cfgMod.resolveShapeForCwd && canonicalCwd) {
          canonicalShape = cfgMod.resolveShapeForCwd(fullCfg, canonicalCwd);
        }
      } catch { /* keep earlier shapeCfg */ }
      const warmScoreCutoff = Number.isFinite(canonicalShape.warmScoreCutoff)
        ? canonicalShape.warmScoreCutoff : undefined;
      const rootDirDepth = Number.isFinite(canonicalShape.rootDirDepth)
        ? canonicalShape.rootDirDepth : undefined;
      const shape = analyzeShape(readShape(sessionId), {
        preserveGlobs, canonicalCwd, warmScoreCutoff, rootDirDepth,
      });
      const diagnosis = draftMessage(shape);

      // Stable mode: drop live token/cost numbers from the headline +
      // skip the adaptive-zone and cost-tightened stat lines below. The
      // zone name alone carries the actionable signal; the numbers are
      // UX nice-to-haves that change every tool call.
      const stablePrefix = !!(fullCfg.compact && fullCfg.compact.stablePrefix);
      const baseHeader = zone === 'red'
        ? 'High-risk zone'
        : zone === 'orange'
          ? 'Drift zone'
          : 'Caution zone'; // yellow
      // Subtle label so the model can tell crossings apart from re-fires —
      // useful when scanning logs for "is this a fresh signal or a reminder?"
      const header = grewEnough ? `${baseHeader} (still)` : baseHeader;
      const costStr = (!stablePrefix && costEst && sessionCost > 0)
        ? `, ${costEst.formatUsd(sessionCost)} spent` : '';
      const tokStr = stablePrefix ? '' : ` — context at ~${formatTokens(tokenBudget)} tokens${costStr}`;
      const headline = `[StrategicCompact] ${header}${tokStr}. Advisory only — continue if the task needs full context.`;
      const body = [];
      if (diagnosis) body.push(`Observed: ${diagnosis}.`);

      // Memory-offload nudge — give Claude a turn to write rich detail to
      // auto-memory BEFORE /compact collapses it. Context is still live at
      // zone crossover; once compacted, the detail is already lost. Gated
      // by the same config key that controls the pre-compact directive.
      if (cfg.memoryOffload !== false) {
        const cwd = (stdinInput && (stdinInput.cwd || (stdinInput.workspace && stdinInput.workspace.current_dir))) || process.cwd();
        const projectDir = resolveProjectDir(cwd);
        const memLine = projectDir
          ? `Optional: offload rich detail to auto-memory at ${path.join(projectDir, 'memory')}/ (project_session_*.md / reference_*.md + MEMORY.md index) before compacting.`
          : 'Optional: offload rich detail to auto-memory before compacting.';
        body.push(memLine);
      }

      body.push(
        'When you do compact, `/compact` auto-injects preserve/drop hints from observed tool usage; free-text hints still work.'
      );
      if (!stablePrefix && zonesCfg.adaptive) {
        const scope = zonesCfg.bucket === 'cwd' ? 'this repo' : 'your history';
        body.push(
          `(Zones adapted to ${scope}: orange=${formatTokens(zonesCfg.orange)}, red=${formatTokens(zonesCfg.red)}, ${zonesCfg.sampleCount} past compacts.)`
        );
      }
      if (!stablePrefix && zonesCfg.costTightened) {
        body.push(
          `(Orange tightened 12%: session cost ${costEst ? costEst.formatUsd(sessionCost) : `$${sessionCost.toFixed(2)}`} exceeds your historical p75 — expensive sessions warrant earlier warnings.)`
        );
      }
      if (learnCfg.announce === true && compactHistory && compactHistory.announceAdaptiveShift) {
        try {
          const shiftLine = compactHistory.announceAdaptiveShift(zonesCfg, cwdForZones);
          if (shiftLine) body.push(shiftLine);
        } catch { /* best effort */ }
      }
      // Rotating tip keyed to (sessionId, zone, day) for crossings, plus
      // the current `tokenBudget` snapshot for re-fires. The token bucket
      // mixed in means the second hit at ~325k draws a different tip from
      // the first hit at ~305k, instead of repeating the same line every
      // refireEveryTokens window. Best-effort: tips module is optional.
      if (pickTip) {
        try {
          const refireBucket = grewEnough
            ? `|tok${Math.floor(tokenBudget / Math.max(refireEvery, 1))}`
            : '';
          const tip = pickTip(zone, `${sessionId}${refireBucket}`);
          if (tip) body.push(`Tip: ${tip}`);
        } catch { /* best effort */ }
      }
      body.push('Silence this feedback with CLAUDE_COMPACT_AUTOBLOCK=0.');
      process.stderr.write(renderCallout(zone, headline, body) + '\n');
      intelLog('suggest-compact', 'warn', `zone feedback at ${zone}`, {
        tokenBudget, count, lastZone, lastEmitTok,
        emitReason: grewEnough ? 'refire' : 'crossing',
        sessionCost,
        zonesAdaptive: !!zonesCfg.adaptive,
        costTightened: !!zonesCfg.costTightened,
        shape: shape ? { hot: shape.hot.length, cold: shape.cold.length, shift: !!shape.shift, stale: shape.staleTokens } : null,
      });
      process.exit(2); // PostToolUse exit 2 = stderr surfaces to assistant; tool NOT blocked
    }

    // Tokens dropped (likely after /compact) — re-arm for next escalation.
    // Reset lastEmitTok to the current budget so the next re-fire window is
    // measured from "now," not from the high-water mark before /compact.
    // Also log the descent so operators can correlate compact events with
    // budget recovery in intel logs.
    if (rank[zone] < rank[lastZone]) {
      try { writeFile(stateFile, JSON.stringify({ zone, tok: tokenBudget })); }
      catch { /* best effort */ }
      intelLog('suggest-compact', 'info', 'zone descended', {
        from: lastZone, to: zone, tokenBudget, sessionId,
      });
    }
  }

  process.exit(0);
}

function getZone(tokens, zones) {
  const z = zones || { yellow: 200000, orange: 300000, red: 400000 };
  if (tokens >= z.red)    return 'red';
  if (tokens >= z.orange) return 'orange';
  if (tokens >= z.yellow) return 'yellow';
  return 'green';
}

function formatTokens(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

main().catch(err => {
  console.error('[StrategicCompact] Error:', err.message);
  intelLog('suggest-compact', 'error', 'hook crashed', { err: err.message });
  process.exit(0);
});
