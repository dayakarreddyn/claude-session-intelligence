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

Configurable, multi-line, color-coded status bar rendered at the bottom of Claude Code on every redraw:

```
🔥 Opus 4.7 (1M) · CSM · dev · ▰▰▰▰ 425k
   70 tools · $0.76 · deploy:gateway 5m ago · feat — statusline v2
```

Line 1 = identity + token zone. Line 2 = activity. The intelligent emoji at the head reflects the highest-severity signal (red zone, dirty tree, task intent). Line 2 is indented to align with line 1 under the emoji.

### Real token count

By default we read `transcript_path` from the stdin payload Claude Code provides and extract the most recent assistant message's `usage` block. That gives the **authoritative Anthropic API count** — `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. This is what Claude actually sees.

When a transcript isn't available (first redraw of a new session, or `tokenSource: "estimate"` in config), we fall back to the tool-I/O estimate maintained by the PostToolUse hook. Estimate values are prefixed with `~` so you can tell which source is active.

### Available fields

Set `fields` in `~/.claude/statusline-intel.json` to the list + order you want. Each one is optional; unconfigured fields render nothing.

| Field | Example | Description |
|---|---|---|
| `emoji` | `🔥` | Intelligent state emoji — picked from zone, task intent, dirty tree, deploy freshness (see priority list below) |
| `model` | `Opus 4.7 (1M)` | Model display name from Claude Code's stdin |
| `project` | `CSM` | Basename of the working directory |
| `branch` | `dev` | Current git branch |
| `dirty` | `±3` | Simple count of dirty files |
| `diffstat` | `(+120,-5)` | Git `--numstat` aggregated add/delete counts across the working tree |
| `issue` | `#164` | GH issue number parsed from branch name or current task |
| `tokens` | `▰▰▰▱ 425k` | Zone bar + count (colored by zone). Prefixed with `~` when using the estimate fallback |
| `zone` | `orange` | Zone name only, colored |
| `tools` | `70 tools` | Unified tool count — every PostToolUse hook fire (all tools, not just Edit/Write) |
| `session` | `3h42m` | Duration since the first transcript timestamp |
| `cost` | `$7.56` | **Cumulative** session cost summed across every assistant turn in the transcript (cached by size+mtime for speed; prices configurable) |
| `compactAge` | `compact:2h13mago` | Time since last `/compact` event (mtime of the pre-compact log) |
| `deploy` | `deploy:gateway 5m ago` | Target + age, read from `~/.claude/logs/deploy-breadcrumb` (any CI/script can write it) |
| `outputStyle` | `style:explanatory` | Current Claude Code output style (from stdin or env) |
| `health` | `[●●○]` | Colored dot per service URL configured in `serviceHealth` — curl probe cached 30s |
| `task` | `feat — statusline v2` | `type:` line extracted from `session-context.md`, truncated to `maxTaskLength` |
| `newline` | *(pseudo-field)* | Forces a line break at this point so long bars wrap into 2+ lines |

### Intelligent emoji priority

First matching signal wins:

| | When |
|---|---|
| 🔥 | Red zone (≥400k tokens) |
| ⚠️  | Orange zone (300–400k) |
| 🚀 | Deploy breadcrumb written less than 15 min ago |
| 🐛 | Task mentions `bug`, `fix`, `issue`, `error`, `crash` |
| 🏗️ | Task mentions `build`, `feat`, `add`, `implement`, `create` |
| 🧹 | Task mentions `refactor`, `cleanup`, `simpl*` |
| 🧪 | Task mentions `test`, `spec` |
| 🚀 | Task mentions `deploy`, `ship`, `release` |
| 📝 | Task mentions `doc`, `readme` |
| ✏️  | Dirty working tree (any uncommitted change) |
| 🟡 | Yellow zone (200–300k) |
| ✨ | Task looks idle/done/clean and we're in green zone |
| 🟢 | Default fallback |

Tweak the regex list in `statusline-intel.js` → `pickEmoji()` to fit your workflow.

### Example config: `~/.claude/statusline-intel.json`

```json
{
  "fields": [
    "emoji", "model", "project", "branch", "issue", "diffstat", "tokens",
    "newline",
    "emoji2", "tools", "session", "cost", "compactAge", "deploy", "task"
  ],
  "tokenSource": "auto",
  "zones": { "yellow": 200000, "orange": 300000, "red": 400000 },
  "maxTaskLength": 70,
  "separator": " · ",
  "colors": true,
  "serviceHealth": [
    { "name": "api", "url": "https://api.example.com/healthz", "ttlSec": 30 }
  ],
  "prices": {
    "input": 15, "cache_creation": 18.75, "cache_read": 1.5, "output": 75
  }
}
```

