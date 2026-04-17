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

// Resolve SI lib dir. Source layout: ../lib (sibling of hooks/).
// Installed layout: ./session-intelligence/lib (bundled under ECC scripts/hooks/).
// context-shape.js is SI-only, so it's the sentinel distinguishing the full
// SI bundle from an ECC lib dir that happens to carry utils/intel-debug but
// none of the SI-specific modules (and an older utils.js that predates
// readStdinJson, which is the actual source of past crashes).
function resolveSiLibDir() {
  const candidates = [
    path.join(__dirname, '..', 'lib'),
    path.join(__dirname, 'session-intelligence', 'lib'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'context-shape.js'))) return dir;
  }
  return candidates[0];
}
const SI_LIB = resolveSiLibDir();

const utils = require(path.join(SI_LIB, 'utils'));

let intelLog = () => {};
try { ({ intelLog } = require(path.join(SI_LIB, 'intel-debug'))); } catch { /* debug logging unavailable — hook still runs */ }

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

// Optional SI-only modules — degrade silently if absent.
let ctxShape = null;
try { ctxShape = require(path.join(SI_LIB, 'context-shape')); } catch { /* not available */ }

let compactHistory = null;
try { compactHistory = require(path.join(SI_LIB, 'compact-history')); } catch { /* not available */ }

let costEst = null;
try { costEst = require(path.join(SI_LIB, 'cost-estimation')); } catch { /* not available */ }

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
    // At compact-time the work under "## Current Task" is the task we were
    // just on — from the post-compact summariser's perspective it's the
    // last one. "LAST TASK" reads more accurately than "CURRENT TASK" here.
    ['Current Task', 'LAST TASK:'],
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

  // Shape hints pulled from the live tool-usage history for THIS session id
  // (same session id every other hook uses). Generated fresh at compact-time
  // so we never feed the model stale hot/cold bands.
  const rawSid = stdinInput.session_id || stdinInput.sessionId || process.env.CLAUDE_SESSION_ID || 'default';
  const sessionId = String(rawSid).replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
  let shapeInjection = '';
  if (ctxShape) {
    try {
      const entries = ctxShape.readShape(sessionId);
      const analysis = ctxShape.analyzeShape(entries);
      if (analysis) {
        shapeInjection = ctxShape.formatCompactInjection(analysis);
      }
      intelLog('pre-compact', 'info', 'shape analysis', {
        entries: entries.length,
        hasAnalysis: !!analysis,
        shift: analysis && !!analysis.shift,
        hot: analysis ? analysis.hot.length : 0,
        cold: analysis ? analysis.cold.length : 0,
        staleTokens: analysis ? analysis.staleTokens : 0,
      });
    } catch (err) {
      intelLog('pre-compact', 'warn', 'shape analysis failed', { err: err && err.message });
    }
  }

  let hints = '';
  if (projectDir) {
    const contextFile = path.join(projectDir, 'session-context.md');
    const content = readFile(contextFile);

    if (content && content.trim().length > 0) {
      const sections = parseSessionContext(content);
      hints = formatCompactionHints(sections);
      if (hints) {
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

  // Emit a single top-level "Session Intelligence" heading so the model
  // knows this structured block came from the plugin (vs. arbitrary user
  // text). Only when at least one sub-block has content — a lonely heading
  // with no guidance under it wastes tokens and confuses the summariser.
  if (hints || shapeInjection) {
    const bar = '\u2501'.repeat(50);
    process.stdout.write(`\n${bar}\n  SESSION INTELLIGENCE \u2014 compaction guidance\n${bar}\n`);
  }

  // User-authored session-context.md hints first (manual curation, stronger
  // signal), then observed shape (grounded in what actually happened).
  if (hints) {
    process.stdout.write(hints);
    log('[PreCompact] Injected compaction hints from session-context.md');
  }
  if (shapeInjection) {
    process.stdout.write(shapeInjection);
    log('[PreCompact] Injected observed context-shape hints');
  }

  // Learning-loop logging: record this compaction event so future sessions
  // can adapt zones + dampen drop suggestions based on observed behaviour.
  // Also write a per-session snapshot so token-budget-tracker can watch for
  // regret (touching a dropped dir shortly after compact).
  if (compactHistory && ctxShape) {
    try {
      const entries = ctxShape.readShape(sessionId);
      const analysis = ctxShape.analyzeShape(entries);

      // tokens-at-compact = last observed cumulative budget, fallback to 0.
      // cost-at-compact  = same, best-effort from transcript.
      const tokens = entries.length ? (entries[entries.length - 1].tok || 0) : 0;
      const transcriptPath = stdinInput.transcript_path;
      const cost = costEst
        ? costEst.totalCostFromTranscript(transcriptPath, sessionId, costEst.DEFAULT_PRICES)
        : 0;

      const droppedDirs = analysis ? analysis.cold.map((c) => c.root) : [];
      const hotDirs     = analysis ? analysis.hot.map((h) => h.root) : [];

      const historyEntry = {
        t: Date.now(),
        sid: sessionId,
        cwd,
        tokens,
        cost: Number(cost.toFixed(4)),
        hotDirs,
        droppedDirs,
        hadShift: !!(analysis && analysis.shift),
        regretCount: 0, // upgraded later when the snapshot window closes
      };
      compactHistory.appendHistory(historyEntry);

      // Snapshot drives post-compact regret monitoring for up to 30 calls
      // or 30 min — whichever first. si-token-budget.js consumes it.
      compactHistory.writeSnapshot(sessionId, {
        t: historyEntry.t,
        tokens,
        cost: historyEntry.cost,
        hotDirs,
        droppedDirs,
        callsSince: 0,
        regretHits: [],
      });

      intelLog('pre-compact', 'info', 'history + snapshot written', {
        tokens, cost: historyEntry.cost, dropped: droppedDirs.length, hot: hotDirs.length,
      });
    } catch (err) {
      intelLog('pre-compact', 'warn', 'history/snapshot failed', { err: err && err.message });
    }
  }

  process.exit(0);
}

main().catch(err => {
  console.error('[PreCompact] Error:', err.message);
  intelLog('pre-compact', 'error', 'hook crashed', { err: err.message });
  process.exit(0);
});
