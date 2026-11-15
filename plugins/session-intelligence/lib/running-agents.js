'use strict';
/**
 * Subagents still working for a session, with the model and effort each one
 * is actually running at.
 *
 * Source of truth is what Claude Code writes beside the session transcript:
 *   <projects>/<encoded-cwd>/<sid>.jsonl                      session transcript
 *   <projects>/<encoded-cwd>/<sid>/subagents/agent-<id>.meta.json
 *   <projects>/<encoded-cwd>/<sid>/subagents/agent-<id>.jsonl
 *
 * The meta file gains `finished: true` when the agent returns. Killed agents
 * and teammates never get the flag, so an unfinished agent also has to have
 * written to its transcript recently. Assistant records carry the resolved
 * `message.model` and `effort`; the launch metadata only names what was
 * requested, so it is the fallback before the first turn lands.
 *
 * Read-only and total: any fs or parse failure yields fewer rows, never a throw.
 */
const fs = require('fs');
const path = require('path');

const STALE_AFTER_MS = 15 * 60 * 1000;
const TAIL_BYTES = 256 * 1024;
const MAX_GROUPS = 3;
const META_SUFFIX = '.meta.json';
const EFFORT_RE = /^[a-z]{1,12}$/;

function subagentsDirOf(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath.endsWith('.jsonl')) return null;
  return path.join(transcriptPath.slice(0, -'.jsonl'.length), 'subagents');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Last TAIL_BYTES of a file as text; '' when unreadable. */
function readTail(file, size) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const length = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

/** Model and effort of the newest assistant record in the transcript tail, or null. */
function latestTurn(file, size) {
  const lines = readTail(file, size).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"assistant"')) continue;
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; } // torn first/last line
    const model = rec && rec.type === 'assistant' && rec.message && rec.message.model;
    if (typeof model !== 'string' || !model) continue;
    const effort = typeof rec.effort === 'string' && EFFORT_RE.test(rec.effort) ? rec.effort : '';
    return { model, effort };
  }
  return null;
}

function describeAgent(dir, metaName, now, staleMs) {
  const transcript = path.join(dir, metaName.slice(0, -META_SUFFIX.length) + '.jsonl');
  let stat;
  try { stat = fs.statSync(transcript); } catch { return null; }
  if (now - stat.mtimeMs > staleMs) return null;
  const meta = readJson(path.join(dir, metaName));
  if (!meta || typeof meta !== 'object' || meta.finished) return null;
  const turn = latestTurn(transcript, stat.size);
  const launchModel = typeof meta.pickedEffortModel === 'string' ? meta.pickedEffortModel : '';
  return {
    agentType: typeof meta.agentType === 'string' ? meta.agentType : '',
    model: turn ? turn.model : launchModel,
    effort: turn ? turn.effort : '',
  };
}

/**
 * @param {{ transcriptPath?: string, now?: number, staleMs?: number }} opts
 * @returns {{ agentType: string, model: string, effort: string }[]}
 */
function listRunningAgents(opts) {
  const { transcriptPath, now = Date.now(), staleMs = STALE_AFTER_MS } = opts || {};
  const dir = subagentsDirOf(transcriptPath);
  if (!dir) return [];
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((name) => name.endsWith(META_SUFFIX))
    .sort()
    .map((name) => describeAgent(dir, name, now, staleMs))
    .filter(Boolean);
}

/** "claude-opus-5-5-20260101" -> "opus-5-5". */
function shortModel(model) {
  const short = String(model || '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
  return short || '?';
}

/**
 * "opus-5-5·high ×2 · fable-5-2·xhigh": agents grouped by model and effort,
 * largest group first; groups past MAX_GROUPS fold into "+<agents>".
 */
function formatRunningAgents(agents) {
  const counts = new Map();
  for (const a of agents || []) {
    const label = shortModel(a.model) + (a.effort ? `·${a.effort}` : '');
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const groups = [...counts.entries()].sort((x, y) => y[1] - x[1]);
  const shown = groups.slice(0, MAX_GROUPS).map(([label, n]) => (n > 1 ? `${label} ×${n}` : label));
  const hidden = groups.slice(MAX_GROUPS).reduce((sum, [, n]) => sum + n, 0);
  return (hidden > 0 ? [...shown, `+${hidden}`] : shown).join(' · ');
}

module.exports = { listRunningAgents, formatRunningAgents, STALE_AFTER_MS };