The installer drops this file at `~/.claude/statusline-intel.json` on first install (copied from `statusline-intel.json.example`). Edit freely — changes take effect on the next redraw.

### Append, don't replace

Most users already have a statusLine — ccstatusline, starship, a custom script. The installer detects it and wires a chain wrapper (`statusline-chain.sh`) that runs your previous command first, then the intel line as new lines below:

```
🌴 main · ⎇ dev · (+0,-0) · /Users/you/project       ← your existing statusLine
🔛 · ↓ · ↑ · c · 🏎️
⏱️ Session: 0m · 💰 3hr 42m
👾 Opus 4.7 (1M)
⏳ Weekly: 3.0% · Weekly Reset: 6d 10hr
🔥 Opus 4.7 · project · dev · ▰▰▰▰ 425k            ← appended by us (line 1)
   70 tools · $0.76 · feat — statusline v2          ← appended by us (line 2)
```

If you had no statusLine configured, you get just the intel lines.

### Status-line env knobs

| Variable | Effect |
|---|---|
| `CLAUDE_STATUSLINE_FIELDS` | Comma-separated field list — overrides the config file for this session |
| `CLAUDE_STATUSLINE_TOKEN_SOURCE` | `auto` / `transcript` / `estimate` — force a source |
| `CLAUDE_STATUSLINE_SEP_INLINE` | In-line separator (default `" · "`) — for the config, not for chain |
| `CLAUDE_STATUSLINE_COMPACT=1` | Drop the `task` field from the rendered line |
| `CLAUDE_STATUSLINE_NO_COLOR=1` / `NO_COLOR=1` | Strip ANSI |
| `CLAUDE_STATUSLINE_NO_PREV=1` | (Chain) Skip the previous command — show only our intel line |
| `CLAUDE_STATUSLINE_NO_INTEL=1` | (Chain) Skip our line — show only the previous command |
| `CLAUDE_STATUSLINE_SEP="..."` | (Chain) Separator between previous and intel (default: newline) |

### Deploy breadcrumb

To make the `deploy` field light up after a deploy, have your deploy script write one line to the breadcrumb:

```bash
echo "gateway $(date -u +%FT%TZ)" > ~/.claude/logs/deploy-breadcrumb
```

Format: `<target-name> <ISO-timestamp>`. The status line parses it and shows `deploy:<target> <age> ago`. Good targets to breadcrumb: gateway restart, frontend CF Pages deploy, production cutover, schema migration.

### Service health

Configure one or more URLs in `serviceHealth`. The status line shows a colored dot per service:

- 🟢 `●` — HTTP 2xx
- 🟡 `●` — HTTP 3xx (redirect)
- 🔴 `●` — anything else
- ⚪ `○` — no cached probe result yet

Probes run async (detached `curl`), results cached in `/tmp/claude-health-<name>` for `ttlSec` (default 30s). The redraw reads the cache — never blocks on the network.

### Swap back to your original statusLine

Open `~/.claude/scripts/statusline-chain.sh` and edit the `PREV_STATUSLINE=…` line — anything between the quotes gets run on each redraw. Or re-point `~/.claude/settings.json` → `statusLine.command` directly at whatever you want.

## Unified Config + `/si` command

All configuration lives in **`~/.claude/session-intelligence.json`** — one file for every hook and the status line. You don't have to edit it by hand: the `/si` slash command lets Claude do it for you, with a diff preview and a confirmation before writing.

### Shape

```json
{
  "statusline": { "fields": [...], "zones": {...}, "prices": {...}, ... },
  "compact":     { "threshold": 50, "autoblock": true, "prompt": true, "promptTimeout": 30 },
  "taskChange":  { "enabled": true, "minTokens": 100000, "sameDomainScore": 0.5,
                   "differentDomainScore": 0.2, "prompt": true, "promptTimeout": 20 },
  "debug":       { "enabled": false, "quiet": false }
}
```

Defaults live in `lib/config.js` → `DEFAULTS`. The loader merges: **built-ins ← legacy `statusline-intel.json` ← `session-intelligence.json` ← env vars**. Env vars still win so CI and one-off overrides keep working.

