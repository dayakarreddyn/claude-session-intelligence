#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────
# Session Intelligence for Claude Code
# Prevents context rot with task-aware compaction hints
# ─────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${HOME}/.claude"
HOOKS_DIR="${CLAUDE_DIR}/scripts/hooks"
LIB_DIR="${HOOKS_DIR}/session-intelligence/lib"
SETTINGS="${CLAUDE_DIR}/settings.json"

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

# ─── 1. Install hooks ───────────────────────────────

mkdir -p "$HOOKS_DIR" "$LIB_DIR"

# Backup existing hooks if they exist (ECC or previous install)
for hook in pre-compact.js suggest-compact.js; do
  if [ -f "${HOOKS_DIR}/${hook}" ]; then
    # Check if it's already our version
    if grep -q "Session Intelligence" "${HOOKS_DIR}/${hook}" 2>/dev/null; then
      info "  ${hook} already installed, updating..."
    else
      cp "${HOOKS_DIR}/${hook}" "${HOOKS_DIR}/${hook}.bak"
      warn "  Backed up existing ${hook} → ${hook}.bak"
    fi
  fi
done

cp "${SCRIPT_DIR}/hooks/pre-compact.js"         "${HOOKS_DIR}/pre-compact.js"
cp "${SCRIPT_DIR}/hooks/suggest-compact.js"      "${HOOKS_DIR}/suggest-compact.js"
cp "${SCRIPT_DIR}/hooks/token-budget-tracker.js"  "${HOOKS_DIR}/token-budget-tracker.js"
cp "${SCRIPT_DIR}/lib/utils.js"                  "${LIB_DIR}/utils.js"

chmod +x "${HOOKS_DIR}/pre-compact.js"
chmod +x "${HOOKS_DIR}/suggest-compact.js"
chmod +x "${HOOKS_DIR}/token-budget-tracker.js"

ok "Hooks installed to ${HOOKS_DIR}/"

# ─── 2. Register hooks in settings.json ─────────────

if [ ! -f "$SETTINGS" ]; then
  warn "No settings.json found — creating minimal one"
  echo '{}' > "$SETTINGS"
fi

# Use node to safely merge hook registrations
node -e "
const fs = require('fs');
const settingsPath = '${SETTINGS}';
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

if (!settings.hooks) settings.hooks = {};

// ─── PreCompact hook (replace if exists) ───
if (!settings.hooks.PreCompact) settings.hooks.PreCompact = [];

const preCompactIdx = settings.hooks.PreCompact.findIndex(h =>
  h.id === 'pre:compact' || h.id === 'si:pre-compact'
);
const preCompactEntry = {
  matcher: '*',
  hooks: [{
    type: 'command',
    command: 'node \"${HOOKS_DIR}/pre-compact.js\"'
  }],
  description: 'Session Intelligence: inject compaction hints from session-context.md',
  id: 'si:pre-compact'
};
if (preCompactIdx >= 0) {
  settings.hooks.PreCompact[preCompactIdx] = preCompactEntry;
} else {
  settings.hooks.PreCompact.push(preCompactEntry);
}

// ─── PostToolUse: token budget tracker ───
if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];

const budgetIdx = settings.hooks.PostToolUse.findIndex(h =>
  h.id === 'post:token-budget-tracker' || h.id === 'si:token-budget-tracker'
);
const budgetEntry = {
  matcher: 'Read|Bash|Grep|Glob|Agent',
  hooks: [{
    type: 'command',
    command: 'node \"${HOOKS_DIR}/token-budget-tracker.js\"',
    async: true,
    timeout: 5
  }],
  description: 'Session Intelligence: track approximate token usage for context rot prevention',
  id: 'si:token-budget-tracker'
};
if (budgetIdx >= 0) {
  settings.hooks.PostToolUse[budgetIdx] = budgetEntry;
} else {
  settings.hooks.PostToolUse.push(budgetEntry);
}

// ─── PreToolUse: suggest compact ───
if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];

const suggestIdx = settings.hooks.PreToolUse.findIndex(h =>
  h.id === 'pre:edit-write:suggest-compact' || h.id === 'si:suggest-compact'
);
const suggestEntry = {
  matcher: 'Edit|Write',
  hooks: [{
    type: 'command',
    command: 'node \"${HOOKS_DIR}/suggest-compact.js\"'
  }],
  description: 'Session Intelligence: token-aware compaction suggestions',
  id: 'si:suggest-compact'
};
if (suggestIdx >= 0) {
  settings.hooks.PreToolUse[suggestIdx] = suggestEntry;
} else {
  settings.hooks.PreToolUse.push(suggestEntry);
}

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
console.log('OK');
" && ok "Hooks registered in settings.json" || err "Failed to register hooks"

# ─── 3. Create session-context template ─────────────

# Detect current project and create session-context.md
if git rev-parse --show-toplevel &>/dev/null; then
  GIT_ROOT="$(git rev-parse --show-toplevel)"
  ENCODED="$(echo "$GIT_ROOT" | sed 's|/|-|g')"
  PROJECT_DIR="${CLAUDE_DIR}/projects/${ENCODED}"

  if [ -d "$PROJECT_DIR" ]; then
    if [ ! -f "${PROJECT_DIR}/session-context.md" ]; then
      cp "${SCRIPT_DIR}/templates/session-context.md" "${PROJECT_DIR}/session-context.md"
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

# ─── 4. Validate ────────────────────────────────────

echo ""
info "Validating installation..."

PASS=true
for f in pre-compact.js suggest-compact.js token-budget-tracker.js; do
  if node -c "${HOOKS_DIR}/${f}" 2>/dev/null; then
    ok "  ${f} — syntax OK"
  else
    err "  ${f} — syntax ERROR"
    PASS=false
  fi
done

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

# ─── 5. Next steps ──────────────────────────────────

echo ""
echo -e "${CYAN}Next steps:${NC}"
echo ""
echo "  1. Add session discipline rules to your CLAUDE.md:"
echo "     cat ${SCRIPT_DIR}/templates/claude-md-rules.md"
echo ""
echo "  2. Start a new Claude Code session (hooks load on session start)"
echo ""
echo "  3. Claude will maintain session-context.md at task boundaries."
echo "     The pre-compact hook reads it to guide compaction."
echo ""
echo -e "${CYAN}Token budget zones:${NC}"
echo "  Green  (<200k) — free zone, work normally"
echo "  Yellow (200k)  — caution, compact between tasks"
echo "  Orange (300k)  — context rot zone, compact now"
echo "  Red    (400k)  — urgent, compact immediately"
echo ""
