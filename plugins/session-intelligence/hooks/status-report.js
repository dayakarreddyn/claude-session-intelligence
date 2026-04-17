#!/usr/bin/env node
/**
 * Session Intelligence — runtime status report.
 *
 * Prints a short, human-readable picture of the live install:
 *
 *   • installation: plugin / bash install / unified config presence
 *   • hooks registered in ~/.claude/settings.json (si:* ids)
 *   • status line wiring
 *   • current session's tool count, token budget, compact-zone state,
 *     task-change one-shot state, last compaction timestamp
 *
 * Usage:
 *   echo '{"session_id":"<sid>"}' | node status-report.js
 *   node status-report.js --session <sid>
 *
 * When a session id is unavailable, falls back to the tmp-file with the
 * newest mtime, then to "default". The script never mutates anything —
 * pure read-only.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const UNIFIED_CONFIG = path.join(CLAUDE_DIR, 'session-intelligence.json');
const PLUGIN_DIR_CANDIDATES = [
  path.join(CLAUDE_DIR, 'plugins', 'marketplaces', 'session-intelligence'),
  path.join(CLAUDE_DIR, 'plugins', 'session-intelligence'),
];
const BASH_HOOK_DIR = path.join(CLAUDE_DIR, 'scripts', 'hooks');
const TMP = os.tmpdir();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function exists(file) {
  try { fs.accessSync(file); return true; } catch { return false; }
}

function fmtBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}kB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function fmtTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtAge(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m ago`;
}

function zoneFor(tokens, zones) {
  const z = zones || { yellow: 200000, orange: 300000, red: 400000 };
  if (tokens >= z.red) return 'red';
  if (tokens >= z.orange) return 'orange';
  if (tokens >= z.yellow) return 'yellow';
  return 'green';
}

function readArg(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : null;
}

function readStdinJsonOrEmpty() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function resolveSessionId() {
  const stdin = readStdinJsonOrEmpty();
  const candidates = [
    readArg('--session'),
    stdin.session_id,
    stdin.sessionId,
    process.env.CLAUDE_SESSION_ID,
  ].filter(Boolean);
  for (const c of candidates) {
    const sid = String(c).replace(/[^a-zA-Z0-9_-]/g, '');
    if (sid) return { id: sid, source: 'provided' };
  }
  // Newest counter file in tmp.
  try {
    const names = fs.readdirSync(TMP)
      .filter((n) => n.startsWith('claude-tool-count-'))
      .map((n) => ({ name: n, mtime: fs.statSync(path.join(TMP, n)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (names.length) {
      return { id: names[0].name.replace(/^claude-tool-count-/, ''), source: 'newest-tmp' };
    }
  } catch { /* ignore */ }
  return { id: 'default', source: 'fallback' };
}

// ─── Collectors ──────────────────────────────────────────────────────────────

function collectInstallation() {
  const plugin = PLUGIN_DIR_CANDIDATES.find(exists);
  const pluginManifest = plugin
    ? readJson(path.join(plugin, 'plugins', 'session-intelligence', '.claude-plugin', 'plugin.json'))
      || readJson(path.join(plugin, '.claude-plugin', 'plugin.json'))
    : null;
  const bashHooks = [
    'pre-compact.js', 'suggest-compact.js',
    'token-budget-tracker.js', 'task-change-detector.js',
  ].filter((h) => exists(path.join(BASH_HOOK_DIR, h)));
  const configStat = exists(UNIFIED_CONFIG) ? fs.statSync(UNIFIED_CONFIG) : null;
  const configSections = configStat
    ? Object.keys(readJson(UNIFIED_CONFIG) || {})
    : [];

  return {
    plugin: plugin ? {
      path: plugin,
      version: pluginManifest?.version || '?',
    } : null,
    bashHooks,
    config: configStat ? {
      path: UNIFIED_CONFIG,
      size: configStat.size,
      sections: configSections,
    } : null,
  };
}

const OUR_HOOK_FILES = [
  'pre-compact.js', 'suggest-compact.js',
  'token-budget-tracker.js', 'task-change-detector.js',
  'bootstrap.js',
];

function collectHooks() {
  const settings = readJson(SETTINGS);
  if (!settings || !settings.hooks) return [];
  const out = [];
  for (const event of Object.keys(settings.hooks)) {
    for (const entry of settings.hooks[event] || []) {
      const cmds = (entry.hooks || []).map((h) => h.command || '');
      const isOurs = (entry.id && entry.id.startsWith('si:')) ||
        cmds.some((c) => OUR_HOOK_FILES.some((f) => c.includes(f)));
      if (!isOurs) continue;
      const hookFile = cmds.map((c) =>
        OUR_HOOK_FILES.find((f) => c.includes(f))
      ).find(Boolean) || '(unknown)';
      const source = cmds.some((c) => c.includes('CLAUDE_PLUGIN_ROOT'))
        ? 'plugin'
        : (cmds.some((c) => c.includes('/scripts/hooks/')) ? 'bash-install' : 'unknown');
      out.push({
        event,
        id: entry.id || hookFile.replace(/\.js$/, ''),
        matcher: entry.matcher || '*',
        source,
      });
    }
  }
  return out;
}

