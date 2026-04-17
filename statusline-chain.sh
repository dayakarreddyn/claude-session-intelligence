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

if [ -z "${CLAUDE_STATUSLINE_NO_PREV:-}" ] \
   && [ -n "$PREV_STATUSLINE" ] \
   && [ "$PREV_STATUSLINE" != "__PREV_STATUSLINE__" ]; then
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
