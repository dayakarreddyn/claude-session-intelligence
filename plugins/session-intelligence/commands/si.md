---
description: Session Intelligence config — show, get, set, or reset keys in ~/.claude/session-intelligence.json with a diff preview and confirmation before writing.
---

# /si — Session Intelligence config

Manage the unified config at `~/.claude/session-intelligence.json` from inside Claude. Every **write** shows a diff and waits for the user to confirm before saving, so there are no surprise changes.

## Usage

```
/si help                                  # list subcommands + one-line descriptions
/si show                                  # print current config (pretty JSON)
/si status                                # runtime state: hooks, statusline, session counters
/si get <key>                             # print a single key (dotted path)
/si set <key> <value>                     # stage a change, show diff, wait for YES
/si reset <key|*>                         # reset a key (or all) to default
/si explain <key>                         # describe what a key does
/si config                                # show all keys in one table, edit any subset, review combined diff, confirm
/si migrate                               # import legacy ~/.claude/statusline-intel.json
/si tail                                  # show latest intel log + shape log for this session
```

Keys use dotted paths. Values parse as JSON when possible, else plain string.

Examples:

```
/si set compact.autoblock false
/si set compact.threshold 75
/si set taskChange.minTokens 150000
/si set statusline.zones.orange 350000
/si set statusline.fields '["emoji","model","project","tokens"]'
/si reset taskChange
/si reset *
```

## Process

### Step 1 — Resolve the file and defaults

1. The config file is **`~/.claude/session-intelligence.json`**. If it does not exist, assume an empty `{}` — the hook loader merges with defaults.
2. Defaults live in the plugin's `lib/config.js` under `DEFAULTS`. Resolve the path in this order and read the first that exists:
   - `${CLAUDE_PLUGIN_ROOT}/lib/config.js`
   - `~/.claude/plugins/cache/session-intelligence/plugins/session-intelligence/lib/config.js`
   - `~/.claude/scripts/hooks/session-intelligence/lib/config.js` (legacy install)

### Step 2 — Dispatch on subcommand

**`help`** (also `--help`, `-h`, or no args) — Print the one-line usage block above verbatim, followed by a short "Examples" block with 2–3 common commands. No diff, no config read, no side effects. This is the discovery path — do not link to the README or external docs, just show the available subcommands.

**`show`** — Read the config file and print it. If the file doesn't exist, say so explicitly and show the effective defaults instead.

**`status`** — Run the read-only runtime report. Resolve the status script path in this order and invoke the first that exists with the current session id piped on stdin:

```
${CLAUDE_PLUGIN_ROOT}/hooks/si-status-report.js
~/.claude/plugins/marketplaces/session-intelligence/plugins/session-intelligence/hooks/si-status-report.js
~/.claude/scripts/hooks/si-status-report.js
# Legacy fallbacks (older installs pre si- rename):
${CLAUDE_PLUGIN_ROOT}/hooks/status-report.js
~/.claude/scripts/hooks/status-report.js
```

Invoke as: `echo '{"session_id":"<sid>"}' | node <path>`. Relay the script's stdout verbatim — it's already formatted. Do not attempt to parse or summarise it unless the user asks a follow-up.

**`get <key>`** — Print just the value at the dotted path. Report missing paths clearly.

**`set <key> <value>`** — This is the important one. Follow the write protocol below.

**`reset <key>`** — Same as `set`, but the new value comes from `DEFAULTS` in `lib/config.js`. `reset *` resets the entire file back to defaults.

**`explain <key>`** — Describe what the key controls, its type, its default, and its effect on which hook. Keep it under 60 words. Do not modify anything.

**`config`** — Show-all config form. See the dedicated section below.

**`migrate`** — If `~/.claude/statusline-intel.json` exists, read it, nest its keys under `"statusline"`, merge into the unified config, show the diff, and wait for YES before writing. Keep the legacy file on disk as a backup.

**`tail`** — Read-only snapshot for debugging. Print, in order, with horizontal rule separators between sections:

1. Last 20 lines of today's intel log: `~/.claude/logs/session-intel-<YYYY-MM-DD>.log`. If the file is missing, say so and suggest `/si set debug.enabled true` if the user wants more verbose logging.
2. Last 20 lines of the shape log for the current session: `/tmp/claude-ctx-shape-<sid>.jsonl`. Resolve `<sid>` from the hook stdin `session_id`. Pretty-print each JSONL entry as `tok=<n>k tool=<Name> root=<root> file=<file> event=<event>` — drop any null fields. If no shape file exists, say "no tool calls observed yet for this session."
3. Last 10 adaptive-zones announcements (`~/.claude/logs/adaptive-zones-announced.json`) — a small JSON object keyed by cwd. Relevant when debugging why zones are or aren't adapting.

No diff, no config write, no subagents. This is a "what is the plugin doing right now" view. Emit three clear section headers (`INTEL LOG`, `SHAPE LOG`, `ADAPTIVE ZONES`) so the user can navigate the output quickly.

### `config` — show-all form

Print **every tunable key in one table**, then accept a bulk edit block from the user. Same vibe as `claude config`: everything visible, edit whatever you care about, submit once, review a combined diff, confirm.

**Step A — Print the form**

One fenced block mimicking the look of Claude Code's built-in `/config`: **friendly label on the left, current value right-aligned**. Group rows under section headers. Row order is fixed; do not reorder. Flag values that diverge from default by appending ` *` after the value. Render booleans as `true` / `false`, numbers ≥1000 as `Nk` (e.g. `200k`), everything else verbatim.

```
Session Intelligence — Config                    (~/.claude/session-intelligence.json)

Statusline
  Preset                                           verbose
  Token source                                     auto
  Caution zone (yellow)                            200k
  Compact-now zone (orange)                        300k
  Urgent zone (red)                                400k
  Task text max length                             35 *
  ANSI colors                                      true

Compact
  Advisory threshold (tool calls)                  50
  Show compact suggestion in-tool                  true
  Pre-compact memory offload                       true

Continue
  Resume task after /compact                       true

Task change detection
  Enabled                                          true
  Minimum tokens to detect                         150k *

Shape tracker
  Root dir depth                                   2
  Git Nexus — enabled                              true
  Git Nexus — inject at SessionStart               false

Learning
  Announce zone shifts                             false

Debug
  Verbose logs                                     true *
  Quiet mode                                       false

* = differs from default
```

Resolve current values from the on-disk config (empty-object fallback → default), and defaults from `DEFAULTS` in `lib/config.js`. Do **not** invent keys absent from this list. The friendly label → dotted key mapping is fixed:

| Label | Dotted key |
|---|---|
| Preset | `statusline.preset` |
| Token source | `statusline.tokenSource` |
| Caution zone (yellow) | `statusline.zones.yellow` |
| Compact-now zone (orange) | `statusline.zones.orange` |
| Urgent zone (red) | `statusline.zones.red` |
| Task text max length | `statusline.maxTaskLength` |
| ANSI colors | `statusline.colors` |
| Advisory threshold (tool calls) | `compact.threshold` |
| Show compact suggestion in-tool | `compact.autoblock` |
| Pre-compact memory offload | `compact.memoryOffload` |
| Resume task after /compact | `continue.afterCompact` |
| Enabled *(under Task change detection)* | `taskChange.enabled` |
| Minimum tokens to detect | `taskChange.minTokens` |
| Root dir depth | `shape.rootDirDepth` |
| Git Nexus — enabled | `shape.gitNexus.enabled` |
| Git Nexus — inject at SessionStart | `shape.gitNexus.injectAtStart` |
| Announce zone shifts | `learn.announce` |
| Verbose logs | `debug.enabled` |
| Quiet mode | `debug.quiet` |

**Step B — Collect edits**

Directly after the form, print exactly:

> Reply with one `key=value` per line for any keys you want to change. Accepted forms: the friendly label (case-insensitive, punctuation-insensitive) OR the dotted key. Values accept `true` / `false`, `Nk` for thousands, or a raw number / string. Reply `NONE` to finish with no changes, or `QUIT` to abort. Unlisted keys keep their current value.
>
> Example:
> ```
> Show compact suggestion in-tool=false
> statusline.zones.orange=350k
> verbose logs=false
> ```

Wait for the user's next message. Parse it line by line:

- Blank lines and lines starting with `#` → ignore.
- `NONE` (case-insensitive, trimmed) → no patch; print *"No changes — form finished with current config intact."* and stop.
- `QUIT` (case-insensitive, trimmed) → abort; print *"Cancelled — no changes staged."* and stop.
- `key=value` — resolve the key:
  1. If it matches a dotted path in the table above, use that.
  2. Otherwise normalize the left side (lowercase, strip punctuation/whitespace) and match against the normalized friendly labels. First-match wins. Error on ambiguity.
  3. Parse the value: accept `Nk` / `Nm` for thousands/millions, then `JSON.parse`, then raw string. Type-check against the key's type (`bool`, `number`, `enum`).
- On any validation failure: report the offending line, list what you expected, and ask the user to resubmit the whole block — do not silently drop lines or write a partial patch.

Stage valid edits into an in-memory patch. Do not mutate the file.

**Step C — Diff and confirm**

Enter Step 3's write protocol verbatim with the staged patch: show the combined diff once, ask for `YES`, write on confirmation, discard on anything else.

**Invariants**
- One form, one submission, one diff, one confirmation. No per-key prompting.
- Never write to disk outside Step 3.
- Never accept a key not in the table without warning (same edge case as `/si set` — warn once, then proceed if the user resubmits).

### Step 3 — Write protocol (for `set` / `reset` / `migrate`)

Every write goes through the same four-step dance. Do not skip steps.

1. **Load current config.**
   - If the file exists, read its JSON.
   - If not, start from `{}`.

2. **Compute the new config.**
   - For `set`: apply the dotted-path assignment on a deep copy. Parse the value with `JSON.parse` first; fall back to the raw string only if JSON parse fails.
   - For `reset <key>`: copy the value at that dotted path out of `DEFAULTS`.
   - For `reset *`: the new config is `DEFAULTS` itself.
   - For `migrate`: see above.

3. **Show the diff.**
   Print the change as a unified diff or a clear before/after block. Use fenced JSON so it stays readable. Include enough surrounding context that the user can tell what's changing:

   ```
   ~/.claude/session-intelligence.json

   - "autoblock": true,
   + "autoblock": false,
   ```

   If the change is a no-op (new value equals existing), say so and stop — do not write.

4. **Ask for confirmation.**
   End the message with exactly:

   > Apply this change? Reply **YES** to write, anything else to cancel.

   Wait for the user's next message.
   - Reply is `YES` (case-insensitive, trimmed) → write the file with `JSON.stringify(next, null, 2) + '\n'`, then confirm with the final path and one-line summary of what changed.
   - Reply is anything else → print *"Cancelled — no changes written."* and stop.

   Do not write the file before the user confirms. Do not re-show the diff while waiting.

### Step 4 — Post-write effects

After a successful write, remind the user in one line if any change requires a Claude Code restart to take effect:

| Section changed | Takes effect |
|---|---|
| `statusline.*` | Next status line redraw (no restart needed) |
| `compact.*` | Next tool call after the hook fires |
| `continue.*` | Next /compact (read at next SessionStart) |
| `taskChange.*` | Next user prompt |
| `shape.*` | Next tool call after the hook fires |
| `learn.*` | Next compact-suggestion advisory |
| `debug.*` | New sessions (restart recommended) |

## Edge cases

- **Invalid JSON in existing file:** report the parse error and offer `/si reset *` to rebuild from defaults. Do not silently overwrite.
- **Unknown dotted key (not in DEFAULTS):** allow it, but warn once: *"Heads up — this key isn't in the schema. No hook will read it unless you also patch the loader."* Then continue with the normal write protocol.
- **Value that fails to parse and isn't plausibly a string** (e.g. `set compact.autoblock maybe` — user probably wanted `true`/`false`): flag the ambiguity, propose the likely fix, and wait for a corrected command. Do not guess.
- **`reset` without an existing file:** treat as a reset of the defaults target — effectively a no-op write (skip).

## Safety

- Never write to any file other than `~/.claude/session-intelligence.json`.
- Never edit the loader (`lib/config.js`) from this command — only read it to look up defaults.
- Never include secrets or environment variables in the written config.
- Always show the full proposed diff before writing. No partial previews.