### `/si` inside Claude Code

```text
/si show                            # print the effective config
/si get compact.promptTimeout       # read a single dotted key
/si set compact.autoblock false     # stage + diff + confirm + write
/si set taskChange.minTokens 150000
/si set statusline.zones.orange 350000
/si reset taskChange                # restore one section to defaults
/si reset *                         # restore everything
/si explain taskChange.minTokens    # describe what a key does
/si migrate                         # fold legacy statusline-intel.json in
```

Every write shows a unified diff of the proposed change and waits for you to reply **YES** before touching the file. Anything else cancels cleanly. Post-write, Claude tells you whether a Claude Code restart is required.

## Auto-Compact with Prompt

`suggest-compact.js` is a `PreToolUse` hook that watches token budget on every `Bash`/`Read`/`Edit`/`Write`/`Grep`/`Glob` call. When context **escalates** into a higher-severity zone, it interrupts the tool call and asks the user what to do:

### Zone behavior

| Zone | Threshold | Action |
|---|---|---|
| green | <200k | silent |
| yellow | ≥200k | passive log suggestion ("good time to /compact between tasks") |
| **orange** | **≥300k** | **prompt + block** — native dialog "Run /compact now?" |
| **red** | **≥400k** | **prompt + block (urgent)** — same flow, stronger wording |

One-shot per escalation. State is persisted to `/tmp/claude-compact-state-<session>` so you won't be re-prompted for the same zone. After `/compact` runs, tokens drop and state re-arms for the next escalation.

### Prompt flow (macOS)

1. You hit 300k tokens on your next Edit/Write/Bash/…
2. A native dialog pops:
   > *"Context at ~310k tokens — ORANGE ZONE (context rot risk). Run /compact now to preserve context before continuing?"*
   > `[ Skip ]   [ Compact now ]`
3. Outcomes:
   - **Compact now** → tool call blocked with exit 2, Claude is told "User approved compaction — please run /compact now" and will prompt you to type `/compact`
   - **Skip** → tool call proceeds, state saved so you won't be re-asked for this zone
   - **Timeout (30s default)** → falls through to plain exit-2 block with the instruction

### Why not auto-execute /compact?

