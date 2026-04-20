# Session Intelligence for Claude Code

Prevent context rot and bad compactions in Claude Code sessions. Adds task-aware compaction hints, token budget tracking, a context-shape tracker that auto-generates PRESERVE/DROP hints from your actual tool usage, a learning loop that adapts zone thresholds to your own compact history, a structured debug log, and a colored status-line indicator that appends to whatever statusLine you already have.

> **Why these specific thresholds?** See [docs/context-engineering.md](docs/context-engineering.md) for the mechanics behind context rot, how the shape tracker and adaptive zones work, and why 250k is "start warning" not "broken."

The 1M token context window lets Claude work autonomously for longer, but performance degrades as context grows (~300-400k tokens). This plugin gives Claude — and you — live visibility into where the session is on that curve, and makes every compaction deliberate instead of guessed. When you type `/compact`, the hook auto-injects preserve/drop hints grounded in the directories you've actually been touching — so you don't have to remember the `/compact preserve X, drop Y` syntax.

## The Problem

Without session intelligence:
- Auto-compact fires at arbitrary points and **drops context you need**
- No way to tell Claude "preserve X, drop Y" during compaction — and remembering the syntax mid-flow is its own tax
- You rediscover the same findings 2-3 times across compaction boundaries
- Context rot degrades output quality long before hitting the 1M limit
- No way to tell from the CLI how close you are to the rot zone
- Zone thresholds are one-size-fits-all — your actual compact pattern doesn't feed back into the warnings

## How It Works

```
┌────────────────────────────────────────────────────┐
│ 1. Claude updates session-context.md at each       │
│    task boundary (auto-seeded from git)            │
│                                                    │
│ 2. Token-budget-tracker estimates usage per tool   │
│    call AND appends a shape entry {root, file,     │
│    event} to /tmp/claude-ctx-shape-<sid>.jsonl     │
│                                                    │
│ 3. Suggest-compact warns at zone borders with a    │
│    grounded diagnosis ("shifted auth→billing,      │
│    $1.43 spent, 82k stale in tests/") — zones      │
│    adapt to your past compact history after 5      │
│    samples                                         │
│                                                    │
│ 4. On /compact: pre-compact injects BOTH the       │
│    session-context.md hints AND auto-generated     │
│    PRESERVE/DROP bands from observed shape.        │
│    Writes a history entry + ephemeral snapshot     │
│                                                    │
│ 5. Next 30 tool calls: token-budget-tracker        │
│    watches for "regret" — touching a dropped       │
│    rootDir. Regret rate dampens future drop        │
│    eagerness                                       │
│                                                    │
│ 6. Status line: dim context + one coloured signal  │
│    (tokens zone). Red only for stale-compact       │
│    alert on line 2                                 │
└────────────────────────────────────────────────────┘
```

### Token Zones

| Zone | Tokens (default) | Action |
|------|--------|--------|
| Green | <200k | Free zone — work normally |
| Yellow | 200-300k | Caution — compact between tasks |
| Orange | 300-400k | Context rot — compact now |
| Red | >400k | Urgent — compact immediately |

After **≥5 compacts** land in `~/.claude/logs/compact-history.jsonl`, the zones adapt to your own pattern: `orange` anchors to P50 of your historical compact-at-tokens, `red` to P90. Bounded ±30% from defaults so a noisy history can't silence the warnings. See [Learning Loop](#learning-loop) below.

## Install

Two supported paths. **Plugin install is the recommended default** — zero shell scripts, zero manual settings edits.

### A. Native plugin (recommended)

From inside Claude Code:

```text
/plugin marketplace add dayakarreddyn/claude-session-intelligence
/plugin install session-intelligence
```

Then restart Claude Code. A `SessionStart` bootstrap hook runs automatically and does five things, idempotently, every session:

1. Seeds `~/.claude/session-intelligence.json` on first install.
2. Wires the status-line chain into `settings.json`, preserving any existing statusLine.
3. Seeds `session-context.md` into `~/.claude/projects/<encoded>/` for the active project when one doesn't exist yet.
4. Auto-fills the `## Current Task` and `## Key Files` sections of that file from the last commit (`type`, subject, branch, touched files) while they're still placeholder-only. Tracks HEAD SHA so we don't rewrite unchanged content. Steps back the moment you or Claude writes real content.
5. Injects a managed session-discipline block into the project's `CLAUDE.md` between `<!-- BEGIN session-intelligence:rules -->` and `<!-- END session-intelligence:rules -->` markers. Content inside the markers refreshes on upgrades; anything outside is user-owned and never touched. If `CLAUDE.md` doesn't exist, it gets created with just the managed block.

### B. Bash installer (legacy)

```bash
git clone https://github.com/dayakarreddyn/claude-session-intelligence.git
cd claude-session-intelligence
chmod +x install.sh
./install.sh
```

The install script copies files from `plugins/session-intelligence/` into `~/.claude/scripts/`, registers hooks in `~/.claude/settings.json`, and chains the intel status line after any existing statusLine you had. Restart Claude Code after install.

### What lands on your system

- Hooks → `~/.claude/scripts/hooks/` (plugin path: `${CLAUDE_PLUGIN_ROOT}/hooks/`)
- `/si` slash command → `~/.claude/commands/si.md`
- Unified config → `~/.claude/session-intelligence.json` (only if missing — never clobbered)
- Statusline → `~/.claude/scripts/statusline-{intel.js,chain.sh}` wired into `settings.json`
- Debug logs → `~/.claude/logs/session-intel-YYYY-MM-DD.log`

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

When `/compact` fires (manually or auto), the pre-compact hook injects up to three blocks into the summary context:

