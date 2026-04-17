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
  getSessionsDir,
  getDateTimeString,
  getTimeString,
  findFiles,
  ensureDir,
  appendFile,
  readFile,
  log,
  readStdinJson,
  resolveProjectDir,
} = utils;

// Lines that are still template placeholders: either a "key: (…)" pair
// with only parenthesised hint text, or a bullet that is just parens.
// An unfilled session-context.md is worse than no guidance because Claude
// will follow the placeholder literally during compaction.
function isPlaceholderLine(line) {
  const t = line.trim();
  if (!t) return false; // blank lines preserved as whitespace, not stripped
  if (/^[-*]\s*\([^)]*\)\s*$/.test(t)) return true;           // "- (list files)"
  if (/^[A-Za-z][A-Za-z0-9_-]*:\s*\([^)]*\)\s*$/.test(t)) return true; // "type: (a | b)"
  if (/^[A-Z]+:\s*\([^)]*\)\s*$/.test(t)) return true;        // "PRESERVE: (what must...)"
  return false;
}

function stripPlaceholderLines(body) {
  return body
    .split('\n')
    .filter((l) => !isPlaceholderLine(l))
    .join('\n')
    .trim();
}

/**
 * Parse session-context.md into sections keyed by ## headers. Template
 * placeholder lines are stripped so only real user-authored content
 * reaches the compaction prompt.
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
    sections[key] = stripPlaceholderLines(sections[key].join('\n'));
  }
  return sections;
}

/**
 * Format structured compaction hints from parsed session context. Returns
 * an empty string when every section is placeholder-only — we'd rather
 * ship no guidance than misleading guidance.
 */
function formatCompactionHints(sections) {
  const sectionMap = [
    ['Current Task', 'CURRENT TASK:'],
    ['Key Files', 'KEY FILES (must preserve):'],
    ['Key Decisions', 'KEY DECISIONS (must preserve):'],
    ['On Compact', 'COMPACTION INSTRUCTIONS:'],
    ['Completed Tasks (safe to drop details)', 'SAFE TO DROP (resolved \u2014 keep only one-line summaries):'],
  ];

  const body = [];
  for (const [key, label] of sectionMap) {
    if (sections[key]) body.push('', label, sections[key]);
  }
  if (body.length === 0) return '';

  return [
    '',
    'COMPACTION GUIDANCE (from session-context.md):',
    '\u2501'.repeat(50),
    ...body,
    '',
    '\u2501'.repeat(50),
    '',
  ].join('\n');
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

  // Inject compaction hints from session-context.md. Pull cwd from hook stdin
  // (same contract as every other hook) and fall back to process.cwd() only
  // when Claude doesn't supply it — avoids resolving the wrong project when
  // Claude launches the hook from a different directory.
  const stdinInput = readStdinJson();
  const cwd = stdinInput.cwd || (stdinInput.workspace && stdinInput.workspace.current_dir) || process.cwd();
  const projectDir = resolveProjectDir(cwd);

  if (projectDir) {
    const contextFile = path.join(projectDir, 'session-context.md');
    const content = readFile(contextFile);

    if (content && content.trim().length > 0) {
      const sections = parseSessionContext(content);
      const hints = formatCompactionHints(sections);
      if (hints) {
        process.stdout.write(hints);
        log(`[PreCompact] Injected compaction hints from session-context.md`);
        intelLog('pre-compact', 'info', 'injected hints', {
          projectDir: path.basename(projectDir),
          sections: Object.keys(sections).filter((k) => sections[k]),
          bytes: hints.length,
        });
      } else {
        log('[PreCompact] session-context.md is placeholder-only \u2014 compacting without hints');
        intelLog('pre-compact', 'info', 'skipped — placeholder-only', {
          projectDir: path.basename(projectDir),
        });
      }
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
