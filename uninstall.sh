#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────
# Uninstall Session Intelligence for Claude Code
# ─────────────────────────────────────────────────────

CLAUDE_DIR="${HOME}/.claude"
HOOKS_DIR="${CLAUDE_DIR}/scripts/hooks"
SCRIPTS_DIR="${CLAUDE_DIR}/scripts"
SETTINGS="${CLAUDE_DIR}/settings.json"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[SI]${NC} $1"; }
ok()    { echo -e "${GREEN}[SI]${NC} $1"; }

info "Uninstalling Session Intelligence..."

# Remove our hooks (both current si-prefixed names and any pre-rename
# unprefixed copies left behind by older installs).
for f in si-pre-compact.js si-suggest-compact.js si-token-budget.js si-task-change.js si-status-report.js \
         pre-compact.js suggest-compact.js token-budget-tracker.js task-change-detector.js status-report.js; do
  if [ -f "${HOOKS_DIR}/${f}" ] && grep -q "Session Intelligence" "${HOOKS_DIR}/${f}" 2>/dev/null; then
    rm "${HOOKS_DIR}/${f}"
    ok "Removed ${f}"
  fi
done

# Restore backups left behind by the pre-rename migration (if we had shadowed
# a same-named hook from another source before install).
for hook in pre-compact.js suggest-compact.js si-pre-compact.js si-suggest-compact.js; do
  for suffix in .bak .bak-pre-si-rename; do
    if [ -f "${HOOKS_DIR}/${hook}${suffix}" ]; then
      mv "${HOOKS_DIR}/${hook}${suffix}" "${HOOKS_DIR}/${hook}"
      ok "Restored ${hook} from backup (${suffix})"
    fi
  done
done

# Remove bundled lib (utils + intel-debug)
if [ -d "${HOOKS_DIR}/session-intelligence" ]; then
  rm -rf "${HOOKS_DIR}/session-intelligence"
  ok "Removed session-intelligence lib"
fi

# Remove status line scripts
for f in statusline-intel.js statusline-chain.sh; do
  if [ -f "${SCRIPTS_DIR}/${f}" ]; then
    rm "${SCRIPTS_DIR}/${f}"
    ok "Removed ${f}"
  fi
done

# Clean settings.json: drop si:* hooks, and restore the prior statusLine
# that statusline-chain.sh was wrapping (recorded in the script's
# PREV_STATUSLINE variable before we removed it above).
if [ -f "$SETTINGS" ]; then
  node -e "
  const fs = require('fs');
  const settings = JSON.parse(fs.readFileSync('${SETTINGS}', 'utf8'));
  const hooks = settings.hooks || {};

  for (const [event, entries] of Object.entries(hooks)) {
    if (Array.isArray(entries)) {
      hooks[event] = entries.filter(h => !String(h.id || '').startsWith('si:'));
    }
  }
  settings.hooks = hooks;

  // If current statusLine points at our chain (which we just deleted),
  // remove it so the bar doesn't break. Users can re-configure later.
  const cmd = settings.statusLine && settings.statusLine.command;
  if (typeof cmd === 'string' && cmd.includes('statusline-chain.sh')) {
    delete settings.statusLine;
  }

  fs.writeFileSync('${SETTINGS}', JSON.stringify(settings, null, 2), 'utf8');
  console.log('OK');
  " && ok "Removed hook + statusLine registrations from settings.json" || echo -e "${RED}[SI]${NC} Failed to clean settings.json"
fi

echo ""
ok "Uninstall complete. session-context.md files in projects are preserved."
echo "  Remove them manually if you want:"
echo "    find ~/.claude/projects -name session-context.md"
echo ""
echo "  Debug logs also preserved:"
echo "    ls ~/.claude/logs/session-intel-*.log"
