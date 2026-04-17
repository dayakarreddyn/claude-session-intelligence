#!/usr/bin/env bash
# Session Intelligence — statusLine wrapper
#
# Chains a previous statusLine command with the session-intelligence line:
#
#     [whatever you had before]  ·  [Model · project · zone · tokens · tools · task]
#
# The install script writes your previous statusLine.command into
# PREV_STATUSLINE below. If you install by hand, set it there directly.
# Leave as __PREV_STATUSLINE__ (or empty) to show only the intel line.
#
# Env overrides:
#   CLAUDE_STATUSLINE_NO_PREV=1    — skip the previous command
#   CLAUDE_STATUSLINE_NO_INTEL=1   — skip the intel line
#   CLAUDE_STATUSLINE_SEP="..."    — separator between them (default newline)
#
# Trust model:
#   PREV_STATUSLINE is executed via `bash -c` on every statusline redraw.
#   It originates from your own `~/.claude/settings.json → statusLine.command`
#   which Claude Code would execute anyway — we don't add any new privilege.
#   Bootstrap validates the value before baking (no NUL/newline, ≤4 KB) and
#   writes this file 0700 so other local users can't read or swap it. Anyone
#   who can write ~/.claude/ already has full user-level access; this script
#   is not the trust boundary.
#
# Rationale: most existing statusLine commands (ccstatusline and friends)
# already emit multiple lines, so we always want the intel line as a new,
# separate line at the bottom rather than a same-line append.

set -o pipefail

PREV_STATUSLINE='__PREV_STATUSLINE__'
INTEL_SCRIPT="$HOME/.claude/scripts/statusline-intel.js"
SEP="${CLAUDE_STATUSLINE_SEP:-$'\n'}"

input="$(cat)"
prev=""
intel=""

# Placeholder-sentinel check must NOT literally contain __PREV_STATUSLINE__
# as a double-quoted value — the installer's substitution would rewrite it
# along with the assignment above, turning this guard into
# `[ "$PREV_STATUSLINE" != "<the real command>" ]`, which skips the real
# command (ccstatusline, etc.) every time. Assemble the sentinel from pieces
# at runtime so the installer's search/replace can't touch it.
PLACEHOLDER_SENTINEL='__PREV'"_STATUSLINE__"
if [ -z "${CLAUDE_STATUSLINE_NO_PREV:-}" ] \
   && [ -n "$PREV_STATUSLINE" ] \
   && [ "$PREV_STATUSLINE" != "$PLACEHOLDER_SENTINEL" ]; then
  prev="$(printf '%s' "$input" | bash -c "$PREV_STATUSLINE" 2>/dev/null)"
fi

if [ -z "${CLAUDE_STATUSLINE_NO_INTEL:-}" ] && [ -f "$INTEL_SCRIPT" ]; then
  intel="$(printf '%s' "$input" | node "$INTEL_SCRIPT" 2>/dev/null)"
fi

if [ -n "$prev" ] && [ -n "$intel" ]; then
  printf '%s%s%s' "$prev" "$SEP" "$intel"
elif [ -n "$prev" ]; then
  printf '%s' "$prev"
elif [ -n "$intel" ]; then
  printf '%s' "$intel"
else
  printf 'claude'
fi
