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

// Section parsing + placeholder stripping live in lib/session-context.js
// (shared with lib/handoff.js). Local copies previously drifted between
// the two files — extract-once keeps compact-hint output and handoff
// replay working from the same parse rules.
const {
  parseSessionContext,
  AUTOFILL_SENTINEL_RE,
} = require(path.join(SI_LIB, 'session-context'));

// Sections without the `<!-- si:autofill sha=... -->` sentinel are user-
// managed and can drift stale for weeks. Inject them verbatim only while
// the file was recently edited; past this window we replace the body with
// a "stale — verify before trusting" pointer so the model doesn't treat
// multi-week-old guidance as current. Mirrors the handoff.js fix that
// stopped inlining scraped `nextPriorities` bullets.
const STALENESS_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Format structured compaction hints from parsed session context. Returns
 * an empty string when every section is placeholder-only — we'd rather
 * ship no guidance than misleading guidance.
 */
/**
 * Build a memory-offload directive that tells Claude to preserve rich detail
 * in auto-memory BEFORE the compact summary collapses it. Pre-compact stdout
 * lands in the conversation context Claude sees during + after summarisation,
 * so the directive acts as a standing instruction the post-compact turn will
 * honour even if tool calls aren't emitted during summarisation itself.
 *
 * Returns '' when projectDir is null — no memory home to write to.
 */
/**
 * Priorities-review directive — tell Claude to strike resolved priorities
 * before compact closes. Claude has full transcript context and can judge
 * semantically what shipped, which a regex matcher cannot. The directive
 * stands alone: it names the files + sections + strike convention and
 * lets Claude scan + edit directly. No handoff-helper needed.
 *
 * Skipped when no priority-bearing file exists, so an empty block doesn't
 * pollute the pre-compact output on first-ever compacts.
 */
/**
 * Memory-cleanup directive — ask Claude to sweep resolved/stale lines out of
 * auto-memory before compact closes. Sister to priorities-review but scoped
 * at memory files: MEMORY.md pointers that reference deleted files, session
 * logs whose "next steps" all shipped, reference_*.md recipes that no longer
 * match current code. Regex sweepers can't judge semantic staleness; the
 * model has transcript + git state + ability to read current files and can.
 *
 * Skipped when no memory dir exists so first-ever compacts aren't spammed.
 */
function buildMemoryCleanupBlock(projectDir) {
  if (!projectDir) return '';
  const memoryDir = path.join(projectDir, 'memory');
  if (!fs.existsSync(memoryDir)) return '';

  return [
    '',
    '## STALE MEMORY CLEANUP (pre-compact)',
    `Before compact closes, spot-check \`${memoryDir}/\` for rot — resolved items, dead pointers, outdated recipes:`,
    '  - `MEMORY.md` index — remove or update lines whose target file was deleted, renamed, or no longer matches what it describes.',
    '  - `project_session_*.md` — strike (`~~...~~`) or remove lines describing work that visibly shipped this session (commits landed, feature removed, decision reversed).',
    '  - `reference_*.md` — delete or correct recipes that now disagree with the current code (renamed functions, removed flags, deprecated patterns).',
    '',
    'Prefer in-place edits over "new session log" churn. One-line summary when done: "cleaned N lines" or "nothing stale".',
    '',
  ].join('\n');
}

/**
 * Git Nexus refresh note — one-line confirmation that the top-touched-files
 * cache was re-derived from git-log this compact. Compact is a natural
 * milestone (session commits just landed) so the 24h-TTL cache is likely
 * mid-stale; refreshing now keeps the repo graph current for the next
 * session's preserveGlobs + allowlist derivation.
 *
 * Returns '' when disabled, when git-nexus failed silently, or when the
 * repo isn't a git repo (anchors=0, sinceDays=0 sentinel from a failed call).
 */
function buildGitNexusRefreshBlock(status) {
  if (!status || status.skipped || !status.refreshed) return '';
  const { anchors, sinceDays } = status;
  if (!Number.isFinite(anchors) || anchors <= 0) return '';
  if (!Number.isFinite(sinceDays) || sinceDays <= 0) return '';
  return [
    '',
    '## REPO GRAPH (git-nexus refreshed)',
    `Re-derived top-touched file anchors from the last ${sinceDays}d of commit history — ${anchors} anchor(s) cached. This is the frequency-based signal that feeds preserveGlobs + shape allowlisting, so refreshing at compact time keeps the repo graph current with whatever landed this session.`,
    '',
  ].join('\n');
}

