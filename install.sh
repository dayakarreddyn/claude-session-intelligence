#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────
# Session Intelligence for Claude Code
# Task-aware compaction + token budget + status line
# ─────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_SRC="${SCRIPT_DIR}/plugins/session-intelligence"
CLAUDE_DIR="${HOME}/.claude"
HOOKS_DIR="${CLAUDE_DIR}/scripts/hooks"
LIB_DIR="${HOOKS_DIR}/session-intelligence/lib"
SCRIPTS_DIR="${CLAUDE_DIR}/scripts"
LOGS_DIR="${CLAUDE_DIR}/logs"
COMMANDS_DIR="${CLAUDE_DIR}/commands"
SETTINGS="${CLAUDE_DIR}/settings.json"
UNIFIED_CONFIG="${CLAUDE_DIR}/session-intelligence.json"
INSTALLED_PLUGINS_JSON="${CLAUDE_DIR}/plugins/installed_plugins.json"

FORCE_LEGACY=false
for arg in "$@"; do
  case "$arg" in
    --force-legacy) FORCE_LEGACY=true ;;
  esac
done

if [ ! -d "$PLUGIN_SRC" ]; then
  echo "[SI] expected plugin source at $PLUGIN_SRC — repo layout may be out of date" >&2
  exit 1
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[SI]${NC} $1"; }
ok()    { echo -e "${GREEN}[SI]${NC} $1"; }
warn()  { echo -e "${YELLOW}[SI]${NC} $1"; }
err()   { echo -e "${RED}[SI]${NC} $1"; }

# ─── Preflight ───────────────────────────────────────

if [ ! -d "$CLAUDE_DIR" ]; then
  err "~/.claude directory not found. Install Claude Code first."
  exit 1
fi

if ! command -v node &>/dev/null; then
  err "Node.js is required. Install it first."
  exit 1
fi

info "Installing Session Intelligence for Claude Code..."
echo ""

# ─── Detect plugin install ──────────────────────────
#
# If the user installed session-intelligence via Claude Code's plugin
# marketplace, the plugin-cache hooks.json already registers every SI hook
# via ${CLAUDE_PLUGIN_ROOT}/hooks/si-*.js. Running this script's legacy path
# on top of that writes a second registration into settings.json, so every
# hook fires twice (duplicate /compact blocks, 2× shape observations, 2×
# token-budget writes).
#
# Behavior when plugin is detected:
#   - skip hook-file copy into ~/.claude/scripts/hooks/ (plugin cache owns them)
#   - skip hook upsert in settings.json (plugin manifest owns registration)
#   - PURGE any pre-existing SI entries from settings.json (cleanup for users
#     who ran both paths historically — the "Bucket 3" case)
#   - statusline, unified config, /si command, session-context template still
#     install (none of those are auto-registered by the plugin system)
#
# Escape hatch: --force-legacy skips detection (for dev loops where you
# want edits in ~/.claude/scripts/hooks/ to override the plugin cache).
PLUGIN_INSTALLED=false
if [ "$FORCE_LEGACY" = false ] && [ -f "$INSTALLED_PLUGINS_JSON" ]; then
  if node -e "
    try {
      const j = JSON.parse(require('fs').readFileSync('${INSTALLED_PLUGINS_JSON}', 'utf8'));
      const entries = j && j.plugins && j.plugins['session-intelligence@session-intelligence'];
      process.exit(Array.isArray(entries) && entries.length > 0 ? 0 : 1);
    } catch { process.exit(1); }
  " 2>/dev/null; then
    PLUGIN_INSTALLED=true
    info "Detected session-intelligence plugin in installed_plugins.json"
    info "  → plugin manifest handles hook registration; this script will"
    info "    skip hook copy + settings.json upsert, and purge any legacy"
    info "    SI entries that would fire duplicates."
    info "  (Pass --force-legacy to override and re-run the pre-plugin path.)"
    echo ""
  fi
fi

