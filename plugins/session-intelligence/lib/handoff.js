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

const HANDOFF_FILENAME = '.si-handoff.json';
const GIT_EXEC_OPTS = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 };
const CURRENT_TASK_STALE_HOURS = 12;

function handoffPath(projectDir) {
  return path.join(projectDir, HANDOFF_FILENAME);
}

function gitPorcelain(cwd) {
  try {
    const out = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], GIT_EXEC_OPTS);
    return out.split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 20);
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

// Mirror of si-pre-compact.js's stripPlaceholderLines + parseSessionContext.
// Duplicated intentionally so handoff.js stays standalone — pulling it in
// from the hook file would couple every consumer of handoff to that file's
// internal state.
function stripPlaceholderLines(text) {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      if (t.startsWith('#')) return true;
      if (/^\(.*\)$/.test(t)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

function parseSessionContextSections(content) {
  const sections = {};
  let current = null;
  for (const line of content.split('\n')) {
    const m = line.match(/^##\s+(.+)/);
    if (m) { current = m[1].trim(); sections[current] = []; }
    else if (current) sections[current].push(line);
  }
  for (const k of Object.keys(sections)) {
    sections[k] = stripPlaceholderLines(sections[k].join('\n'));
  }
  return sections;
}

function readSessionContext(projectDir) {
  if (!projectDir) return { currentTask: '', keyFiles: '', mtimeMs: 0 };
  const file = path.join(projectDir, 'session-context.md');
  try {
    const stat = fs.statSync(file);
    const content = fs.readFileSync(file, 'utf8');
    const sections = parseSessionContextSections(content);
    return {
      currentTask: sections['Current Task'] || '',
      keyFiles: sections['Key Files'] || '',
      mtimeMs: stat.mtimeMs,
    };
  } catch { return { currentTask: '', keyFiles: '', mtimeMs: 0 }; }
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

  try {
    fs.writeFileSync(handoffPath(projectDir), JSON.stringify(handoff, null, 2) + '\n');
    return true;
  } catch { return false; }
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
  let handoff;
  try { handoff = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return ''; }

  // Stale handoff (>1h) — don't replay, just remove.
  if (handoff && Number.isFinite(handoff.t) && Date.now() - handoff.t > 3600000) {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
    return '';
  }

  const block = renderHandoffBlock(handoff);
  try { fs.unlinkSync(file); } catch { /* one-shot; ignore cleanup failure */ }
  return block;
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
  handoffPath,
  _internal: {
    parseSessionContextSections,
    readSessionContext,
    readNextPriorities,
    gitPorcelain,
    gitRecentCommits,
  },
};
