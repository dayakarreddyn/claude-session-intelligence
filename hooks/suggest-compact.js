#!/usr/bin/env node
/**
 * Strategic Compact Suggester (with Token Budget Awareness)
 *
 * Runs on PreToolUse to suggest compaction at logical intervals.
 * Combines tool-call counting with approximate token budget from
 * the token-budget-tracker PostToolUse hook.
 *
 * Token zones (from Anthropic research on 1M context):
 *   Green  (<200k): free zone
 *   Yellow (200-300k): caution, compact between tasks
 *   Orange (300-400k): context rot zone, compact soon
 *   Red    (>400k): urgent, compact immediately
 *
 * Works standalone or alongside ECC.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

async function main() {
  const sessionId = (process.env.CLAUDE_SESSION_ID || 'default').replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
  const counterFile = path.join(os.tmpdir(), `claude-tool-count-${sessionId}`);
  const budgetFile = path.join(os.tmpdir(), `claude-token-budget-${sessionId}`);
  const rawThreshold = parseInt(process.env.COMPACT_THRESHOLD || '50', 10);
  const threshold = Number.isFinite(rawThreshold) && rawThreshold > 0 && rawThreshold <= 10000
    ? rawThreshold
    : 50;

  let count = 1;

  // Increment tool call counter
  try {
    const fd = fs.openSync(counterFile, 'a+');
    try {
      const buf = Buffer.alloc(64);
      const bytesRead = fs.readSync(fd, buf, 0, 64, 0);
      if (bytesRead > 0) {
        const parsed = parseInt(buf.toString('utf8', 0, bytesRead).trim(), 10);
        count = (Number.isFinite(parsed) && parsed > 0 && parsed <= 1000000)
          ? parsed + 1
          : 1;
      }
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, String(count), 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    try {
      fs.writeFileSync(counterFile, String(count), 'utf8');
    } catch { /* ignore */ }
  }

  // Read token budget
  let tokenBudget = 0;
  try {
    const raw = fs.readFileSync(budgetFile, 'utf8').trim();
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) tokenBudget = parsed;
  } catch { /* no budget file yet */ }

  const zone = getZone(tokenBudget);
  const budgetStr = tokenBudget > 0 ? ` (~${fmt(tokenBudget)} tokens, ${zone} zone)` : '';

  // Tool-call based suggestions
  if (count === threshold) {
    console.error(`[StrategicCompact] ${threshold} tool calls reached${budgetStr} - consider /compact if transitioning phases`);
  }
  if (count > threshold && (count - threshold) % 25 === 0) {
    console.error(`[StrategicCompact] ${count} tool calls${budgetStr} - good checkpoint for /compact if context is stale`);
  }

  // Token-budget zone transitions
  if (tokenBudget > 0) {
    const prevZone = getZone(tokenBudget - 5000);
    if (zone === 'yellow' && prevZone === 'green') {
      console.error(`[StrategicCompact] ~${fmt(tokenBudget)} tokens \u2014 entering caution zone. Good time to /compact between tasks.`);
    } else if (zone === 'orange' && prevZone === 'yellow') {
      console.error(`[StrategicCompact] ~${fmt(tokenBudget)} tokens \u2014 CONTEXT ROT ZONE. Compact now: /compact [preserve current task context]`);
    } else if (zone === 'red' && prevZone === 'orange') {
      console.error(`[StrategicCompact] ~${fmt(tokenBudget)} tokens \u2014 URGENT. /compact immediately or /clear and start fresh.`);
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

function fmt(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

main().catch(err => {
  console.error('[StrategicCompact] Error:', err.message);
  process.exit(0);
});
