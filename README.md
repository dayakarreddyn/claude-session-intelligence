# Session Intelligence for Claude Code

Prevent context rot and bad compactions in Claude Code sessions. Adds task-aware compaction hints, token budget tracking, proactive compact suggestions, a structured debug log, and a colored status-line indicator that appends to whatever statusLine you already have.

The 1M token context window lets Claude work autonomously for longer, but performance degrades as context grows (~300-400k tokens). This plugin gives Claude — and you — live visibility into where the session is on that curve, and makes every compaction deliberate instead of guessed.

## The Problem

Without session intelligence:
- Auto-compact fires at arbitrary points and **drops context you need**
- No way to tell Claude "preserve X, drop Y" during compaction
- You rediscover the same findings 2-3 times across compaction boundaries
- Context rot degrades output quality long before hitting the 1M limit
- No way to tell from the CLI how close you are to the rot zone

## How It Works

```
┌─────────────────────────────────────────────┐
│ 1. Claude updates session-context.md        │
│    at each task boundary                    │
│                                             │
│ 2. Token budget tracker estimates usage     │
│    from tool I/O (~4 chars/token)           │
│                                             │
│ 3. Suggest-compact warns at zone borders    │
│    Yellow (200k) → Orange (300k) → Red (400k)│
│                                             │
│ 4. On compact: pre-compact hook reads       │
│    session-context.md and injects           │
│    PRESERVE/DROP hints into the prompt      │
│                                             │
│ 5. Every prompt: status line appends a      │
│    colored zone indicator beneath your      │
│    existing statusLine                      │
└─────────────────────────────────────────────┘
```

### Token Zones

| Zone | Tokens | Action |
|------|--------|--------|
| Green | <200k | Free zone — work normally |
| Yellow | 200-300k | Caution — compact between tasks |
| Orange | 300-400k | Context rot — compact now |
| Red | >400k | Urgent — compact immediately |

## Install

```bash
git clone https://github.com/dayakarreddyn/claude-session-intelligence.git
cd claude-session-intelligence
chmod +x install.sh
./install.sh
```

Then restart Claude Code. That's it.

The install script:
1. Copies 3 hook files to `~/.claude/scripts/hooks/`
2. Copies the debug lib to `~/.claude/scripts/hooks/session-intelligence/lib/`
3. Copies `statusline-intel.js` + `statusline-chain.sh` to `~/.claude/scripts/`
4. **Detects your existing statusLine** (ccstatusline, custom, etc.) and configures the chain wrapper to preserve it — our intel line appends as a new line at the bottom, never replacing yours
5. Registers all hooks in `~/.claude/settings.json` (non-destructive merge, existing hooks kept)
6. Creates `session-context.md` template in your current project
7. Creates `~/.claude/logs/` for debug output
8. Backs up any existing hooks before replacing
9. Validates everything

### Requirements
- Claude Code CLI installed (`~/.claude/` directory exists)
- Node.js (any recent version)
- Bash (for the status-line chain wrapper)

### Uninstall

```bash
./uninstall.sh
```

Restores backed-up hooks, removes `si:*` registrations from settings, deletes statusline scripts, leaves your `session-context.md` files and debug logs intact.

## Usage

### 1. Add rules to your CLAUDE.md

Copy the rules from `templates/claude-md-rules.md` into your project's `CLAUDE.md`. These tell Claude to:
- Update `session-context.md` at task boundaries
- Compact proactively instead of waiting for auto-compact
- Use subagents for exploratory work
- Rewind instead of stacking corrections

### 2. Session Context File

Claude maintains `~/.claude/projects/<project>/session-context.md` during sessions:

```markdown
## Current Task
type: bug-fix
description: Fix model dropdown not pre-selecting on scene navigation

## Key Files
- src/components/editor/GenerateTab.tsx
- src/store/useSceneEditor.ts

## Key Decisions
- Dropdown reads from settings.generate || projectModel || generation_config
- Deep clone cached scenes before hydration (Immer freeze)

## Completed Tasks (safe to drop details)
- Login page reload fix (resolved)
- CSS thumbnail fix (deployed)

## On Compact
PRESERVE: current task context, key files, all decisions
DROP: login debugging traces, CSS exploration, E2E raw output
```

