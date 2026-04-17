#!/usr/bin/env node
/**
 * Strategic Compact Suggester (Enhanced with Token Budget Awareness)
 *
 * Cross-platform (Windows, macOS, Linux)
 *
 * Runs on PreToolUse to suggest manual compaction at logical intervals.
 * Now combines tool-call counting WITH approximate token budget from
 * the token-budget-tracker PostToolUse hook.
 *
 * Why manual over auto-compact:
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
const {
  getTempDir,
  writeFile,
  log
} = require('../lib/utils');
const { intelLog } = require('../lib/intel-debug');

async function main() {
  const sessionId = (process.env.CLAUDE_SESSION_ID || 'default').replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
  const counterFile = path.join(getTempDir(), `claude-tool-count-${sessionId}`);
  const budgetFile = path.join(getTempDir(), `claude-token-budget-${sessionId}`);
  intelLog('suggest-compact', 'debug', 'hook fired', { sessionId });
  const rawThreshold = parseInt(process.env.COMPACT_THRESHOLD || '50', 10);
  const threshold = Number.isFinite(rawThreshold) && rawThreshold > 0 && rawThreshold <= 10000
    ? rawThreshold
    : 50;

  // Tool counting is now owned by token-budget-tracker.js (PostToolUse with
  // wider matcher). We only READ the count here to drive threshold warnings.
  let count = 0;
  try {
    const raw = fs.readFileSync(counterFile, 'utf8').trim();
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) count = parsed;
  } catch { /* no count yet — tracker hasn't run */ }

  // Read token budget (written by token-budget-tracker.js PostToolUse hook)
  let tokenBudget = 0;
  try {
    const raw = fs.readFileSync(budgetFile, 'utf8').trim();
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      tokenBudget = parsed;
    }
  } catch {
    // No budget file yet — tracker hasn't run
  }

  const zone = getZone(tokenBudget);
  const budgetStr = tokenBudget > 0 ? ` (~${formatTokens(tokenBudget)} tokens, ${zone} zone)` : '';

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
    const prevZone = getZone(tokenBudget - 5000);

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

  // Auto-enforce: on escalation into orange/red, block the current tool call
  // with a clear instruction for the user to run /compact. One-shot per
  // zone-rank increase. When tokens drop (post-compact), state re-sets so the
  // next escalation fires again. Opt-out with CLAUDE_COMPACT_AUTOBLOCK=0.
  if (tokenBudget > 0 && process.env.CLAUDE_COMPACT_AUTOBLOCK !== '0') {
    const stateFile = path.join(getTempDir(), `claude-compact-state-${sessionId}`);
    const rank = { green: 0, yellow: 1, orange: 2, red: 3 };
    let lastZone = 'green';
    try {
      const raw = fs.readFileSync(stateFile, 'utf8').trim();
      if (rank[raw] !== undefined) lastZone = raw;
    } catch { /* no prior state */ }

    const escalated = rank[zone] > rank[lastZone] && rank[zone] >= rank.orange;
    if (escalated) {
      // Persist immediately so a second concurrent tool call doesn't re-prompt.
      try { writeFile(stateFile, zone); } catch { /* best effort */ }

      const header = zone === 'red' ? 'URGENT — RED ZONE' : 'ORANGE ZONE — context rot risk';
      const answer = askUserCompact(zone, tokenBudget);
      intelLog('suggest-compact', 'info', `zone escalation prompt`, { zone, answer, tokenBudget });

      if (answer === 'skip') {
        // User chose to continue without compacting — allow the tool through.
        log(`[StrategicCompact] ${header} acknowledged — continuing without compaction (~${formatTokens(tokenBudget)} tokens).`);
        process.exit(0);
      }

      // "yes", "timeout", "unavailable", or dialog-missing all fall through to
      // exit-2 with instruction, so the user still sees a clear next step.
      const approvedPrefix = answer === 'yes'
        ? 'User approved compaction via prompt. '
        : '';
      const msg =
        `[StrategicCompact] ${header}. ${approvedPrefix}` +
        `Context at ~${formatTokens(tokenBudget)} tokens. ` +
        `Run \`/compact\` now (add "preserve current task context" if mid-task), ` +
        `then retry. This tool call was blocked to force a compaction checkpoint. ` +
        `Opt out with CLAUDE_COMPACT_AUTOBLOCK=0.`;
      process.stderr.write(`${msg}\n`);
      intelLog('suggest-compact', 'warn', `autoblock at ${zone}`, { tokenBudget, count, lastZone, answer });
      process.exit(2); // exit 2 = block tool; stderr is fed back to Claude
    }

    // Tokens dropped (likely after /compact) — re-arm for next escalation.
    if (rank[zone] < rank[lastZone]) {
      try { writeFile(stateFile, zone); } catch { /* best effort */ }
    }
  }

  process.exit(0);
}

function getZone(tokens) {
  if (tokens >= 400000) return 'red';
  if (tokens >= 300000) return 'orange';
  if (tokens >= 200000) return 'yellow';
  return 'green';
}

/**
 * Ask the user via a native OS dialog whether to compact now.
 * Returns 'yes' | 'skip' | 'timeout' | 'unavailable'.
 * Currently implemented for macOS (osascript). Other platforms return
 * 'unavailable' and callers fall back to the stderr-block behaviour.
 */
function askUserCompact(zone, tokens) {
  if (process.env.CLAUDE_COMPACT_PROMPT === '0') return 'unavailable';
  if (process.platform !== 'darwin') return 'unavailable';

  const { execFileSync } = require('child_process');
  const zoneLabel = zone === 'red'
    ? 'RED ZONE (urgent)'
    : 'ORANGE ZONE (context rot risk)';
  const body = `Context at ~${formatTokens(tokens)} tokens — ${zoneLabel}.\n\n` +
    `Run /compact now to preserve context before continuing?`;
  const icon = zone === 'red' ? 'stop' : 'caution';
  const timeoutSec = parseInt(process.env.CLAUDE_COMPACT_PROMPT_TIMEOUT || '30', 10);

  const script =
    `display dialog ${JSON.stringify(body)} ` +
    `buttons {"Skip", "Compact now"} default button "Compact now" ` +
    `with title "Claude Code — Auto-Compact" with icon ${icon} ` +
    `giving up after ${timeoutSec}`;

  try {
    const out = execFileSync('osascript', ['-e', script], {
      encoding: 'utf8',
      timeout: (timeoutSec + 5) * 1000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (/gave up:\s*true/.test(out)) return 'timeout';
    if (/button returned:\s*Compact now/.test(out)) return 'yes';
    if (/button returned:\s*Skip/.test(out)) return 'skip';
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
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