function collectStatusline() {
  const settings = readJson(SETTINGS);
  const sl = settings && settings.statusLine;
  if (!sl) return { wired: false };
  const cmd = typeof sl === 'string' ? sl : sl.command;
  const isChain = !!cmd && /statusline-chain\.sh/.test(cmd);
  let chainPrev = null;
  if (isChain && exists(cmd)) {
    try {
      const txt = fs.readFileSync(cmd, 'utf8');
      const m = txt.match(/^PREV_STATUSLINE=['"](.*)['"]\s*$/m);
      if (m) chainPrev = m[1];
    } catch { /* ignore */ }
  }
  return { wired: true, command: cmd, isChain, chainPrev };
}

function collectSession(sid) {
  const files = {
    toolCount:  path.join(TMP, `claude-tool-count-${sid}`),
    tokenBudget: path.join(TMP, `claude-token-budget-${sid}`),
    compactState: path.join(TMP, `claude-compact-state-${sid}`),
    taskChange: path.join(TMP, `claude-task-change-${sid}`),
  };
  const readInt = (f) => {
    try { const n = parseInt(fs.readFileSync(f, 'utf8').trim(), 10); return Number.isFinite(n) ? n : null; }
    catch { return null; }
  };
  const readStr = (f) => {
    try { return fs.readFileSync(f, 'utf8').trim() || null; }
    catch { return null; }
  };
  return {
    sessionId: sid,
    toolCount: readInt(files.toolCount),
    tokenBudget: readInt(files.tokenBudget),
    compactState: readStr(files.compactState),
    taskChangeHash: readStr(files.taskChange),
  };
}

function collectCompactLog() {
  const log = path.join(CLAUDE_DIR, 'session-data', 'compaction-log.txt');
  try {
    const stat = fs.statSync(log);
    return { path: log, ageMs: Date.now() - stat.mtimeMs };
  } catch { return null; }
}

// ─── Printer ─────────────────────────────────────────────────────────────────

function line(label, value) {
  const pad = label.length < 18 ? ' '.repeat(18 - label.length) : ' ';
  return `  ${label}${pad}${value}`;
}

function main() {
  const { id: sid, source: sidSource } = resolveSessionId();
  const install = collectInstallation();
  const hooks = collectHooks();
  const statusline = collectStatusline();
  const session = collectSession(sid);
  const config = readJson(UNIFIED_CONFIG) || {};
  const zones = config.statusline?.zones;
  const zone = session.tokenBudget ? zoneFor(session.tokenBudget, zones) : null;
  const compactLog = collectCompactLog();

  const out = [];
  out.push('Session Intelligence — runtime status');
  out.push('');

  out.push('Installation');
  out.push(line('plugin',
    install.plugin
      ? `${install.plugin.path}  (v${install.plugin.version})`
      : 'not installed'));
  out.push(line('bash install',
    install.bashHooks.length
      ? `${install.bashHooks.length}/4 hooks in ~/.claude/scripts/hooks/`
      : 'none'));
  out.push(line('config file',
    install.config
      ? `${install.config.path}  (${fmtBytes(install.config.size)}, ${install.config.sections.join(',')})`
      : 'missing'));
  out.push('');

  out.push(`Hooks registered (${hooks.length} si:* entries)`);
  if (hooks.length === 0) {
    out.push('  (none)');
  } else {
    for (const h of hooks) {
      const matcher = h.matcher && h.matcher !== '*' ? ` (${h.matcher})` : '';
      out.push(line(h.event, `${h.id}${matcher}   [${h.source}]`));
    }
  }
  out.push('');

  out.push('Status line');
  out.push(line('wired', statusline.wired ? 'yes' : 'no'));
  if (statusline.wired) {
    out.push(line('command', statusline.command || '(unknown)'));
    if (statusline.isChain) {
      out.push(line('chain prev', statusline.chainPrev || '(none)'));
    }
  }
  out.push('');

  out.push(`This session  [id=${sid.slice(0, 12)}${sid.length > 12 ? '…' : ''}, resolved via ${sidSource}]`);
  out.push(line('tool count',
    session.toolCount !== null ? String(session.toolCount) : '—'));
  out.push(line('token budget',
    session.tokenBudget !== null
      ? `~${fmtTokens(session.tokenBudget)}${zone ? `  (${zone} zone)` : ''}`
      : '—'));
  out.push(line('compact state',
    session.compactState ? session.compactState : '—'));
  out.push(line('task-change oneshot',
    session.taskChangeHash ? `armed (hash=${session.taskChangeHash})` : '—'));
  out.push(line('last /compact',
    compactLog ? fmtAge(compactLog.ageMs) : '—'));
  out.push('');

  if (config.debug?.enabled) out.push('(debug logging ON — ~/.claude/logs/session-intel-YYYY-MM-DD.log)');
  if (config.debug?.quiet)   out.push('(quiet mode ON — errors only)');

  process.stdout.write(out.join('\n') + '\n');
}

try { main(); }
catch (err) {
  process.stderr.write(`[status-report] ${err.message}\n`);
  process.exit(1);
}
