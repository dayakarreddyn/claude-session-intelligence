# Session Intelligence for Claude Code

Prevent context rot and bad compactions in Claude Code sessions.

The 1M token context window lets Claude work autonomously for longer, but performance degrades as context grows (~300-400k tokens). This plugin adds **task-aware compaction hints**, **token budget tracking**, and **proactive compact suggestions** so Claude always compacts with guidance instead of guessing.

## The Problem

Without session intelligence:
- Auto-compact fires at arbitrary points and **drops context you need**
- No way to tell Claude "preserve X, drop Y" during compaction  
- You rediscover the same findings 2-3 times across compaction boundaries
- Context rot degrades output quality long before hitting the 1M limit

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

The install script:
1. Copies 3 hook files to `~/.claude/scripts/hooks/`
2. Registers hooks in `~/.claude/settings.json` (non-destructive merge)
3. Creates `session-context.md` template in your current project
4. Backs up any existing hooks before replacing
5. Validates everything

### Requirements
- Claude Code CLI installed (`~/.claude/` directory exists)
- Node.js (any recent version)

### Uninstall

```bash
./uninstall.sh
```

Restores backed-up hooks, removes registrations, leaves session-context files intact.

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
issue: #163

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

## Hooks Installed

| Hook | Event | Purpose |
|------|-------|---------|
| `pre-compact.js` | PreCompact | Reads session-context.md, injects PRESERVE/DROP hints |
| `token-budget-tracker.js` | PostToolUse | Estimates tokens from Read/Bash/Grep/Glob/Agent output |
| `suggest-compact.js` | PreToolUse | Warns at zone transitions (200k/300k/400k) |

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `COMPACT_THRESHOLD` | `50` | Tool calls before first compact suggestion |

### Customizing Zones

Edit the `getZone()` function in `suggest-compact.js` and `token-budget-tracker.js`:

```js
function getZone(tokens) {
  if (tokens >= 400000) return 'red';    // adjust these
  if (tokens >= 300000) return 'orange';
  if (tokens >= 200000) return 'yellow';
  return 'green';
}
```

## Works With

- **Standalone** — no dependencies, just Node.js
- **ECC (Everything Claude Code)** — hooks coexist, enhanced pre-compact replaces ECC's basic version
- **Any Claude Code project** — hooks are global, session-context is per-project

## Background

Based on [Thariq's research](https://x.com/trq212/status/2044548257058328723) on Claude Code session management with 1M context:
- Context rot starts at ~300-400k tokens
- Auto-compact drops context unpredictably
- Proactive compaction with hints prevents bad compacts
- Subagents and rewind are underused context management tools

## License

MIT