# ─── 1a. Refresh plugin cache (when plugin is installed) ───
#
# `/plugin install session-intelligence@session-intelligence` is a no-op
# for cache content when `plugin.json.version` hasn't bumped — it registers
# the scope entry in `installed_plugins.json` but reuses whatever is already
# at `installPath`. Without an rsync, in-tree edits never reach the live
# plugin cache that `CLAUDE_PLUGIN_ROOT` points at, so hooks + statusline
# silently run the stale cached version (easy-to-miss footgun: UI looks
# "wrong" after a /plugin install because it's running old code).
#
# Fix: on every `install.sh` run with a detected plugin install, rsync the
# source tree into every `installPath` listed for this plugin. One
# statement, uses `installed_plugins.json` as the source of truth for where
# the cache lives (so multi-scope installs all stay in sync).
if [ "$PLUGIN_INSTALLED" = true ]; then
  CACHE_PATHS="$(node -e "
    try {
      const j = JSON.parse(require('fs').readFileSync('${INSTALLED_PLUGINS_JSON}','utf8'));
      const entries = (j && j.plugins && j.plugins['session-intelligence@session-intelligence']) || [];
      const paths = Array.from(new Set(entries.map(e => e.installPath).filter(Boolean)));
      process.stdout.write(paths.join('\n'));
    } catch {}
  " 2>/dev/null)"

  if [ -n "$CACHE_PATHS" ] && command -v rsync &>/dev/null; then
    while IFS= read -r cache; do
      [ -z "$cache" ] && continue
      if [ -d "$cache" ]; then
        rsync -a --delete \
          --exclude='.git/' --exclude='node_modules/' --exclude='tests/' \
          "${PLUGIN_SRC}/" "${cache}/" \
          && ok "Refreshed plugin cache → ${cache}"
      else
        warn "Plugin cache path missing: ${cache} (skipped)"
      fi
    done <<< "$CACHE_PATHS"
  elif [ -n "$CACHE_PATHS" ]; then
    warn "rsync not found — skipping plugin cache refresh. Install rsync or re-run /plugin install."
  fi
fi

# ─── 1. Install hooks + shared lib ──────────────────

mkdir -p "$HOOKS_DIR" "$LIB_DIR" "$SCRIPTS_DIR" "$LOGS_DIR" "$COMMANDS_DIR"

# Migrate any pre-rename (unprefixed) SI hooks left behind by older installs.
# We only touch files we authored — the marker regex lists three fingerprints
# because the banner text drifted over time ("Session Intelligence" on the
# newer ones, "Strategic Compact Suggester" / "Token Budget Tracker" on the
# older per-hook-titled ones). bootstrap.js + status-report.js are listed
# here too: earlier installer versions shipped them unprefixed and forgot to
# rename them when we moved to the si- prefix, leaving live orphans on disk.
SI_MARKER_RE='Session Intelligence|Strategic Compact Suggester|Token Budget Tracker'
for legacy in pre-compact.js suggest-compact.js token-budget-tracker.js task-change-detector.js bootstrap.js status-report.js; do
  if [ -f "${HOOKS_DIR}/${legacy}" ] && grep -qE "$SI_MARKER_RE" "${HOOKS_DIR}/${legacy}" 2>/dev/null; then
    mv "${HOOKS_DIR}/${legacy}" "${HOOKS_DIR}/${legacy}.bak-pre-si-rename"
    warn "  Migrated ${legacy} → ${legacy}.bak-pre-si-rename (renamed with si- prefix)"
  fi
done

# GC stale .bak files older than 7 days. Each install creates a fresh .bak;
# without GC these accumulate forever. 7 days is long enough to roll back a
# bad install, short enough that noise doesn't build up across weeks.
gc_count=0
while IFS= read -r stale; do
  [ -z "$stale" ] && continue
  rm -f "$stale"
  gc_count=$((gc_count + 1))
done < <(find "$HOOKS_DIR" -maxdepth 1 -type f \( -name '*.bak' -o -name '*.bak-*' \) -mtime +7 2>/dev/null)
if [ "$gc_count" -gt 0 ]; then
  info "  GC'd ${gc_count} backup file(s) older than 7 days"
fi

