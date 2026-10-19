#!/usr/bin/env node
/**
 * Output pruner — one hook file, two events.
 *
 *   PostToolUse: a tool result whose full body is already archived on disk and
 *     exceeds the prune floor is replaced (for THIS result only) by a
 *     head/tail excerpt via `hookSpecificOutput.updatedToolOutput`.
 *   PreToolUse:  well-known noisy Bash commands (test runners, log cats) are
 *     rewritten via `hookSpecificOutput.updatedInput`. No `permissionDecision`
 *     is emitted, so the normal permission prompt still runs on the rewritten
 *     command.
 *
 * stdout is the JSON channel (nothing when there is no change). Exits 0 on
 * every path: a pruner failure must never break a tool call. Earlier
 * transcript turns are never touched.
 */

const fs = require('fs');
const path = require('path');

function resolveSiLibDir() {
  const candidates = [
    path.join(__dirname, '..', 'lib'),
    path.join(__dirname, 'session-intelligence', 'lib'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'prune.js'))) return dir;
  }
  return candidates[0];
}
const SI_LIB = resolveSiLibDir();

let intelLog = () => {};
try { intelLog = require(path.join(SI_LIB, 'intel-debug')).intelLog; } catch { /* optional */ }

function emit(hookSpecificOutput) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput }));
}

function loadPruneConfig() {
  try { return require(path.join(SI_LIB, 'config')).loadConfig().prune || {}; }
  catch { return {}; }
}

function loadArchiveConfig() {
  try { return require(path.join(SI_LIB, 'config')).loadConfig().toolArchive || {}; }
  catch { return {}; }
}

function handlePre(payload, cfg) {
  if (payload.tool_name !== 'Bash') return;
  if (cfg.rewriteInput === false || cfg.enabled === false) return;
  const input = payload.tool_input;
  if (!input || typeof input.command !== 'string' || input.run_in_background) return;
  const { command, rule } = require(path.join(SI_LIB, 'prune')).rewriteCommand(input.command, cfg.inputRules);
  if (!rule || command === input.command) return;
  intelLog('prune', 'info', 'rewrote bash command', { rule });
  emit({ hookEventName: 'PreToolUse', updatedInput: { ...input, command } });
}

function ensureArchived(sid, id, toolName, toolInput, body) {
  const toolArchive = require(path.join(SI_LIB, 'tool-archive'));
  if (toolArchive.readArchive(sid, id)) return true;
  // The prune floor can sit above the archive threshold; archive with the
  // threshold lowered to 0 so the full body is always on disk before pruning.
  const written = toolArchive.writeArchive(sid, id,
    { tool_name: toolName, tool_input: toolInput }, body,
    { ...loadArchiveConfig(), enabled: true, thresholdChars: 1 });
  return Boolean(written);
}

function handlePost(payload, cfg) {
  const { decidePrune } = require(path.join(SI_LIB, 'prune'));
  const toolArchive = require(path.join(SI_LIB, 'tool-archive'));
  const { id, toolName, toolInput } = toolArchive.extractFromPayload(payload);
  // Raw response (not stringified) so structured MCP results are rejected.
  const raw = payload.tool_response !== undefined ? payload.tool_response : payload.tool_output;
  const decision = decidePrune({ toolName, toolUseId: id, body: raw, cfg });
  if (!decision.pruned) return;

  const sid = payload.session_id || payload.sessionId || process.env.CLAUDE_SESSION_ID || 'default';
  if (!ensureArchived(sid, id, toolName, toolInput, raw)) {
    intelLog('prune', 'warn', 'skipped — archive write failed', { id, tool: toolName });
    return;
  }
  try { require(path.join(SI_LIB, 'events')).markArchivePruned(id); } catch { /* best-effort */ }
  intelLog('prune', 'info', 'pruned tool output',
    { id, tool: toolName, originalChars: decision.originalChars, excerptChars: decision.excerptChars });
  emit({ hookEventName: 'PostToolUse', updatedToolOutput: decision.output });
}

function main() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  let payload = null;
  try { payload = raw.trim() ? JSON.parse(raw) : null; } catch { /* ignore */ }
  if (!payload) return;
  const cfg = loadPruneConfig();
  if (payload.hook_event_name === 'PreToolUse') handlePre(payload, cfg);
  else if (payload.hook_event_name === 'PostToolUse') handlePost(payload, cfg);
}

try { main(); } catch (err) {
  intelLog('prune', 'error', 'hook crashed', { err: err && err.message });
}
process.exit(0);
