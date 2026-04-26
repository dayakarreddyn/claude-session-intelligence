#!/usr/bin/env node
/**
 * Session Intelligence — project health check.
 *
 * Answers one question, authoritatively: "is SI actually wired up for the
 * project I'm sitting in right now?" Diagnoses the most common silent
 * failure — the project's `enabledPlugins` whitelist excluding SI — plus
 * the supporting pieces (plugin cache present, shape log being written,
 * unified config readable).
 *
 * Usage:
 *   echo '{"session_id":"<sid>","cwd":"<abs cwd>"}' | node si-doctor.js
 *   node si-doctor.js --cwd <abs cwd> [--session <sid>]
 *
 * Pure read-only. Never writes. Exits 0 when everything's healthy, 1
 * otherwise — so the `/si doctor` command can shell out and surface the
 * exit status if it wants to. The text output is the primary contract;
 * exit code is best-effort secondary.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const PLUGIN_KEY = 'session-intelligence@session-intelligence';
const TMP = os.tmpdir();

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function exists(file) { try { fs.accessSync(file); return true; } catch { return false; } }

function readArg(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : null;
}

function readStdinJsonOrEmpty() {
  try {
    const buf = fs.readFileSync(0, 'utf8');
    return buf ? (JSON.parse(buf) || {}) : {};
  } catch { return {}; }
}

/**
 * Walk up from `cwd` looking for a `.claude/settings*.json` that declares
 * `enabledPlugins`. Returns the first match (project-level wins over
 * whatever's deeper). The whitelist semantics: if `enabledPlugins` exists
 * AT ALL on a project, Claude Code treats it as authoritative — every
 * plugin not listed (or listed as `false`) is suppressed for that project.
 */
function findProjectEnabledPlugins(cwd) {
  let dir = path.resolve(cwd || process.cwd());
  while (true) {
    for (const fname of ['settings.json', 'settings.local.json']) {
      const p = path.join(dir, '.claude', fname);
      const cfg = readJson(p);
      if (cfg && cfg.enabledPlugins && typeof cfg.enabledPlugins === 'object') {
        return { path: p, enabledPlugins: cfg.enabledPlugins };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function pluginCachePath() {
  const candidates = [
    path.join(HOME, '.claude', 'plugins', 'cache', 'session-intelligence',
      'session-intelligence', '1.0.0'),
    path.join(HOME, '.claude', 'plugins', 'marketplaces', 'session-intelligence',
      'plugins', 'session-intelligence'),
  ];
  return candidates.find(exists) || null;
}

function resolveSessionId(stdinPayload) {
  return stdinPayload.session_id
    || stdinPayload.sessionId
    || readArg('--session')
    || process.env.CLAUDE_SESSION_ID
    || null;
}

function shapeLogStat(sid) {
  if (!sid) return null;
  const file = path.join(TMP, `claude-ctx-shape-${sid}.jsonl`);
  if (!exists(file)) return { file, present: false };
  try {
    const stat = fs.statSync(file);
    const buf = fs.readFileSync(file, 'utf8');
    const lines = buf.split('\n').filter(Boolean);
    return { file, present: true, bytes: stat.size, entries: lines.length, mtime: stat.mtime };
  } catch { return { file, present: false }; }
}

function check(label, status, detail) {
  // status: 'pass' | 'fail' | 'warn' | 'info'
  const mark = status === 'pass' ? '✓' : status === 'fail' ? '✗' : status === 'warn' ? '!' : '·';
  return `  ${mark} ${label}${detail ? `  — ${detail}` : ''}`;
}

function main() {
  const stdin = readStdinJsonOrEmpty();
  const cwd = readArg('--cwd') || stdin.cwd || process.cwd();
  const sid = resolveSessionId(stdin);

  const cachePath = pluginCachePath();
  const project = findProjectEnabledPlugins(cwd);
  const userCfg = readJson(path.join(HOME, '.claude', 'session-intelligence.json'));
  const shape = shapeLogStat(sid);

  let pluginGated = null;
  if (project) {
    const v = project.enabledPlugins[PLUGIN_KEY];
    if (v === undefined) pluginGated = 'missing-from-whitelist';
    else if (v === false) pluginGated = 'explicitly-disabled';
    else pluginGated = 'enabled';
  }

  const out = [];
  out.push(`Session Intelligence — doctor for ${cwd}`);
  out.push('');

  out.push('Plugin install');
  out.push(check('plugin cache present',
    cachePath ? 'pass' : 'fail',
    cachePath || 'no install found under ~/.claude/plugins'));
  out.push(check('unified config readable',
    userCfg ? 'pass' : 'warn',
    userCfg ? '~/.claude/session-intelligence.json' : 'missing — defaults will apply'));
  out.push('');

  out.push('Project gating');
  if (!project) {
    out.push(check('project enabledPlugins whitelist',
      'pass', 'none found in cwd ancestry — every installed plugin runs'));
  } else if (pluginGated === 'enabled') {
    out.push(check('project enabledPlugins whitelist',
      'pass', `${path.relative(HOME, project.path) || project.path} explicitly enables SI`));
  } else {
    out.push(check('project enabledPlugins whitelist',
      'fail',
      `${path.relative(HOME, project.path) || project.path} ` +
      `${pluginGated === 'explicitly-disabled' ? 'sets SI to false' : 'omits SI'} ` +
      '— hooks are dark on this project'));
    out.push('');
    out.push('  Fix: add to enabledPlugins block:');
    out.push(`    "${PLUGIN_KEY}": true`);
    out.push(`  in ${project.path}, then restart the Claude Code session.`);
  }
  out.push('');

  out.push('Runtime evidence (this session)');
  out.push(check('session id resolved',
    sid ? 'pass' : 'warn',
    sid ? sid.slice(0, 12) + (sid.length > 12 ? '…' : '') : 'no session_id passed — pass via stdin or --session'));
  if (sid) {
    if (!shape || !shape.present) {
      out.push(check('shape log written',
        'fail',
        `no file at ${shape ? shape.file : '<unknown>'} — si-token-budget hasn't run`));
    } else if (shape.entries === 0) {
      out.push(check('shape log written',
        'warn',
        `${shape.file} exists but is empty — hook fired without a file_path payload`));
    } else {
      out.push(check('shape log written',
        'pass',
        `${shape.entries} entries, ${shape.bytes}B, last touched ${shape.mtime.toISOString()}`));
    }
  }
  out.push('');

  // Verdict — one line, easy to grep.
  const dark = pluginGated === 'missing-from-whitelist' || pluginGated === 'explicitly-disabled'
    || (sid && shape && !shape.present);
  out.push(dark ? 'VERDICT: SI is dark for this project. See "Fix:" above.'
                : 'VERDICT: SI is live.');

  process.stdout.write(out.join('\n') + '\n');
  process.exit(dark ? 1 : 0);
}

try { main(); }
catch (err) {
  process.stderr.write(`[si-doctor] ${err.message}\n`);
  process.exit(2);
}