Hooks run as subprocesses — they can `exit 0/2`, write stdout/stderr, or emit structured JSON, but they have no API to invoke slash commands (`/compact` is interpreted by Claude Code's main loop, not a tool). The closest we can get to "auto" is the native dialog above: the decision is explicit, the prompt is unmissable, and the instruction flows back to Claude via stderr. You still press Enter on `/compact`, but you can't miss the moment.

### Tunables

- Opt out entirely: `export CLAUDE_COMPACT_AUTOBLOCK=0`
- Skip the GUI dialog (passive block only): `export CLAUDE_COMPACT_PROMPT=0`
- Dialog timeout in seconds: `export CLAUDE_COMPACT_PROMPT_TIMEOUT=60`

Linux/Windows users currently hit the exit-2 fallback directly (no native dialog). Easy to extend `askUserCompact()` in `suggest-compact.js` with `zenity` / PowerShell prompts.

## Task Change Detector

When you submit a prompt, `task-change-detector.js` (UserPromptSubmit hook) decides whether it looks like a **domain change** from the task you're currently working on — and if so, asks whether you want to `/compact`, `/clear`, or keep going before it processes the prompt.

### Signals combined into a 0..1 same-domain score

| # | Signal | What it compares | Weight |
|---|---|---|---|
| 1 | **File overlap** | paths mentioned in the new prompt vs. `## Key Files` in `session-context.md` | 2 |
| 2 | **Git locality** | paths mentioned in the new prompt vs. files the working tree has touched | *(folded into 1)* |
| 3 | **Root prefix** | top-level folder match (e.g. `src/auth/*` vs `src/billing/*`) | *(folded into 1)* |
| 4 | **Keyword Jaccard** | stopword-filtered Jaccard of current task description vs. new prompt | 1 |

Absent signals are neutral — a prompt that mentions no paths is judged on keywords alone. If every signal is missing, the hook stays silent rather than prompting on no evidence.

### Decision

| Same-domain score | Tokens ≥ `minTokens` | Action |
|---|---|---|
| ≥ `sameDomainScore` (default 0.5) | any | silent |
| between both thresholds | yes | recommend **/compact** (preserve current task) |
| < `differentDomainScore` (default 0.2) | yes | recommend **/clear** (fresh start is cheaper) |
| any | no | silent (below `minTokens` — cheap either way) |

The dialog offers three buttons: `[Continue]`, `[Compact]`, `[Clear]`. **Continue** proceeds. **Compact/Clear/timeout** block the prompt with exit 2 + an instruction for Claude to relay. One-shot per (session, prompt-hash) — retrying the same prompt won't re-prompt.

### Tuning

Everything is in `taskChange.*`:

```text
/si set taskChange.enabled false                # turn off entirely
/si set taskChange.minTokens 150000             # only kick in above 150k
/si set taskChange.sameDomainScore 0.6          # stricter "same domain"
/si set taskChange.differentDomainScore 0.15    # looser "different domain"
/si set taskChange.promptTimeout 30
```

Make sure `session-context.md` has a real `## Current Task` and `## Key Files` section — that's what the detector compares against. No baseline = silent.

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
| `suggest-compact.js` | PreToolUse (Bash/Read/Edit/Write/Grep/Glob) | Warns at 200k, **auto-blocks + prompts the user** at 300k/400k (native macOS dialog, graceful fallback to exit-2 block) |
| `task-change-detector.js` | UserPromptSubmit | Scores same-domain on each new prompt; offers /compact, /clear, or continue when the task looks like it just shifted |

All three emit structured entries to the debug log (see above).

## Files Installed

| Target | Source | Purpose |
|---|---|---|
| `~/.claude/scripts/hooks/pre-compact.js` | `hooks/pre-compact.js` | Compaction hint injector |
| `~/.claude/scripts/hooks/token-budget-tracker.js` | `hooks/token-budget-tracker.js` | Token estimator |
| `~/.claude/scripts/hooks/suggest-compact.js` | `hooks/suggest-compact.js` | Zone warnings + auto-block |
| `~/.claude/scripts/hooks/task-change-detector.js` | `hooks/task-change-detector.js` | Task-domain change detector |
| `~/.claude/scripts/hooks/lib/config.js` (+ `session-intelligence/lib/`) | `lib/config.js` | Unified config loader |
| `~/.claude/scripts/hooks/session-intelligence/lib/utils.js` | `lib/utils.js` | Minimal shared utils |
| `~/.claude/scripts/hooks/session-intelligence/lib/intel-debug.js` | `lib/intel-debug.js` | Debug logger |
| `~/.claude/scripts/statusline-intel.js` | `statusline-intel.js` | Intel status-line renderer |
| `~/.claude/scripts/statusline-chain.sh` | `statusline-chain.sh` | Chain wrapper (preserves your existing statusLine) |
| `~/.claude/commands/si.md` | `commands/si.md` | `/si` slash command (config manager) |
| `~/.claude/session-intelligence.json` | `templates/session-intelligence.json` | Unified config (shipped on first install only) |

## Configuration

### Config file

Prefer **`/si set <key> <value>`** over env vars — it's Claude-native, diffed, and persistent. Env vars remain as an override for scripting/CI.

### Environment Variables

| Variable | Config equivalent | Description |
|----------|---|---|
| `COMPACT_THRESHOLD` | `compact.threshold` | Tool calls before first compact suggestion |
| `CLAUDE_COMPACT_AUTOBLOCK` | `compact.autoblock` | `0` disables the orange/red auto-block |
| `CLAUDE_COMPACT_PROMPT` | `compact.prompt` | `0` skips the native GUI dialog |
| `CLAUDE_COMPACT_PROMPT_TIMEOUT` | `compact.promptTimeout` | Dialog timeout (seconds) |
| `CLAUDE_TASK_CHANGE` | `taskChange.enabled` | `0` disables task-change detection entirely |
| `CLAUDE_INTEL_DEBUG` | `debug.enabled` | Enable debug-level log entries |
| `CLAUDE_INTEL_QUIET` | `debug.quiet` | Suppress all log entries except errors |
| `CLAUDE_STATUSLINE_NO_PREV` | — | (Chain) Suppress the previous statusLine command |
| `CLAUDE_STATUSLINE_NO_INTEL` | — | (Chain) Suppress the intel line |
| `CLAUDE_STATUSLINE_COMPACT` | — | Hide the task summary from the intel line |
| `CLAUDE_STATUSLINE_SEP` | — | Separator between prev statusLine and intel (default: newline) |
| `CLAUDE_STATUSLINE_NO_COLOR` | `statusline.colors` | `1` strips ANSI |

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
