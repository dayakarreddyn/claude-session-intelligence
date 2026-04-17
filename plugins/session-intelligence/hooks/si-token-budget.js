#!/usr/bin/env node
/**
 * Token Budget Tracker — PostToolUse hook
 *
 * Cross-platform (Windows, macOS, Linux)
 *
 * Tracks approximate token usage per session by measuring tool output sizes.
 * Writes cumulative estimate to a temp file that si-suggest-compact.js reads
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

// Resolve SI lib dir. Source layout: ../lib. Installed layout: bundled under
// ./session-intelligence/lib. Sentinel: context-shape.js is SI-only.
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
  log
} = require(path.join(SI_LIB, 'utils'));
const { intelLog } = require(path.join(SI_LIB, 'intel-debug'));
const { rootDirOf, appendShape } = require(path.join(SI_LIB, 'context-shape'));
// Post-compact regret monitoring is optional — degrade silently when the
// module is not on disk yet (fresh install not synced).
let compactHistory = null;
try { compactHistory = require(path.join(SI_LIB, 'compact-history')); } catch { /* optional */ }

const CHARS_PER_TOKEN = 4;
const TOOL_OVERHEAD_TOKENS = 100;

async function main() {
  // Read stdin FIRST so we can pick up session_id from the hook payload.
  // Claude Code passes the session id on stdin; env is a fallback only.
  let inputData = '';
  try { inputData = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  let parsedInput = null;
  try { parsedInput = inputData.trim() ? JSON.parse(inputData) : null; } catch { /* ignore */ }

  const rawSid = (parsedInput && (parsedInput.session_id || parsedInput.sessionId))
    || process.env.CLAUDE_SESSION_ID
    || 'default';
  const sessionId = String(rawSid).replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
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

  // Estimate tokens from this tool call (stdin was already read above).
  let callTokens = TOOL_OVERHEAD_TOKENS;
  if (parsedInput) {
    const output = parsedInput.tool_output || parsedInput.output || parsedInput.result || '';
    const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
    callTokens += Math.ceil(outputStr.length / CHARS_PER_TOKEN);

    const toolIn = parsedInput.tool_input || parsedInput.input || '';
    const inputStr = typeof toolIn === 'string' ? toolIn : JSON.stringify(toolIn);
    callTokens += Math.ceil(inputStr.length / CHARS_PER_TOKEN);
  } else if (inputData) {
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

  // Shape tracking — observe which directories / phase events this tool call
  // touched, so suggest-compact and pre-compact can generate grounded
  // preserve/drop hints instead of generic "consider /compact". Observation
  // only — decisions happen elsewhere. Never fails the hook.
  try {
    const toolName = (parsedInput && parsedInput.tool_name) || '';
    const toolInput = (parsedInput && parsedInput.tool_input) || {};
    const filePath = toolInput.file_path || toolInput.path || toolInput.notebook_path || '';
    const root = rootDirOf(filePath);
    const cmd = toolInput.command || '';
    let event = null;
    if (toolName === 'Bash' && typeof cmd === 'string') {
      if (/^\s*git\s+commit\b/.test(cmd))                        event = 'commit';
      else if (/^\s*git\s+push\b/.test(cmd))                     event = 'push';
      else if (/^\s*gh\s+pr\s+(create|merge)\b/.test(cmd))       event = 'pr';
    }
    // Only append entries that carry a signal — a pure Bash echo with no file
    // and no event adds noise without informing the analyzer.
    if (root || event) {
      appendShape(sessionId, {
        t: Date.now(),
        tok: cumulative,
        tool: toolName || null,
        root: root || null,
        file: filePath ? String(filePath) : null,
        event,
      });
    }

    // Post-compact regret monitoring: if there's a live snapshot (written by
    // pre-compact within the last 30 calls or 30 min), check whether this
    // tool call is touching a rootDir we told the model was SAFE TO DROP.
    // A hit means the compact was too aggressive; multiple hits dampen
    // future drop suggestions via the adaptiveZones() regret-rate path.
    if (root && compactHistory) {
      try {
        const { regretHit, windowClosed } =
          compactHistory.checkPostCompactRegret(sessionId, root);
        if (regretHit) {
          intelLog('token-budget', 'info', 'post-compact regret hit',
            { root, windowClosed });
        }
      } catch (err) {
        intelLog('token-budget', 'debug', 'regret check failed',
          { err: err && err.message });
      }
    }
  } catch (err) {
    intelLog('token-budget', 'debug', 'shape append failed', { err: err && err.message });
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