1. **COMPACTION GUIDANCE** — parsed from `session-context.md` (user-curated signal)
2. **OBSERVED CONTEXT SHAPE** — generated from the shape tracker's tool-call log (grounded signal)
3. **MEMORY OFFLOAD CHECKPOINT** — a directive telling Claude to preserve rich detail in auto-memory before the summary collapses it

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

MEMORY OFFLOAD CHECKPOINT (pre-compact):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Compact will compress this session. Before detail is lost, write auto-memory
under /Users/you/.claude/projects/<encoded>/memory/ following the frontmatter +
MEMORY.md index convention already defined in your system prompt. Two files
suggested — skip either if there's nothing new to record:

  1. project_session_YYYY-MM-DD_<sid8>.md (type: project) — decisions, files
     touched, follow-ups, any non-obvious context that took >3 attempts to
     discover. Filename is deterministic: date + first 8 chars of session id,
     so repeated compacts in the same session extend one file while distinct
     sessions never collide.
  2. reference_<pattern>.md — ONLY if a reusable recipe/layout/rule was
     discovered this session
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

The memory-offload block works with Claude Code's built-in auto-memory system (`~/.claude/projects/<encoded>/memory/` + `MEMORY.md` index) to preserve detail the compressed summary will lose. Disable with `compact.memoryOffload: false` or `CLAUDE_COMPACT_MEMORY_OFFLOAD=0`.

## Status Line

Configurable, multi-line status bar rendered at the bottom of Claude Code on every redraw:

```
Opus 4.7 (1M) · CSM · dev · (+22,-13) · ▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱ 425k/1M (43%)
3h42m · 70 tools · $7.56 · feat — statusline v2 · compact:2h13m ago
```

**Colour policy — one colour, one signal.** The whole bar exists to warn about context pressure, so `tokens` on line 1 stays zone-coloured (green → yellow → orange → red) and every other field is `dim`. Line 2 is entirely dim except `compactAge` which goes **red** when the last /compact was ≥2h ago. Emojis are off by default in the shipped presets — they added width and a second decision point ("what does that glyph mean?") on top of already-loud text. They're opt-in via the `emoji` / `emoji2` fields if you want them back.

### Real token count

By default we read `transcript_path` from the stdin payload Claude Code provides and extract the most recent assistant message's `usage` block. That gives the **authoritative Anthropic API count** — `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. This is what Claude actually sees.

When a transcript isn't available (first redraw of a new session, or `tokenSource: "estimate"` in config), we fall back to the tool-I/O estimate maintained by the PostToolUse hook. Estimate values are prefixed with `~` so you can tell which source is active.

### Available fields

Set `fields` in `~/.claude/statusline-intel.json` to the list + order you want. Each one is optional; unconfigured fields render nothing.

