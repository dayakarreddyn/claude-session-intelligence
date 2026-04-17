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

# ─── 1. Install hooks + shared lib ──────────────────

mkdir -p "$HOOKS_DIR" "$LIB_DIR" "$SCRIPTS_DIR" "$LOGS_DIR" "$COMMANDS_DIR"

# Migrate any pre-rename (unprefixed) SI hooks left behind by older installs.
# We only remove files we authored — match on the "Session Intelligence"
# banner so we don't trample a same-named file from another source.
for legacy in pre-compact.js suggest-compact.js token-budget-tracker.js task-change-detector.js; do
  if [ -f "${HOOKS_DIR}/${legacy}" ] && grep -q "Session Intelligence" "${HOOKS_DIR}/${legacy}" 2>/dev/null; then
    mv "${HOOKS_DIR}/${legacy}" "${HOOKS_DIR}/${legacy}.bak-pre-si-rename"
    warn "  Migrated ${legacy} → ${legacy}.bak-pre-si-rename (renamed with si- prefix)"
  fi
done

# New install path (all hooks carry the si- prefix for discoverability in
# shared hook directories).
for hook in si-pre-compact.js si-suggest-compact.js si-token-budget.js si-task-change.js; do
  if [ -f "${HOOKS_DIR}/${hook}" ]; then
    if grep -q "Session Intelligence" "${HOOKS_DIR}/${hook}" 2>/dev/null; then
      info "  ${hook} already installed, updating..."
    else
      cp "${HOOKS_DIR}/${hook}" "${HOOKS_DIR}/${hook}.bak"
      warn "  Backed up existing ${hook} → ${hook}.bak"
    fi
  fi
done

cp "${PLUGIN_SRC}/hooks/si-pre-compact.js"     "${HOOKS_DIR}/si-pre-compact.js"
cp "${PLUGIN_SRC}/hooks/si-suggest-compact.js" "${HOOKS_DIR}/si-suggest-compact.js"
cp "${PLUGIN_SRC}/hooks/si-token-budget.js"    "${HOOKS_DIR}/si-token-budget.js"
cp "${PLUGIN_SRC}/hooks/si-task-change.js"     "${HOOKS_DIR}/si-task-change.js"
cp "${PLUGIN_SRC}/hooks/si-status-report.js"   "${HOOKS_DIR}/si-status-report.js"
cp "${PLUGIN_SRC}/lib/utils.js"                    "${LIB_DIR}/utils.js"
cp "${PLUGIN_SRC}/lib/intel-debug.js"              "${LIB_DIR}/intel-debug.js"
cp "${PLUGIN_SRC}/lib/config.js"                   "${LIB_DIR}/config.js"

# Hooks load lib/config via ../lib — mirror that layout so relative requires
# resolve the same whether the hook is run from the repo or from ~/.claude.
HOOK_LIB_SHIM="${HOOKS_DIR}/../lib"
mkdir -p "${HOOK_LIB_SHIM}"
cp "${PLUGIN_SRC}/lib/utils.js"       "${HOOK_LIB_SHIM}/utils.js"
cp "${PLUGIN_SRC}/lib/intel-debug.js" "${HOOK_LIB_SHIM}/intel-debug.js"
cp "${PLUGIN_SRC}/lib/config.js"      "${HOOK_LIB_SHIM}/config.js"

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

chmod +x "${HOOKS_DIR}/si-pre-compact.js"
chmod +x "${HOOKS_DIR}/si-suggest-compact.js"
chmod +x "${HOOKS_DIR}/si-token-budget.js"
chmod +x "${HOOKS_DIR}/si-task-change.js"
chmod +x "${HOOKS_DIR}/si-status-report.js"

ok "Hooks + lib installed to ${HOOKS_DIR}/"

# ─── 2. Register hooks in settings.json ─────────────

if [ ! -f "$SETTINGS" ]; then
  warn "No settings.json found — creating minimal one"
  echo '{}' > "$SETTINGS"
fi

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

if (!settings.hooks.PreCompact) settings.hooks.PreCompact = [];
const preCompactIdx = settings.hooks.PreCompact.findIndex(h =>
  h.id === 'pre:compact' || h.id === 'si:pre-compact'
);
const preCompactEntry = {
  matcher: '*',
  hooks: [{ type: 'command', command: 'node \"${HOOKS_DIR}/si-pre-compact.js\"' }],
  description: 'Session Intelligence: inject compaction hints from session-context.md',
  id: 'si:pre-compact'
};
if (preCompactIdx >= 0) settings.hooks.PreCompact[preCompactIdx] = preCompactEntry;
else settings.hooks.PreCompact.push(preCompactEntry);

if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
const budgetIdx = settings.hooks.PostToolUse.findIndex(h =>
  h.id === 'post:token-budget-tracker' || h.id === 'si:token-budget-tracker' || h.id === 'si:token-budget'
);
const budgetEntry = {
  matcher: '*',
  hooks: [{ type: 'command', command: 'node \"${HOOKS_DIR}/si-token-budget.js\"', async: true, timeout: 5 }],
  description: 'Session Intelligence: track token usage + unified tool count across ALL tools',
  id: 'si:token-budget'
};
if (budgetIdx >= 0) settings.hooks.PostToolUse[budgetIdx] = budgetEntry;
else settings.hooks.PostToolUse.push(budgetEntry);

// suggest-compact moved from PreToolUse (blocking) to PostToolUse (feedback-only).
// Strip any stale PreToolUse entry from older installs so we don't double-fire.
if (settings.hooks.PreToolUse) {
  settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(h =>
    h.id !== 'pre:edit-write:suggest-compact' && h.id !== 'si:suggest-compact'
  );
  if (settings.hooks.PreToolUse.length === 0) delete settings.hooks.PreToolUse;
}

const suggestIdx = settings.hooks.PostToolUse.findIndex(h =>
  h.id === 'si:suggest-compact'
);
const suggestEntry = {
  matcher: '*',
  hooks: [{ type: 'command', command: 'node \"${HOOKS_DIR}/si-suggest-compact.js\"', timeout: 10 }],
  description: 'Session Intelligence: token-aware compaction suggestions (PostToolUse, non-blocking)',
  id: 'si:suggest-compact'
};
if (suggestIdx >= 0) settings.hooks.PostToolUse[suggestIdx] = suggestEntry;
else settings.hooks.PostToolUse.push(suggestEntry);

if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];
const taskIdx = settings.hooks.UserPromptSubmit.findIndex(h =>
  h.id === 'si:task-change-detector' || h.id === 'si:task-change'
);
const taskEntry = {
  matcher: '*',
  hooks: [{ type: 'command', command: 'node \"${HOOKS_DIR}/si-task-change.js\"' }],
  description: 'Session Intelligence: detect task-domain changes at prompt submit',
  id: 'si:task-change'
};
if (taskIdx >= 0) settings.hooks.UserPromptSubmit[taskIdx] = taskEntry;
else settings.hooks.UserPromptSubmit.push(taskEntry);

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
console.log('OK');
" >/dev/null && ok "Hooks registered in settings.json" || err "Failed to register hooks"

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
