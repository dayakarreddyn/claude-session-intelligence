#!/usr/bin/env node
/**
 * PreCompact Hook — Session Intelligence
 *
 * Reads session-context.md (maintained by Claude during the session) and
 * injects structured PRESERVE/DROP hints into stdout so Claude sees them
 * during compaction. Prevents "bad compacts" where Claude drops context
 * it needs for the next task.
 *
 * Works standalone or alongside ECC.
 */

const fs = require('fs');
const path = require('path');

// Try ECC utils first, fall back to bundled
let utils;
try {
  utils = require('../lib/utils');
} catch {
  try {
    utils = require('./session-intelligence/lib/utils');
  } catch {
    utils = require(path.join(__dirname, '..', 'lib', 'utils'));
  }
}

// intel-debug: same fallback chain. Falls back to a no-op if missing.
let intelLog = () => {};
try {
  ({ intelLog } = require('../lib/intel-debug'));
} catch {
  try {
    ({ intelLog } = require('./session-intelligence/lib/intel-debug'));
  } catch {
    try {
      ({ intelLog } = require(path.join(__dirname, '..', 'lib', 'intel-debug')));
    } catch { /* debug logging unavailable — hook still runs */ }
  }
}

const {
  getClaudeDir,
  getSessionsDir,
  getDateTimeString,
  getTimeString,
  findFiles,
  ensureDir,
  appendFile,
  readFile,
  log
} = utils;

/**
 * Resolve the Claude project directory for the current working directory.
 * Claude Code stores project data in ~/.claude/projects/<encoded-path>/
 */
function resolveProjectMemoryDir(cwd) {
  const claudeDir = getClaudeDir();
  const projectsDir = path.join(claudeDir, 'projects');
  if (!fs.existsSync(projectsDir)) return null;

  // Claude encodes cwd paths: /Users/x/project → -Users-x-project
  const encoded = cwd.replace(/\//g, '-');

  // Direct match first
  const direct = path.join(projectsDir, encoded);
  if (fs.existsSync(path.join(direct, 'session-context.md'))) return direct;

  // Check parent paths (for subdirectories of a project)
  try {
    const dirs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    // Sort by length descending for longest (most specific) match first
    dirs.sort((a, b) => b.name.length - a.name.length);

    for (const d of dirs) {
      const decodedPath = d.name.replace(/^-/, '/').replace(/-/g, '/');
      if (cwd.startsWith(decodedPath) || cwd === decodedPath) {
        const candidate = path.join(projectsDir, d.name);
        if (fs.existsSync(path.join(candidate, 'session-context.md'))) return candidate;
      }
    }

    // Return first dir that exists (even without session-context)
    if (fs.existsSync(direct)) return direct;
  } catch { /* ignore */ }

  return null;
}

/**
 * Parse session-context.md into sections keyed by ## headers.
 */
function parseSessionContext(content) {
  const sections = {};
  let currentSection = null;
  for (const line of content.split('\n')) {
    const headerMatch = line.match(/^##\s+(.+)/);
    if (headerMatch) {
      currentSection = headerMatch[1].trim();
      sections[currentSection] = [];
    } else if (currentSection) {
      sections[currentSection].push(line);
    }
  }
  for (const key of Object.keys(sections)) {
    sections[key] = sections[key].join('\n').trim();
  }
  return sections;
}

/**
 * Format structured compaction hints from parsed session context.
 */
function formatCompactionHints(sections) {
  const lines = [
    '',
    'COMPACTION GUIDANCE (from session-context.md):',
    '\u2501'.repeat(50),
  ];

  const sectionMap = [
    ['Current Task', 'CURRENT TASK:'],
    ['Key Files', 'KEY FILES (must preserve):'],
    ['Key Decisions', 'KEY DECISIONS (must preserve):'],
    ['On Compact', 'COMPACTION INSTRUCTIONS:'],
    ['Completed Tasks (safe to drop details)', 'SAFE TO DROP (resolved \u2014 keep only one-line summaries):'],
  ];

  for (const [key, label] of sectionMap) {
    if (sections[key]) {
      lines.push('', label, sections[key]);
    }
  }

  lines.push('', '\u2501'.repeat(50), '');
  return lines.join('\n');
}

async function main() {
  const sessionsDir = getSessionsDir();
  const compactionLog = path.join(sessionsDir, 'compaction-log.txt');
  ensureDir(sessionsDir);

  // Log compaction event
  const timestamp = getDateTimeString();
  appendFile(compactionLog, `[${timestamp}] Context compaction triggered\n`);

  // Note compaction in active session file
  const sessions = findFiles(sessionsDir, '*-session.tmp');
  if (sessions.length > 0) {
    const timeStr = getTimeString();
    appendFile(sessions[0].path, `\n---\n**[Compaction occurred at ${timeStr}]** - Context was summarized\n`);
  }

  // Inject compaction hints from session-context.md
  const cwd = process.cwd();
  const projectDir = resolveProjectMemoryDir(cwd);

  if (projectDir) {
    const contextFile = path.join(projectDir, 'session-context.md');
    const content = readFile(contextFile);

    if (content && content.trim().length > 0) {
      const sections = parseSessionContext(content);
      const hints = formatCompactionHints(sections);
      process.stdout.write(hints);
      log(`[PreCompact] Injected compaction hints from session-context.md`);
      intelLog('pre-compact', 'info', 'injected hints', {
        projectDir: path.basename(projectDir),
        sections: Object.keys(sections),
        bytes: hints.length,
      });
    } else {
      log('[PreCompact] No session-context.md found \u2014 compacting without hints');
      intelLog('pre-compact', 'warn', 'no session-context.md found', { projectDir: path.basename(projectDir) });
    }
  } else {
    log('[PreCompact] No project directory found \u2014 compacting without hints');
    intelLog('pre-compact', 'warn', 'no project directory resolved', { cwd });
  }

  process.exit(0);
}

main().catch(err => {
  console.error('[PreCompact] Error:', err.message);
  intelLog('pre-compact', 'error', 'hook crashed', { err: err.message });
  process.exit(0);
});
