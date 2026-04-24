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
 *   echo '{"session_id":"<sid>"}' | node si-status-report.js
 *   node si-status-report.js --session <sid>
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
  // Detect both post-rename (si-prefixed) and legacy (unprefixed) hook files.
  // Older installs wrote unprefixed names; newer installs use si- prefix.
  const bashHooks = [
    'si-pre-compact.js', 'si-suggest-compact.js',
    'si-token-budget.js', 'si-task-change.js', 'si-bootstrap.js',
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
  // Current (si-prefixed) names
  'si-pre-compact.js', 'si-suggest-compact.js',
  'si-token-budget.js', 'si-task-change.js', 'si-bootstrap.js',
  // Legacy unprefixed names — kept so status still reports correctly on
  // older installs that haven't re-run install.sh since the rename.
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

// Partner tools in the Claude Code token-reduction ecosystem. Detection is
// best-effort and read-only: we look for their MCP server names in user-level
// MCP config files plus a couple of well-known env markers. Never run external
// processes and never write anywhere. Purpose is purely informational — show
// the user which token-reducer tools are active so they can reason about
// SI's metrics in the context of the full stack.
const ECOSYSTEM_MCP_NAMES = [
  { id: 'token-optimizer-mcp', match: /token[-_]?optimizer/i,  note: 'MCP cache + compression (ooples)' },
  { id: 'claude-context',      match: /claude[-_]?context/i,   note: 'hybrid vector search (zilliztech)' },
  { id: 'context-mode',        match: /context[-_]?mode/i,     note: 'SQLite sandbox for raw output (mksglu)' },
];

const ECOSYSTEM_ENV_MARKERS = [
  { id: 'rtk',           env: 'RTK_ENABLED',           note: 'Rust Token Killer proxy' },
  { id: 'rtk',           env: 'CLAUDE_RTK',            note: 'Rust Token Killer proxy' },
  { id: 'caveman-claude', env: 'CAVEMAN_MODE',         note: 'Caveman output mode' },
];

function mcpServerNamesFromFile(filePath) {
  const data = readJson(filePath);
  if (!data) return [];
  // Two common shapes: top-level `mcpServers` (user MCP config) or nested
  // under `settings.json`'s `mcpServers` key.
  const bag = data.mcpServers || (data.mcp && data.mcp.servers) || data.servers;
  if (!bag || typeof bag !== 'object') return [];
  return Object.keys(bag);
}

function collectEcosystem() {
  const detected = [];
  const seen = new Set();

  const mcpCandidates = [
    path.join(CLAUDE_DIR, 'mcp.json'),
    path.join(CLAUDE_DIR, '.mcp.json'),
    path.join(CLAUDE_DIR, 'settings.json'),
    path.join(process.cwd(), '.mcp.json'),
    path.join(process.cwd(), '.claude', 'mcp.json'),
  ];
  const allServerNames = new Set();
  for (const p of mcpCandidates) {
    for (const name of mcpServerNamesFromFile(p)) allServerNames.add(name);
  }
  for (const name of allServerNames) {
    for (const partner of ECOSYSTEM_MCP_NAMES) {
      if (partner.match.test(name) && !seen.has(partner.id)) {
        detected.push({ id: partner.id, via: `mcp:${name}`, note: partner.note });
        seen.add(partner.id);
      }
    }
  }

  for (const marker of ECOSYSTEM_ENV_MARKERS) {
    if (process.env[marker.env] && !seen.has(marker.id)) {
      detected.push({ id: marker.id, via: `env:${marker.env}`, note: marker.note });
      seen.add(marker.id);
    }
  }

  return detected;
}

// Session-scoped — only reports a /compact timestamp if THIS session has
// compacted. Global mtime of compaction-log.txt was misleading in fresh
// tabs that inherited "last compact" from a sibling session.
function collectCompactLog(sid) {
  if (!sid) return null;
  for (const pluginDir of PLUGIN_DIR_CANDIDATES) {
    const libPath = path.join(pluginDir, 'plugins', 'session-intelligence', 'lib', 'compact-history.js');
    if (!fs.existsSync(libPath)) continue;
    try {
      const lib = require(libPath);
      if (typeof lib.lastCompactMsForSession !== 'function') continue;
      const ms = lib.lastCompactMsForSession(sid);
      if (ms === null) return null;
      return { sid, ageMs: Date.now() - ms };
    } catch { /* try next candidate */ }
  }
  return null;
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
  const compactLog = collectCompactLog(sid);

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

  const ecosystem = collectEcosystem();
  if (ecosystem.length > 0) {
    out.push(`Ecosystem (coexisting token-reducer tools)`);
    for (const e of ecosystem) {
      out.push(line(e.id, `${e.note}  [${e.via}]`));
    }
    out.push('');
  }

  if (config.debug?.enabled) out.push('(debug logging ON — ~/.claude/logs/session-intel-YYYY-MM-DD.log)');
  if (config.debug?.quiet)   out.push('(quiet mode ON — errors only)');

  process.stdout.write(out.join('\n') + '\n');
}

try { main(); }
catch (err) {
  process.stderr.write(`[status-report] ${err.message}\n`);
  process.exit(1);
}
