#!/usr/bin/env node
/**
 * Token Budget Tracker — PostToolUse hook
 *
 * Tracks approximate token usage per session by measuring tool I/O sizes.
 * Writes cumulative estimate to a temp file that suggest-compact reads.
 *
 * Token estimation: ~4 characters per token (rough but directionally correct).
 * Each tool call adds ~100 tokens overhead for schema/framing.
 *
 * Works standalone or alongside ECC.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// intel-debug: optional timestamped logger. Falls back to a no-op if missing.
let intelLog = () => {};
try {
  ({ intelLog } = require('../lib/intel-debug'));
} catch {
  try {
    ({ intelLog } = require('./session-intelligence/lib/intel-debug'));
  } catch {
    try {
      ({ intelLog } = require(path.join(__dirname, '..', 'lib', 'intel-debug')));
    } catch { /* debug logging unavailable — hook still runs */ }
  }
}

const CHARS_PER_TOKEN = 4;
const TOOL_OVERHEAD_TOKENS = 100;

async function main() {
  const sessionId = (process.env.CLAUDE_SESSION_ID || 'default').replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
  const budgetFile = path.join(os.tmpdir(), `claude-token-budget-${sessionId}`);
  intelLog('token-budget', 'debug', 'hook fired', { sessionId, budgetFile });

  // Read stdin for tool output data
  let inputData = '';
  try {
    inputData = fs.readFileSync(0, 'utf8');
  } catch {
    // No stdin
  }

  // Estimate tokens from this tool call
  let callTokens = TOOL_OVERHEAD_TOKENS;
  try {
    const parsed = JSON.parse(inputData);
    const output = parsed.tool_output || parsed.output || parsed.result || '';
    const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
    callTokens += Math.ceil(outputStr.length / CHARS_PER_TOKEN);

    const input = parsed.tool_input || parsed.input || '';
    const inputStr = typeof input === 'string' ? input : JSON.stringify(input);
    callTokens += Math.ceil(inputStr.length / CHARS_PER_TOKEN);
  } catch {
    callTokens += Math.ceil(inputData.length / CHARS_PER_TOKEN);
  }

  // Accumulate to budget file
  let cumulative = 0;
  try {
    const fd = fs.openSync(budgetFile, 'a+');
    try {
      const buf = Buffer.alloc(64);
      const bytesRead = fs.readSync(fd, buf, 0, 64, 0);
      if (bytesRead > 0) {
        const parsed = parseInt(buf.toString('utf8', 0, bytesRead).trim(), 10);
        if (Number.isFinite(parsed) && parsed > 0 && parsed <= 10000000) {
          cumulative = parsed;
        }
      }
      cumulative += callTokens;
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, String(cumulative), 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Silently fail — supplementary tracking
  }

  // Log at zone transitions only
  const prevZone = getZone(cumulative - callTokens);
  const newZone = getZone(cumulative);

  if (newZone !== prevZone && newZone !== 'green') {
    const messages = {
      yellow: `[TokenBudget] ~${fmt(cumulative)} tokens — good time to /compact after current task`,
      orange: `[TokenBudget] ~${fmt(cumulative)} tokens — context rot zone. Consider /compact now`,
      red:    `[TokenBudget] ~${fmt(cumulative)} tokens — compact immediately to prevent degraded output`
    };
    console.error(messages[newZone] || '');
    intelLog('token-budget', 'info', `zone transition ${prevZone} → ${newZone}`, { cumulative, callTokens });
  } else {
    intelLog('token-budget', 'debug', `tick ${newZone}`, { cumulative, callTokens });
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
  console.error('[TokenBudget] Error:', err.message);
  intelLog('token-budget', 'error', 'hook crashed', { err: err.message });
  process.exit(0);
});
