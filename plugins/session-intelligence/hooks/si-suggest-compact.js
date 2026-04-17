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
  log,
  readStdinJson,
  readTranscriptTokens,
} = require(path.join(SI_LIB, 'utils'));
const { intelLog } = require(path.join(SI_LIB, 'intel-debug'));
const { readShape, analyzeShape, draftMessage } = require(path.join(SI_LIB, 'context-shape'));
let compactHistory = null;
try { compactHistory = require(path.join(SI_LIB, 'compact-history')); } catch { /* optional */ }
let costEst = null;
try { costEst = require(path.join(SI_LIB, 'cost-estimation')); } catch { /* optional */ }

// Load unified config; env overrides already baked in by loadConfig().
function loadSiConfig() {
  try { return require(path.join(SI_LIB, 'config')).loadConfig(); }
  catch { return { compact: { threshold: 50, autoblock: true } }; }
}

async function main() {
  const cfg = loadSiConfig().compact || {};
  const stdinInput = readStdinJson();
  const rawSid = (stdinInput && (stdinInput.session_id || stdinInput.sessionId))
    || process.env.CLAUDE_SESSION_ID
    || 'default';
  const sessionId = String(rawSid).replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
  const counterFile = path.join(getTempDir(), `claude-tool-count-${sessionId}`);
  const budgetFile = path.join(getTempDir(), `claude-token-budget-${sessionId}`);
  intelLog('suggest-compact', 'debug', 'hook fired', { sessionId });
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

  // Zones: prefer adaptive thresholds derived from the user's own compact
  // history when ≥5 samples are available. Otherwise fall back to the
  // static 200/300/400k defaults. adaptiveZones() is bounded ±30% from the
  // defaults so a noisy history can't silence the warnings entirely.
  const staticZones = { yellow: 200000, orange: 300000, red: 400000 };
  let zonesCfg = staticZones;
  try {
    if (compactHistory) {
      zonesCfg = compactHistory.adaptiveZones(compactHistory.readHistory(), staticZones);
    }
  } catch { /* keep static */ }

  const zone = getZone(tokenBudget, zonesCfg);
  const budgetStr = tokenBudget > 0 ? ` (~${formatTokens(tokenBudget)} tokens, ${zone} zone)` : '';

  // Session cost — surfaced in the escalation message and used by the model
  // when deciding whether the suggestion is worth acting on. Pulled from
  // transcript usage; 0 when transcript isn't available.
  let sessionCost = 0;
  try {
    if (costEst && transcriptPath) {
      sessionCost = costEst.totalCostFromTranscript(
        transcriptPath, sessionId, costEst.DEFAULT_PRICES);
    }
  } catch { /* best effort */ }

  // Tool-call based suggestions (original logic)
  if (count === threshold) {
    log(`[StrategicCompact] ${threshold} tool calls reached${budgetStr} - consider /compact if transitioning phases`);
  }

  if (count > threshold && (count - threshold) % 25 === 0) {
    log(`[StrategicCompact] ${count} tool calls${budgetStr} - good checkpoint for /compact if context is stale`);
  }

  // Token-budget based suggestions (new — only fires at zone transitions)
  // We check both current and what the zone was ~5k tokens ago to avoid spam
  if (tokenBudget > 0) {
    const prevZone = getZone(tokenBudget - 5000, zonesCfg);

    if (zone === 'yellow' && prevZone === 'green') {
      log(`[StrategicCompact] ~${formatTokens(tokenBudget)} tokens — entering caution zone. Good time to /compact between tasks.`);
      intelLog('suggest-compact', 'info', `suggestion: yellow-zone`, { tokenBudget, count });
    } else if (zone === 'orange' && prevZone === 'yellow') {
      log(`[StrategicCompact] ~${formatTokens(tokenBudget)} tokens — CONTEXT ROT ZONE. Compact now: /compact [preserve current task context]`);
      intelLog('suggest-compact', 'warn', `suggestion: orange-zone`, { tokenBudget, count });
    } else if (zone === 'red' && prevZone === 'orange') {
      log(`[StrategicCompact] ~${formatTokens(tokenBudget)} tokens — URGENT. /compact immediately or /clear and start fresh.`);
      intelLog('suggest-compact', 'warn', `suggestion: red-zone`, { tokenBudget, count });
    }
  }

  // Surface the zone escalation to the assistant via PostToolUse exit 2
  // (stderr becomes hook feedback on the next turn — does NOT block the
  // tool that just ran). One-shot per zone-rank increase so we don't spam
  // every tool call inside the same zone. When tokens drop (post-compact),
  // state re-sets and the next escalation fires again.
  //
  // Disable the assistant-feedback channel with compact.autoblock=false
  // (kept name for backwards compat — it's a misnomer now but changing the
  // key would silently break existing configs).
  if (tokenBudget > 0 && cfg.autoblock !== false) {
    const stateFile = path.join(getTempDir(), `claude-compact-state-${sessionId}`);
    const rank = { green: 0, yellow: 1, orange: 2, red: 3 };
    let lastZone = 'green';
    try {
      const raw = fs.readFileSync(stateFile, 'utf8').trim();
      if (rank[raw] !== undefined) lastZone = raw;
    } catch { /* no prior state */ }

    const escalated = rank[zone] > rank[lastZone] && rank[zone] >= rank.orange;
    if (escalated) {
      // Persist immediately so we don't re-emit the same escalation on the
      // very next tool call inside the same zone.
      try { writeFile(stateFile, zone); } catch { /* best effort */ }

      // Grounded diagnosis — what's actually in the context right now?
      // token-budget-tracker has been writing observation entries per tool
      // call. analyzeShape returns null when there isn't enough signal to
      // bother (short sessions, no file paths), which we handle below.
      const shape = analyzeShape(readShape(sessionId));
      const diagnosis = draftMessage(shape);

      const header = zone === 'red' ? 'URGENT — RED ZONE' : 'ORANGE ZONE — context rot risk';
      const costStr = (costEst && sessionCost > 0) ? `, ${costEst.formatUsd(sessionCost)} spent` : '';
      const lines = [
        `[StrategicCompact] ${header}. Context at ~${formatTokens(tokenBudget)} tokens${costStr}.`,
      ];
      if (diagnosis) lines.push(`Observed: ${diagnosis}.`);
      lines.push(
        `Run \`/compact\` — preserve/drop hints will be auto-injected from observed tool usage. ` +
        `Free-text hint after /compact still works.`
      );
      if (zonesCfg.adaptive) {
        lines.push(
          `(Zones adapted to your history: orange=${formatTokens(zonesCfg.orange)}, red=${formatTokens(zonesCfg.red)}, ${zonesCfg.sampleCount} past compacts.)`
        );
      }
      lines.push('Silence this feedback with CLAUDE_COMPACT_AUTOBLOCK=0.');
      process.stderr.write(`${lines.join(' ')}\n`);
      intelLog('suggest-compact', 'warn', `zone feedback at ${zone}`, {
        tokenBudget, count, lastZone, sessionCost,
        zonesAdaptive: !!zonesCfg.adaptive,
        shape: shape ? { hot: shape.hot.length, cold: shape.cold.length, shift: !!shape.shift, stale: shape.staleTokens } : null,
      });
      process.exit(2); // PostToolUse exit 2 = stderr surfaces to assistant; tool NOT blocked
    }

    // Tokens dropped (likely after /compact) — re-arm for next escalation.
    if (rank[zone] < rank[lastZone]) {
      try { writeFile(stateFile, zone); } catch { /* best effort */ }
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