# New install path (all hooks carry the si- prefix for discoverability in
# shared hook directories).
#
# When the plugin is installed, we skip this block entirely — the plugin
# cache owns canonical copies at ${CLAUDE_PLUGIN_ROOT}/hooks/si-*.js and
# writing a second copy into ${HOOKS_DIR} that's never registered just
# creates drift (stale copies that can confuse `tail -f` debugging).
if [ "$PLUGIN_INSTALLED" = false ]; then
  for hook in si-bootstrap.js si-pre-compact.js si-suggest-compact.js si-token-budget.js si-task-change.js; do
    if [ -f "${HOOKS_DIR}/${hook}" ]; then
      if grep -q "Session Intelligence" "${HOOKS_DIR}/${hook}" 2>/dev/null; then
        info "  ${hook} already installed, updating..."
      else
        cp "${HOOKS_DIR}/${hook}" "${HOOKS_DIR}/${hook}.bak"
        warn "  Backed up existing ${hook} → ${hook}.bak"
      fi
    fi
  done

  cp "${PLUGIN_SRC}/hooks/si-bootstrap.js"       "${HOOKS_DIR}/si-bootstrap.js"
  cp "${PLUGIN_SRC}/hooks/si-pre-compact.js"     "${HOOKS_DIR}/si-pre-compact.js"
  cp "${PLUGIN_SRC}/hooks/si-suggest-compact.js" "${HOOKS_DIR}/si-suggest-compact.js"
  cp "${PLUGIN_SRC}/hooks/si-token-budget.js"    "${HOOKS_DIR}/si-token-budget.js"
  cp "${PLUGIN_SRC}/hooks/si-task-change.js"     "${HOOKS_DIR}/si-task-change.js"
  cp "${PLUGIN_SRC}/hooks/si-status-report.js"   "${HOOKS_DIR}/si-status-report.js"
  # Copy every .js in plugins/session-intelligence/lib/ so new modules
  # (thinking.js, phase-events.js, git-nexus.js, …) land automatically
  # without touching the installer each time. Pre-existing installs may
  # have stale copies from earlier cherry-picked `cp` lines; this loop
  # overwrites them all.
  for _lib in "${PLUGIN_SRC}/lib"/*.js; do
    [ -f "$_lib" ] || continue
    cp "$_lib" "${LIB_DIR}/$(basename "$_lib")"
  done
  unset _lib
else
  info "Plugin install detected — skipping hook copy to ${HOOKS_DIR}/"
fi

# Repair ECC-owned lib dir if an older SI install clobbered it.
#
# Background: previous versions of this script copied SI's utils.js /
# intel-debug.js / config.js into ${HOOKS_DIR}/../lib (which resolves to
# ${CLAUDE_DIR}/scripts/lib, an ECC-owned directory). The intent was to
# satisfy `require('../lib/*')` from SI hooks, but that's now handled by
# a runtime sentinel resolver inside each hook that prefers the bundled
# ./session-intelligence/lib/ copies. The shim only broke ECC — its own
# utils.js exports symbols (getSessionSearchDirs, stripAnsi, etc.) that
# SI's shorter utils.js didn't, so session-start, desktop-notify,
# evaluate-session and cost-tracker would fail on missing exports.
#
# Repair steps:
#   1. If ~/.claude/scripts/lib/utils.js still carries SI's banner and an
#      ECC marketplace copy is on disk, restore the ECC original.
#   2. Delete ~/.claude/scripts/lib/intel-debug.js and
#      ~/.claude/scripts/lib/config.js if they're SI plants (ECC doesn't
#      ship these names; only SI did).
ECC_LIB_UTILS_SRC="${CLAUDE_DIR}/plugins/marketplaces/ecc/scripts/lib/utils.js"
HOOK_LIB_SHIM="${HOOKS_DIR}/../lib"
if [ -f "${HOOK_LIB_SHIM}/utils.js" ] \
   && grep -q "session-intelligence hooks" "${HOOK_LIB_SHIM}/utils.js" 2>/dev/null; then
  if [ -f "$ECC_LIB_UTILS_SRC" ]; then
    cp "$ECC_LIB_UTILS_SRC" "${HOOK_LIB_SHIM}/utils.js"
    warn "  Restored ECC utils.js over prior SI shim (${HOOK_LIB_SHIM}/utils.js)"
  else
    # No ECC source to restore from — removing would break anything that
    # depended on the shim. Leave alone and warn.
    warn "  Detected SI-shimmed utils.js at ${HOOK_LIB_SHIM}/ but no ECC source to restore. Reinstall ECC to fix."
  fi
fi
for orphan in intel-debug.js config.js; do
  path="${HOOK_LIB_SHIM}/${orphan}"
  if [ -f "$path" ] && grep -q "Session Intelligence" "$path" 2>/dev/null; then
    rm -f "$path"
    info "  Removed SI plant ${path#${CLAUDE_DIR}/}"
  fi
done

# Install unified config if one doesn't exist yet.
if [ ! -f "$UNIFIED_CONFIG" ] && [ -f "${PLUGIN_SRC}/templates/session-intelligence.json" ]; then
  cp "${PLUGIN_SRC}/templates/session-intelligence.json" "$UNIFIED_CONFIG"
  ok "Installed default unified config: ${UNIFIED_CONFIG}"
else
  info "Unified config already exists at ${UNIFIED_CONFIG} — leaving as-is"
fi

# Legacy example for users who prefer the flat format; safe to ignore now.
if [ ! -f "${CLAUDE_DIR}/statusline-intel.json" ] && [ -f "${PLUGIN_SRC}/statusline/statusline-intel.json.example" ]; then
  cp "${PLUGIN_SRC}/statusline/statusline-intel.json.example" "${CLAUDE_DIR}/statusline-intel.json"
  info "Also wrote legacy ~/.claude/statusline-intel.json (kept for backward compat)"
fi

# /si slash command
if [ -f "${PLUGIN_SRC}/commands/si.md" ]; then
  cp "${PLUGIN_SRC}/commands/si.md" "${COMMANDS_DIR}/si.md"
  ok "Installed /si slash command → ${COMMANDS_DIR}/si.md"
fi

if [ "$PLUGIN_INSTALLED" = false ]; then
  chmod +x "${HOOKS_DIR}/si-bootstrap.js"
  chmod +x "${HOOKS_DIR}/si-pre-compact.js"
  chmod +x "${HOOKS_DIR}/si-suggest-compact.js"
  chmod +x "${HOOKS_DIR}/si-token-budget.js"
  chmod +x "${HOOKS_DIR}/si-task-change.js"
  chmod +x "${HOOKS_DIR}/si-status-report.js"

  ok "Hooks + lib installed to ${HOOKS_DIR}/"
fi

# ─── 2. Register hooks in settings.json ─────────────

if [ ! -f "$SETTINGS" ]; then
  warn "No settings.json found — creating minimal one"
  echo '{}' > "$SETTINGS"
fi

# Plugin path: purge SI hook entries from settings.json (plugin manifest
# registers them; any duplicate here fires twice). This runs in place of
# the upsert block below — still need to keep legacy-path cleanup and
# the PreToolUse→PostToolUse migration, so we share both as helpers.
if [ "$PLUGIN_INSTALLED" = true ]; then
  node -e "
  const fs = require('fs');
  const settingsPath = '${SETTINGS}';
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  if (!settings.hooks) { process.exit(0); }

  // Match any entry whose command mentions one of our hook basenames OR
  // whose id is a known SI id. Both checks needed: legacy entries from
  // the pre-id era have no id, and entries written by older installers
  // may carry different ids than we use today.
  const SI_HOOK_BASENAMES = [
    'si-pre-compact.js', 'si-bootstrap.js', 'si-token-budget.js',
    'si-suggest-compact.js', 'si-task-change.js',
    // pre-rename legacy:
    'pre-compact.js', 'bootstrap.js', 'token-budget-tracker.js',
    'suggest-compact.js', 'task-change-detector.js',
  ];
  const SI_IDS = new Set([
    'si:pre-compact', 'si:bootstrap', 'si:token-budget',
    'si:token-budget-tracker', 'si:suggest-compact', 'si:task-change',
    'si:task-change-detector',
    'pre:compact', 'pre:edit-write:suggest-compact',
    'post:token-budget-tracker',
  ]);
  function isSiEntry(entry) {
    if (!entry) return false;
    if (entry.id && SI_IDS.has(entry.id)) return true;
    const hooks = entry.hooks || [];
    return hooks.some(h => {
      if (typeof h.command !== 'string') return false;
      // Never strip ECC's run-with-flags wrapper — that's a separate hook.
      if (h.command.includes('run-with-flags')) return false;
      return SI_HOOK_BASENAMES.some(b => h.command.includes('/' + b));
    });
  }

  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[event])) continue;
    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter(e => !isSiEntry(e));
    removed += before - settings.hooks[event].length;
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  console.log('PURGED ' + removed);
  " 2>/dev/null && ok "Purged legacy SI hook entries from settings.json (plugin manifest is canonical)" \
    || err "Failed to purge settings.json"

  # Still run the statusline install path below — plugin system doesn't
  # auto-configure the global statusLine, only hooks.
else

node -e "
const fs = require('fs');
const settingsPath = '${SETTINGS}';
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

if (!settings.hooks) settings.hooks = {};

// Strip any entries that point at the legacy (pre si- rename) hook files so
// re-running this script on an older install doesn't leave duplicates that
// fire hooks we no longer ship. We skip ECC's run-with-flags wrapper — that
// wrapper resolves paths inside the ECC plugin root, not our HOOKS_DIR.
const LEGACY_PATHS = [
  '/scripts/hooks/pre-compact.js',
  '/scripts/hooks/suggest-compact.js',
  '/scripts/hooks/token-budget-tracker.js',
  '/scripts/hooks/task-change-detector.js',
  '/scripts/hooks/bootstrap.js',
  '/scripts/hooks/status-report.js',
];
function pointsAtLegacy(cmd) {
  if (typeof cmd !== 'string') return false;
  if (cmd.includes('run-with-flags')) return false;
  return LEGACY_PATHS.some(p => cmd.includes(p) && !cmd.includes('/si-'));
}
for (const event of Object.keys(settings.hooks)) {
  if (!Array.isArray(settings.hooks[event])) continue;
  settings.hooks[event] = settings.hooks[event].filter(entry => {
    const hooks = entry.hooks || [];
    return !hooks.some(h => pointsAtLegacy(h.command));
  });
}

// Upsert a single hook entry, deduping by BOTH id and command-basename.
// The legacy findIndex-by-id upsert missed idless entries left behind by
// earlier installs / plugin-cache rsyncs — those accumulated as duplicates
// and caused every PostToolUse call to fire the same tracker twice. Dedupe
// by command-basename catches anything that points at our hook regardless
// of whether it was registered with an id.
function upsertSiHook(arr, hookBasename, ids, entry) {
  for (let i = arr.length - 1; i >= 0; i--) {
    const item = arr[i];
    if (!item) continue;
    const matchesId = ids.some(id => item.id === id);
    const matchesCmd = (item.hooks || []).some(h =>
      typeof h.command === 'string' && h.command.includes(hookBasename)
    );
    if (matchesId || matchesCmd) arr.splice(i, 1);
  }
  arr.push(entry);
}

if (!settings.hooks.PreCompact) settings.hooks.PreCompact = [];
upsertSiHook(settings.hooks.PreCompact, 'si-pre-compact.js',
  ['pre:compact', 'si:pre-compact'], {
    matcher: '*',
    hooks: [{ type: 'command', command: 'node \"${HOOKS_DIR}/si-pre-compact.js\"' }],
    description: 'Session Intelligence: inject compaction hints from session-context.md',
    id: 'si:pre-compact'
  });

// SessionStart: bootstrap (seeds config, autofills session-context, consumes
// one-shot .si-handoff.json written by pre-compact and emits the resume
// banner). Without this, /compact resume silently drops on every project
// that runs install.sh (plugin-based projects wire it via hooks.json).
if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];
upsertSiHook(settings.hooks.SessionStart, 'si-bootstrap.js',
  ['si:bootstrap'], {
    matcher: '*',
    hooks: [{ type: 'command', command: 'node \"${HOOKS_DIR}/si-bootstrap.js\"', timeout: 5 }],
    description: 'Session Intelligence: seed config + consume post-compact handoff',
    id: 'si:bootstrap'
  });

if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
upsertSiHook(settings.hooks.PostToolUse, 'si-token-budget.js',
  ['post:token-budget-tracker', 'si:token-budget-tracker', 'si:token-budget'], {
    matcher: '*',
    hooks: [{ type: 'command', command: 'node \"${HOOKS_DIR}/si-token-budget.js\"', async: true, timeout: 5 }],
    description: 'Session Intelligence: track token usage + unified tool count across ALL tools',
    id: 'si:token-budget'
  });

// suggest-compact moved from PreToolUse (blocking) to PostToolUse (feedback-only).
// Strip any stale PreToolUse entry from older installs so we don't double-fire.
if (settings.hooks.PreToolUse) {
  settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(h => {
    const cmdMatches = (h.hooks || []).some(hh =>
      typeof hh.command === 'string' && hh.command.includes('si-suggest-compact.js'));
    return !cmdMatches
      && h.id !== 'pre:edit-write:suggest-compact'
      && h.id !== 'si:suggest-compact';
  });
  if (settings.hooks.PreToolUse.length === 0) delete settings.hooks.PreToolUse;
}

upsertSiHook(settings.hooks.PostToolUse, 'si-suggest-compact.js',
  ['si:suggest-compact'], {
    matcher: '*',
    hooks: [{ type: 'command', command: 'node \"${HOOKS_DIR}/si-suggest-compact.js\"', timeout: 10 }],
    description: 'Session Intelligence: token-aware compaction suggestions (PostToolUse, non-blocking)',
    id: 'si:suggest-compact'
  });

if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];
upsertSiHook(settings.hooks.UserPromptSubmit, 'si-task-change.js',
  ['si:task-change-detector', 'si:task-change'], {
    matcher: '*',
    hooks: [{ type: 'command', command: 'node \"${HOOKS_DIR}/si-task-change.js\"' }],
    description: 'Session Intelligence: detect task-domain changes at prompt submit',
    id: 'si:task-change'
  });

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
console.log('OK');
" >/dev/null && ok "Hooks registered in settings.json" || err "Failed to register hooks"

fi  # end PLUGIN_INSTALLED branching for hook registration

# ─── 3. Install status line (append, do not replace) ─

# Read any existing statusLine.command so we can chain it. If the user had
# nothing, we still install the wrapper — it'll show only the intel line.
PREV_CMD="$(node -e "
const fs = require('fs');
let out = '';
try {
  const s = JSON.parse(fs.readFileSync('${SETTINGS}', 'utf8'));
  const sl = s.statusLine;
  if (sl) {
    if (typeof sl.command === 'string') out = sl.command;
    else if (typeof sl === 'string') out = sl;
  }
} catch {}
process.stdout.write(out);
" 2>/dev/null)"

# Don't chain our own wrapper back into itself if re-running install.
if echo "$PREV_CMD" | grep -q "statusline-chain.sh"; then
  info "  Detected previous install of statusline-chain.sh — preserving its PREV_STATUSLINE."
  PREV_CMD="$(grep '^PREV_STATUSLINE=' "${SCRIPTS_DIR}/statusline-chain.sh" 2>/dev/null | head -1 | sed "s/^PREV_STATUSLINE=['\"]\(.*\)['\"]$/\1/")"
fi

cp "${PLUGIN_SRC}/statusline/statusline-intel.js" "${SCRIPTS_DIR}/statusline-intel.js"
chmod +x "${SCRIPTS_DIR}/statusline-intel.js"

# Substitute __PREV_STATUSLINE__ with the detected command (or leave blank).
# Using a Perl one-liner to avoid sed escape pain.
PERL_ESCAPED="$(printf '%s' "$PREV_CMD" | perl -pe "s/\\\\/\\\\\\\\/g; s/'/\\\\'/g")"
perl -pe "BEGIN { \$p = q{${PERL_ESCAPED}}; } s/__PREV_STATUSLINE__/\$p/g" \
  "${PLUGIN_SRC}/statusline/statusline-chain.sh" > "${SCRIPTS_DIR}/statusline-chain.sh"
chmod +x "${SCRIPTS_DIR}/statusline-chain.sh"

if [ -n "$PREV_CMD" ]; then
  ok "Chain installed — appending intel line to your existing statusLine"
  info "  Previous: $(echo "$PREV_CMD" | head -c 80)"
else
  ok "Chain installed — showing intel line only (no previous statusLine detected)"
fi

node -e "
const fs = require('fs');
const s = JSON.parse(fs.readFileSync('${SETTINGS}', 'utf8'));
s.statusLine = {
  type: 'command',
  command: '${SCRIPTS_DIR}/statusline-chain.sh',
  padding: 0
};
fs.writeFileSync('${SETTINGS}', JSON.stringify(s, null, 2), 'utf8');
" && ok "settings.json statusLine → statusline-chain.sh"

# ─── 4. Create session-context template ─────────────

if git rev-parse --show-toplevel &>/dev/null; then
  GIT_ROOT="$(git rev-parse --show-toplevel)"
  ENCODED="$(echo "$GIT_ROOT" | sed 's|/|-|g')"
  PROJECT_DIR="${CLAUDE_DIR}/projects/${ENCODED}"

  if [ -d "$PROJECT_DIR" ]; then
    if [ ! -f "${PROJECT_DIR}/session-context.md" ]; then
      cp "${PLUGIN_SRC}/templates/session-context.md" "${PROJECT_DIR}/session-context.md"
      ok "Created session-context.md in ${PROJECT_DIR}/"
    else
      info "session-context.md already exists in ${PROJECT_DIR}/"
    fi
  else
    info "No Claude project dir found for $(basename "$GIT_ROOT") — template not installed"
    info "  Claude will create it on first session in that directory"
  fi
else
  info "Not in a git repo — skipping session-context.md template"
fi

# ─── 5. Validate ────────────────────────────────────

echo ""
info "Validating installation..."

PASS=true
if [ "$PLUGIN_INSTALLED" = false ]; then
  for f in si-pre-compact.js si-suggest-compact.js si-token-budget.js si-task-change.js; do
    if node -c "${HOOKS_DIR}/${f}" 2>/dev/null; then
      ok "  ${f} — syntax OK"
    else
      err "  ${f} — syntax ERROR"
      PASS=false
    fi
  done

  if node -c "${LIB_DIR}/config.js" 2>/dev/null; then
    ok "  lib/config.js — syntax OK"
  else
    err "  lib/config.js — syntax ERROR"
    PASS=false
  fi
else
  info "  hooks validated via plugin cache (skipped — owned by plugin manifest)"
fi

if node -c "${SCRIPTS_DIR}/statusline-intel.js" 2>/dev/null; then
  ok "  statusline-intel.js — syntax OK"
else
  err "  statusline-intel.js — syntax ERROR"
  PASS=false
fi

if bash -n "${SCRIPTS_DIR}/statusline-chain.sh" 2>/dev/null; then
  ok "  statusline-chain.sh — syntax OK"
else
  err "  statusline-chain.sh — syntax ERROR"
  PASS=false
fi

if node -e "JSON.parse(require('fs').readFileSync('${SETTINGS}','utf8'))" 2>/dev/null; then
  ok "  settings.json — valid JSON"
else
  err "  settings.json — invalid JSON"
  PASS=false
fi

echo ""
if [ "$PASS" = true ]; then
  ok "Installation complete!"
else
  err "Installation completed with errors — check above"
fi

# ─── 6. Next steps ──────────────────────────────────

echo ""
echo -e "${CYAN}Next steps:${NC}"
echo ""
echo "  1. Restart Claude Code so it picks up the new statusLine + hooks."
echo ""
echo "  2. (Optional) Add session discipline rules to your CLAUDE.md:"
echo "     cat ${SCRIPT_DIR}/templates/claude-md-rules.md"
echo ""
echo "  3. Tail the debug log while working:"
echo "     tail -f ${LOGS_DIR}/session-intel-\$(date +%F).log"
echo ""
echo "  4. Enable verbose debug output (optional):"
echo "     export CLAUDE_INTEL_DEBUG=1   # then restart Claude Code"
echo ""
echo -e "${CYAN}Token budget zones:${NC}"
echo "  Green  (<200k) — free zone, work normally"
echo "  Yellow (200k)  — caution, compact between tasks"
echo "  Orange (300k)  — context rot zone, compact now"
echo "  Red    (400k)  — urgent, compact immediately"
echo ""