| Field | Example | Description |
|---|---|---|
| `model` | `Opus 4.7 (1M)` or `Opus 4.7 · explanatory` | Model display name. When `output_style` is non-default it's suffixed with ` · <style>` (e.g. `explanatory`, `concise`). This is the *output style mode*, not reasoning effort — Claude Code doesn't expose thinking-budget on stdin (dim) |
| `project` | `CSM` | Basename of the working directory (dim) |
| `branch` | `dev` | Current git branch (dim) |
| `dirty` | `±3` | Simple count of dirty files (dim) |
| `diffstat` | `(+120,-5)` | Git `--numstat` aggregated add/delete counts across the working tree (dim) |
| `issue` | `#164` | GH issue number parsed from branch name or current task (dim) |
| `tokens` | `▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱ 425k/1M (43%)` | **Full context bar + used/cap + percent** — the ONE coloured field. Fill proportional to used/cap, colored green → yellow → orange → red by current zone. Cap auto-detects from `model.id`: `[1m]` tag → 1M, else 200k. Prefixed with `~` when using the estimate fallback. Zones are adaptive (fall back to defaults when history < 5 compacts) |
| `zone` | `orange` | Zone name only, coloured |
| `tools` | `70 tools` | Unified tool count — every PostToolUse hook fire (dim) |
| `session` | `3h42m` | Session wall-clock duration. Reads `cost.total_duration_ms` from stdin when Claude Code provides it (authoritative, survives resumes); falls back to scanning the transcript for the earliest event timestamp (dim) |
| `thinking` | `think:32k` | Estimated extended-thinking tokens in recent assistant turns. Residual of `output_tokens` after subtracting visible text + tool_use content on turns with `thinking` blocks. Rendered only when the recent-window estimate crosses `statusline.thinkingMinDisplay` (default 5k). Opt-in — add to `fields` to enable (dim) |
| `sessionId` | `sid:1b672dad` | Short session id (first 8 chars) — useful when multiple Claude Code windows are open (dim) |
| `cost` | `$7.56` | **Cumulative** session cost summed across every assistant turn in the transcript (dim; prices configurable) |
| `cacheHit` | `cache:92%` | Live prompt-cache hit ratio on the latest assistant turn: `cache_read / (cache_read + cache_creation)`. Dim green ≥70%, dim yellow 30–70%, dim red <30%. Hidden on turns with no cacheable prefix (first turn of a session). The one coloured field on line 3 — colour escalates when `compact.stablePrefix` isn't paying off (low cache-hit on a stable working set) |
| `cacheTokens` | `prefix:120k/3k` | Latest turn's prefix breakdown — `<cache_read>/<cache_creation>` tokens. Low read + high creation on a stable working set is the warning sign that `stablePrefix` is leaking a volatile value somewhere. Dim |
| `cacheSaved` | `saved:$2.83` | **Cumulative** USD saved across the session by cache hits vs. paying the uncached input rate for the same tokens. Hidden when savings are under $0.10 (not worth the field) (dim) |
| `compactAge` | `compact:2h13m ago` | Time since last `/compact` event. Dim when <2h, **red** when ≥2h — the only line-2 field that escalates, because it's the one line-2 signal that says "you should act" |
| `deploy` | `deploy:gateway 5m ago` | Target + age, read from `~/.claude/logs/deploy-breadcrumb` (dim) |
| `outputStyle` | `style:explanatory` | Current Claude Code output style (dim) |
| `health` | `[●●○]` | Coloured dot per service URL configured in `serviceHealth` — curl probe cached 30s |
| `task` | `feat — statusline v2` | What you're working on, in order of freshness: (1) `type:` line from `session-context.md` if real and fresh, (2) same suffixed ` (stale)` if older than `taskStaleHours`, (3) last commit subject. Always dim |
| `emoji` | `🔥` | (Opt-in.) Intelligent state emoji — red-zone / orange-zone / dirty / task-intent / deploy. Not in any default preset — add to `fields` if you want it. See [emoji priority](#intelligent-emoji-priority-opt-in) |
| `emoji2` | `📊` | (Opt-in.) Activity emoji for line 2 — deploy / cost / session-long / heavy-tools. Same opt-in rule |
| `newline` | *(pseudo-field)* | Forces a line break at this point so long bars wrap into 2+ lines |

### Presets

`statusline.preset` is a shorthand for the `fields` array. Setting `fields` explicitly always wins — presets are just the fallback:

| Preset | Fields |
|---|---|
| `minimal` | `tokens` |
| `standard` | `model`, `project`, `tokens`, `newline`, `task` |
| `verbose` (default) | line 1: `model`, `project`, `branch`, `diffstat`, `tokens` · line 2: `session`, `tools`, `cost`, `task` · line 3: `cacheHit`, `cacheTokens`, `cacheSaved`, `compactAge` |
| `verbose-cache` | Token-economics-focused — smaller line 1 (`model`, `project`, `tokens`), standard line 2, full cache line 3 |

Switch via `/si set statusline.preset minimal` or override one session with `CLAUDE_STATUSLINE_PRESET=minimal`.

**Upgrading from an older `verbose`**: if you already have an explicit `statusline.fields` array in `~/.claude/session-intelligence.json`, the preset extension doesn't touch it — your layout is preserved exactly. To adopt the new line 3, either delete the `fields` key (preset will take over) or append `"newline", "cacheHit", "cacheTokens", "cacheSaved"` manually via `/si set statusline.fields '[...]'`.

### Intelligent emoji priority (opt-in)

First matching signal wins. Add `emoji` / `emoji2` to your `fields` array to enable:

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

### Example config: `~/.claude/session-intelligence.json`

```json
{
  "statusline": {
    "preset": "verbose",
    "fields": [
      "model", "project", "branch", "issue", "diffstat", "tokens",
      "newline",
      "session", "tools", "cost", "deploy", "task", "compactAge"
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
}
```

The installer drops this file at `~/.claude/session-intelligence.json` on first install (copied from `templates/session-intelligence.json`). Edit freely — changes take effect on the next redraw.

### Append, don't replace

Most users already have a statusLine — ccstatusline, starship, a custom script. The installer detects it and wires a chain wrapper (`statusline-chain.sh`) that runs your previous command first, then the intel line as new lines below:

```
🌴 main · ⎇ dev · (+0,-0) · /Users/you/project       ← your existing statusLine
🔛 · ↓ · ↑ · c · 🏎️
⏱️ Session: 0m · 💰 3hr 42m
👾 Opus 4.7 (1M)
⏳ Weekly: 3.0% · Weekly Reset: 6d 10hr
🔥 Opus 4.7 · project · dev · ▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱ 425k/1M (43%)   ← appended by us (line 1)
   3h42m · 70 tools · $0.76 · feat — statusline v2 · compact:2h13m ago  ← appended by us (line 2)
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
| `CLAUDE_STATUSLINE_PREV_FIRST=1` | (Chain) Flip default ordering so the previous command renders above the intel line — by default intel renders on top so the zone signal is at eye level |

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
  "statusline": { "fields": [...], "zones": {...}, "prices": {...},
                  "taskStaleHours": 12, ... },
  "compact":     { "threshold": 50, "autoblock": true },
  "taskChange":  { "enabled": true, "minTokens": 100000,
                   "sameDomainScore": 0.5, "differentDomainScore": 0.2,
                   "prompt": true, "promptTimeout": 20,
                   "conversationalMaxLen": 120,
                   "recentHours": 24, "transcriptTurns": 20,
                   "semanticFallback": false, "semanticTimeoutMs": 3000,
                   "haikuModel": "claude-haiku-4-5" },
  "debug":       { "enabled": false, "quiet": false }
}
```

Defaults live in `lib/config.js` → `DEFAULTS`. The loader merges: **built-ins ← legacy `statusline-intel.json` ← `session-intelligence.json` ← env vars**. Env vars still win so CI and one-off overrides keep working.

### `/si` inside Claude Code

```text
/si show                            # print the effective config
/si status                          # runtime state: hooks, statusline, session counters
/si get compact.threshold           # read a single dotted key
/si set compact.autoblock false     # stage + diff + confirm + write
/si set taskChange.minTokens 150000
/si set statusline.zones.orange 350000
/si reset taskChange                # restore one section to defaults
/si reset *                         # restore everything
/si explain taskChange.minTokens    # describe what a key does
/si config                          # show all settings in one /config-style form
/si migrate                         # fold legacy statusline-intel.json in
```

Every write shows a unified diff of the proposed change and waits for you to reply **YES** before touching the file. Anything else cancels cleanly. Post-write, Claude tells you whether a Claude Code restart is required.

### `/si config` — show-all form

For users who'd rather not memorize dotted keys. Prints every user-facing tunable in one labeled, `/config`-style block — grouped by section (`Statusline`, `Compact`, `Continue`, `Task change detection`, `Shape tracker`, `Learning`, `Debug`), current value right-aligned, values that diverge from default marked with `*`.

Edit any subset in one reply: one `key=value` per line, using either the friendly label (case-insensitive) or the dotted key. Values accept `true`/`false`, `Nk`/`Nm` for thousands/millions, or a raw JSON value. Reply `NONE` to exit cleanly or `QUIT` to abort.

One combined diff, one **YES** confirmation, one write. Complex fields (`statusline.fields` array, `serviceHealth` URL list, `prices` overrides) stay under `/si set` because they're too freeform for the form.

## Auto-Compact Suggestions

`si-suggest-compact.js` is a `PostToolUse` hook that watches token budget after every tool call. When context **escalates** into a higher-severity zone, it emits a **grounded diagnosis** that Claude Code surfaces back to the assistant on its next turn — **without blocking the tool call** that just ran.

### Zone behavior

| Zone | Threshold (default) | Action |
|---|---|---|
| green | <200k | silent |
| yellow | ≥200k | passive log suggestion ("good time to /compact between tasks") |
| **orange** | **≥300k** | **surface grounded suggestion to assistant via hook feedback** |
| **red** | **≥400k** | **surface urgent grounded suggestion** |

One-shot per escalation. State is persisted to `/tmp/claude-compact-state-<session>` so the same zone doesn't spam every subsequent tool call. After `/compact` runs, tokens drop and state re-arms for the next escalation.

After **≥5 compacts** land in your history, the thresholds adapt: orange anchors to P50 of your historical compact points, red to P90 (bounded ±30% from defaults).

### What you see

When the budget first crosses orange on a tool call:

```
[StrategicCompact] Drift zone — context at ~260k tokens, $1.43 spent. Advisory only — continue if the task needs full context.
Observed: shifted src/auth → src/billing · ~82k stale in tests/browser · hot: src/billing.
Optional: offload rich detail to auto-memory at /Users/you/.claude/projects/<encoded>/memory/
(project_session_*.md / reference_*.md + MEMORY.md index) before compacting.
When you do compact, `/compact` auto-injects preserve/drop hints from observed tool usage; free-text hints still work.
(Zones adapted to your history: orange=251k, red=317k, 7 past compacts.)
Silence this feedback with CLAUDE_COMPACT_AUTOBLOCK=0.
```

The tone is **advisory, not directive**. Claude is told "continue if the task needs full context" so a zone warning doesn't derail a mid-flight refactor. Five layers:
- **Header** — zone + tokens + cost, explicitly flagged "advisory only"
- **Diagnosis** — what the shape tracker observed: domain shifts, stale bands, hot dirs
- **Memory offload** — *optional* nudge to dump rich detail to auto-memory before compact collapses it, while context is still live
- **Action hint** — when you do compact, `/compact` auto-injects preserve/drop hints via the PreCompact hook
- **Adaptive footnote** — only appears when zones learned from your history

The hook exits `2` (stderr fed back to Claude Code as hook feedback), but because this runs on `PostToolUse` the tool call itself already completed successfully — the message arrives on the next assistant turn as a heads-up, not an interruption.

### Why PostToolUse, not PreToolUse?

Earlier versions blocked the tool call on `PreToolUse` to force a compaction checkpoint. In practice that broke momentum: the user would hit it mid-edit, lose the thread of what they were doing, and the wording ("this tool call was blocked") read like an error. Suggestions should inform, not interrupt — so the hook moved to `PostToolUse`. The tool runs, Claude sees the suggestion at a natural pause, and the user stays in flow.

### Why not auto-execute /compact?

Hooks run as subprocesses — they can `exit 0/2`, write stdout/stderr, or emit structured JSON, but they have no API to invoke slash commands (`/compact` is interpreted by Claude Code's main loop, not a tool). The closest thing to "auto" is the inline suggestion above: the decision is explicit, the instruction flows back via stderr, and nothing fires off-screen.

### Tunables

- Silence suggestions entirely: `export CLAUDE_COMPACT_AUTOBLOCK=0` (the env var keeps its old name for backwards compat — it no longer blocks anything)
- Silence the memory-offload nudge + pre-compact directive: `/si set compact.memoryOffload false` or `export CLAUDE_COMPACT_MEMORY_OFFLOAD=0`
- First advisory after N tool calls: `/si set compact.threshold 75`
- Cache-friendly pre-compact output (default **on**): strips per-compact volatile values (call counts, stale-token estimate, Jaccard, dated/session-scoped memory filename, zone-crossover token + cost figures) from every model-visible channel so the post-compact prefix is byte-stable and survives as a prompt-cache hit across subsequent compacts of the same working set. Trades "47 calls / ~35k stale / $2.40 spent" detail for cache stability (roughly −90% read cost on the post-compact prefix). Opt back into the verbose metrics with `/si set compact.stablePrefix false` or `export CLAUDE_COMPACT_STABLE_PREFIX=0`.
- Priorities-review directive (pre-compact): names `memory/MEMORY.md`, the most recent `memory/project_session_*.md`, and `session-context.md` and asks Claude to strike (`~~...~~`) any `## Follow-ups` / `## Next steps` / `## Next priorities` / `## TODO` bullet whose work visibly shipped this session. Struck items drop out of the next post-compact resume banner automatically. No regex matcher — Claude has transcript context and can judge what shipped semantically. Skipped when no priority-bearing file exists.

## Context Shape Tracker

A cheap, append-only observer of where Claude's tool calls are **actually** landing — which directories, which files, at what cumulative token cost. Turns generic "consider /compact" into grounded "you shifted from auth → billing 40k ago, ~82k of tests/ context is stale, here's what to preserve."

### What it observes

Every `PostToolUse` call, `si-token-budget.js` appends one line to `/tmp/claude-ctx-shape-<sid>.jsonl`:

```json
{"t":1714000000,"tok":155432,"tool":"Read","root":"src/auth","file":"src/auth/login.ts"}
{"t":1714000012,"tok":156812,"tool":"Edit","root":"src/auth","file":"src/auth/login.ts"}
{"t":1714000145,"tok":184320,"tool":"Bash","root":null,"file":null,"event":"commit"}
```

Size-bounded to 200 entries / 128 KB. Only entries that carry a signal (a file path OR a phase event) get appended — a pure Bash echo with no path adds no information.

Phase events flagged automatically: `git commit`, `git push`, `gh pr create`, `gh pr merge`.

### How it's analyzed

`lib/context-shape.js` classifies rootDirs into bands by **where in the token span they were last touched**:

| Band | Definition | Meaning |
|---|---|---|
| HOT | last 20% of token-span | preserve — still in active use |
| WARM | 20–60% | keep one-line summary |
| COLD | only in first 40%, untouched since | safe to drop |

**Tuning the WARM band.** The WARM cutoff is exposed as `shape.warmScoreCutoff` (default `0.40`, meaning "score ≥ 0.40 → WARM"). Raise it toward `0.80` to tighten WARM so mid-recency dirs fall into COLD instead. Per-project overrides go under `shape.perProject`, keyed by canonical project cwd, e.g.:

```json
"shape": {
  "warmScoreCutoff": 0.40,
  "perProject": {
    "/Users/me/DWS/CSM": { "warmScoreCutoff": 0.65 }
  }
}
```

Useful when one repo's post-compact data shows WARM producing no soft-regret signal — tighten its cutoff without affecting other projects. `shape.perProject[cwd]` may also override `scoring`, `rootDirDepth`, and add to (unions) `preserveGlobs`; unknown keys are ignored.

**Domain shift** — Jaccard overlap of the first-N vs last-N rootDir sets. < 0.3 = pivot detected.

**Stale tokens** — rough estimate of how much of the context is spent in COLD dirs.

### Where it shows up

1. **Suggest-compact message**: the `Observed:` line above.
2. **Pre-compact injection**: at the moment of `/compact`, `si-pre-compact.js` regenerates the analysis and streams this to stdout (which Claude Code feeds to the model as compaction guidance):

```
OBSERVED CONTEXT SHAPE (auto-generated from tool usage):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

DOMAIN SHIFT DETECTED: src/auth → src/billing
(Jaccard overlap 0 across recent tool calls)

PRESERVE (recently active, still in use):
  - src/billing (15 calls) — e.g. src/billing/invoice.ts, src/billing/ledger.ts

SAFE TO DROP (untouched for most of the session, ~82k tokens):
  - tests/browser (12 calls earlier) — e.g. tests/browser/auth.spec.ts

Keep only one-line summaries of what happened in the DROP section — the detail is no longer load-bearing.

PHASE MARKERS OBSERVED:
  - commit at ~145k tokens
```

This gets *appended* to whatever you have in `session-context.md`, so user-curated hints still come first (stronger signal, manual curation) and observed shape comes second (grounded in reality).

### You just type `/compact`

No need to remember preserve/drop syntax. Plain `/compact` works — the hook injects hints automatically. Free-text `/compact preserve auth refactor, drop old browser tests` still works too and composes on top of the auto-injection (your words go in first, hook adds its block after).

### Post-compact resume

Pre-compact writes a one-shot handoff file (`.si-handoff.json` in the project's `~/.claude/projects/<encoded>/` dir) with: current task, unresolved follow-ups from memory, in-flight (uncommitted) files, commits shipped this session, and recently-active directories. The next SessionStart reads it, deletes it (so unrelated compacts don't replay stale state), and injects a **SESSION RESUME** block via `additionalContext`.

The resume block carries an explicit model directive to (1) echo the banner verbatim at the top of the next reply, then (2) auto-resume the current task — read files, make the next edit — without re-announcing what it's about to do. The model only pauses to ask if the current task is finished **and** no actionable next priority exists.

**Claude Code pauses for input after manual `/compact`.** There's no hook channel to auto-trigger a model turn, so you need to send any short message (e.g. just `c`) for the resume banner to show + work to continue. The bootstrap hook surfaces this tip once per install; the banner itself carries the same hint at the bottom.

Gated by `continue.afterCompact` (default true). Self-gated: if every signal is empty (no fresh current task, no follow-ups, no commits, no hot dirs) the handoff file isn't written at all, so a topic-pivot `/compact` doesn't drag old context forward.

## Learning Loop

Three cooperating mechanisms so the plugin **gets better the longer you use it**:

### 1. Compact history

Every `/compact` appends an entry to `~/.claude/logs/compact-history.jsonl`:

```json
{"t":1714000000,"sid":"abc","cwd":"/proj","tokens":265000,"cost":2.14,
 "hotDirs":["src/auth"],"droppedDirs":["tests/browser","scripts/old"],
 "hadShift":true,"regretCount":0}
```

Size-bounded at 200 entries / 256 KB with automatic rotation. Cross-session — history persists across every Claude Code session you run.

### 2. Adaptive zone thresholds

With ≥5 compacts in history, `si-suggest-compact.js` swaps the static 200k/300k/400k thresholds for ones learned from your pattern:

- `orange` = `floor(P50 * 0.9)` — slightly below where you typically pull the trigger, so warnings land before you've already decided to compact
- `yellow` = `orange - 80k`
- `red` = `max(orange + 60k, P90 * 1.05)` — the scramble zone above your heaviest compacts

All bounded **±30% from defaults** so a degenerate history can't silence warnings entirely. The escalation message includes a disclosure footnote when adaptive zones are active:

```
(Zones adapted to your history: orange=251k, red=317k, 7 past compacts.)
```

### 3. Post-compact regret detection

When `si-pre-compact.js` writes PRESERVE/DROP bands, it also snapshots them to `/tmp/claude-compact-snapshot-<sid>.json`:

```json
{"t":1714000000,"tokens":265000,"cost":2.14,
 "hotDirs":["src/auth"],"warmDirs":["src/billing"],"droppedDirs":["tests/browser"],
 "callsSince":0,"regretHits":[],"softRegretHits":[],"positiveHits":[]}
```

For the next **30 tool calls** or **30 minutes** (whichever first), `si-token-budget.js` checks every file path against three bands:

- **hard regret** — touch a `droppedDirs` entry. You told the model to drop that context, but reached back for it. Weighted by op type (Read=1.0, Edit=0.3, cleanup=0.1).
- **soft regret** — touch a `warmDirs` entry (mid-recency, not current focus, not dropped). Weaker signal, dampened 0.5× so a handful of soft hits are needed to rival one hard hit. Instrumentation-only right now: stamped to history as `softRegretCount` but not yet fed into zone adjustment. Exists because users compacting early (median ~60k) rarely age dirs to COLD, so hard regret alone undercounts.
- **positive** — touch a `hotDirs` entry. "Compact freed attention for the stuff we flagged as important." Feeds `continuationQuality` = `(positive − regret) / (positive + regret)`, range [-1, 1], stamped on window close.

When the window closes, weighted sums get stamped back onto the original history entry. The **regret rate across your last 10 compacts** feeds `adaptiveZones()` — ≥1 hard regret per compact on average pushes orange **out** by 10% (be more conservative, the user apparently needs that context).

### What you get from it

- **Zones match your actual work pattern** — the warning never fires "too late" for your style
- **Drop suggestions learn** — if you keep re-reaching for `tests/` after dropping it, the plugin starts recommending drop less aggressively
- **No opt-in required** — history logs automatically, adapts when there's enough data, otherwise falls back to static defaults silently

### Files written

| Path | Contents | Lifetime |
|---|---|---|
| `/tmp/claude-ctx-shape-<sid>.jsonl` | observation log, last 200 tool calls | per-session (temp) |
| `/tmp/claude-compact-snapshot-<sid>.json` | pre-compact snapshot of dropped/hot dirs | 30 calls / 30 min post-compact |
| `~/.claude/logs/compact-history.jsonl` | cross-session compact history | persistent, bounded 200 entries |

## Task Change Detector

When you submit a prompt, `si-task-change.js` (UserPromptSubmit hook) decides whether it looks like a **domain change** from the task you're currently working on — and if so, writes a single-line **hint** to stderr suggesting `/compact` or `/clear`. The prompt is never blocked; derailing a legitimate topic shift is worse than a little context pollution. Background `<task-notification>` completions and slash-command artifacts (`<local-command-*>`, `<command-*>`) are filtered out — they aren't user intent and were previously mis-scored.

### Layer 1 — heuristic signals (always on)

Combined into a 0..1 same-domain score:

| # | Signal | What it compares | Weight |
|---|---|---|---|
| 1 | **File overlap** | paths mentioned in the new prompt vs. a pooled baseline of `## Key Files`, dirty / untracked files, files touched by commits in the last `taskChange.recentHours` (default 24), and path-like mentions from the last `taskChange.transcriptTurns` transcript turns (default 20) | 2 |
| 2 | **Root prefix** | top-level folder match (e.g. `src/auth/*` vs `src/billing/*`) | *(folded into 1)* |
| 3 | **Keyword Jaccard** | stopword-filtered Jaccard of current task description vs. new prompt | 1 |

The pooled baseline is the critical fix — historically this hook only knew what you'd typed into `session-context.md`. Now "current work" also means files you've actually edited/committed recently and files you've talked about in the session, so follow-ups score as same-domain even when the markdown is out of date.

Absent signals are neutral — a prompt that mentions no paths is judged on keywords alone. If every signal is missing, the hook stays silent rather than prompting on no evidence.

### Layer 2 — Claude Haiku tie-breaker (opt-in)

When the heuristic score falls in the ambiguous band (`differentDomainScore < score < sameDomainScore`) and `taskChange.semanticFallback=true`, the hook shells out to `claude --print` with a short `SAME / DIFFERENT` prompt. A confident `SAME` verdict overrides the heuristic and lets the prompt through.

- Uses whatever auth your `claude` CLI already has — OAuth subscription or `ANTHROPIC_API_KEY`, no env-forwarding of the key into the child process
- `--setting-sources ''` prevents the subprocess from loading settings.json, so none of your hooks (including this one) re-fire in the child — no recursion
- Bounded 3s timeout (`taskChange.semanticTimeoutMs`); falls through to the heuristic on failure/timeout
- Model configurable via `taskChange.haikuModel` (default `claude-haiku-4-5`)
- Only fires in the ambiguous band, not on every prompt — typical cost ≈ $0.0002 per disputed submission

### Decision

| Same-domain score | Tokens ≥ `minTokens` | Action |
|---|---|---|
| ≥ `sameDomainScore` (default 0.5) | any | silent |
| between both thresholds | yes | stderr hint: *consider `/compact` (preserve current task)* |
| < `differentDomainScore` (default 0.2) | yes | stderr hint: *consider `/clear` (fresh start is cheaper)* |
| any | no | silent (below `minTokens` — cheap either way) |

The prompt is always allowed through (`exit 0`). One-shot per (session, prompt-hash) — retrying the same prompt won't re-hint.

### Tuning

Everything is in `taskChange.*`:

```text
/si set taskChange.enabled false                # turn off entirely
/si set taskChange.minTokens 150000             # only kick in above 150k
/si set taskChange.sameDomainScore 0.6          # stricter "same domain"
/si set taskChange.differentDomainScore 0.15    # looser "different domain"
/si set taskChange.conversationalMaxLen 120     # treat short prompts without
                                                # file refs as conversation
/si set taskChange.recentHours 24               # pool commits from last N hours
/si set taskChange.transcriptTurns 20           # pool file refs from last N turns
/si set taskChange.semanticFallback true        # enable Haiku tie-breaker
/si set taskChange.semanticTimeoutMs 3000       # Haiku call timeout
/si set taskChange.haikuModel claude-haiku-4-5  # override tie-breaker model
```

You don't *need* to fill `session-context.md` for the detector to work — the pooled baseline (recent commits + transcript file mentions + dirty tree) is usually enough. Filling it helps the pre-compact hint injection more than it helps the detector. No baseline at all (placeholder-only template + no recent git activity + no transcript file refs) = silent. Short conversational prompts (under `conversationalMaxLen` chars with no `@path` or backtick code references) also stay silent — they're follow-up talk, not task drift.

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
| `si-bootstrap.js` | SessionStart | Seeds session-context.md from git, wires statusline chain, injects CLAUDE.md rules |
| `si-pre-compact.js` | PreCompact | Injects session-context.md hints **+ auto-generated PRESERVE/DROP from observed shape**, logs compact history entry + post-compact snapshot |
| `si-token-budget.js` | PostToolUse | Estimates tokens from tool I/O, appends context-shape entries, monitors post-compact regret |
| `si-suggest-compact.js` | PostToolUse | Grounded zone warnings at 200k/300k/400k (adaptive from history). Non-blocking — runs as feedback, not interruption |
| `si-task-change.js` | UserPromptSubmit | Scores same-domain on each new prompt; writes a one-line stderr hint (never blocks) when the task looks like it just shifted |

All emit structured entries to the debug log (see above).

## Files Installed

| Target | Source | Purpose |
|---|---|---|
| `~/.claude/scripts/hooks/si-bootstrap.js` | `hooks/si-bootstrap.js` | SessionStart bootstrapper |
| `~/.claude/scripts/hooks/si-pre-compact.js` | `hooks/si-pre-compact.js` | Compaction hint injector (session-context + shape + history logging) |
| `~/.claude/scripts/hooks/si-token-budget.js` | `hooks/si-token-budget.js` | Token estimator + shape observer + regret detector |
| `~/.claude/scripts/hooks/si-suggest-compact.js` | `hooks/si-suggest-compact.js` | Grounded zone warnings with adaptive thresholds |
| `~/.claude/scripts/hooks/si-task-change.js` | `hooks/si-task-change.js` | Task-domain change detector |
| `~/.claude/scripts/hooks/session-intelligence/lib/config.js` | `lib/config.js` | Unified config loader + presets |
| `~/.claude/scripts/hooks/session-intelligence/lib/context-shape.js` | `lib/context-shape.js` | Shape observer: appendShape / analyzeShape / formatCompactInjection |
| `~/.claude/scripts/hooks/session-intelligence/lib/compact-history.js` | `lib/compact-history.js` | History log + adaptive zones + post-compact regret tracking |
| `~/.claude/scripts/hooks/session-intelligence/lib/cost-estimation.js` | `lib/cost-estimation.js` | Incremental cost-from-transcript + cost-band classification |
| `~/.claude/scripts/hooks/session-intelligence/lib/utils.js` | `lib/utils.js` | Minimal shared utils |
| `~/.claude/scripts/hooks/session-intelligence/lib/intel-debug.js` | `lib/intel-debug.js` | Debug logger |
| `~/.claude/scripts/statusline-intel.js` | `statusline/statusline-intel.js` | Intel status-line renderer |
| `~/.claude/scripts/si-statusline-chain.sh` | `statusline/statusline-chain.sh` | Chain wrapper (preserves your existing statusLine) |
| `~/.claude/commands/si.md` | `commands/si.md` | `/si` slash command (config manager) |
| `~/.claude/session-intelligence.json` | `templates/session-intelligence.json` | Unified config (shipped on first install only) |

## Configuration

### Config file

Prefer **`/si set <key> <value>`** over env vars — it's Claude-native, diffed, and persistent. Env vars remain as an override for scripting/CI.

### Environment Variables

| Variable | Config equivalent | Description |
|----------|---|---|
| `COMPACT_THRESHOLD` | `compact.threshold` | Tool calls before first compact suggestion |
| `CLAUDE_COMPACT_AUTOBLOCK` | `compact.autoblock` | `0` silences the orange/red zone suggestions (legacy name — no longer blocks) |
| `CLAUDE_TASK_CHANGE` | `taskChange.enabled` | `0` disables task-change detection entirely |
| `CLAUDE_INTEL_DEBUG` | `debug.enabled` | Enable debug-level log entries |
| `CLAUDE_INTEL_QUIET` | `debug.quiet` | Suppress all log entries except errors |
| `CLAUDE_STATUSLINE_NO_PREV` | — | (Chain) Suppress the previous statusLine command |
| `CLAUDE_STATUSLINE_NO_INTEL` | — | (Chain) Suppress the intel line |
| `CLAUDE_STATUSLINE_COMPACT` | — | Hide the task summary from the intel line |
| `CLAUDE_STATUSLINE_SEP` | — | Separator between prev statusLine and intel (default: newline) |
| `CLAUDE_STATUSLINE_NO_COLOR` | `statusline.colors` | `1` strips ANSI |

### Customizing Zones

Three paths, from preferred to least:

1. **Adaptive (recommended)** — after you've run 5+ `/compact`s they're derived automatically from your pattern. No configuration.
2. **`/si set statusline.zones.<name> <value>`** — override for the status line:
   ```
   /si set statusline.zones.yellow 250000
   /si set statusline.zones.orange 350000
   /si set statusline.zones.red 450000
   ```
3. **Hardcoded edit** — only if you want to change the fallback defaults used when history is empty. Edit the `getZone()` function in `si-suggest-compact.js`, `si-token-budget.js`, and `statusline-intel.js`:

```js
function getZone(tokens, zones) {
  const z = zones || { yellow: 200000, orange: 300000, red: 400000 };
  if (tokens >= z.red)    return 'red';
  if (tokens >= z.orange) return 'orange';
  if (tokens >= z.yellow) return 'yellow';
  return 'green';
}
```

### Inspecting the learning state

```bash
# View all historical compacts (JSONL, last 200 entries)
tail ~/.claude/logs/compact-history.jsonl | jq .

# Current session's observed shape
cat /tmp/claude-ctx-shape-$SESSION_ID.jsonl | jq .

# Live post-compact snapshot (only exists during the 30-call regret window)
cat /tmp/claude-compact-snapshot-$SESSION_ID.json | jq .

# What would the adaptive zones be right now?
node -e 'const {adaptiveZones, readHistory} = require("~/.claude/plugins/cache/session-intelligence/session-intelligence/1.0.0/lib/compact-history"); console.log(adaptiveZones(readHistory()))'
```

## Works With

- **Standalone** — zero dependencies, just Node.js + bash
- **ECC (Everything Claude Code)** — hooks coexist, enhanced pre-compact replaces ECC's basic version
- **ccstatusline / starship / custom statusLines** — the chain wrapper preserves whatever you had
- **Any Claude Code project** — hooks are global, session-context is per-project

## Ecosystem

Session Intelligence is a **session-level** tool — it decides *when* the whole context should compact and *what* to preserve. A parallel ecosystem of **per-call** token reducers decides *how much each individual tool call costs*. They compose well and solve different problems, so SI doesn't bundle or require any of them.

If you're running one of these alongside SI, `/si status` will surface it under an `Ecosystem` section so you can reason about SI's metrics (zone frequency, cache-hit ratio) in the context of the full stack.

**Per-call output / read-scope reducers**
- [RTK (Rust Token Killer)](https://github.com/rtk-ai/rtk) — proxy that filters terminal output before it enters the context. Zero dependencies. Detected via `RTK_ENABLED` / `CLAUDE_RTK`.
- [Context Mode](https://github.com/mksglu/context-mode) — sandboxes raw tool output into SQLite instead of the context window. Large log + GitHub dumps go there instead of into tokens.
- [Code Review Graph](https://github.com/tirth8205/code-review-graph) — Tree-sitter graph makes Claude read only the symbols that matter on large monorepos.
- [Token Savior](https://github.com/mibayy/token-savior) — symbol-based code navigation with persistent memory.

**MCP layer**
- [Token Optimizer MCP](https://github.com/ooples/token-optimizer-mcp) — aggressive caching + compression for MCP tool calls. Detected by MCP server name.
- [Claude Context](https://github.com/zilliztech/claude-context) — Zilliz hybrid vector-search MCP that turns your codebase into retrieval context. Detected by MCP server name.

**Static terseness**
- [Claude Token Efficient](https://github.com/drona23/claude-token-efficient) — drop-in `CLAUDE.md` enforcing terse output.
- [Claude Token Optimizer](https://github.com/nadimtuhin/claude-token-optimizer) — setup prompts that shrink project docs.
- [Caveman Claude](https://github.com/juliusbrussee/caveman) — caveman-speak output-style for dramatic output-token reduction.

Detection in `/si status` is read-only — it only parses MCP config files and a couple of env markers. It never runs external processes or modifies anything. If you want a tool added to detection, open an issue with the MCP server name or env var.

## Background

Based on [Thariq's research](https://x.com/trq212/status/2044548257058328723) on Claude Code session management with 1M context:
- Context rot starts at ~300-400k tokens
- Auto-compact drops context unpredictably
- Proactive compaction with hints prevents bad compacts
- Subagents and rewind are underused context management tools
- Live visibility (status line) encourages better habits than retrospective review

Extensions this plugin adds beyond the original:
- **Grounded suggestions** — every zone warning cites observed tool shape (domain shifts, hot/cold dirs, stale tokens, session cost) so Claude has the "why" alongside the "when"
- **Auto-injection** — user types plain `/compact` and the PreCompact hook injects PRESERVE/DROP bands derived from actual tool usage, so you don't need to remember the hint syntax
- **Learning loop** — zone thresholds adapt to your compact history; regret detection watches for re-touched dropped dirs and dampens drop eagerness when the plugin has been too aggressive
- **One colour, one signal** — status line uses dim for context and a single coloured field (tokens zone) for the warning, so the bar has one loud voice and one quiet voice

## License

MIT