### 3. What Happens on Compact

When `/compact` fires (manually or auto), the pre-compact hook reads session-context.md and injects:

```
COMPACTION GUIDANCE (from session-context.md):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CURRENT TASK:
type: bug-fix
description: Fix model dropdown not pre-selecting

KEY FILES (must preserve):
- src/components/editor/GenerateTab.tsx
- src/store/useSceneEditor.ts

KEY DECISIONS (must preserve):
- Dropdown reads from settings.generate || projectModel || generation_config
- Deep clone cached scenes before hydration (Immer freeze)

SAFE TO DROP (resolved — keep only one-line summaries):
- Login page reload fix (resolved)
- CSS thumbnail fix (deployed)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Claude uses these hints to make better compaction decisions.

## Status Line

A single-line indicator rendered at the bottom of Claude Code's status bar on every redraw:

```
Opus 4.7 · CSM · ▰▱▱▱ 23k tok · 39 tools · idle — session 28 ended 2026-04-17 clean
```

Fields:
- **Model** — from the stdin payload Claude Code provides
- **Project** — basename of the working directory
- **Zone bar + token count** — colored green → yellow → orange → red as the budget grows
- **Tool count** — total hook-tracked tool invocations this session
- **Current task** — the `type: …` line from `session-context.md`, truncated

### Append, don't replace

Most users already have a statusLine — ccstatusline, starship, a custom script. The installer detects it and wires a chain wrapper (`statusline-chain.sh`) that runs your previous command first, then the intel line as a new line below:

```
🌴 main · ⎇ dev · (+0,-0) · /Users/you/project       ← your existing statusLine
🔛 · ↓ · ↑ · c · 🏎️
⏱️ Session: 0m · 💰 3hr 42m
👾 Opus 4.7 (1M)
⏳ Weekly: 3.0% · Weekly Reset: 6d 10hr
Opus 4.7 · project · ▰▱▱▱ 23k tok · 39 tools · idle         ← appended by us
```

If you had no statusLine configured, you get just the intel line.

### Status-line env knobs

| Variable | Effect |
|---|---|
| `CLAUDE_STATUSLINE_NO_PREV=1` | Skip the previous command — show only our intel line |
| `CLAUDE_STATUSLINE_NO_INTEL=1` | Skip our line — show only the previous command |
| `CLAUDE_STATUSLINE_SEP="..."` | Separator between the two (default: newline) |
| `CLAUDE_STATUSLINE_COMPACT=1` | Drop the task-description tail from the intel line |
| `CLAUDE_STATUSLINE_NO_COLOR=1` / `NO_COLOR=1` | Strip ANSI from the intel line |

### Swap back to your original statusLine

Open `~/.claude/scripts/statusline-chain.sh` and edit the `PREV_STATUSLINE=…` line — anything between the quotes gets run on each redraw. Or re-point `~/.claude/settings.json` → `statusLine.command` directly at whatever you want.

## Debug Log

All three hooks (plus `intelLog` calls from your own scripts) write structured, timestamped lines to:

```
~/.claude/logs/session-intel-YYYY-MM-DD.log
```

The file rotates at 5 MB per day (the prior file is renamed to `*.log.1`).

### Log format

```
YYYY-MM-DD HH:MM:SS.mmm LEVEL source           [sessionId] message | {meta}
```

Example entries:

```
2026-04-17 07:17:25.645 DEBUG token-budget     [test-123] hook fired | {"sessionId":"test-123"}
2026-04-17 08:03:11.201 INFO  token-budget     [abc]      zone transition green → yellow | {"cumulative":210432}
2026-04-17 08:05:47.882 WARN  suggest-compact  [abc]      suggestion: orange-zone | {"tokenBudget":310000,"count":142}
2026-04-17 08:12:55.004 INFO  pre-compact      [abc]      injected hints | {"sections":["Current Task","On Compact"]}
```

### Log env knobs

| Variable | Effect |
|---|---|
| `CLAUDE_INTEL_DEBUG=1` | Enable debug-level output (every tick, full payloads) |
| `CLAUDE_INTEL_QUIET=1` | Suppress info/warn — only errors land in the log |

Export these **before** launching Claude Code so the hooks see them.

### Useful queries

```bash
# Tail today's log while working
tail -f ~/.claude/logs/session-intel-$(date +%F).log

