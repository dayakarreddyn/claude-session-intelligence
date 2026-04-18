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
/si configure                             # walk every key one at a time, review combined diff, confirm
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

**`configure`** — Interactive per-key wizard. See the dedicated section below.

**`migrate`** — If `~/.claude/statusline-intel.json` exists, read it, nest its keys under `"statusline"`, merge into the unified config, show the diff, and wait for YES before writing. Keep the legacy file on disk as a backup.

**`tail`** — Read-only snapshot for debugging. Print, in order, with horizontal rule separators between sections:

1. Last 20 lines of today's intel log: `~/.claude/logs/session-intel-<YYYY-MM-DD>.log`. If the file is missing, say so and suggest `/si set debug.enabled true` if the user wants more verbose logging.
2. Last 20 lines of the shape log for the current session: `/tmp/claude-ctx-shape-<sid>.jsonl`. Resolve `<sid>` from the hook stdin `session_id`. Pretty-print each JSONL entry as `tok=<n>k tool=<Name> root=<root> file=<file> event=<event>` — drop any null fields. If no shape file exists, say "no tool calls observed yet for this session."
3. Last 10 adaptive-zones announcements (`~/.claude/logs/adaptive-zones-announced.json`) — a small JSON object keyed by cwd. Relevant when debugging why zones are or aren't adapting.

No diff, no config write, no subagents. This is a "what is the plugin doing right now" view. Emit three clear section headers (`INTEL LOG`, `SHAPE LOG`, `ADAPTIVE ZONES`) so the user can navigate the output quickly.

### `configure` — interactive per-key wizard

Walks every tunable key in order, **one at a time**, using the `AskUserQuestion` tool. For each key, stage the user's selection in an in-memory patch; after the last key (or when the user picks **Quit wizard**), fall through to Step 3's write protocol so the combined change is previewed and confirmed in a single diff.

**Loop invariants**
- Never write to disk inside the loop. Only Step 3 writes.
- Never ask more than one `AskUserQuestion` at a time. Do not batch multiple keys into a single prompt.
- Preserve the current value when the user picks **Keep**, **Skip**, or **Quit**. Only mutate the staged config on explicit selection.
- If the user picks **Custom…**, immediately follow up with a second `AskUserQuestion` (or plain message) that accepts a free-form value. Parse numbers with `parseInt` / `parseFloat`; refuse and re-ask on parse failure — never silently skip.

**Prompt shape (per key)**

Every question header must include: dotted key, current value, default value, one-sentence description. Example:

```
statusline.zones.orange — caution zone where compact is strongly suggested
  current: 300000   default: 300000
```

Then `AskUserQuestion` with 3–5 short options. Always include **Keep current**, **Custom…**, **Skip**, and **Quit wizard** in addition to the named presets. Do not invent options outside the table below.

**Keys to walk, in order**

| # | Key | Type | Description (≤12 words) | Named options |
|---|-----|------|-------------------------|---------------|
| 1 | `statusline.preset` | enum | Line shape preset | `minimal`, `standard`, `verbose` |
| 2 | `statusline.tokenSource` | enum | How token count is read | `auto`, `transcript`, `estimate` |
| 3 | `statusline.zones.yellow` | number | Tokens → caution zone | `150000`, `200000`, `250000` |
| 4 | `statusline.zones.orange` | number | Tokens → compact-now zone | `250000`, `300000`, `350000` |
| 5 | `statusline.zones.red` | number | Tokens → urgent zone | `350000`, `400000`, `450000` |
| 6 | `statusline.maxTaskLength` | number | Line-2 task text truncation | `25`, `35`, `50`, `70` |
| 7 | `statusline.colors` | bool | ANSI colors in statusline | `true`, `false` |
| 8 | `compact.threshold` | number | Tool calls before first advisory | `50`, `75`, `100` |
| 9 | `compact.autoblock` | bool | Surface compact suggestion as tool feedback | `true`, `false` |
| 10 | `compact.memoryOffload` | bool | Pre-compact memory-offload directive | `true`, `false` |
| 11 | `continue.afterCompact` | bool | Replay task + in-flight state after /compact | `true`, `false` |
| 12 | `taskChange.enabled` | bool | Detect task-domain changes | `true`, `false` |
| 13 | `taskChange.minTokens` | number | Skip detection below this many tokens | `50000`, `100000`, `150000` |
| 14 | `shape.rootDirDepth` | number | Path segments to group tool calls by (monorepo knob) | `1`, `2`, `3` |
| 15 | `shape.gitNexus.enabled` | bool | Auto-derive preserveGlobs from git commit frequency | `true`, `false` |
| 16 | `shape.gitNexus.injectAtStart` | bool | Emit top anchor files as SessionStart context | `true`, `false` |
| 17 | `learn.announce` | bool | Emit one-line zone-shift summary when adaptive zones change | `true`, `false` |
| 18 | `debug.enabled` | bool | Verbose debug logs | `true`, `false` |
| 19 | `debug.quiet` | bool | Suppress non-error output | `true`, `false` |

Walk this list top-to-bottom. Do not reorder. Do not insert keys that are not in this table (service health, prices, individual fields array — those are covered by `/si set`).

**Selection handling**
- `Keep current` → no change staged, advance.
- A named option → stage `config[key] = option` on the in-memory copy, advance.
- `Custom…` → ask for a free-form value, validate against the type column, stage, advance. On repeated invalid input (twice), treat as `Skip`.
- `Skip` → no change staged, advance.
- `Quit wizard` → stop immediately, jump to Step 3.

**After the loop**

If zero keys were staged, print *"No changes — wizard finished with current config intact."* and stop. Otherwise:
1. Compute the new config (= current deep-merged with the staged patch).
2. Enter Step 3's write protocol verbatim: show the combined diff, then ask for `YES`.
3. On `YES`, write once; on anything else, discard the staged patch.

No mid-wizard writes. No partial saves. One diff, one confirmation.

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
