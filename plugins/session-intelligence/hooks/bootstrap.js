#!/usr/bin/env node
/**
 * Session Intelligence — SessionStart bootstrap.
 *
 * Runs once per session. Idempotent. Does three things:
 *
 *   1. Seeds ~/.claude/session-intelligence.json from the shipped template
 *      (only if the file is missing — never overwrites user edits).
 *
 *   2. Wires the status-line chain wrapper into ~/.claude/settings.json so
 *      the intel line shows up below whatever the user already had. If the
 *      user has a different statusLine, the chain preserves it via the
 *      PREV_STATUSLINE placeholder inside statusline-chain.sh. If our chain
 *      is already wired, this step is a no-op.
 *
 *   3. Seeds templates/session-context.md into the active project's
 *      ~/.claude/projects/<encoded>/session-context.md if that project has
 *      no session-context.md yet. Claude updates it as real work happens.
 *
 * Silent on success. Only logs on first-install or on error.
 *
 * Plugin convention: __dirname points to .../plugins/session-intelligence/hooks,
 * so the plugin root is __dirname/.. — ${CLAUDE_PLUGIN_ROOT} at runtime also
 * resolves there but env vars aren't guaranteed inside child processes.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const CLAUDE_DIR = path.join(homeDir(), '.claude');
const STATE_FILE = path.join(CLAUDE_DIR, '.si-bootstrap-state');
const UNIFIED_CONFIG = path.join(CLAUDE_DIR, 'session-intelligence.json');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const CHAIN_SH = path.join(PLUGIN_ROOT, 'statusline', 'statusline-chain.sh');
const CONFIG_TEMPLATE = path.join(PLUGIN_ROOT, 'templates', 'session-intelligence.json');
const SESSION_CTX_TEMPLATE = path.join(PLUGIN_ROOT, 'templates', 'session-context.md');

// ─── State helpers ───────────────────────────────────────────────────────────

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8'); }
  catch { /* best effort */ }
}

function notify(msg) {
  // SessionStart hook stdout is surfaced to the user exactly once per install.
  process.stdout.write(`[session-intelligence] ${msg}\n`);
}

// ─── Step 1: seed unified config ─────────────────────────────────────────────

function seedConfig(state) {
  if (fs.existsSync(UNIFIED_CONFIG)) return false;
  if (!fs.existsSync(CONFIG_TEMPLATE)) return false;
  try {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    fs.copyFileSync(CONFIG_TEMPLATE, UNIFIED_CONFIG);
    state.seededConfigAt = new Date().toISOString();
    notify(`seeded default config → ${UNIFIED_CONFIG}`);
    return true;
  } catch (err) {
    notify(`config seed failed: ${err.message}`);
    return false;
  }
}

// ─── Step 2: wire statusline chain ───────────────────────────────────────────

function prepareChainScript(state) {
  // The shipped chain script has __PREV_STATUSLINE__ placeholder. Substitute
  // whatever the user currently has in settings.json → statusLine.command so
  // their existing line is preserved on the first line.
  if (!fs.existsSync(CHAIN_SH)) return null;

  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); }
  catch { /* will be created below */ }

  const currentCmd = typeof settings.statusLine === 'string'
    ? settings.statusLine
    : (settings.statusLine && settings.statusLine.command) || '';

  // Don't chain our own wrapper back into itself.
  const isAlreadyOurs = currentCmd && currentCmd.includes('statusline-chain.sh');

  const instanceChain = path.join(CLAUDE_DIR, 'scripts', 'si-statusline-chain.sh');

  // If our instance exists and matches, skip re-write.
  const prev = state.wiredStatuslinePrev || '';
  if (isAlreadyOurs && fs.existsSync(instanceChain) && prev === currentCmd) {
    return instanceChain;
  }

  let tmpl;
  try { tmpl = fs.readFileSync(CHAIN_SH, 'utf8'); }
  catch { return null; }

  const resolvedPrev = isAlreadyOurs ? prev : currentCmd;
  const rendered = tmpl.replace(/__PREV_STATUSLINE__/g,
    resolvedPrev.replace(/\\/g, '\\\\').replace(/'/g, "'\\''"));
  const intelScript = path.join(PLUGIN_ROOT, 'statusline', 'statusline-intel.js');
  const withIntelPath = rendered.replace(
    /INTEL_SCRIPT=.*$/m,
    `INTEL_SCRIPT="${intelScript}"`,
  );

  try {
    fs.mkdirSync(path.dirname(instanceChain), { recursive: true });
    fs.writeFileSync(instanceChain, withIntelPath, { mode: 0o755 });
    state.wiredStatuslinePrev = resolvedPrev;
    return instanceChain;
  } catch (err) {
    notify(`statusline chain write failed: ${err.message}`);
    return null;
  }
}

function wireStatusline(state) {
  const chain = prepareChainScript(state);
  if (!chain) return false;

  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); }
  catch { /* create */ }

  const current = settings.statusLine && settings.statusLine.command;
  if (current === chain) return false; // already wired

  settings.statusLine = { type: 'command', command: chain, padding: 0 };
  try {
    fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    state.wiredStatuslineAt = new Date().toISOString();
    notify(`wired intel status line (chain preserves existing)`);
    return true;
  } catch (err) {
    notify(`settings.json write failed: ${err.message}`);
    return false;
  }
}

// ─── Step 3: seed session-context.md for the active project ──────────────────

function seedSessionContext(cwd, state) {
  if (!cwd || !fs.existsSync(SESSION_CTX_TEMPLATE)) return false;

  const encoded = cwd.replace(/\//g, '-');
  const projectDir = path.join(CLAUDE_DIR, 'projects', encoded);
  if (!fs.existsSync(projectDir)) return false; // Claude hasn't created it yet

  const target = path.join(projectDir, 'session-context.md');
  if (fs.existsSync(target)) return false;

  try {
    fs.copyFileSync(SESSION_CTX_TEMPLATE, target);
    state.seededContexts = state.seededContexts || {};
    state.seededContexts[encoded] = new Date().toISOString();
    notify(`seeded session-context.md → ${target}`);
    return true;
  } catch { return false; }
}

// ─── Main ────────────────────────────────────────────────────────────────────

function readStdinJsonOrEmpty() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function main() {
  const input = readStdinJsonOrEmpty();
  const cwd = input.cwd || input.workspace?.current_dir || process.cwd();

  const state = loadState();
  const didSeedConfig = seedConfig(state);
  const didWire = wireStatusline(state);
  const didSeedCtx = seedSessionContext(cwd, state);

  if (didSeedConfig || didWire || didSeedCtx) {
    saveState(state);
  }

  process.exit(0);
}

try { main(); } catch (err) {
  // Never block the session on a bootstrap failure.
  process.stderr.write(`[session-intelligence] bootstrap error: ${err.message}\n`);
  process.exit(0);
}