function buildPrioritiesReviewBlock(projectDir) {
  if (!projectDir) return '';
  const memoryDir = path.join(projectDir, 'memory');
  const sessionCtx = path.join(projectDir, 'session-context.md');
  const hasMemory = fs.existsSync(memoryDir);
  const hasCtx = fs.existsSync(sessionCtx);
  if (!hasMemory && !hasCtx) return '';

  return [
    '',
    '## PRIORITIES REVIEW (pre-compact)',
    'Before compact closes, review the `## Follow-ups` / `## Next steps` / `## Next priorities` / `## TODO` sections in:',
    hasMemory ? `  - \`${path.join('memory', 'MEMORY.md')}\` and the most recent \`memory/project_session_*.md\`` : null,
    hasCtx ? `  - \`session-context.md\`` : null,
    '',
    'For any bullet whose work this session visibly shipped (commits landed, files written, issues closed), edit the source file in place — wrap the bullet body in `~~...~~`. Resolved items drop out of the next post-compact banner automatically. Surface one line of output: "struck N items" or "nothing to strike".',
    '',
  ].filter((l) => l !== null).join('\n');
}

function buildMemoryOffloadBlock(projectDir, sessionId, opts = {}) {
  if (!projectDir) return '';
  const memoryDir = path.join(projectDir, 'memory');
  // Stable mode omits the dated + session-scoped filename — both change
  // every compact and cache-bust the post-compact prefix. The generic
  // "project_session_*.md" glob still gives Claude the convention
  // without pinning a specific filename to resolve.
  const stable = !!opts.stablePrefix;
  let filenameRef;
  if (stable) {
    filenameRef = 'the latest `project_session_*.md`';
  } else {
    const today = new Date();
    const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const sid8 = String(sessionId || 'session').slice(0, 8);
    filenameRef = `\`project_session_${ymd}_${sid8}.md\``;
  }

  return [
    '',
    '## MEMORY OFFLOAD (pre-compact)',
    `Before detail collapses, persist non-obvious findings to \`${memoryDir}/\` using the frontmatter + MEMORY.md convention from your system prompt. Extend ${filenameRef} (project) if new; add \`reference_<slug>.md\` only for reusable recipes. Skip if nothing new is worth keeping.`,
    '',
  ].join('\n');
}

