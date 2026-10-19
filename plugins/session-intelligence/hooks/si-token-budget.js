#!/usr/bin/env node
/**
 * Token Budget Tracker — PostToolUse hook
 *
 * Cross-platform (Windows, macOS, Linux)
 *
 * Tracks approximate token usage per session by measuring tool output sizes.
 * Writes a cumulative TOOL-I/O ESTIMATE (a share diagnostic, NOT the context
 * size: real context comes from the transcript's per-call usage) to the state
 * file read by session-end peak stats and shape tracking.
 *
 * Token estimation (rough, code/JSON-heavy):
 *   - 1 token ≈ 3 characters
 *   - Each tool call adds ~100 tokens overhead (schema, framing)
 *   - User/assistant messages add ~200-500 tokens each
 *
 * We only track tool I/O since that's the majority of context growth.
 */

const fs = require('fs');
const path = require('path');

// Resolve SI lib dir. Source layout: ../lib. Installed layout: bundled under
// ./session-intelligence/lib. Sentinel: context-shape.js is SI-only.
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

const {
  getStateDir
} = require(path.join(SI_LIB, 'utils'));
const { intelLog } = require(path.join(SI_LIB, 'intel-debug'));
const {
  rootDirOf,
  appendShape,
  readShape,
  resolveSessionCwd,
  writeSessionState,
  readSessionState,
} = require(path.join(SI_LIB, 'context-shape'));
const SHAPE_MIN_CHARS = 4096;

function safeInputHash(toolName, toolInput) {
  try { return require(path.join(SI_LIB, 'prune')).inputHash(toolName, toolInput); } catch { return null; }
}

// Record a same-input re-run (within RERUN_GAP_CALLS) of the call just appended.
// wasPruned approximates "the earlier result was over the prune floor"; the
// archive table is keyed by tool_use_id which the shape log does not carry.
function recordRerunSignal(sessionId, cfg, chars) {
  try {
    const signals = require(path.join(SI_LIB, 'shape-signals'));
    const entries = readShape(sessionId, signals.SIGNAL_WINDOW);
    const rerun = signals.newestRerun(entries);
    if (!rerun) return;
    const floor = cfg && cfg.prune && cfg.prune.outputFloorChars;
    require(path.join(SI_LIB, 'events')).recordRerun({
      sid: sessionId, t: Date.now(), tool: rerun.tool, inputHash: rerun.inputHash,
      gapCalls: rerun.gapCalls, wasPruned: Number.isFinite(floor) && chars >= floor,
    });
  } catch (err) {
    intelLog('token-budget', 'debug', 'rerun signal failed', { err: String(err && err.message) });
  }
}

// Phase-event detection is optional — fall back to the legacy inline regex
// if the module is not on disk yet (mixed-version install, e.g. during a
// plugin upgrade).
let detectPhaseEvent = null;
try { detectPhaseEvent = require(path.join(SI_LIB, 'phase-events')).detectPhaseEvent; }
catch { /* optional */ }
// Post-compact regret monitoring is optional — degrade silently when the
// module is not on disk yet (fresh install not synced).
let compactHistory = null;
try { compactHistory = require(path.join(SI_LIB, 'compact-history')); } catch { /* optional */ }

// Unified config — gives us shape.rootDirDepth (monorepo knob) with env
// overrides already applied. Failure here just means we fall back to depth 2.
function loadSiConfig() {
  try { return require(path.join(SI_LIB, 'config')).loadConfig(); }
  catch { return {}; }
}

const CHARS_PER_TOKEN = 3; // calibrated for code/JSON-heavy tool I/O
const TOOL_OVERHEAD_TOKENS = 100;

