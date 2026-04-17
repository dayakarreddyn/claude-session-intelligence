---
description: Session Intelligence config — show, get, set, or reset keys in ~/.claude/session-intelligence.json with a diff preview and confirmation before writing.
---

# /si — Session Intelligence config

Manage the unified config at `~/.claude/session-intelligence.json` from inside Claude. Every **write** shows a diff and waits for the user to confirm before saving, so there are no surprise changes.

## Usage

```
/si show                                  # print current config (pretty JSON)
/si status                                # runtime state: hooks, statusline, session counters
/si get <key>                             # print a single key (dotted path)
/si set <key> <value>                     # stage a change, show diff, wait for YES
/si reset <key|*>                         # reset a key (or all) to default
/si explain <key>                         # describe what a key does
/si migrate                               # import legacy ~/.claude/statusline-intel.json
```

Keys use dotted paths. Values parse as JSON when possible, else plain string.

Examples:

```
/si set compact.autoblock false
/si set compact.promptTimeout 45
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

**`show`** — Read the config file and print it. If the file doesn't exist, say so explicitly and show the effective defaults instead.

**`status`** — Run the read-only runtime report. Resolve the status script path in this order and invoke the first that exists with the current session id piped on stdin:

```
${CLAUDE_PLUGIN_ROOT}/hooks/status-report.js
~/.claude/plugins/marketplaces/session-intelligence/plugins/session-intelligence/hooks/status-report.js
~/.claude/scripts/hooks/status-report.js
```

Invoke as: `echo '{"session_id":"<sid>"}' | node <path>`. Relay the script's stdout verbatim — it's already formatted. Do not attempt to parse or summarise it unless the user asks a follow-up.

**`get <key>`** — Print just the value at the dotted path. Report missing paths clearly.

**`set <key> <value>`** — This is the important one. Follow the write protocol below.

**`reset <key>`** — Same as `set`, but the new value comes from `DEFAULTS` in `lib/config.js`. `reset *` resets the entire file back to defaults.

**`explain <key>`** — Describe what the key controls, its type, its default, and its effect on which hook. Keep it under 60 words. Do not modify anything.

**`migrate`** — If `~/.claude/statusline-intel.json` exists, read it, nest its keys under `"statusline"`, merge into the unified config, show the diff, and wait for YES before writing. Keep the legacy file on disk as a backup.

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
| `taskChange.*` | Next user prompt |
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
