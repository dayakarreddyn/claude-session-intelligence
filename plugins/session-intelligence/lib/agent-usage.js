/**
 * Subagent (Task tool) usage extractor.
 *
 * Claude Code writes a dedicated transcript file for every subagent
 * invocation at:
 *   ~/.claude/projects/<encoded-cwd>/<parent-sid>/subagents/agent-<id>.jsonl
 *
 * Each file is the subagent's full conversation — including per-turn usage
 * blocks with authoritative input/output/cache token counts and the model
 * actually used. This is the only honest source of subagent cost; PostToolUse
 * payloads to the parent only carry the final summary, not internal tokens.
 *
 * Attribution: we don't get the agent-id back in the parent's PostToolUse
 * payload, so we match by (1) the file lives under the parent session's
 * subagents/ dir, (2) the file's mtime is recent, (3) its first timestamp
 * is after the Task call started. The most recently modified candidate
 * wins. Parallel Task calls of the same kind running concurrently can
 * cross-attribute, which we accept as a known v1 limitation.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { priceForModel, costFromUsage } = require('./cost-estimation');

/**
 * Convert an absolute cwd into the directory-encoding Claude Code uses
 * for `~/.claude/projects/<encoded>/`. The encoding replaces path
 * separators and dots with hyphens.
 */
function encodeProjectPath(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  return cwd.replace(/[\/.]/g, '-');
}

function projectsRoot(override) {
  if (override) return override;
  return path.join(os.homedir(), '.claude', 'projects');
}

function subagentsDirFor(cwd, sid, projectsRootOverride) {
  const enc = encodeProjectPath(cwd);
  if (!enc || !sid) return null;
  return path.join(projectsRoot(projectsRootOverride), enc, sid, 'subagents');
}

/**
 * List candidate subagent transcript files under `dir`, newest first by
 * mtime. Returns [] when the dir doesn't exist (subagent not flushed yet
 * or never written — both no-ops for us).
 */
function listCandidates(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const rows = [];
  for (const name of names) {
    if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) continue;
    const full = path.join(dir, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    rows.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return rows;
}

/**
 * Parse one subagent transcript. Sum usage across all assistant turns,
 * pick the dominant model (first one seen — subagents rarely switch),
 * compute duration from first→last timestamp.
 *
 * Returns null when the file isn't usable (no usage blocks, malformed).
 */
function readSubagentTranscript(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return null; }
  const lines = raw.split('\n').filter(Boolean);
  if (!lines.length) return null;

  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  let firstTs = null;
  let lastTs = null;
  let model = null;
  let agentId = null;
  let parentToolUseId = null;
  let assistantTurns = 0;
  const seenMessageIds = new Set();

  for (const line of lines) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (!d) continue;

    // Earliest/latest timestamps bound the wall-clock duration.
    const ts = d.timestamp ? Date.parse(d.timestamp) : NaN;
    if (Number.isFinite(ts)) {
      if (firstTs === null || ts < firstTs) firstTs = ts;
      if (lastTs === null || ts > lastTs) lastTs = ts;
    }
    if (!agentId && d.agentId) agentId = d.agentId;
    if (!parentToolUseId && d.parentToolUseId) parentToolUseId = d.parentToolUseId;

    if (d.type !== 'assistant') continue;
    const m = d.message;
    if (!m || !m.usage) continue;

    // Dedupe streaming-snapshot rows by message.id (same pattern used in
    // cost-estimation.js — the transcript repeats the same id across stream
    // chunks and double-counts otherwise).
    if (m.id) {
      if (seenMessageIds.has(m.id)) continue;
      seenMessageIds.add(m.id);
    }
    if (!model && m.model) model = m.model;
    assistantTurns += 1;
    usage.input_tokens += m.usage.input_tokens || 0;
    usage.output_tokens += m.usage.output_tokens || 0;
    usage.cache_creation_input_tokens += m.usage.cache_creation_input_tokens || 0;
    usage.cache_read_input_tokens += m.usage.cache_read_input_tokens || 0;
  }

  if (assistantTurns === 0) return null;

  const prices = priceForModel(model);
  const costUsd = costFromUsage(usage, prices);
  const durationMs = (firstTs !== null && lastTs !== null) ? (lastTs - firstTs) : null;

  return {
    agentId, parentToolUseId, model,
    usage, costUsd, durationMs,
    firstTs, lastTs,
    assistantTurns,
    path: filePath,
  };
}

/**
 * Find the subagent transcript most likely to belong to the Task call we
 * just observed. `windowMs` is how far back to look; the default is wide
 * enough to cover slow subagents but tight enough that an unrelated older
 * run won't get cross-attributed.
 *
 * Returns the parsed transcript (see readSubagentTranscript) or null.
 */
function findUsageForTask({ cwd, sid, parentToolUseId, now = Date.now(), windowMs = 30 * 60 * 1000, projectsRoot: projectsRootOverride } = {}) {
  const dir = subagentsDirFor(cwd, sid, projectsRootOverride);
  if (!dir) return null;
  const candidates = listCandidates(dir);
  if (!candidates.length) return null;

  // First pass: filter by mtime within window. Most recent candidate wins.
  const recent = candidates.filter((c) => (now - c.mtimeMs) <= windowMs);
  if (!recent.length) return null;

  // If parentToolUseId is recorded in the transcript, prefer an exact match.
  if (parentToolUseId) {
    for (const c of recent) {
      const t = readSubagentTranscript(c.path);
      if (t && t.parentToolUseId === parentToolUseId) return t;
    }
  }
  // Fall back to newest mtime.
  return readSubagentTranscript(recent[0].path);
}

module.exports = {
  encodeProjectPath,
  subagentsDirFor,
  listCandidates,
  readSubagentTranscript,
  findUsageForTask,
};