# All zone transitions today
grep "zone transition" ~/.claude/logs/session-intel-$(date +%F).log

# Confirm pre-compact fired on the last compaction
grep "pre-compact" ~/.claude/logs/session-intel-$(date +%F).log | tail -5

# Errors across all days
grep "ERROR" ~/.claude/logs/session-intel-*.log
```

## Hooks Installed

| Hook | Event | Purpose |
|------|-------|---------|
| `pre-compact.js` | PreCompact | Reads session-context.md, injects PRESERVE/DROP hints |
| `token-budget-tracker.js` | PostToolUse | Estimates tokens from Read/Bash/Grep/Glob/Agent output |
| `suggest-compact.js` | PreToolUse | Warns at zone transitions (200k/300k/400k) |

All three emit structured entries to the debug log (see above).

## Files Installed

| Target | Source | Purpose |
|---|---|---|
| `~/.claude/scripts/hooks/pre-compact.js` | `hooks/pre-compact.js` | Compaction hint injector |
| `~/.claude/scripts/hooks/token-budget-tracker.js` | `hooks/token-budget-tracker.js` | Token estimator |
| `~/.claude/scripts/hooks/suggest-compact.js` | `hooks/suggest-compact.js` | Zone warnings |
| `~/.claude/scripts/hooks/session-intelligence/lib/utils.js` | `lib/utils.js` | Minimal shared utils |
| `~/.claude/scripts/hooks/session-intelligence/lib/intel-debug.js` | `lib/intel-debug.js` | Debug logger |
| `~/.claude/scripts/statusline-intel.js` | `statusline-intel.js` | Intel status-line renderer |
| `~/.claude/scripts/statusline-chain.sh` | `statusline-chain.sh` | Chain wrapper (preserves your existing statusLine) |

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `COMPACT_THRESHOLD` | `50` | Tool calls before first compact suggestion |
| `CLAUDE_INTEL_DEBUG` | off | Enable debug-level log entries |
| `CLAUDE_INTEL_QUIET` | off | Suppress all log entries except errors |
| `CLAUDE_STATUSLINE_NO_PREV` | off | Suppress the previous statusLine command |
| `CLAUDE_STATUSLINE_NO_INTEL` | off | Suppress the intel line |
| `CLAUDE_STATUSLINE_COMPACT` | off | Hide the task summary from the intel line |
| `CLAUDE_STATUSLINE_SEP` | `\n` | Separator between prev statusLine and intel |
| `CLAUDE_STATUSLINE_NO_COLOR` | off | Strip ANSI from the intel line |

### Customizing Zones

Edit the `getZone()` function in `suggest-compact.js`, `token-budget-tracker.js`, and `statusline-intel.js`:

```js
function getZone(tokens) {
  if (tokens >= 400000) return 'red';    // adjust these
  if (tokens >= 300000) return 'orange';
  if (tokens >= 200000) return 'yellow';
  return 'green';
}
```

## Works With

- **Standalone** — zero dependencies, just Node.js + bash
- **ECC (Everything Claude Code)** — hooks coexist, enhanced pre-compact replaces ECC's basic version
- **ccstatusline / starship / custom statusLines** — the chain wrapper preserves whatever you had
- **Any Claude Code project** — hooks are global, session-context is per-project

## Background

Based on [Thariq's research](https://x.com/trq212/status/2044548257058328723) on Claude Code session management with 1M context:
- Context rot starts at ~300-400k tokens
- Auto-compact drops context unpredictably
- Proactive compaction with hints prevents bad compacts
- Subagents and rewind are underused context management tools
- Live visibility (status line) encourages better habits than retrospective review

## License

MIT
