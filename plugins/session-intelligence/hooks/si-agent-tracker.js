#!/usr/bin/env node
/**
 * Agent-invocation tracker — PostToolUse hook.
 *
 * The subagent-spawn tool is how the parent session delegates work (Explore,
 * code-reviewer, etc.). Depending on the harness build this tool is named
 * either `Task` or `Agent` — we match both, since real payloads here arrive
 * as `Agent` and matching only `Task` silently dropped every invocation.
 * Each call is a discrete unit of delegated work worth measuring: which agent,
 * how big the prompt and response were, how often it errored. We don't get the
 * subagent's internal token breakdown from the hook payload — only the
 * parent-visible envelope.
 *
 * Pairs with the SQLite events store via recordAgentInvocation(). Like
 * every other telemetry hook here, errors are swallowed and the process
 * exits 0 so the tool pipeline keeps moving.
 */

const fs = require('fs');
const path = require('path');

function resolveSiLibDir() {
  const candidates = [
    path.join(__dirname, '..', 'lib'),
    path.join(__dirname, 'session-intelligence', 'lib'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'events.js'))) return dir;
  }
  return candidates[0];
}
const SI_LIB = resolveSiLibDir();

const events = require(path.join(SI_LIB, 'events'));
const agentUsage = require(path.join(SI_LIB, 'agent-usage'));

let intelLog = () => {};
try { intelLog = require(path.join(SI_LIB, 'intel-debug')).intelLog; } catch { /* optional */ }

function responseSize(payload) {
  const raw = payload.tool_response !== undefined ? payload.tool_response
            : payload.tool_output   !== undefined ? payload.tool_output
            : payload.output        !== undefined ? payload.output
            : payload.result        !== undefined ? payload.result
            : '';
  if (typeof raw === 'string') return raw.length;
  try { return JSON.stringify(raw).length; } catch { return 0; }
}

function isErrorResponse(payload) {
  // Claude Code surfaces subagent failures as `is_error: true` on the
  // tool_response envelope, or as a string body starting with "Error".
  const r = payload.tool_response;
  if (r && typeof r === 'object' && r.is_error) return true;
  if (typeof r === 'string' && /^error[: ]/i.test(r)) return true;
  return false;
}

function main() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  let payload = null;
  try { payload = raw.trim() ? JSON.parse(raw) : null; } catch { /* ignore */ }
  if (!payload) { process.exit(0); return; }

  const toolName = payload.tool_name || payload.toolName || '';
  // Subagent-spawn tool is `Task` in some builds, `Agent` in others. Match both.
  if (toolName !== 'Task' && toolName !== 'Agent') { process.exit(0); return; }

  const sid = payload.session_id || payload.sessionId || process.env.CLAUDE_SESSION_ID;
  if (!sid) { process.exit(0); return; }

  const input = payload.tool_input || payload.toolInput || {};
  const subagentType = input.subagent_type || input.subagentType || null;
  const description = input.description || null;
  const promptText = typeof input.prompt === 'string' ? input.prompt : '';
  const toolUseId = payload.tool_use_id || payload.toolUseId || null;
  const cwd = payload.cwd || process.cwd();

  // Authoritative usage comes from the subagent's own transcript file.
  // It may not be flushed for a beat after PostToolUse fires — best-effort:
  // we record what's there, and the row's chars/duration stay accurate even
  // when token data is unavailable (older Claude Code, locked-down filesystem).
  let usage = null;
  try {
    usage = agentUsage.findUsageForTask({ cwd, sid, parentToolUseId: toolUseId });
  } catch (err) {
    intelLog('agent-tracker', 'debug', 'usage lookup failed', { err: err && err.message });
  }

  const ok = events.recordAgentInvocation({
    sid,
    toolUseId,
    subagentType,
    description,
    promptChars: promptText.length || null,
    responseChars: responseSize(payload),
    durationMs: usage && usage.durationMs,
    t: Date.now(),
    isError: isErrorResponse(payload),
    model: usage && usage.model,
    inputTokens: usage && usage.usage && usage.usage.input_tokens,
    outputTokens: usage && usage.usage && usage.usage.output_tokens,
    cacheCreationTokens: usage && usage.usage && usage.usage.cache_creation_input_tokens,
    cacheReadTokens: usage && usage.usage && usage.usage.cache_read_input_tokens,
    costUsd: usage && usage.costUsd,
  });
  if (ok) {
    intelLog('agent-tracker', 'info', 'recorded agent invocation', {
      type: subagentType,
      prompt: promptText.length,
      response: responseSize(payload),
      model: usage && usage.model,
      cost: usage && usage.costUsd,
      duration: usage && usage.durationMs,
    });
  }
  process.exit(0);
}

try {
  main();
} catch (err) {
  try { intelLog('agent-tracker', 'error', 'hook crashed', { err: err && err.message }); } catch { /* ignore */ }
  process.exit(0);
}