async function main() {
  // Read stdin FIRST so we can pick up session_id from the hook payload.
  // Claude Code passes the session id on stdin; env is a fallback only.
  let inputData = '';
  try { inputData = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  let parsedInput = null;
  try { parsedInput = inputData.trim() ? JSON.parse(inputData) : null; } catch { /* ignore */ }

  const rawSid = (parsedInput && (parsedInput.session_id || parsedInput.sessionId))
    || process.env.CLAUDE_SESSION_ID
    || 'default';
  const sessionId = String(rawSid).replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
  // State dir, not tmp: macOS wipes /var/folders/.../T mid-session, which
  // would zero peak-token/tool-count reads at session end. All readers
  // (si-suggest-compact, si-stop, si-status-report) already use getStateDir();
  // this writer was the last straggler from the incomplete state-dir migration.
  const budgetFile = path.join(getStateDir(), `claude-token-budget-${sessionId}`);
  const countFile  = path.join(getStateDir(), `claude-tool-count-${sessionId}`);
  intelLog('token-budget', 'debug', 'hook fired', { sessionId, budgetFile });

  // Unified tool counter — every PostToolUse call increments this file, so
  // "N tools" on the status line reflects ALL tool invocations (not just
  // Edit/Write as the earlier design did).
  try {
    const fd = fs.openSync(countFile, 'a+');
    try {
      const buf = Buffer.alloc(64);
      const bytesRead = fs.readSync(fd, buf, 0, 64, 0);
      let count = 0;
      if (bytesRead > 0) {
        const parsed = parseInt(buf.toString('utf8', 0, bytesRead).trim(), 10);
        if (Number.isFinite(parsed) && parsed > 0 && parsed <= 1000000) count = parsed;
      }
      count += 1;
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, String(count), 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* supplementary — never fail the hook */ }

  // Estimate tokens from this tool call (stdin was already read above).
  let callTokens = TOOL_OVERHEAD_TOKENS;
  if (parsedInput) {
    const output = parsedInput.tool_output || parsedInput.output || parsedInput.result || '';
    const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
    callTokens += Math.ceil(outputStr.length / CHARS_PER_TOKEN);

    const toolIn = parsedInput.tool_input || parsedInput.input || '';
    const inputStr = typeof toolIn === 'string' ? toolIn : JSON.stringify(toolIn);
    callTokens += Math.ceil(inputStr.length / CHARS_PER_TOKEN);
  } else if (inputData) {
    callTokens += Math.ceil(inputData.length / CHARS_PER_TOKEN);
  }

  // Accumulate to budget file (atomic-ish read+write)
  let cumulative = 0;
  try {
    const fd = fs.openSync(budgetFile, 'a+');
    try {
      const buf = Buffer.alloc(64);
      const bytesRead = fs.readSync(fd, buf, 0, 64, 0);
      if (bytesRead > 0) {
        const parsed = parseInt(buf.toString('utf8', 0, bytesRead).trim(), 10);
        if (Number.isFinite(parsed) && parsed > 0 && parsed <= 10000000) {
          cumulative = parsed;
        }
      }
      cumulative += callTokens;
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, String(cumulative), 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Silently fail — this is supplementary tracking
  }

  // Shape tracking — observe which directories / phase events this tool call
  // touched, so suggest-compact and pre-compact can generate grounded
  // preserve/drop hints instead of generic "consider /compact". Observation
  // only — decisions happen elsewhere. Never fails the hook.
  // Load config once for shape tracking (rootDirDepth, maxEntries). Loaded
  // outside the shape-tracking try so a shape error can't leave `cfg` unbound.
  const cfg = loadSiConfig();
  try {
    const toolName = (parsedInput && parsedInput.tool_name) || '';
    const toolInput = (parsedInput && parsedInput.tool_input) || {};
    const filePath = toolInput.file_path || toolInput.path || toolInput.notebook_path || '';
    // Resolve cwd through the session anchor chain:
    //   1. session-state file written by si-bootstrap (stable across subagent
    //      cwd drift — the motivating case for this design)
    //   2. payload.cwd / workspace.current_dir
    //   3. projectRootOf walk-up from filePath (handles cross-repo reads)
    //   4. process.cwd() as last resort
    // Without this chain, depth=2 on /Users/alex/DWS/CSM/frontend/dashboard/...
    // collapses to /Users/alex whenever the payload arrives without a cwd,
    // poisoning HOT/WARM/COLD banding and silencing the regret signal.
    const payloadCwd = (parsedInput && (parsedInput.cwd
      || (parsedInput.workspace && parsedInput.workspace.current_dir))) || '';
    const { cwd, source: cwdSource } = resolveSessionCwd({
      sessionId, payloadCwd, filePath,
    });
    // Apply per-project shape overrides — without this, `cfg.shape.rootDirDepth`
    // is always the top-level value (default 2), so a perProject override like
    // `/Users/alex/DWS/CSM: { rootDirDepth: 3 }` is silently ignored at WRITE
    // time. Each appended entry's `root` field gets bucketed with the wrong
    // depth, and downstream reclassification can only paper over so much.
    let shapeCfg = (cfg && cfg.shape) ? cfg.shape : {};
    try {
      const cfgMod = require(path.join(SI_LIB, 'config'));
      if (cfgMod.resolveShapeForCwd) {
        shapeCfg = cfgMod.resolveShapeForCwd(cfg, cwd);
      }
    } catch { /* fall back to top-level shape */ }
    const depth = Number.isFinite(shapeCfg.rootDirDepth) ? shapeCfg.rootDirDepth : 2;
    const root = rootDirOf(filePath, depth, { cwd });

    // Self-heal: if bootstrap didn't run (fresh install, cache drift) and the
    // payload carries a good absolute cwd, pin it now so the next call uses
    // the session source instead of falling through the chain every time.
    if (cwdSource !== 'session' && typeof payloadCwd === 'string' && payloadCwd.startsWith('/')) {
      try {
        const existing = readSessionState(sessionId);
        if (!existing || existing.cwd !== payloadCwd) {
          writeSessionState(sessionId, {
            ...existing,
            sessionId,
            cwd: payloadCwd,
            pinnedBy: 'token-budget',
            updatedAt: new Date().toISOString(),
          });
          intelLog('token-budget', 'debug', 'pinned session cwd from payload',
            { sessionId, cwd: payloadCwd, prevSource: cwdSource });
        }
      } catch { /* best-effort — never break the hook */ }
    }
    const cmd = toolInput.command || '';
    const toolOutput = (parsedInput && (parsedInput.tool_output || parsedInput.output || parsedInput.result)) || '';
    let event = null;
    if (detectPhaseEvent) {
      event = detectPhaseEvent(toolName, toolInput, toolOutput);
    } else if (toolName === 'Bash' && typeof cmd === 'string') {
      // Legacy fallback — pre-phase-events.js regex. Kept so mixed-version
      // installs still record the common cases.
      if (/^\s*git\s+commit\b/.test(cmd))                        event = 'commit';
      else if (/^\s*git\s+push\b/.test(cmd))                     event = 'push';
      else if (/^\s*gh\s+pr\s+(create|merge)\b/.test(cmd))       event = 'pr';
    }
    // Only append entries that carry a signal — a pure Bash echo with no file
    // and no event adds noise unless its result is large enough to matter.
    const outStr = typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput || '');
    const chars = outStr.length;
    if (root || event || chars >= SHAPE_MIN_CHARS) {
      // clampMaxEntries enforces [50, 5000] so a perProject typo can't
      // either starve the analyzer or balloon the shape file.
      let maxEntries;
      try {
        const cfgMod = require(path.join(SI_LIB, 'config'));
        maxEntries = cfgMod.clampMaxEntries
          ? cfgMod.clampMaxEntries(shapeCfg.maxEntries)
          : (Number.isFinite(shapeCfg.maxEntries) ? shapeCfg.maxEntries : undefined);
      } catch {
        maxEntries = Number.isFinite(shapeCfg.maxEntries) ? shapeCfg.maxEntries : undefined;
      }
      appendShape(sessionId, {
        t: Date.now(),
        tok: cumulative,
        tool: (toolName === 'Task' ? 'Agent' : toolName) || null,
        root: root || null,
        file: filePath ? String(filePath) : null,
        event,
        chars,
        inputHash: safeInputHash(toolName, toolInput),
      }, { maxEntries });
      recordRerunSignal(sessionId, cfg, chars);
    }

    // Post-compact regret monitoring: if there's a live snapshot (written by
    // pre-compact within the last 30 calls or 30 min), check whether this
    // tool call is touching a rootDir we told the model was SAFE TO DROP.
    // A hit means the compact was too aggressive; multiple hits dampen
    // future drop suggestions via the adaptiveZones() regret-rate path.
    if (root && compactHistory) {
      try {
        const { regretHit, softRegretHit, windowClosed, weight } =
          compactHistory.checkPostCompactRegret(sessionId, root, {
            toolName,
            toolInput,
          });
        if (regretHit) {
          intelLog('token-budget', 'info', 'post-compact regret hit',
            { root, tool: toolName, weight, windowClosed });
        } else if (softRegretHit) {
          // Q1 unblocker: WARM-not-HOT hits. Log at info so the signal is
          // visible in intel logs without needing debug mode, but keep the
          // wording distinct from hard regret so grep filters can separate.
          intelLog('token-budget', 'info', 'post-compact soft-regret hit',
            { root, tool: toolName, weight, windowClosed });
        }
      } catch (err) {
        intelLog('token-budget', 'debug', 'regret check failed',
          { err: err && err.message });
      }
    }

    // Post-compact cache-hit telemetry: while the regret window is still open
    // (first 30 calls / 30 min), try to read the first assistant turn that
    // landed AFTER the snapshot's t and stamp its cache-hit ratio on the
    // snapshot. upgradeHistoryRegret copies it to the persistent history
    // entry on window close. Fires at most once per compact — snapshot
    // carries `postCompactCacheMeasured` as a one-shot flag.
    if (compactHistory && parsedInput && parsedInput.transcript_path) {
      try {
        const snap = compactHistory.readSnapshot(sessionId);
        if (snap && Number.isFinite(snap.t) && !snap.postCompactCacheMeasured) {
          const costEst = require(path.join(SI_LIB, 'cost-estimation'));
          const u = costEst.firstAssistantUsageAfter(parsedInput.transcript_path, snap.t);
          if (u) {
            const ratio = costEst.cacheHitRatio(u);
            snap.postCompactCacheMeasured = true;
            if (ratio !== null) {
              snap.postCompactCacheHitRatio = Number(ratio.toFixed(3));
              snap.postCompactCacheRead = u.cache_read_input_tokens || 0;
              snap.postCompactCacheCreation = u.cache_creation_input_tokens || 0;
            }
            compactHistory.writeSnapshot(sessionId, snap);
            intelLog('token-budget', 'info', 'post-compact cache-hit measured',
              { ratio: snap.postCompactCacheHitRatio,
                read: snap.postCompactCacheRead,
                creation: snap.postCompactCacheCreation });
          }
        }
      } catch (err) {
        intelLog('token-budget', 'debug', 'cache-hit measurement failed',
          { err: err && err.message });
      }
    }
  } catch (err) {
    intelLog('token-budget', 'debug', 'shape append failed', { err: err && err.message });
  }

  // The cumulative chars/4 tool-I/O estimate is written for diagnostics only.
  // Zone decisions and messages belong to si-suggest-compact, which reads the
  // transcript's real usage against the resolved window.
  intelLog('token-budget', 'debug', 'tick', { toolIoEstimate: cumulative, callTokens });

  process.exit(0);
}

main().catch(err => {
  // exit(1) so the hook pipeline sees the failure. See si-pre-compact.js
  // for the rationale — crashes in the shape-append / regret-check paths
  // would otherwise ship as silent "success" and hide regressions.
  console.error('[TokenBudget] Error:', err.message);
  intelLog('token-budget', 'error', 'hook crashed', { err: err.message, stack: err.stack });
  process.exit(1);
});
