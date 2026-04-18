/**
 * Post-compact continuation handoff.
 *
 * PreCompact writes a one-shot handoff file to the project's ~/.claude
 * projects dir. SessionStart (matcher=compact fires through the same
 * bootstrap hook) reads it, renders an `additionalContext` block for
 * Claude Code, and deletes the file — so the continuation context only
 * gets replayed on the NEXT session turn after the compact that wrote
 * it. Subsequent unrelated compacts don't replay stale handoffs.
 *
 * Signals captured:
 *   - currentTask / keyFiles    from session-context.md (user-curated)
 *   - inFlightFiles             from `git status --porcelain` — work not
 *                               yet committed; Claude should finish it
 *   - recentCommits             from `git log --since=<sessionStart>` —
 *                               what was shipped in this session
 *   - hotDirs                   last 5 HOT bands from the shape log
 *
 * Gated by `continue.afterCompact` (default true) in the unified config.
 * Also self-gated: if every signal is empty (no in-flight work, no
 * fresh task, no recent commits, no HOT dirs), we skip the write.
 * Fresh-topic `/compact`s shouldn't drag old context forward.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Optional debug logger. When unavailable (e.g. tests), warn/error calls
// degrade to no-ops instead of crashing the whole module.
let intelLog = () => {};
try { ({ intelLog } = require('./intel-debug')); } catch { /* optional */ }

const HANDOFF_FILENAME = '.si-handoff.json';
const GIT_EXEC_OPTS = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 };
const CURRENT_TASK_STALE_HOURS = 12;

function handoffPath(projectDir) {
  return path.join(projectDir, HANDOFF_FILENAME);
}

const IN_FLIGHT_CAP = 20;

function gitPorcelain(cwd) {
  try {
    const out = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], GIT_EXEC_OPTS);
    const all = out.split('\n').map((l) => l.trim()).filter(Boolean);
    if (all.length <= IN_FLIGHT_CAP) return all;
    // Signal the truncation so the model doesn't silently plan against a
    // subset. The sentinel carries the hidden count so the user can see at
    // a glance that "finish these before starting new work" is incomplete.
    const extra = all.length - IN_FLIGHT_CAP;
    return [...all.slice(0, IN_FLIGHT_CAP), `   ... and ${extra} more (truncated)`];
  } catch { return []; }
}