function formatCompactionHints(sections, opts = {}) {
  const mtimeMs = Number.isFinite(opts.mtimeMs) ? opts.mtimeMs : 0;
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const stalenessMs = Number.isFinite(opts.stalenessMs) ? opts.stalenessMs : STALENESS_MS;
  const ageMs = mtimeMs > 0 ? nowMs - mtimeMs : Infinity;
  const isStale = ageMs > stalenessMs;
  const ageDays = Math.max(0, Math.round(ageMs / (24 * 60 * 60 * 1000)));

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

  const skipped = [];
  const body = [];
  for (const [key, label] of sectionMap) {
    const raw = sections[key];
    if (!raw) continue;

    // Autofill sentinel — content is refreshed per-commit by
    // si-bootstrap, so it can never be meaningfully stale. Always inject.
    if (AUTOFILL_SENTINEL_RE.test(raw)) {
      body.push('', label, raw);
      continue;
    }

    // Hand-written content — safe only while the file has been
    // touched recently. If file mtime is missing (mtimeMs=0 →
    // ageMs=Infinity) or older than the staleness window, skip the body.
    if (isStale) {
      skipped.push(key);
      continue;
    }

    body.push('', label, raw);
  }
  if (body.length === 0 && skipped.length === 0) return '';

  const header = '## COMPACTION GUIDANCE (from session-context.md)';
  const notes = [];
  if (skipped.length > 0) {
    const ageLabel = Number.isFinite(ageMs) ? `${ageDays} day(s) old` : 'of unknown age';
    notes.push(
      '',
      `NOTE: skipped user-managed section(s) ${skipped.map((s) => `\`${s}\``).join(', ')} — session-context.md is ${ageLabel} and carries no \`<!-- si:autofill sha=... -->\` sentinel. Refresh the file or add the sentinel to have it surface here again.`,
    );
  }

  // Plain ASCII headers and no heavy-rule bars — both the CLI terminal and
  // the Claude mobile client render this block. Mobile wraps the old 50×━
  // divider across 3 lines and surfaces the surrounding ANSI dim codes as
  // literal "[2m"/"[22m" noise, so we drop bars entirely and rely on
  // section labels + single blank lines for structure.
  return ['', header, ...body, ...notes, ''].join('\n');
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

  // One config load for the whole hook — shape analysis (preserveGlobs),
  // memory-offload gating, and any future knobs all read from this.
  // Missing config.js falls through to an empty object; downstream
  // callers defensively handle nullish fields.
  let siCfg = {};
  try { siCfg = require(path.join(SI_LIB, 'config')).loadConfig() || {}; }
  catch { /* optional */ }
  const userGlobs = (siCfg.shape && Array.isArray(siCfg.shape.preserveGlobs))
    ? siCfg.shape.preserveGlobs : [];

  // Git Nexus — fold top-touched files into the allowlist when enabled. This
  // is the "auto" half of preserve: user doesn't have to enumerate planning/
  // foundational dirs if git commit frequency already surfaces them.
  const gitNexusCfg = (siCfg.shape && siCfg.shape.gitNexus) || {};
  let nexusGlobs = [];
  // Tracks whether we successfully re-derived the anchor list this compact
  // so buildGitNexusRefreshBlock can emit a confirmation note. Initialized
  // with skipped=true so the block renders nothing when git-nexus is off or
  // refresh-on-compact is disabled.
  const gitNexusSinceDays = Number.isFinite(gitNexusCfg.sinceDays) ? gitNexusCfg.sinceDays : 90;
  const gitNexusStatus = { skipped: true, refreshed: false, anchors: 0, sinceDays: gitNexusSinceDays };
  if (gitNexusCfg.enabled !== false) {
    try {
      const { topTouchedFiles, toPreserveGlobs } = require(path.join(SI_LIB, 'git-nexus'));
      const refresh = gitNexusCfg.refreshOnCompact !== false;
      const anchors = topTouchedFiles(cwd, {
        sinceDays: gitNexusSinceDays,
        limit: Number.isFinite(gitNexusCfg.limit) ? gitNexusCfg.limit : 20,
        force: refresh,
      });
      nexusGlobs = toPreserveGlobs(anchors);
      gitNexusStatus.skipped = false;
      gitNexusStatus.refreshed = refresh && nexusGlobs.length > 0;
      gitNexusStatus.anchors = nexusGlobs.length;
      intelLog('pre-compact', 'debug', 'git-nexus anchors resolved',
        { count: nexusGlobs.length, refreshed: gitNexusStatus.refreshed });
    } catch (err) {
      intelLog('pre-compact', 'debug', 'git-nexus lookup failed', { err: err && err.message });
    }
  }
  const preserveGlobs = [...userGlobs, ...nexusGlobs];

  // Shape hints pulled from the live tool-usage history for THIS session id
  // (same session id every other hook uses). Generated fresh at compact-time
  // so we never feed the model stale hot/cold bands.
  // session_id must be a string — guard against object/number/etc. payloads
  // so we don't end up stringifying them to "[object Object]" and emitting
  // meaningless filenames like project_session_<date>_objectOb.md.
  const pickSid = (v) => typeof v === 'string' ? v : '';
  const rawSid = pickSid(stdinInput.session_id)
    || pickSid(stdinInput.sessionId)
    || process.env.CLAUDE_SESSION_ID
    || 'default';
  const sessionId = String(rawSid).replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
  // Scoring + persistence come from siCfg.shape. Destructure once so both
  // analyzeShape calls below pass identical options; drift between the two
  // would produce different hotDirs in the injected hints vs. the history
  // entry — silent but confusing.
  // Resolve shape config AFTER canonicalCwd so per-project overrides apply.
  // Default to top-level shape for now; re-resolved once canonicalCwd below.
  let shapeCfg = (siCfg && siCfg.shape) || {};
  // Canonical cwd: prefer the session-state pin (written by si-bootstrap at
  // SessionStart), fall back to the hook's own stdin cwd. Passed to
  // analyzeShape + rollupShape so entries written with a missing/drifted cwd
  // (subagent worktrees, payloadless calls) get rebucketed at read time
  // against the project's true root.
  let canonicalCwd = cwd;
  if (ctxShape && ctxShape.readSessionState) {
    try {
      const state = ctxShape.readSessionState(sessionId);
      if (state && typeof state.cwd === 'string' && state.cwd.startsWith('/')) {
        canonicalCwd = state.cwd;
      }
    } catch { /* fall back to payload cwd */ }
  }
  // Re-resolve shape config against the canonical cwd so perProject overrides
  // (warmScoreCutoff, per-repo scoring/rootDirDepth) take effect. Falls through
  // to the top-level shape block when no per-project entry exists.
  try {
    const cfgMod = require(path.join(SI_LIB, 'config'));
    if (cfgMod.resolveShapeForCwd) {
      shapeCfg = cfgMod.resolveShapeForCwd(siCfg, canonicalCwd);
    }
  } catch { /* fall back to original shapeCfg */ }

  const rootDirDepth = Number.isFinite(shapeCfg.rootDirDepth) ? shapeCfg.rootDirDepth : 2;
  const analyzeOpts = {
    preserveGlobs,
    scoring: shapeCfg.scoring || 'hybrid',
    persistAcrossCompacts: shapeCfg.persistAcrossCompacts !== false,
    sessionId,
    canonicalCwd,
    rootDirDepth,
    warmScoreCutoff: Number.isFinite(shapeCfg.warmScoreCutoff) ? shapeCfg.warmScoreCutoff : undefined,
  };

  const stablePrefix = !!(siCfg.compact && siCfg.compact.stablePrefix);

  let shapeInjection = '';
  if (ctxShape) {
    try {
      const entries = ctxShape.readShape(sessionId);
      const analysis = ctxShape.analyzeShape(entries, analyzeOpts);
      if (analysis) {
        shapeInjection = ctxShape.formatCompactInjection(analysis, { stablePrefix });
      }
      intelLog('pre-compact', 'info', 'shape analysis', {
        entries: entries.length,
        hasAnalysis: !!analysis,
        shift: analysis && !!analysis.shift,
        hot: analysis ? analysis.hot.length : 0,
        cold: analysis ? analysis.cold.length : 0,
        staleTokens: analysis ? analysis.staleTokens : 0,
        allowlisted: analysis ? analysis.hot.filter((h) => h.allowlisted).length : 0,
        scoring: analyzeOpts.scoring,
        persist: analyzeOpts.persistAcrossCompacts,
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
      // mtime gates user-managed (non-autofill) sections so weeks-old hand-
      // written guidance doesn't leak into every compact. stat() failure →
      // mtimeMs=0 → treated as "unknown age" (stale) by formatCompactionHints.
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(contextFile).mtimeMs; } catch { /* already handled */ }
      hints = formatCompactionHints(sections, { mtimeMs });
      if (hints) {
        intelLog('pre-compact', 'info', 'injected hints', {
          projectDir: path.basename(projectDir),
          sections: Object.keys(sections).filter((k) => sections[k]),
          mtimeMs,
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

  // Memory-offload directive — tell Claude to write rich detail into
  // auto-memory before compact compresses the session. Gated by config so
  // users who don't want this can disable (CLAUDE_COMPACT_MEMORY_OFFLOAD=0
  // or compact.memoryOffload:false in ~/.claude/session-intelligence.json).
  let memoryOffload = '';
  if (!siCfg.compact || siCfg.compact.memoryOffload !== false) {
    memoryOffload = buildMemoryOffloadBlock(projectDir, sessionId, { stablePrefix });
  }

  // Priorities-review directive — cheaper than a regex auto-matcher;
  // Claude has transcript context and can judge what shipped semantically.
  const prioritiesReview = buildPrioritiesReviewBlock(projectDir);

  // Memory-cleanup directive — tell Claude to sweep stale/resolved lines out
  // of MEMORY.md + project_session_*.md before compact closes. Sister
  // directive to priorities-review; same logic (transcript context > regex).
  const memoryCleanup = buildMemoryCleanupBlock(projectDir);

  // Git-nexus refresh note — confirms the repo-graph anchor cache was
  // re-derived this compact. Empty string when gitNexus is disabled,
  // refresh-on-compact is off, or the cwd isn't a git repo.
  const gitNexusRefresh = buildGitNexusRefreshBlock(gitNexusStatus);

  // Single top-level heading so the model knows this block came from the
  // plugin (vs. arbitrary user text). Plain H1 markdown — both terminal and
  // mobile render it cleanly, no wide bars that wrap on narrow screens.
  if (hints || shapeInjection || memoryOffload || prioritiesReview || memoryCleanup || gitNexusRefresh) {
    process.stdout.write(`\n# Session Intelligence \u2014 compaction guidance\n`);
  }

  // User-authored session-context.md hints first (manual curation, stronger
  // signal), then observed shape (grounded in what actually happened), then
  // the memory-offload directive (stands alone; doesn't depend on the others).
  if (hints) {
    process.stdout.write(hints);
    log('[PreCompact] Injected compaction hints from session-context.md');
  }
  if (shapeInjection) {
    process.stdout.write(shapeInjection);
    log('[PreCompact] Injected observed context-shape hints');
  }
  if (memoryOffload) {
    process.stdout.write(memoryOffload);
    log('[PreCompact] Injected memory-offload checkpoint directive');
    intelLog('pre-compact', 'info', 'memory offload directive emitted', {
      projectDir: path.basename(projectDir || ''),
      bytes: memoryOffload.length,
    });
  }
  if (prioritiesReview) {
    process.stdout.write(prioritiesReview);
    log('[PreCompact] Injected priorities-review directive');
    intelLog('pre-compact', 'info', 'priorities review directive emitted', {
      projectDir: path.basename(projectDir || ''),
      bytes: prioritiesReview.length,
    });
  }
  if (memoryCleanup) {
    process.stdout.write(memoryCleanup);
    log('[PreCompact] Injected stale-memory-cleanup directive');
    intelLog('pre-compact', 'info', 'memory cleanup directive emitted', {
      projectDir: path.basename(projectDir || ''),
      bytes: memoryCleanup.length,
    });
  }
  if (gitNexusRefresh) {
    process.stdout.write(gitNexusRefresh);
    log('[PreCompact] Injected git-nexus refresh note');
    intelLog('pre-compact', 'info', 'git-nexus refresh note emitted', {
      anchors: gitNexusStatus.anchors,
      sinceDays: gitNexusStatus.sinceDays,
      bytes: gitNexusRefresh.length,
    });
  }

  // stablePrefix drift check — when the opt-in cache-friendly mode is on,
  // fingerprint the emitted block per-cwd. If the fingerprint moves between
  // compacts of the same working set, something that was supposed to be
  // stable leaked a volatile value; warn so the regression is loud rather
  // than silent. The NEXT footer is intentionally excluded — its presence
  // is already deterministic w.r.t. the same inputs as the rest of the block.
  if (stablePrefix && compactHistory && compactHistory.compareStablePrefixHash) {
    try {
      const prefixText = (hints || '') + (shapeInjection || '')
        + (memoryOffload || '') + (prioritiesReview || '')
        + (memoryCleanup || '') + (gitNexusRefresh || '');
      if (prefixText) {
        const cmp = compactHistory.compareStablePrefixHash(cwd || 'default', prefixText);
        if (cmp.drifted) {
          intelLog('pre-compact', 'warn', 'stablePrefix drifted across compacts',
            { prevHash: cmp.prevHash.slice(0, 12),
              newHash: cmp.newHash.slice(0, 12),
              ageSec: cmp.ageSec, cwd,
              diff: cmp.diff || null });
        } else if (cmp.firstRun) {
          intelLog('pre-compact', 'debug', 'stablePrefix fingerprint recorded',
            { newHash: cmp.newHash.slice(0, 12), cwd });
        } else {
          intelLog('pre-compact', 'debug', 'stablePrefix hash matched prior compact',
            { hash: cmp.newHash.slice(0, 12), cwd });
        }
      }
    } catch (err) {
      intelLog('pre-compact', 'debug', 'stablePrefix drift check failed',
        { err: err && err.message });
    }
  }

  // Continue-hint footer. Claude Code pauses for user input after /compact
  // and won't auto-fire SessionStart until the user types something, so the
  // resume banner only appears after that input. Surface the hint at the
  // END of the pre-compact block — it becomes the last thing the user sees
  // before the input prompt, which is exactly when they need it.
  if (hints || shapeInjection || memoryOffload) {
    process.stdout.write(
      '\n## NEXT (to resume)\n'
      + 'Send any short message (e.g. `c` or `continue`) to show the post-compact '
      + 'resume banner and auto-continue the last task. Claude Code pauses for '
      + 'input after /compact, so the banner only fires on your next turn.\n'
    );
  }

  // Learning-loop logging: record this compaction event so future sessions
  // can adapt zones + dampen drop suggestions based on observed behaviour.
  // Also write a per-session snapshot so token-budget-tracker can watch for
  // regret (touching a dropped dir shortly after compact).
  if (compactHistory && ctxShape) {
    try {
      const entries = ctxShape.readShape(sessionId);
      const analysis = ctxShape.analyzeShape(entries, analyzeOpts);

      // tokens-at-compact = last observed cumulative budget, fallback to 0.
      // cost-at-compact  = same, best-effort from transcript.
      const tokens = entries.length ? (entries[entries.length - 1].tok || 0) : 0;
      const transcriptPath = stdinInput.transcript_path;
      const cost = costEst
        ? costEst.totalCostFromTranscript(transcriptPath, sessionId, costEst.DEFAULT_PRICES)
        : 0;

      const droppedDirs = analysis ? analysis.cold.map((c) => c.root) : [];
      const hotDirs     = analysis ? analysis.hot.map((h) => h.root) : [];
      const warmDirs    = analysis ? analysis.warm.map((w) => w.root) : [];

      const historyEntry = {
        t: Date.now(),
        sid: sessionId,
        cwd,
        tokens,
        cost: Number(cost.toFixed(4)),
        hotDirs,
        warmDirs,
        droppedDirs,
        hadShift: !!(analysis && analysis.shift),
        regretCount: 0, // upgraded later when the snapshot window closes
      };
      compactHistory.appendHistory(historyEntry);

      // Snapshot drives post-compact regret monitoring for up to 30 calls
      // or 30 min — whichever first. si-token-budget.js consumes it.
      // warmDirs enables soft-regret detection: users compacting early
      // (median 60k) rarely age dirs to COLD, so hard regret never fires.
      // WARM-not-HOT touches post-compact are the wider signal we can act on.
      compactHistory.writeSnapshot(sessionId, {
        t: historyEntry.t,
        tokens,
        cost: historyEntry.cost,
        hotDirs,
        warmDirs,
        droppedDirs,
        callsSince: 0,
        regretHits: [],
        softRegretHits: [],
        positiveHits: [],
      });

      intelLog('pre-compact', 'info', 'history + snapshot written', {
        tokens, cost: historyEntry.cost, dropped: droppedDirs.length, hot: hotDirs.length,
      });

      // Post-compact continuation handoff. One-shot file in projectDir —
      // SessionStart reads + deletes it so Claude resumes the task. Gated
      // by continue.afterCompact; handoff self-skips when no directional
      // signal exists (fresh current-task or unresolved memory follow-up).
      if (projectDir && (!siCfg.continue || siCfg.continue.afterCompact !== false)) {
        try {
          const handoff = require(path.join(SI_LIB, 'handoff'));
          const wrote = handoff.writeHandoff({
            projectDir, cwd, sessionId,
            sessionStartMs: entries.length ? entries[0].t : undefined,
            hotDirs, droppedDirs,
          });
          intelLog('pre-compact', 'info', 'continuation handoff', { wrote });
        } catch (err) {
          intelLog('pre-compact', 'warn', 'handoff write failed', { err: err && err.message });
        }
      }
    } catch (err) {
      intelLog('pre-compact', 'warn', 'history/snapshot failed', { err: err && err.message });
    }
  }

  // Persist this session's shape into the rollup AFTER both analyses have
  // read their data. rolledThroughTok advances to the latest observed token
  // position so the next compact's analyzeShape skips already-counted
  // entries. Gated by config; failures are logged but never fatal.
  if (ctxShape && ctxShape.rollupShape && analyzeOpts.persistAcrossCompacts) {
    try {
      const rollup = ctxShape.rollupShape(sessionId, { canonicalCwd, rootDirDepth });
      intelLog('pre-compact', 'info', 'shape rollup updated', {
        roots: rollup ? Object.keys(rollup.roots || {}).length : 0,
        rolledThroughTok: rollup ? rollup.rolledThroughTok : 0,
      });
    } catch (err) {
      intelLog('pre-compact', 'warn', 'rollup failed', { err: err && err.message });
    }
  }

  process.exit(0);
}

// Exported for tests. The hook is run directly by Claude Code, so `main()`
// still fires below even with these exports present.
module.exports = {
  formatCompactionHints,
  buildMemoryCleanupBlock,
  buildGitNexusRefreshBlock,
  STALENESS_MS,
};

if (require.main === module) {
  main().catch(err => {
    // exit(1) so the hook pipeline sees the failure. Previous exit(0) was
    // indistinguishable from success; a crash in the shape-append or
    // compact-history path would silently ship no hints + no handoff while
    // the pipeline reported "completed successfully".
    console.error('[PreCompact] Error:', err.message);
    intelLog('pre-compact', 'error', 'hook crashed', { err: err.message, stack: err.stack });
    process.exit(1);
  });
}
