#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────
# Session Intelligence for Claude Code
# Task-aware compaction + token budget + status line
# ─────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${HOME}/.claude"
HOOKS_DIR="${CLAUDE_DIR}/scripts/hooks"
LIB_DIR="${HOOKS_DIR}/session-intelligence/lib"
SCRIPTS_DIR="${CLAUDE_DIR}/scripts"
LOGS_DIR="${CLAUDE_DIR}/logs"
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

# ─── 1. Install hooks + shared lib ──────────────────

mkdir -p "$HOOKS_DIR" "$LIB_DIR" "$SCRIPTS_DIR" "$LOGS_DIR"

for hook in pre-compact.js suggest-compact.js token-budget-tracker.js; do
  if [ -f "${HOOKS_DIR}/${hook}" ]; then
    if grep -q "Session Intelligence" "${HOOKS_DIR}/${hook}" 2>/dev/null; then
      info "  ${hook} already installed, updating..."
    else
      cp "${HOOKS_DIR}/${hook}" "${HOOKS_DIR}/${hook}.bak"
      warn "  Backed up existing ${hook} → ${hook}.bak"
    fi
  fi
done

cp "${SCRIPT_DIR}/hooks/pre-compact.js"          "${HOOKS_DIR}/pre-compact.js"
cp "${SCRIPT_DIR}/hooks/suggest-compact.js"       "${HOOKS_DIR}/suggest-compact.js"
cp "${SCRIPT_DIR}/hooks/token-budget-tracker.js"   "${HOOKS_DIR}/token-budget-tracker.js"
cp "${SCRIPT_DIR}/lib/utils.js"                   "${LIB_DIR}/utils.js"
cp "${SCRIPT_DIR}/lib/intel-debug.js"             "${LIB_DIR}/intel-debug.js"

# Install an example statusline config if one doesn't exist yet. Users can
# edit ~/.claude/statusline-intel.json to pick fields, zones, colors, etc.
if [ ! -f "${CLAUDE_DIR}/statusline-intel.json" ] && [ -f "${SCRIPT_DIR}/statusline-intel.json.example" ]; then
  cp "${SCRIPT_DIR}/statusline-intel.json.example" "${CLAUDE_DIR}/statusline-intel.json"
  ok "Installed default config: ~/.claude/statusline-intel.json"
fi

chmod +x "${HOOKS_DIR}/pre-compact.js"
chmod +x "${HOOKS_DIR}/suggest-compact.js"
chmod +x "${HOOKS_DIR}/token-budget-tracker.js"

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

if (!settings.hooks.PreCompact) settings.hooks.PreCompact = [];
const preCompactIdx = settings.hooks.PreCompact.findIndex(h =>
  h.id === 'pre:compact' || h.id === 'si:pre-compact'
);
const preCompactEntry = {
  matcher: '*',
  hooks: [{ type: 'command', command: 'node \"${HOOKS_DIR}/pre-compact.js\"' }],
  description: 'Session Intelligence: inject compaction hints from session-context.md',
  id: 'si:pre-compact'
};
if (preCompactIdx >= 0) settings.hooks.PreCompact[preCompactIdx] = preCompactEntry;
else settings.hooks.PreCompact.push(preCompactEntry);

if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
const budgetIdx = settings.hooks.PostToolUse.findIndex(h =>
  h.id === 'post:token-budget-tracker' || h.id === 'si:token-budget-tracker'
);
const budgetEntry = {
  matcher: '*',
  hooks: [{ type: 'command', command: 'node \"${HOOKS_DIR}/token-budget-tracker.js\"', async: true, timeout: 5 }],
  description: 'Session Intelligence: track token usage + unified tool count across ALL tools',
  id: 'si:token-budget-tracker'
};
if (budgetIdx >= 0) settings.hooks.PostToolUse[budgetIdx] = budgetEntry;
else settings.hooks.PostToolUse.push(budgetEntry);

if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
const suggestIdx = settings.hooks.PreToolUse.findIndex(h =>
  h.id === 'pre:edit-write:suggest-compact' || h.id === 'si:suggest-compact'
);
const suggestEntry = {
  matcher: 'Edit|Write',
  hooks: [{ type: 'command', command: 'node \"${HOOKS_DIR}/suggest-compact.js\"' }],
  description: 'Session Intelligence: token-aware compaction suggestions',
  id: 'si:suggest-compact'
};
if (suggestIdx >= 0) settings.hooks.PreToolUse[suggestIdx] = suggestEntry;
else settings.hooks.PreToolUse.push(suggestEntry);

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
console.log('OK');
" >/dev/null && ok "Hooks registered in settings.json" || err "Failed to register hooks"

# ─── 3. Install status line (append, do not replace) ─

# Read any existing statusLine.command so we can chain it. If the user had
# nothing, we still install the wrapper — it'll show only the intel line.
PREV_CMD="$(node -e "
const fs = require('fs');
try {
  const s = JSON.parse(fs.readFileSync('${SETTINGS}', 'utf8'));
  const sl = s.statusLine;
  if (!sl) return process.stdout.write('');
  if (typeof sl.command === 'string') return process.stdout.write(sl.command);
  if (typeof sl === 'string') return process.stdout.write(sl);
} catch {}
" 2>/dev/null)"

# Don't chain our own wrapper back into itself if re-running install.
if echo "$PREV_CMD" | grep -q "statusline-chain.sh"; then
  info "  Detected previous install of statusline-chain.sh — preserving its PREV_STATUSLINE."
  PREV_CMD="$(grep '^PREV_STATUSLINE=' "${SCRIPTS_DIR}/statusline-chain.sh" 2>/dev/null | head -1 | sed "s/^PREV_STATUSLINE=['\"]\(.*\)['\"]$/\1/")"
fi

cp "${SCRIPT_DIR}/statusline-intel.js" "${SCRIPTS_DIR}/statusline-intel.js"
chmod +x "${SCRIPTS_DIR}/statusline-intel.js"

# Substitute __PREV_STATUSLINE__ with the detected command (or leave blank).
# Using a Perl one-liner to avoid sed escape pain.
PERL_ESCAPED="$(printf '%s' "$PREV_CMD" | perl -pe "s/\\\\/\\\\\\\\/g; s/'/\\\\'/g")"
perl -pe "BEGIN { \$p = q{${PERL_ESCAPED}}; } s/__PREV_STATUSLINE__/\$p/g" \
  "${SCRIPT_DIR}/statusline-chain.sh" > "${SCRIPTS_DIR}/statusline-chain.sh"
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

# ─── 5. Validate ────────────────────────────────────

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
