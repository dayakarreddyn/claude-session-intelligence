#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────
# Uninstall Session Intelligence for Claude Code
# ─────────────────────────────────────────────────────

CLAUDE_DIR="${HOME}/.claude"
HOOKS_DIR="${CLAUDE_DIR}/scripts/hooks"
SETTINGS="${CLAUDE_DIR}/settings.json"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[SI]${NC} $1"; }
ok()    { echo -e "${GREEN}[SI]${NC} $1"; }

info "Uninstalling Session Intelligence..."

# Remove hooks
for f in token-budget-tracker.js; do
  if [ -f "${HOOKS_DIR}/${f}" ]; then
    rm "${HOOKS_DIR}/${f}"
    ok "Removed ${f}"
  fi
done

# Restore backups if they exist
for hook in pre-compact.js suggest-compact.js; do
  if [ -f "${HOOKS_DIR}/${hook}.bak" ]; then
    mv "${HOOKS_DIR}/${hook}.bak" "${HOOKS_DIR}/${hook}"
    ok "Restored ${hook} from backup"
  fi
done

# Remove bundled lib
if [ -d "${HOOKS_DIR}/session-intelligence" ]; then
  rm -rf "${HOOKS_DIR}/session-intelligence"
  ok "Removed session-intelligence lib"
fi

# Remove hook registrations from settings.json
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
  fs.writeFileSync('${SETTINGS}', JSON.stringify(settings, null, 2), 'utf8');
  console.log('OK');
  " && ok "Removed hook registrations from settings.json" || echo -e "${RED}[SI]${NC} Failed to clean settings.json"
fi

echo ""
ok "Uninstall complete. Session-context.md files in projects are preserved."
echo "  (Remove them manually if you want: find ~/.claude/projects -name session-context.md)"
