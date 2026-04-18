/**
 * Session Intelligence Debug Logger
 *
 * Hook-safe timestamped logger for the pre-compact / token-budget / suggest-compact
 * family. Never throws — hook failures are worse than silent logs.
 *
 * Log file: ~/.claude/logs/session-intel-YYYY-MM-DD.log
 *
 * Levels:
 *   - info  : always written (hook fired, zone transitions, file writes)
 *   - warn  : always written (missing inputs, parse failures)
 *   - debug : only when env CLAUDE_INTEL_DEBUG=1 (full payload snapshots)
 *
 * Env vars:
 *   CLAUDE_INTEL_DEBUG=1  — enable debug-level output
 *   CLAUDE_INTEL_QUIET=1  — suppress info/warn too (only errors)
 *
 * Usage:
 *   const { intelLog } = require('../lib/intel-debug');
 *   intelLog('token-budget', 'info', 'entered zone yellow', { cumulative: 210_000 });
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_LOG_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB cap per day

// Flags are resolved per-call (not captured at require-time) so that a
// user who flips `/si set debug.enabled true` sees logs appear on the
// very next hook fire without restarting Claude Code. Env still wins over
// config to keep one-shot overrides (`CLAUDE_INTEL_DEBUG=1 node ...`)
// working. Unified config read is wrapped in try/catch because the
// config module lives in the same lib dir and might not be on disk yet
// during a partial install.
function flagsFromConfig() {
  try {
    const { loadConfig } = require('./config');
    const cfg = loadConfig();
    return {
      debug: !!(cfg && cfg.debug && cfg.debug.enabled),
      quiet: !!(cfg && cfg.debug && cfg.debug.quiet),
    };
  } catch { return { debug: false, quiet: false }; }
}

function resolveFlags() {
  const fromCfg = flagsFromConfig();
  return {
    debug: process.env.CLAUDE_INTEL_DEBUG === '1' || fromCfg.debug,
    quiet: process.env.CLAUDE_INTEL_QUIET === '1' || fromCfg.quiet,
  };
}

function getLogDir() {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, '.claude', 'logs');
}

function getLogFile(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return path.join(getLogDir(), `session-intel-${y}-${m}-${d}.log`);
}

function timestamp() {
  // Local time, matching getLogFile()'s local-date filename. Using toISOString
  // here would emit UTC, which made entries look a day off from the filename
  // for users east of UTC after local midnight.
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}.${ms}`;
}

function truncate(value, maxLen = 200) {
  if (value == null) return '';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
}

function shouldLog(level) {
  const { debug, quiet } = resolveFlags();
  if (quiet && (level === 'info' || level === 'warn' || level === 'debug')) return false;
  if (level === 'debug' && !debug) return false;
  return true;
}

/**
 * Write a structured log line. Safe to call from any hook — all errors swallowed.
 *
 * @param {string} source - Hook name ("token-budget", "pre-compact", "suggest-compact", "statusline")
 * @param {'info'|'warn'|'debug'|'error'} level
 * @param {string} message - Short human-readable summary
 * @param {object} [meta] - Optional structured context (truncated in log)
 */
function intelLog(source, level, message, meta) {
  try {
    if (!shouldLog(level)) return;

    const logDir = getLogDir();
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const logFile = getLogFile();

    // Roll the log if it exceeds the daily cap (keeps disk use bounded).
    try {
      const stats = fs.statSync(logFile);
      if (stats.size > MAX_LOG_SIZE_BYTES) {
        fs.renameSync(logFile, logFile + '.1');
      }
    } catch { /* file doesn't exist yet — fine */ }

    const sessionId = (process.env.CLAUDE_SESSION_ID || 'default').slice(-12);
    const levelTag = level.toUpperCase().padEnd(5, ' ');
    const sourceTag = (source || '?').padEnd(16, ' ');
    const metaStr = meta ? ' | ' + truncate(meta, 500) : '';
    const line = `${timestamp()} ${levelTag} ${sourceTag} [${sessionId}] ${message}${metaStr}\n`;

    fs.appendFileSync(logFile, line, 'utf8');
  } catch {
    // Never throw from a hook.
  }
}

module.exports = {
  intelLog,
  getLogFile,
  getLogDir,
};