function gitRecentCommits(cwd, sinceMs) {
  if (!Number.isFinite(sinceMs)) return [];
  const sinceIso = new Date(sinceMs).toISOString();
  try {
    const out = execFileSync('git', [
      '-C', cwd, 'log', `--since=${sinceIso}`,
      '--pretty=format:%h %s', '-n', '10', 'HEAD',
    ], GIT_EXEC_OPTS);
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch { return []; }
}

// Session-context parsing lives in ./session-context.js — single source of
// truth for placeholder stripping, autofill detection, and section
// extraction. We re-export the legacy helpers via `_internal` so existing
// tests (and the `_internal` export at the bottom of this file) stay
// backwards-compatible.
const sessionCtx = require('./session-context');
const parseSessionContextSections = sessionCtx.parseSessionContext;

function readSessionContext(projectDir) {
  const { currentTask, keyFiles, mtimeMs } = sessionCtx.readSessionContext(projectDir);
  return { currentTask, keyFiles, mtimeMs };
}

/**
 * Scan recent memory files for unresolved follow-ups / next priorities.
 *
 * Sources, in order:
 *   1. `memory/MEMORY.md` index (top-level pointers)
 *   2. the most recently modified `memory/project_session_*.md`
 *
 * In each we look for section headers that conventionally hold open work:
 * `## Follow-ups`, `## Open threads`, `## Next steps`, `## Pending`. Items
 * marked as resolved — `~~strikethrough~~`, lines starting with `✅` or
 * `DONE:` — are filtered out so we only surface what's still outstanding.
 *
 * Returns up to 5 items, each trimmed to one line.
 */
function readNextPriorities(projectDir) {
  if (!projectDir) return [];
  const memoryDir = path.join(projectDir, 'memory');
  if (!fs.existsSync(memoryDir)) return [];

  const candidates = [];
  const indexPath = path.join(memoryDir, 'MEMORY.md');
  if (fs.existsSync(indexPath)) candidates.push(indexPath);

  try {
    const projectFiles = fs.readdirSync(memoryDir)
      .filter((f) => f.startsWith('project_session_') && f.endsWith('.md'))
      .map((f) => ({ f, stat: fs.statSync(path.join(memoryDir, f)) }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    if (projectFiles[0]) candidates.push(path.join(memoryDir, projectFiles[0].f));
  } catch { /* ignore */ }

  const items = [];
  const seen = new Set();
  const sectionRe = /^##\s+(Follow-ups|Open threads|Next steps|Pending|Follow-ups\s*\/\s*open threads)/i;
  // Resolved if: whole body is strikethrough, line contains a check mark,
  // or body starts with DONE:. The strikethrough pattern allows a prefix
  // annotation ("~~done~~ notes" still counts as resolved; leftover text
  // is just the explanation of the resolution).
  const isResolved = (body) => {
    if (/^~~[^~]+~~/.test(body)) return true;
    if (/[✅✓]/.test(body)) return true;
    if (/^DONE\b[:\s]/i.test(body)) return true;
    return false;
  };

  for (const file of candidates) {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); }
    catch { continue; }
    const lines = content.split('\n');
    let inSection = false;
    for (const raw of lines) {
      if (sectionRe.test(raw)) { inSection = true; continue; }
      if (/^##\s+/.test(raw))   { inSection = false; continue; }
      if (!inSection) continue;

      const line = raw.trim();
      if (!line) continue;
      // Pick numbered / bulleted items only; body prose inside a section
      // is noise.
      if (!/^(\d+\.|[-*])\s/.test(line)) continue;

      // Strip the bullet / number prefix BEFORE the resolved check so
      // `1. ~~done~~ notes` is correctly identified as a resolved item.
      const body = line.replace(/^(\d+\.|[-*])\s+/, '').trim();
      if (!body) continue;
      if (isResolved(body)) continue;
      if (body.length > 200) continue; // skip long paragraphs masquerading as bullets

      const key = body.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(body);
      if (items.length >= 5) return items;
    }
  }

  return items;
}

/**
 * Write the handoff. Self-gated: when every signal is empty the write is
 * skipped so a `/compact` to change topics doesn't leave a stale file.
 *
 * @param {{
 *   projectDir: string | null,
 *   cwd: string,
 *   sessionId: string,
 *   sessionStartMs?: number,
 *   hotDirs?: string[],
 *   droppedDirs?: string[],
 * }} opts
 * @returns {boolean} whether a file was actually written
 */
function writeHandoff(opts) {
  const { projectDir, cwd, sessionId } = opts || {};
  if (!projectDir || !cwd) return false;

  const ctx = readSessionContext(projectDir);
  const ctxAgeHours = ctx.mtimeMs
    ? (Date.now() - ctx.mtimeMs) / 3600000
    : Number.POSITIVE_INFINITY;
  const currentTaskFresh = ctx.currentTask && ctxAgeHours < CURRENT_TASK_STALE_HOURS;

  const nextPriorities = readNextPriorities(projectDir);
  const inFlight = gitPorcelain(cwd);
  const recentCommits = gitRecentCommits(cwd, opts.sessionStartMs || (Date.now() - 8 * 3600000));
  const hotDirs = Array.isArray(opts.hotDirs) ? opts.hotDirs.slice(0, 5) : [];
  const droppedDirs = Array.isArray(opts.droppedDirs) ? opts.droppedDirs.slice(0, 5) : [];

  // Gate: require at least one STRONG directional signal — a fresh current
  // task or an unresolved memory follow-up. In-flight files and recent
  // commits are WEAK on their own (they describe state, not direction). If
  // only WEAK signals exist, the session wrapped cleanly or the user
  // `/compact`ed for a topic pivot — don't replay stale context either way.
  const hasStrongSignal = currentTaskFresh || nextPriorities.length > 0;
  if (!hasStrongSignal) return false;

  const handoff = {
    t: Date.now(),
    sessionId: sessionId || null,
    cwd,
    currentTask: currentTaskFresh ? ctx.currentTask : '',
    currentTaskAgeHours: currentTaskFresh ? Number(ctxAgeHours.toFixed(1)) : null,
    keyFiles: ctx.keyFiles || '',
    nextPriorities,
    inFlightFiles: inFlight,
    recentCommits,
    hotDirs,
    droppedDirs,
  };

  // Atomic write: stream to a pid/ts-suffixed temp file first, then
  // rename into place. renameSync is atomic on POSIX within a filesystem,
  // so a concurrent reader sees either the previous file or the complete
  // new one — never `{ ` or `{\n` truncated mid-write. Addresses observed
  // "handoff parse failed at position 2" warnings in the dogfood log
  // where a reader hit a partially-flushed file.
  const finalPath = handoffPath(projectDir);
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`;
  const payload = JSON.stringify(handoff, null, 2) + '\n';
  try {
    fs.writeFileSync(tmpPath, payload);
    fs.renameSync(tmpPath, finalPath);
    return true;
  } catch (err) {
    // Distinguishable from the intentional "no strong signal" skip: the
    // caller treats both as `wrote: false`, but this one leaves a log
    // trail so a disk-full / permissions / bad-path regression is
    // diagnosable after the fact.
    intelLog('handoff', 'warn', 'writeHandoff failed', {
      path: finalPath,
      code: err && err.code,
      err: err && err.message,
    });
    // Best-effort cleanup of the orphaned tmp file. Missing is fine.
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    return false;
  }
}

/**
 * Read and render the handoff as a markdown block. One-shot: the file is
 * deleted on success so it doesn't replay across unrelated compacts.
 * Returns '' when missing, unreadable, or stale (>1h old, in which case
 * we also clean up).
 *
 * @param {string | null} projectDir
 * @returns {string}
 */
function readAndRenderHandoff(projectDir) {
  if (!projectDir) return '';
  const file = handoffPath(projectDir);

  // Atomic consume: rename-to-owned before read so two concurrent Claude
  // sessions opened on the same repo don't both replay the same handoff.
  // rename() on POSIX is atomic within a filesystem; the process that wins
  // the rename proceeds, the loser gets ENOENT and returns empty.
  const owned = `${file}.${process.pid}.${Date.now()}`;
  try { fs.renameSync(file, owned); }
  catch (err) {
    // ENOENT is the normal "no handoff to consume" case — silent.
    // Anything else (EACCES, EBUSY on Windows) is worth a trail.
    if (err && err.code !== 'ENOENT') {
      intelLog('handoff', 'warn', 'handoff rename failed', { file, code: err.code, err: err.message });
    }
    return '';
  }

  let raw;
  try { raw = fs.readFileSync(owned, 'utf8'); }
  catch (err) {
    intelLog('handoff', 'warn', 'handoff read failed', { code: err && err.code, err: err && err.message });
    try { fs.unlinkSync(owned); } catch { /* ignore */ }
    return '';
  }

  let handoff;
  try { handoff = JSON.parse(raw); }
  catch (err) {
    // Preserve forensic snapshot — rename to .corrupt.<ts> so we can see
    // what was on disk. Log byte count + a short preview so the warning
    // surfaces the most useful triage info without quoting potentially
    // large payloads. Caller still treats this as "no handoff" and moves on.
    const preview = raw.length > 80 ? raw.slice(0, 80) + '...' : raw;
    intelLog('handoff', 'warn', 'handoff parse failed', {
      code: err && err.code,
      err: err && err.message,
      bytes: raw.length,
      preview,
    });
    try {
      const forensic = `${handoffPath(projectDir)}.corrupt.${Date.now()}`;
      fs.renameSync(owned, forensic);
    } catch {
      try { fs.unlinkSync(owned); } catch { /* ignore */ }
    }
    return '';
  }

  // Stale handoff (>1h) — don't replay, just clean up.
  if (handoff && Number.isFinite(handoff.t) && Date.now() - handoff.t > 3600000) {
    try { fs.unlinkSync(owned); } catch { /* ignore */ }
    return '';
  }

  const block = renderHandoffBlock(handoff);
  try { fs.unlinkSync(owned); } catch { /* one-shot; ignore cleanup failure */ }
  return block;
}

// Produce the user-visible stderr rendering: the full block wrapped in a
// banner so it surfaces in Claude Code's "SessionStart completed successfully"
// transcript line. SessionStart stdout is reserved for the JSON
// additionalContext payload, so stderr is the only channel the user actually
// sees on the CLI. Separate function — the caller chooses whether to display.
function renderHandoffStderr(block) {
  if (!block) return '';
  const div = '\u2501'.repeat(51);
  return [
    div,
    '  SESSION INTELLIGENCE \u2014 post-compact resume',
    div,
    '',
    block,
    div,
    '',
  ].join('\n');
}

// Short user-facing banner — first line of the task plus counts of the
// other signals. Kept to 2-4 lines so it doesn't flood the transcript.
function renderHandoffBanner(handoff) {
  if (!handoff) return '';
  const taskFirstLine = String(handoff.currentTask || '').split('\n').find((l) => l.trim()) || '';
  const head = taskFirstLine
    ? `\u2192 resuming: ${taskFirstLine.trim().slice(0, 100)}`
    : '\u2192 resuming previous session';
  const parts = [];
  if (Array.isArray(handoff.inFlightFiles) && handoff.inFlightFiles.length) {
    parts.push(`${handoff.inFlightFiles.length} in-flight`);
  }
  if (Array.isArray(handoff.recentCommits) && handoff.recentCommits.length) {
    parts.push(`${handoff.recentCommits.length} commits`);
  }
  if (Array.isArray(handoff.nextPriorities) && handoff.nextPriorities.length) {
    parts.push(`${handoff.nextPriorities.length} follow-ups`);
  }
  const tail = parts.length ? `  (${parts.join(', ')})` : '';
  return `[session-intelligence] ${head}${tail}`;
}

function renderHandoffBlock(handoff) {
  if (!handoff) return '';
  const lines = [];
  lines.push('Resuming after /compact. Session state captured just before the pause:');
  lines.push('');

  if (handoff.currentTask) {
    lines.push(`Current task (from session-context.md, ${handoff.currentTaskAgeHours ?? '?'}h fresh):`);
    for (const raw of String(handoff.currentTask).split('\n')) {
      const l = raw.trim();
      if (l) lines.push(`  ${l}`);
    }
    lines.push('');
  }

  if (Array.isArray(handoff.nextPriorities) && handoff.nextPriorities.length) {
    lines.push('Next priorities (from memory):');
    for (const n of handoff.nextPriorities) lines.push(`  - ${n}`);
    lines.push('');
  }

  if (Array.isArray(handoff.inFlightFiles) && handoff.inFlightFiles.length) {
    lines.push('In-flight (uncommitted) files — finish these before starting new work:');
    for (const f of handoff.inFlightFiles) lines.push(`  ${f}`);
    lines.push('');
  }

  if (Array.isArray(handoff.recentCommits) && handoff.recentCommits.length) {
    lines.push('Commits shipped this session:');
    for (const c of handoff.recentCommits) lines.push(`  ${c}`);
    lines.push('');
  }

  if (Array.isArray(handoff.hotDirs) && handoff.hotDirs.length) {
    lines.push(`Recently active directories: ${handoff.hotDirs.join(', ')}`);
    lines.push('');
  }

  lines.push('Ask the user before pivoting — if the `/compact` was meant to change topics, say so and this context becomes stale. Otherwise continue with the next priority above.');
  return lines.join('\n');
}

module.exports = {
  writeHandoff,
  readAndRenderHandoff,
  renderHandoffBlock,
  renderHandoffBanner,
  renderHandoffStderr,
  handoffPath,
  _internal: {
    parseSessionContextSections,
    readSessionContext,
    readNextPriorities,
    gitPorcelain,
    gitRecentCommits,
  },
};
