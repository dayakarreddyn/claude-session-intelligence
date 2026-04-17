#!/usr/bin/env node
/**
 * Token Budget Tracker — PostToolUse hook
 *
 * Cross-platform (Windows, macOS, Linux)
 *
 * Tracks approximate token usage per session by measuring tool output sizes.
 * Writes cumulative estimate to a temp file that suggest-compact.js reads
 * to provide token-aware compaction suggestions.
 *
 * Token estimation (rough but directionally correct):
 *   - 1 token ≈ 4 characters of English text
 *   - Each tool call adds ~100 tokens overhead (schema, framing)
 *   - User/assistant messages add ~200-500 tokens each
 *
 * We only track tool I/O since that's the majority of context growth.
 */

const fs = require('fs');
const path = require('path');
const {
  getTempDir,
  log
} = require('../lib/utils');
const { intelLog } = require('../lib/intel-debug');

const CHARS_PER_TOKEN = 4;
const TOOL_OVERHEAD_TOKENS = 100;

async function main() {
  const sessionId = (process.env.CLAUDE_SESSION_ID || 'default').replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
  const budgetFile = path.join(getTempDir(), `claude-token-budget-${sessionId}`);
  const countFile  = path.join(getTempDir(), `claude-tool-count-${sessionId}`);
  intelLog('token-budget', 'debug', 'hook fired', { sessionId, budgetFile });

  // Unified tool counter — every PostToolUse call increments this file, so
  // "N tools" on the status line reflects ALL tool invocations (not just
  // Edit/Write as the earlier design did).
  try {
    const fd = fs.openSync(countFile, 'a+');
    try {
      const buf = Buffer.alloc(64);
      const bytesRead = fs.readSync(fd, buf, 0, 64, 0);
      let count = 0;
      if (bytesRead > 0) {
        const parsed = parseInt(buf.toString('utf8', 0, bytesRead).trim(), 10);
        if (Number.isFinite(parsed) && parsed > 0 && parsed <= 1000000) count = parsed;
      }
      count += 1;
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, String(count), 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* supplementary — never fail the hook */ }

  // Read stdin for tool output data
  let inputData = '';
  try {
    inputData = fs.readFileSync(0, 'utf8');
  } catch {
    // No stdin available
  }

  // Estimate tokens from this tool call
  let callTokens = TOOL_OVERHEAD_TOKENS;
  try {
    const parsed = JSON.parse(inputData);
    // Tool output/result content
    const output = parsed.tool_output || parsed.output || parsed.result || '';
    const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
    callTokens += Math.ceil(outputStr.length / CHARS_PER_TOKEN);

    // Tool input content (if present)
    const input = parsed.tool_input || parsed.input || '';
    const inputStr = typeof input === 'string' ? input : JSON.stringify(input);
    callTokens += Math.ceil(inputStr.length / CHARS_PER_TOKEN);
  } catch {
    // Couldn't parse — just count the raw input
    callTokens += Math.ceil(inputData.length / CHARS_PER_TOKEN);
  }

  // Accumulate to budget file (atomic-ish read+write)
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
    // Silently fail — this is supplementary tracking
  }

  // Log at zone boundaries (only when crossing, not every call)
  const prevZone = getZone(cumulative - callTokens);
  const newZone = getZone(cumulative);

  if (newZone !== prevZone && newZone !== 'green') {
    const messages = {
      yellow: `[TokenBudget] ~${formatTokens(cumulative)} tokens used — good time to /compact after current task`,
      orange: `[TokenBudget] ~${formatTokens(cumulative)} tokens — context rot zone. Consider /compact now`,
      red:    `[TokenBudget] ~${formatTokens(cumulative)} tokens — compact immediately to prevent degraded output`
    };
    log(messages[newZone] || '');
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

function formatTokens(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

main().catch(err => {
  console.error('[TokenBudget] Error:', err.message);
  intelLog('token-budget', 'error', 'hook crashed', { err: err.message });
  process.exit(0);
});
