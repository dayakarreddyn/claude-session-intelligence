#!/usr/bin/env node
/**
 * Tool-Response Archive — PostToolUse hook.
 *
 * When a tool call returns a large body (Read of a big file, Bash log dump,
 * Grep with many hits), the payload sits in the context window until /compact
 * erases it. If the model later wants the detail back, re-running the tool
 * pays tokens + wall time for data we already had. This hook snapshots the
 * body to disk keyed by `tool_use_id`, so `si expand <id>` (or the CLI at
 * `tools/expand.js`) replays the exact payload after compaction.
 *
 * Observational only. We do not truncate or rewrite the result the model
 * just received — the model sees the full body on the call itself, and the
 * archive is purely a retrieval path for after compact.
 */

const fs = require('fs');
const path = require('path');

function resolveSiLibDir() {
  const candidates = [
    path.join(__dirname, '..', 'lib'),
    path.join(__dirname, 'session-intelligence', 'lib'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'tool-archive.js'))) return dir;
  }
  return candidates[0];
}
const SI_LIB = resolveSiLibDir();

const toolArchive = require(path.join(SI_LIB, 'tool-archive'));

let intelLog = () => {};
try { intelLog = require(path.join(SI_LIB, 'intel-debug')).intelLog; } catch { /* optional */ }

function loadSiConfig() {
  try { return require(path.join(SI_LIB, 'config')).loadConfig(); }
  catch { return {}; }
}

function main() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  let payload = null;
  try { payload = raw.trim() ? JSON.parse(raw) : null; } catch { /* ignore */ }
  if (!payload) { process.exit(0); return; }

  const cfg = loadSiConfig();
  const opts = (cfg && cfg.toolArchive) || {};
  if (opts.enabled === false) { process.exit(0); return; }

  const rawSid = payload.session_id || payload.sessionId || process.env.CLAUDE_SESSION_ID || 'default';
  const { id, body, toolName, toolInput } = toolArchive.extractFromPayload(payload);

  // No tool_use_id means we can't replay a specific archive later — skip
  // rather than write an un-addressable blob to disk.
  if (!id) {
    intelLog('tool-archive', 'debug', 'skipped — no tool_use_id on payload', { tool: toolName });
    process.exit(0);
    return;
  }

  const written = toolArchive.writeArchive(rawSid, id, { tool_name: toolName, tool_input: toolInput }, body, opts);
  if (written) {
    intelLog('tool-archive', 'info', 'archived tool response',
      { id, tool: toolName, chars: (typeof body === 'string' ? body.length : 0), path: written });
  }

  process.exit(0);
}

try {
  main();
} catch (err) {
  // Never fail the hook — archive is best-effort.
  intelLog('tool-archive', 'error', 'hook crashed', { err: err && err.message });
  process.exit(0);
}
