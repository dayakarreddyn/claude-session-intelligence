#!/usr/bin/env node
/**
 * Session Intelligence — Stop hook.
 *
 * Closes the only memory-write window SI doesn't currently cover. We nudge
 * at zone crossover (PostToolUse) and at /compact (PreCompact), but if a
 * session ends WITHOUT a compact and WITHOUT crossing a zone — which is
 * most short sessions — neither nudge fires, and any insights captured
 * during the session that didn't already land in a file disappear.
 *
 * Mirrors Anthropic's official memory-tool guidance:
 *   "Before a session ends, it updates the progress log. This ensures the
 *   next session has an accurate starting point."
 *   — https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
 *
 * What we do:
 *   1. Resolve the active project's session-context.md.
 *   2. Compare its mtime against the session start time (best-effort,
 *      derived from the shape-log session-state file or the session id's
 *      first-seen timestamp).
 *   3. If the session was non-trivial (≥`stopHook.minToolCalls` PostToolUse
 *      records, default 5) AND session-context.md wasn't touched since the
 *      session began, emit a stderr nudge pointing at the right file.
 *
 * Pure stderr — never blocks Stop. Disable via `stopHook.enabled=false` in
 * `~/.claude/session-intelligence.json` or `CLAUDE_SI_STOP_HOOK=0`.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const SI_LIB = path.join(__dirname, '..', 'lib');

function readStdinJsonOrEmpty() {
  try {
    const buf = fs.readFileSync(0, 'utf8');
    return buf ? (JSON.parse(buf) || {}) : {};
  } catch { return {}; }
}

function loadSiConfig() {
  try { return require(path.join(SI_LIB, 'config')).loadConfig() || {}; }
  catch { return {}; }
}

function intelLog(component, level, msg, data) {
  try {
    const lib = require(path.join(SI_LIB, 'intel-log'));
    if (typeof lib.intelLog === 'function') return lib.intelLog(component, level, msg, data);
  } catch { /* logging is best-effort */ }
}

function resolveProjectDir(cwd) {
  if (!cwd) return null;
  // Mirror the bootstrap walk-up: project dir is keyed by canonical cwd
  // with `/` → `-`. For subdir starts, walk up until we find the matching
  // project dir; otherwise the encoded leaf won't exist.
  let dir = path.resolve(cwd);
  for (let i = 0; i < 10; i++) {
    const encoded = dir.replace(/\//g, '-');
    const candidate = path.join(CLAUDE_DIR, 'projects', encoded);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function shapeLogStat(sid) {
  if (!sid) return null;
  const file = path.join(os.tmpdir(), `claude-ctx-shape-${sid}.jsonl`);
  try {
    const stat = fs.statSync(file);
    const buf = fs.readFileSync(file, 'utf8');
    const entries = buf.split('\n').filter(Boolean).length;
    return { entries, mtime: stat.mtime };
  } catch { return null; }
}

function sessionStartTime(sid) {
  if (!sid) return null;
  const file = path.join(os.tmpdir(), `claude-ctx-shape-${sid}.session.json`);
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && data.startedAt) return new Date(data.startedAt);
  } catch { /* fall through */ }
  return null;
}

function fmtAge(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m ago`;
}

function main() {
  const cfg = loadSiConfig();
  const stopCfg = (cfg && cfg.stopHook) || {};
  // Honour env override first (per-session toggle without editing config).
  if (process.env.CLAUDE_SI_STOP_HOOK === '0') return;
  if (stopCfg.enabled === false) return;

  const input = readStdinJsonOrEmpty();
  const cwd = input.cwd || input.workspace?.current_dir || process.cwd();
  const sid = input.session_id || input.sessionId || process.env.CLAUDE_SESSION_ID || '';

  const projectDir = resolveProjectDir(cwd);
  if (!projectDir) {
    intelLog('stop', 'debug', 'no project dir resolved', { cwd });
    return;
  }

  // Trivial-session guard: don't nudge after a 2-tool-call session.
  const minToolCalls = Number.isFinite(stopCfg.minToolCalls) && stopCfg.minToolCalls >= 0
    ? Math.floor(stopCfg.minToolCalls) : 5;
  const shape = shapeLogStat(sid);
  const toolCalls = shape ? shape.entries : 0;
  if (toolCalls < minToolCalls) {
    intelLog('stop', 'debug', 'below minToolCalls — skipping', { toolCalls, minToolCalls });
    return;
  }

  const ctx = path.join(projectDir, 'session-context.md');
  let ctxMtime = null;
  try { ctxMtime = fs.statSync(ctx).mtime; }
  catch { /* file missing — treat as not-updated */ }

  const start = sessionStartTime(sid);
  // Threshold = session start, falling back to "session-context.md not
  // touched in the last hour" so even sessions where we lost the start
  // marker still get a useful nudge.
  const cutoff = start ? start.getTime() : (Date.now() - 60 * 60 * 1000);
  const updated = ctxMtime && ctxMtime.getTime() >= cutoff;

  if (updated) {
    intelLog('stop', 'debug', 'session-context updated this session', {
      ctxMtime: ctxMtime.toISOString(), cutoff: new Date(cutoff).toISOString(),
    });
    return;
  }

  const memoryDir = path.join(projectDir, 'memory');
  const memoryHint = fs.existsSync(memoryDir)
    ? `or append a one-liner to ${path.join(memoryDir, 'MEMORY.md')}`
    : `or seed ${path.join(projectDir, 'memory')}/ with a project_session_*.md`;

  const lines = [
    '\x1b[1;38;5;208m[session-intelligence]\x1b[0m session ending — Progress Log not updated this session.',
    `  ${ctx}`,
    `  Append one line to ## Progress Log (or ## Key Decisions ${memoryHint})`,
    '  before next session opens, otherwise the next-session pickup costs full re-exploration.',
    '  Disable: CLAUDE_SI_STOP_HOOK=0 or stopHook.enabled=false',
    '',
  ];
  process.stderr.write(lines.join('\n'));
}

try { main(); }
catch (err) {
  // Never block Stop on a hook crash — write the error to stderr so the
  // user sees it, but exit 0.
  try { process.stderr.write(`[si-stop] ${err && err.message ? err.message : err}\n`); } catch { /* nothing */ }
  process.exit(0);
}
