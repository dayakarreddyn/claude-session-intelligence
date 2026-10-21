# SI Context Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Session Intelligence measure context fill against the real model window, remove tokens from context with the hook channels Claude Code provides, and carry standing constraints through compaction in a typed registry whose retention is measured by a PostCompact hook.

**Architecture:** Tier 1 fixes the ruler: one per-call context unit (`contextTokens`) everywhere, a shared `lib/context-cap.js` resolver, fill % on every compact and zone row, zones as fractions of the window, and a learner that reads fill % instead of a cumulative estimate. Tier 2 turns the archive into a pruner: PreToolUse `updatedInput` rewrites verbose commands, PostToolUse `updatedToolOutput` replaces results above 50,000 chars with an archived excerpt. Tier 3 hardens compaction: a typed constraint registry goes first in the PreCompact block, is re-injected through the SessionStart `compact` handoff, and a new PostCompact hook string-matches it against `compact_summary`. Tier 4 restores numbers to the callout, corrects Claude 5 pricing, adds `/si doctor` and statusline window advice, consumes resume cache fields, feeds Agent returns into the shape diagnosis, and reconciles telemetry.

**Tech Stack:** Node 20/22 (CommonJS, no TypeScript), `node:test` + `node:assert/strict`, SQLite via `lib/sqlite-driver.js` (better-sqlite3 → `node:sqlite` fallback), Claude Code hooks (`hooks/hooks.json`), statusline stdin JSON.

**Spec:** `/Users/0xd/DWS/claude-session-intelligence/reports/Context rot optimisation for Claude 5.md` — sections "## SI measures the wrong number..." and "## Fourteen changes, ranked" (the 14 table rows are the requirements; the "should explicitly not do" paragraph is a hard constraint list). Hook field names come from `research_notes/Context rot optimisation for Claude 5/claude_code_context_machinery.md` and `anthropic_context_features.md`; the file:line map from `si_plugin_audit.md`.

## Global Constraints

- Plugin root for every command: `/Users/0xd/DWS/claude-session-intelligence/plugins/session-intelligence` (run `npm test` and `npm run test:node22` from there; both must stay green after every task). Branch: `feat/si-context-intelligence`.
- Node only, CommonJS, no TypeScript. Tests in `tests/<name>.test.js` using `node:test` + `node:assert/strict`. TDD per task: write the failing test, run it and watch it fail, implement the minimum, run it green, commit.
- Commits per task: `feat(si): ...` or `fix(si): ...`, no attribution trailers (user's global rule: attribution disabled).
- Files stay under 800 lines. `lib/events.js` (905) gets its migrations extracted in Task 2 before any task grows it. Files already over 800 (`statusline/statusline-intel.js` 2155, `hooks/si-bootstrap.js` 1006, `lib/context-shape.js` 921, `hooks/si-pre-compact.js` 836) may only gain a call site (≤ 10 lines); new logic for them goes into a new lib module named in the task.
- Immutable-style updates: functions return new objects; never mutate a config/entry argument.
- No `console.log` in hook code; use `intelLog(source, level, message, meta)` from `lib/intel-debug.js`. Hook stderr is the only user-visible channel; stdout is the JSON/model channel.
- Every hook keeps total stdout and every `additionalContext` under 10,000 characters (Claude Code substitutes a 2,000-char preview and a file path above that; no override exists).
- Hooks never rewrite earlier transcript turns (invalidates every later thinking block on Fable 5.1 / Opus 5.5). The only token-removing channels are PostToolUse `hookSpecificOutput.updatedToolOutput` and PreToolUse `hookSpecificOutput.updatedInput`, both acting before the result enters history.
- PreCompact never exits 2 and never emits `{"decision":"block"}`: a blocked recovery compaction surfaces the API's context-limit error and fails the request.
- Mid-session `additionalContext` is not durable across compaction; only SessionStart `source: "compact"` output is re-added after compaction.
- The chars/4 cumulative estimate is never a primary metric again; where it survives as a diagnostic it is recalibrated to 3 chars/token and labelled tool-I/O share.
- The pruner never fights Claude Code's own caps (file read 25,000 tokens, Bash 30,000 chars, MCP 25,000 tokens, text results over 50,000 chars written to a file): floor starts at 50,000 chars and only the long tail those caps let through is touched; nothing is pruned that is not already archived on disk.
- Exact spec values: zone fractions yellow 0.20 / orange 0.30 / red 0.40; prune floor 50,000 chars; Fable 5.1 cache read $0.25; Opus 5.5 $4 / $5 / $0.20 / $20; Sonnet 5.5 $2 / $2.50 / $0.10 / $10; Haiku 5.5 tier boundary 100,000 input tokens; 1M default auto-compaction point ~967,000; `autoCompactWindow` recommendation 400,000–500,000; callout bucket 5 %.
- Dogfood: the live plugin copy is `~/.claude/plugins/cache/session-intelligence/session-intelligence/1.0.0/`; the last task of each tier runs `npm run sync` and verifies the new file is in the cache.

## Review Focus

1. A transcript with no `usage` line at all (fresh session, or a user-only tail): the zone gate must stay silent and the statusline must show idle — never fall back to the cumulative estimate or manufacture a red crossing. Pinned by Task 4 (`readLatestUsage` returns null) and Task 5 (no callout, no `zone_transitions` row, exit 0 with a 3,000,000 estimate file on disk).
2. A 200K session on a 1M model under `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`: cap must resolve to 200,000, zones to 40,000 / 60,000 / 80,000, and the callout must say "200k window". Pinned by Task 1 (env precedence), Task 8 (thresholds at 200K) and Task 17 (window label).
3. `updatedToolOutput` on a tool whose result is JSON, not text (an MCP tool returning structured content as an object): the pruner must leave it untouched — replacing a structured result with a string excerpt breaks the tool contract. Pinned by Task 9 (`decidePrune` returns `{ pruned: false, reason: 'not-string' }`) and Task 10 (hook emits nothing for an object `tool_response`).
4. A PreCompact block that would exceed 10,000 characters (large shape block + six archive ids + memory directives): the constraint registry must survive and the hook must stay under the cap by dropping optional blocks from the end, logging what it dropped. Pinned by Task 14 (`assembleUnderCap` with a 12,000-char optional block).
5. An old events DB at `user_version` 2 (and one at 0) opened by the new code: columns must be added once, existing rows keep NULL `fill_pct`, the version advances to the current value, and a second open is a no-op. Pinned by Task 3.

---

## File Structure

### New modules

| File | Responsibility |
|---|---|
| `lib/context-cap.js` | Effective window + auto-compaction point resolver, lifted from `statusline/statusline-intel.js:610-636`; reused by hooks, statusline and config. |
| `lib/transcript-usage.js` | Latest assistant `usage` reader with a per-session byte-offset cache and bounded backward scan; per-session peak file. Replaces the 512 KB tail scan in `lib/utils.js:188-212` and `statusline-intel.js:318-346`. |
| `lib/events-migrations.js` | `initSchema(db)` (CREATE TABLEs), all `user_version` migrations and guarded `ADD COLUMN` lists, extracted from `lib/events.js:86-247`. |
| `lib/events-stats.js` | Read-side aggregation (`aggregateStats`, `listRecentCompacts` bodies) extracted from `lib/events.js:640-867`; takes an open `db` so there is no circular require. `lib/events.js` keeps thin wrappers with the same public names. |
| `lib/compact-record.js` | Pure `buildCompactRecord(...)` that turns the latest usage + cap + shape analysis into the history entry, DB row and snapshot (keeps `si-pre-compact.js` from growing). |
| `lib/prune.js` | Pure prune decisions: output excerpt builder, command rewrite rules, input hash. |
| `hooks/si-prune-output.js` | One hook file for both events, dispatched on `hook_event_name`: PreToolUse (`updatedInput`, registered directly in hooks.json with matcher `Bash`) and PostToolUse (`updatedToolOutput`, run as a dispatcher child). |
| `lib/shape-signals.js` | Window signals over shape entries: duplicate reads, same-input re-runs, large results, Agent returns. Kept out of `lib/context-shape.js` (921 lines). |
| `lib/constraint-registry.js` | Typed constraint registry (Action / Information / Process / Preference / Output) built from `session-context.md` and CLAUDE.md `# Compact instructions`; per-session state file; retention matcher. |
| `lib/hook-output.js` | `assembleUnderCap` — orders named blocks and enforces the 10,000-char hook-output cap. |
| `hooks/si-post-compact.js` | PostCompact hook: reads `trigger` + `compact_summary`, records retention and fill into `compact_outcomes`. |
| `lib/resume-advice.js` | Builds the cold-resume advice line from SessionStart resume fields. |

### Locked interfaces

**The single per-call context unit is named `contextTokens`** = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` of the latest assistant `usage` block. It is the value stored in `compacts.tokens`, `zone_transitions.tokens`, `sessions.peak_tokens`, compact-history `tokens` (plus an explicit `contextTokens` field), the snapshot `tokens`, and what the learner reads via `fillPct`. The cumulative tool-I/O estimate is renamed `toolIoEstimate` wherever it survives.

`lib/context-cap.js`:
```js
/** @typedef {{ cap: number, source: 'config'|'statusline'|'env-max-context'|'env-disable-1m'|'model-id'|'fallback' }} ContextCapResult */
function resolveContextCap({ model, env = process.env, settings = null, contextWindowSize = null, configCap = null }) // → ContextCapResult
/** @typedef {{ point: number, source: 'env'|'model-settings'|'settings'|'default' }} AutoCompactPoint */
function resolveAutoCompactPoint({ cap, model, env = process.env, settings = null })  // → AutoCompactPoint
function loadSettingsForCwd(cwd)            // merges ~/.claude/settings.json then <cwd>/.claude/settings.json then settings.local.json (later wins, shallow)
function isNative1M(modelId)                // Fable/Mythos, Sonnet 5+, Haiku 5.5, Opus 4.7+ or an explicit [1m]/-1m/1000k marker
function fillPctOf(contextTokens, cap)      // percentage 0..∞ rounded to 1 decimal; 0 when cap ≤ 0
function bucketPct(pct, step = 5)           // floor to the bucket
function windowLabel(cap)                   // '1M' for ≥ 1,000,000 else `${Math.round(cap/1000)}k`
const ONE_M = 1000000, DEFAULT_CAP = 200000, AUTO_COMPACT_1M_DEFAULT = 967000, RECOMMENDED_AUTO_COMPACT = { min: 400000, max: 500000 };
```
Precedence in `resolveContextCap`: `configCap` (only when `> 0`) → `contextWindowSize` → `env.CLAUDE_CODE_MAX_CONTEXT_TOKENS` (only when the model id is unrecognised, or `env.DISABLE_COMPACT === '1'`) → `env.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1'` ⇒ 200,000 → model id ⇒ 1,000,000 when `isNative1M` → 200,000. Precedence in `resolveAutoCompactPoint`: `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` → `settings.modelSettings[<key>].autoCompactWindow` where `<key>` is tried as the exact model id, then its family alias (`opus`, `sonnet`, `haiku`, `fable`, `mythos` derived from the id) → `settings.autoCompactWindow` → default (`cap ≥ ONE_M ? 967000 : cap`); result is clamped to `[100000, cap]`, then lowered by `env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (1–100, never raised).

`lib/transcript-usage.js`:
```js
/** @typedef {{ contextTokens: number, usage: object, model: string|null, messageId: string|null, timestamp: string|null, source: 'transcript'|'cache' }} LatestUsage */
function readLatestUsage(transcriptPath, { sessionId } = {})   // → LatestUsage | null (null when no usage line exists anywhere and no cache)
function contextTokensOf(usage)      // → input_tokens + cache_creation_input_tokens + cache_read_input_tokens (0 for null)
function usageCachePath(sessionId)   // ~/.claude/state/claude-usage-cache-<sid>.json  { offset, contextTokens, usage, model, messageId, timestamp, t, lastRecordedMessageId }
function peakPath(sessionId)         // ~/.claude/state/claude-context-peak-<sid>  (plain integer)
function updatePeak(sessionId, contextTokens)  // → new peak
function readPeak(sessionId)                   // → number | null
const TAIL_CHUNK_BYTES = 524288, MAX_BACKWARD_CHUNKS = 8;
```
`lib/utils.js` keeps `readTranscriptTokens(transcriptPath, opts)` as a thin wrapper returning `readLatestUsage(...)?.contextTokens || 0`.

`lib/config.js` additions (`DEFAULTS`):
```js
statusline: {
  zoneMode: 'fraction',                                    // 'fraction' | 'absolute'
  zoneFractions: { yellow: 0.20, orange: 0.30, red: 0.40 }, // of the effective window; heuristic — no official degradation point exists
  zones: { yellow: 200000, orange: 300000, red: 400000 },   // honoured only when zoneMode === 'absolute'
  contextCap: 0,                                            // explicit cap override; 0 = auto (resolveContextCap)
},
compact: { stablePrefix: false, calloutBucketPct: 5 },      // stablePrefix default flips from true
prune: {
  enabled: true,
  outputFloorChars: 50000,
  headChars: 2000,
  tailChars: 1500,
  tools: ['Read', 'Bash', 'Grep', 'Glob', 'WebFetch'],
  rewriteInput: true,
  inputRules: DEFAULT_INPUT_RULES,   // from lib/prune.js
},
```
Env overrides: `CLAUDE_SI_PRUNE=0|1`, `CLAUDE_SI_PRUNE_FLOOR=<int>`, `CLAUDE_SI_ZONE_MODE=fraction|absolute`. `getZoneThresholds(cfg, { cap })` → `{ yellow, orange, red, mode, cap }`; in fraction mode each threshold is `Math.round(fraction * cap)`; when `cap` is omitted it assumes `ONE_M`.

`lib/events-migrations.js` and `lib/events-stats.js`:
```js
const SCHEMA_VERSION = 4;   // 3 = fill columns (Task 3), 4 = Claude 5 reprice (Task 19)
function initSchema(db)     // CREATE TABLE/INDEX IF NOT EXISTS for every table, then runMigrations(db)
function runMigrations(db)  // → { from, to }; runs guarded ADD COLUMNs, then v1..v4 in order, each gated on PRAGMA user_version
function repriceAgentInvocations(db)  // shared by v2 and v4
// lib/events-stats.js
function aggregateStats(db, { sinceDays = 30, project = null } = {})   // same return shape as today's events.aggregateStats
function listRecentCompacts(db, { limit = 20, project = null } = {})
```
`lib/events.js` keeps `aggregateStats(opts)` / `listRecentCompacts(opts)` as wrappers that open the DB and delegate, so `tools/stats.js` and the statusline keep importing from `lib/events.js`.
New columns (v3): `compacts.context_cap INTEGER`, `compacts.fill_pct REAL`, `compacts.model TEXT`; `zone_transitions.context_cap INTEGER`, `zone_transitions.fill_pct REAL`, `zone_transitions.model TEXT`, `zone_transitions.trigger TEXT` (the PostToolUse `tool_name` that fired the crossing; `reason` keeps `crossing|refire`). Guarded (no version bump): `tool_archives.pruned INTEGER DEFAULT 0`; tables `compact_outcomes`, `cache_hits`, `tool_reruns` via `CREATE TABLE IF NOT EXISTS`.

`lib/events.js` writer signatures after this plan:
```js
recordCompact({ sid, project, cwd, t, tokens, cost, costAtCompactUsd, hotDirs, warmDirs, droppedDirs, hadShift, trigger, contextCap, fillPct, model })
recordZoneTransition({ sid, project, t, fromZone, toZone, tokens, cost, reason, contextCap, fillPct, model, trigger })
recordCompactOutcome({ sid, project, t, compactT, trigger, summaryChars, constraintsTotal, constraintsRetained, retention, missing, fillBefore, contextCap, model })
stampCompactOutcomeAfter({ sid, compactT, fillAfter })
recordCacheHit({ sid, t, model, messageId, ratio, cacheRead, cacheCreation, contextTokens })   // INSERT OR IGNORE on UNIQUE(sid, message_id)
recordRerun({ sid, t, tool, inputHash, gapCalls, wasPruned })
markArchivePruned(toolUseId)
reconcileCompactHistory(entries)   // inserts compacts rows absent for (sid, t); → count
```

`lib/compact-history.js`: `adaptiveZones(history, defaults, { cwd, cap })` learns from entries carrying `fillPct` (entries without it are ignored); the fixed 80,000 / 60,000 yellow/red gaps become `YELLOW_GAP_FRACTION = 0.08` and `RED_GAP_FRACTION = 0.06` of `cap` (identical to today at 1M); `costTightened` is removed in Task 18. History entries gain `contextTokens, contextCap, fillPct, model, trigger, toolIoEstimate`.

`lib/compact-record.js`:
```js
function buildCompactRecord({ latest, cap, entries, trigger, cwd, sessionId, cost, costAtCompactUsd, analysis })
  // → { historyEntry, dbRow, snapshot } — all new objects; historyEntry = { t, sid, cwd, tokens: contextTokens, contextTokens, contextCap, fillPct, model, trigger, toolIoEstimate, cost, hotDirs, warmDirs, droppedDirs, hadShift, regretCount: 0, costAtCompactUsd? }
```

`lib/prune.js`:
```js
/** @typedef {{ pruned: true, output: string, archiveId: string, originalChars: number, excerptChars: number } | { pruned: false, reason: 'disabled'|'not-string'|'tool-excluded'|'below-floor'|'no-id' }} PruneDecision */
function decidePrune({ toolName, toolUseId, body, cfg })      // cfg = loadConfig().prune
function buildExcerpt(body, { headChars, tailChars, archiveId, toolName, originalChars })
function rewriteCommand(command, rules = DEFAULT_INPUT_RULES) // → { command, rule: string|null }
function inputHash(toolName, toolInput)                        // sha1 of toolName + canonical JSON, first 16 hex
const DEFAULT_INPUT_RULES = [
  { name: 'test-runner', match: '^\\s*(npm|pnpm|yarn)\\s+(run\\s+)?test\\b|^\\s*(pytest|go\\s+test|cargo\\s+test)\\b|^\\s*node\\s+--test\\b',
    suffix: " 2>&1 | grep -E -A 5 '(FAIL|ERROR|error:|not ok|# fail|# pass|passed|failed)' | head -100" },
  { name: 'log-cat', match: '^\\s*cat\\s+\\S+\\.log\\b', suffix: ' | tail -n 200' },
];
```
`rewriteCommand` skips (returns the command unchanged, `rule: null`) when the command contains a `>` redirect, already pipes through `grep|head|tail|wc|jq`, or spans multiple lines. Excerpt exact copy:
```
[SI pruned: Read result 103,625 chars → 3,742-char excerpt. Full body archived; run `/si expand toolu_01ABC` to replay it verbatim.]
<first headChars>
…[98,125 chars omitted]…
<last tailChars>
```

`hooks/si-prune-output.js` stdout, exit 0 in every case:
- PreToolUse: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{...tool_input, command: rewritten}}}` — never a `permissionDecision` key, so the normal permission prompt still runs on the rewritten command.
- PostToolUse: `{"hookSpecificOutput":{"hookEventName":"PostToolUse","updatedToolOutput":"<excerpt>"}}`.
- Nothing on stdout when no change.

`hooks/si-post-tool.js` dispatcher: `CHILDREN = ['si-token-budget.js','si-tool-archive.js','si-prune-output.js','si-agent-tracker.js','si-suggest-compact.js']`; the prune child's stdout is captured; `si-suggest-compact.js` stderr is captured. If prune produced JSON and suggest-compact exited 2, the dispatcher emits one merged object `{ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput, additionalContext: <callout with ANSI stripped> } }` and exits 0 (exit 2 would discard the JSON). Otherwise it forwards the callout to stderr and propagates exit 2 exactly as today.

`lib/shape-signals.js` (shape entries gain `chars` and `inputHash`; Agent/Task calls are appended with `tool: 'Agent'`):
```js
const SIGNAL_WINDOW = 40, RERUN_GAP_CALLS = 20, LARGE_RESULT_CHARS = 60000, CHARS_PER_TOKEN = 3;
function detectDuplicates(entries, { window = SIGNAL_WINDOW, rerunGap = RERUN_GAP_CALLS } = {})
  // → { reads: [{ file, count, chars }], reruns: [{ tool, inputHash, count, gapCalls }] }
function countLargeResults(entries, { window = SIGNAL_WINDOW, minChars = LARGE_RESULT_CHARS } = {})  // → number
function agentReturns(entries, { window = SIGNAL_WINDOW } = {})   // → { count, chars }
function duplicateReadsPhrase(duplicates)            // 'dup reads: src/a.js ×3 (~30k tokens)' or ''
function renderDuplicateReadsBlock(duplicates, { stablePrefix })  // '**Duplicate reads (drop all but the latest):**' list or ''
function agentReturnsPhrase(agentReturns)            // 'agents: 2 returns ~15k tokens' or '' (below 20,000 chars)
function largeReadDelegationLine(n)   // exact copy, see Task 22
```
`analyzeShape` result gains `duplicates`, `largeResults`, `agentReturns`; `draftMessage` and `formatCompactInjection` call the phrase/render helpers (one line each) so `lib/context-shape.js` grows by at most 10 lines over this plan.

`lib/constraint-registry.js`:
```js
/** @typedef {'Action'|'Information'|'Process'|'Preference'|'Output'} ConstraintType */
/** @typedef {{ type: ConstraintType, text: string, source: 'key-decisions'|'on-compact'|'compact-instructions' }} ConstraintItem */
/** @typedef {{ items: ConstraintItem[], truncated: boolean, sources: string[] }} ConstraintRegistry */
const CONSTRAINT_TYPES = ['Action','Information','Process','Preference','Output'];
const MAX_ITEMS = 25, MAX_ITEM_CHARS = 200, MAX_BLOCK_CHARS = 3000;
function classifyConstraint(text)                 // → ConstraintType (order of checks: Action, Output, Process, Preference, else Information)
function extractCompactInstructions(claudeMdText) // bullets under any heading matching /^#{1,6}\s*compact instructions/i up to the next heading
function buildRegistry({ sections, claudeMdText }) // sections = parseSessionContext(); reads 'Key Decisions' and 'On Compact' via sectionByTitle
function renderRegistryBlock(registry)            // '' when empty; heading '## CONSTRAINT REGISTRY (must survive compaction)'; lines `- [Action] text`
function registryStatePath(sessionId)             // ~/.claude/state/claude-constraints-<sid>.json
function writeRegistryState(sessionId, data), readRegistryState(sessionId)
function retentionOf(items, summary)              // → { total, retained, ratio, missing: string[] }
```
An item is retained when the summary (lower-cased, whitespace-collapsed) contains the item's normalized text, or at least 60 % of the item's distinct words of ≥ 4 characters appear in it.

`lib/hook-output.js`:
```js
const HOOK_OUTPUT_CAP_CHARS = 10000;
/** @typedef {{ name: string, text: string, required?: boolean }} OutputBlock */
function assembleUnderCap(blocks, { maxChars = HOOK_OUTPUT_CAP_CHARS } = {})  // → { text, dropped: string[], chars, overCap }
```
Keeps order; drops optional blocks from the end until under the cap; if required blocks alone exceed it, truncates the joined required text to `maxChars - 16` and appends `\n…[truncated]\n`, `overCap: true`.

`hooks/hooks.json` additions:
```json
"PreToolUse":  [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/si-prune-output.js", "timeout": 5 }] }],
"PostCompact": [{ "matcher": "*",    "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/si-post-compact.js", "timeout": 5 }] }]
```

`compact_outcomes` table: `id, sid, project, t, compact_t, trigger, summary_chars, constraints_total, constraints_retained, retention REAL, missing TEXT (JSON), fill_before REAL, fill_after REAL, context_cap INTEGER, model TEXT`. `cache_hits`: `id, sid, t, model, message_id, ratio REAL, cache_read, cache_creation, context_tokens`, `UNIQUE(sid, message_id)`. `tool_reruns`: `id, sid, t, tool, input_hash, gap_calls, was_pruned INTEGER`.

### Modified files (by task)

Task 1 `statusline/statusline-intel.js:610-636,1163,1443` · Task 2 `lib/events.js:86-247,640-867` · Task 3 `lib/events-migrations.js`, `lib/events.js:286-330,655-676`, `tools/stats.js:370-385` · Task 4 `lib/utils.js:181-212`, `statusline-intel.js:318-360,1982-1998` · Task 5 `hooks/si-suggest-compact.js:168-192,434-449`, `hooks/si-stop.js:139-145` · Task 6 `hooks/si-pre-compact.js:689-770`, `hooks/si-token-budget.js:66-67,111-145` · Task 7 `lib/compact-history.js:153-253`, `statusline-intel.js:1966-1979`, `si-suggest-compact.js:230-238` · Task 8 `lib/config.js:72-81,553-569`, `si-token-budget.js:308-352`, `si-suggest-compact.js:218-229`, `statusline-intel.js:1153-1173`, `README.md:52-61` · Tasks 9–10 `lib/config.js:274-291,350-428`, `hooks/si-post-tool.js:17-49`, `hooks/si-tool-archive.js:12-15`, `lib/tool-archive.js:20-23`, `hooks/hooks.json` · Task 12 `si-token-budget.js:220-242`, `lib/context-shape.js:602-781,790-892` · Tasks 13–15 `hooks/si-pre-compact.js:571-636`, `lib/handoff.js:192-257,398-447` · Task 16 `hooks/hooks.json`, `docs/context-engineering.md:458` · Task 17 `si-suggest-compact.js:361-403`, `lib/config.js:131-140` · Task 18 `lib/compact-history.js:211-228`, `hooks/si-task-change.js:520-544`, `lib/tips.js:16-37` · Task 19 `lib/cost-estimation.js:38-88` · Task 20 `hooks/si-doctor.js:109-186`, `statusline-intel.js:1440-1452`, `README.md` · Task 21 `hooks/si-bootstrap.js:858-989`, `si-suggest-compact.js` · Task 22 `si-token-budget.js:220-242`, `hooks/si-agent-tracker.js:95-111`, `lib/tips.js:22-26`, `README.md` · Task 23 `lib/events.js:286-330,348-380,655-661`, `hooks/si-bootstrap.js:904-911`, `tools/stats.js:377`.

---

## Tier 1 — Fix the ruler

### Task 1: Shared context-cap resolver (`lib/context-cap.js`)

**Files:**
- Create: `lib/context-cap.js`
- Modify: `statusline/statusline-intel.js:610-636` (delete local `contextCap`; call the lib), `:1163` and `:1443` (callers)
- Test: `tests/context-cap.test.js`

**Interfaces:**
- Consumes: nothing new (lifts `statusline-intel.js:624-636`).
- Produces: `resolveContextCap`, `resolveAutoCompactPoint`, `loadSettingsForCwd`, `isNative1M`, `fillPctOf`, `bucketPct`, `windowLabel`, constants — as locked above.

- [ ] **Step 1: Write the failing tests**

```js
test('resolveContextCap: config override beats everything', () =>
  assert.deepEqual(resolveContextCap({ model: 'claude-opus-5-5', env: {}, configCap: 150000 }), { cap: 150000, source: 'config' }));
test('resolveContextCap: statusline context_window_size beats model id', () =>
  assert.deepEqual(resolveContextCap({ model: 'claude-opus-5-5', env: {}, contextWindowSize: 200000 }), { cap: 200000, source: 'statusline' }));
test('resolveContextCap: CLAUDE_CODE_DISABLE_1M_CONTEXT=1 holds a 1M model to 200000', () =>
  assert.deepEqual(resolveContextCap({ model: 'claude-fable-5-1', env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' } }), { cap: 200000, source: 'env-disable-1m' }));
test('resolveContextCap: CLAUDE_CODE_MAX_CONTEXT_TOKENS applies to unrecognised ids only', () => {
  assert.deepEqual(resolveContextCap({ model: 'gateway-custom-7', env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '400000' } }), { cap: 400000, source: 'env-max-context' });
  assert.equal(resolveContextCap({ model: 'claude-opus-5-5', env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '400000' } }).cap, 1000000);
  assert.equal(resolveContextCap({ model: 'claude-opus-5-5', env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '400000', DISABLE_COMPACT: '1' } }).cap, 400000);
});
test('isNative1M follows the documented list', () => {
  for (const id of ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-4-7', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'Opus 5.5', 'claude-opus-4-6[1m]']) assert.equal(isNative1M(id), true, id);
  for (const id of ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', '']) assert.equal(isNative1M(id), false, id);
});
test('resolveContextCap: unknown id falls back to 200000', () =>
  assert.deepEqual(resolveContextCap({ model: 'mystery', env: {} }), { cap: 200000, source: 'fallback' }));
test('resolveAutoCompactPoint precedence env > modelSettings > settings > default', () => {
  const settings = { autoCompactWindow: 300000, modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 450000 } } };
  assert.deepEqual(resolveAutoCompactPoint({ cap: 1000000, model: 'claude-opus-5-5', env: {}, settings: null }), { point: 967000, source: 'default' });
  assert.deepEqual(resolveAutoCompactPoint({ cap: 200000, model: 'claude-opus-5-5', env: {}, settings: null }), { point: 200000, source: 'default' });
  assert.deepEqual(resolveAutoCompactPoint({ cap: 1000000, model: 'claude-opus-5-5', env: {}, settings }), { point: 450000, source: 'model-settings' });
  assert.deepEqual(resolveAutoCompactPoint({ cap: 1000000, model: 'claude-opus-5-5', env: {}, settings: { modelSettings: { opus: { autoCompactWindow: 420000 } } } }), { point: 420000, source: 'model-settings' }, 'family alias key');
  assert.deepEqual(resolveAutoCompactPoint({ cap: 1000000, model: 'claude-fable-5-1', env: {}, settings }), { point: 300000, source: 'settings' });
  assert.deepEqual(resolveAutoCompactPoint({ cap: 1000000, model: 'claude-opus-5-5', env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' }, settings }), { point: 500000, source: 'env' });
  assert.equal(resolveAutoCompactPoint({ cap: 1000000, model: 'x', env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50' } }).point, 483500);
  assert.equal(resolveAutoCompactPoint({ cap: 200000, model: 'x', env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '900000' } }).point, 200000, 'clamped to cap');
});
test('fillPctOf / bucketPct / windowLabel', () => {
  assert.equal(fillPctOf(480000, 1000000), 48);
  assert.equal(fillPctOf(123456, 1000000), 12.3);
  assert.equal(fillPctOf(100, 0), 0);
  assert.equal(bucketPct(48.9), 45);
  assert.equal(bucketPct(50), 50);
  assert.equal(windowLabel(1000000), '1M');
  assert.equal(windowLabel(200000), '200k');
});
test('loadSettingsForCwd merges user then project then local', () => { /* temp HOME + temp cwd with .claude/settings.json {autoCompactWindow:300000} and settings.local.json {autoCompactWindow:250000}; assert 250000 */ });
```

- [ ] **Step 2: Run `node --test tests/context-cap.test.js`** — Expected: FAIL, `Cannot find module '../lib/context-cap'`.

- [ ] **Step 3: Implement `lib/context-cap.js`** with the locked signatures and precedence. `isNative1M` regex: `/\[1m\]|-1m\b|\b1m\b|1000k|1000000/i` or `/fable|mythos|opus[\s-]?(4[\s.-]?[7-9]|[5-9])|sonnet[\s-]?[5-9]|haiku[\s-]?5[\s.-]?5/i`. `loadSettingsForCwd` reads with `JSON.parse` in try/catch per file, returns a new merged object.

- [ ] **Step 4: Run `node --test tests/context-cap.test.js`** — Expected: PASS.

- [ ] **Step 5: Replace `contextCap(input, cfg)` in `statusline-intel.js`** with a two-line shim calling `resolveContextCap({ model: input.model && (input.model.id || input.model.display_name), env: process.env, contextWindowSize: input.context_window && input.context_window.context_window_size, configCap: cfg.contextCap })`.cap, loaded through the existing `resolveLibDir()` (fallback 200000 when the lib is unavailable). Net line count of the statusline must not grow.

- [ ] **Step 6: Run `npm test && npm run test:node22`** — Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/context-cap.js tests/context-cap.test.js statusline/statusline-intel.js
git commit -m "feat(si): lift context-cap resolver into lib/context-cap.js with env precedence"
```

### Task 2: Split schema/migrations and readers out of `lib/events.js`

**Files:**
- Create: `lib/events-migrations.js`, `lib/events-stats.js`
- Modify: `lib/events.js:86-247` (replace `initSchema` with `require('./events-migrations').initSchema(db)`), `:640-867` (`aggregateStats`/`listRecentCompacts` become `(opts) => require('./events-stats').aggregateStats(openDb(), opts)` wrappers that return `null`/`[]` when the DB is unavailable)
- Test: `tests/events-migrations.test.js`

**Interfaces:**
- Consumes: `openDatabase` from `lib/sqlite-driver.js`; `priceForModel`, `costFromUsage` from `lib/cost-estimation.js`.
- Produces: `SCHEMA_VERSION` (2 after this task), `initSchema(db)`, `runMigrations(db) → { from, to }`, `repriceAgentInvocations(db) → count`, `GUARDED_ADD_COLUMNS` (the six `agent_invocations` ALTERs); `events-stats.aggregateStats(db, opts)`, `events-stats.listRecentCompacts(db, opts)`. Public names on `lib/events.js` are unchanged.

- [ ] **Step 1: Write the failing tests**

```js
test('initSchema lands on SCHEMA_VERSION and runMigrations is idempotent', () => {
  events._setDbPathForTest(dbPath); assert.equal(events.isAvailable(), true); events._resetForTest();
  const raw = openDatabase(dbPath).db;
  assert.equal(raw.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  assert.deepEqual(runMigrations(raw), { from: SCHEMA_VERSION, to: SCHEMA_VERSION });
  raw.pragma('user_version = 0');
  assert.deepEqual(runMigrations(raw), { from: 0, to: SCHEMA_VERSION });
  raw.close();
});
test('repriceAgentInvocations reprices rows with model+tokens and skips token-less rows', () => { /* same fixture as events.test.js "user_version 2 migration": cost 15.0 → 5.0, token-less 9.99 untouched */ });
test('events-stats.aggregateStats(db) matches events.aggregateStats(opts) on the same DB', () => { /* seed one session + one compact; deepEqual the two results */ });
test('lib/events.js stays under 800 lines after the split', () => {
  const lines = fs.readFileSync(path.join(__dirname, '..', 'lib', 'events.js'), 'utf8').split('\n').length;
  assert.ok(lines < 800, `events.js is ${lines} lines`);
});
```

- [ ] **Step 2: Run `node --test tests/events-migrations.test.js`** — Expected: FAIL (modules missing).

- [ ] **Step 3: Move `lib/events.js:86-247` into `lib/events-migrations.js`** (`initSchema`, `migrateV1`, `migrateV2` calling `repriceAgentInvocations`, each migration in its own try/catch) and `lib/events.js:640-867` into `lib/events-stats.js` with a leading `db` parameter; leave the wrappers in `events.js`.

- [ ] **Step 4: Run `npm test && npm run test:node22`** — Expected: PASS, with the existing `events.test.js` migration and stats tests unchanged.

- [ ] **Step 5: Commit** — `git commit -m "fix(si): split events schema/migrations and readers out of lib/events.js (file-size rule)"`

### Task 3: Schema v3 — fill columns on compacts and zone transitions

**Files:**
- Modify: `lib/events-migrations.js` (add `migrateV3`, `SCHEMA_VERSION = 3`), `lib/events.js:286-330` (writers), `lib/events-stats.js` (readers), `tools/stats.js:370-385` (`renderCompacts`)
- Test: `tests/events.test.js` (append)

**Interfaces:**
- Consumes: Task 2 `runMigrations`.
- Produces: `recordCompact`/`recordZoneTransition` accept `contextCap, fillPct, model, trigger`; `aggregateStats()` returns `compactFill: { auto: { n, p50 }, manual: { n, p50 } }` and `listRecentCompacts` rows include `fill_pct, context_cap, model`; stats renders `Fill at compact (auto p50 / manual p50)`.

- [ ] **Step 1: Write the failing tests**

```js
test('v3 migration adds fill columns to a user_version 2 DB and leaves old rows NULL', () => {
  // seed: open, insert compacts(sid,t,tokens) + zone_transitions(sid,t,to_zone), set user_version = 2, close; reopen via events
  const cols = (table) => verify.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  assert.ok(['context_cap', 'fill_pct', 'model'].every((c) => cols('compacts').includes(c)));
  assert.ok(['context_cap', 'fill_pct', 'model', 'trigger'].every((c) => cols('zone_transitions').includes(c)));
  assert.equal(verify.prepare('SELECT fill_pct FROM compacts').get().fill_pct, null);
  assert.ok(verify.pragma('user_version', { simple: true }) >= 3);
});
test('v3 migration from user_version 0 runs v1, v2 and v3 in one open', () => { /* seed uv 0 with disagreeing project keys as in the existing test; assert project backfilled AND fill columns present */ });
test('recordCompact stores contextCap/fillPct/model; aggregateStats splits fill p50 by trigger', () => {
  events.recordCompact({ sid: 's1', project: 'p', t: now, tokens: 480000, contextCap: 1000000, fillPct: 48, model: 'claude-opus-5-5', trigger: 'auto' });
  events.recordCompact({ sid: 's1', project: 'p', t: now + 1, tokens: 300000, contextCap: 1000000, fillPct: 30, model: 'claude-opus-5-5', trigger: 'manual' });
  const s = events.aggregateStats({ sinceDays: 30 });
  assert.deepEqual(s.compactFill, { auto: { n: 1, p50: 48 }, manual: { n: 1, p50: 30 } });
  assert.equal(events.listRecentCompacts({ limit: 1 })[0].fill_pct, 30);
});
test('recordZoneTransition stores contextCap/fillPct/model/trigger', () => {
  events.recordZoneTransition({ sid: 's1', project: 'p', fromZone: 'green', toZone: 'yellow', tokens: 210000, reason: 'crossing', contextCap: 1000000, fillPct: 21, model: 'claude-fable-5-1', trigger: 'Read' });
  const row = verify.prepare('SELECT context_cap, fill_pct, model, trigger FROM zone_transitions').get();
  assert.deepEqual(row, { context_cap: 1000000, fill_pct: 21, model: 'claude-fable-5-1', trigger: 'Read' });
});
```

- [ ] **Step 2: Run `node --test tests/events.test.js`** — Expected: FAIL on the four new tests.

- [ ] **Step 3: Implement** `migrateV3` (guarded `ALTER TABLE ... ADD COLUMN` × 7, then `user_version = 3`), extend the two writers (NULL when not finite), add `compactFill` to `aggregateStats` (JS percentile over `SELECT fill_pct, trigger FROM compacts WHERE t >= ? AND fill_pct IS NOT NULL`), add `fill_pct, context_cap, model` to both compact SELECTs, and the stats row.

- [ ] **Step 4: Run `npm test && npm run test:node22`** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(si): schema v3 — context_cap/fill_pct/model/trigger on compacts and zone rows"`

### Task 4: Latest-usage reader with offset cache (`lib/transcript-usage.js`)

**Files:**
- Create: `lib/transcript-usage.js`
- Modify: `lib/utils.js:181-212` (`readTranscriptTokens` delegates), `statusline/statusline-intel.js:318-346` (delete local `readTranscriptUsage`; call the lib), `:1982-1998` (use `readLatestUsage(...).usage`)
- Test: `tests/transcript-usage.test.js`

**Interfaces:**
- Consumes: `getStateDir` from `lib/utils.js`.
- Produces: `readLatestUsage`, `usageCachePath`, `peakPath`, `updatePeak`, `readPeak`, `TAIL_CHUNK_BYTES`, `MAX_BACKWARD_CHUNKS` as locked.

- [ ] **Step 1: Write the failing tests** (write transcripts with `fs.writeFileSync` as in `tests/cost-estimation.test.js`; point `HOME` at a temp dir before `require`)

```js
test('readLatestUsage returns the last assistant usage with model and messageId', () => {
  const u = readLatestUsage(p, { sessionId: 'tu-1' });
  assert.equal(u.contextTokens, 1000 + 5000 + 100000);
  assert.equal(u.model, 'claude-opus-5-5'); assert.equal(u.messageId, 'msg_B'); assert.equal(u.source, 'transcript');
});
test('readLatestUsage returns null when the transcript has no usage line at all', () => {
  // lines: {type:'user'}, {type:'file-history-snapshot'}
  assert.equal(readLatestUsage(p, { sessionId: 'tu-none' }), null);
});
test('readLatestUsage finds the usage line behind a single 1.5 MB tool result (beyond the old 512 KB tail)', () => {
  // usage line, then a user line whose content is 'x'.repeat(1.5 * 1024 * 1024)
  assert.equal(readLatestUsage(p, { sessionId: 'tu-big' }).contextTokens, 250000);
});
test('readLatestUsage serves the cache when new bytes carry no usage, and advances the offset', () => {
  const a = readLatestUsage(p, { sessionId: 'tu-cache' }); fs.appendFileSync(p, JSON.stringify({ type: 'user' }) + '\n');
  const b = readLatestUsage(p, { sessionId: 'tu-cache' });
  assert.equal(b.contextTokens, a.contextTokens); assert.equal(b.source, 'cache');
  assert.equal(JSON.parse(fs.readFileSync(usageCachePath('tu-cache'), 'utf8')).offset, fs.statSync(p).size);
});
test('readLatestUsage restarts from 0 when the file shrank', () => { /* truncate file after caching; assert new value, source transcript */ });
test('readLatestUsage returns the cache when the transcript path is missing', () => { /* cache written, then unlink file → cached value, source cache */ });
test('updatePeak keeps the max and readPeak returns null when unset', () => {
  assert.equal(readPeak('tu-peak'), null); assert.equal(updatePeak('tu-peak', 100), 100); assert.equal(updatePeak('tu-peak', 50), 100); assert.equal(readPeak('tu-peak'), 100);
});
test('utils.readTranscriptTokens still returns 0 for a missing file and the contextTokens otherwise', () => { ... });
```

- [ ] **Step 2: Run `node --test tests/transcript-usage.test.js`** — Expected: FAIL (module missing).

- [ ] **Step 3: Implement `lib/transcript-usage.js`.** Algorithm (the signature and tests do not determine it): read cache; if `stat.size < cache.offset` reset offset to 0; read bytes `[offset, size)`, keep only complete lines (up to the last `\n`), walk forward remembering the last line with `message.usage` (`d.message.model`, `d.message.id`, `d.timestamp`); if found, write cache with the new offset and return `source: 'transcript'`; if not found and a cache exists, advance `offset` and return the cached value with `source: 'cache'`; if not found and no cache, scan backwards from EOF in `TAIL_CHUNK_BYTES` chunks up to `MAX_BACKWARD_CHUNKS`, re-joining the boundary line, and return the last usage found (caching it) or `null`. Never throw; every fs call in try/catch.

- [ ] **Step 4: Run `node --test tests/transcript-usage.test.js`** — Expected: PASS.

- [ ] **Step 5: Wire `lib/utils.js` and the statusline.** `readTranscriptTokens(transcriptPath, opts)` → wrapper. In the statusline replace `readTranscriptUsage(transcriptPath)` with `readLatestUsage(transcriptPath, { sessionId })` from the lib (`usage = latest && latest.usage`), keeping `totalTokensFromUsage`.

- [ ] **Step 6: Run `npm test && npm run test:node22`** — Expected: PASS.

- [ ] **Step 7: Commit** — `git commit -m "feat(si): offset-cached latest-usage reader replaces 512KB tail scan"`

### Task 5: Remove the estimate fallback from zone decisions; stamp zone rows with fill

**Files:**
- Modify: `hooks/si-suggest-compact.js:168-192` (token source), `:434-449` (zone row), `hooks/si-stop.js:139-145` (peak)
- Test: `tests/suggest-compact.test.js` (new; spawn pattern from `tests/agent-tracker.test.js`)

**Interfaces:**
- Consumes: `readLatestUsage`, `updatePeak`, `readPeak` (Task 4); `resolveContextCap`, `loadSettingsForCwd`, `fillPctOf` (Task 1); `recordZoneTransition` with new fields (Task 3).
- Produces: suggest-compact `tokenSource` is `'transcript' | 'cache' | 'none'` (never `'estimate'`); `~/.claude/state/claude-context-peak-<sid>` written on every call with usage; `sessions.peak_tokens` = that peak.

- [ ] **Step 1: Write the failing tests** (helper `runHook(hookFile, payload, { home })` with sandbox HOME; transcript fixtures written under the sandbox; zones at defaults so 210,000 contextTokens crosses yellow at the 1M cap)

```js
test('no callout and no zone row when the transcript has no usage, even with a 3,000,000 estimate file', () => {
  // write ~/.claude/state/claude-token-budget-<sid> = '3000000'; transcript with only user lines
  const r = runHook('si-suggest-compact.js', { session_id: sid, transcript_path: t, cwd, tool_name: 'Read' });
  assert.equal(r.status, 0); assert.equal(r.stderr.includes('[StrategicCompact]'), false);
  assert.equal(zoneRows(home, sid).length, 0);
});
test('yellow crossing records contextCap/fillPct/model/trigger on the zone row and writes the peak file', () => {
  // transcript: assistant usage input 10000 + cache_creation 0 + cache_read 200000, model claude-opus-5-5
  const r = runHook('si-suggest-compact.js', { session_id: sid, transcript_path: t, cwd, tool_name: 'Read' });
  assert.equal(r.status, 2);
  const row = zoneRows(home, sid)[0];
  assert.deepEqual({ ...row }, { to_zone: 'yellow', tokens: 210000, context_cap: 1000000, fill_pct: 21, model: 'claude-opus-5-5', trigger: 'Read' });
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'state', `claude-context-peak-${sid}`), 'utf8').trim(), '210000');
});
test('si-stop reports peak_tokens from the peak file, not the cumulative estimate', () => {
  // seed peak file 210000 and budget file 3000000; run si-stop with a sessions row present
  assert.equal(sessionRow(home, sid).peak_tokens, 210000);
});
```

- [ ] **Step 2: Run `node --test tests/suggest-compact.test.js`** — Expected: FAIL (first test sees a red callout from the estimate; row fields missing).

- [ ] **Step 3: Implement.** In suggest-compact replace lines 174-190 with `const latest = readLatestUsage(transcriptPath, { sessionId })`; `tokenBudget = latest ? latest.contextTokens : 0`; `tokenSource = latest ? latest.source : 'none'`; delete the budget-file read. Resolve `cap = resolveContextCap({ model: latest && latest.model, env: process.env, settings: loadSettingsForCwd(stdinCwd), configCap: fullCfg.statusline && fullCfg.statusline.contextCap }).cap` and `fillPct = fillPctOf(tokenBudget, cap)`; call `updatePeak(sessionId, tokenBudget)` whenever `tokenBudget > 0`; pass `contextCap: cap, fillPct, model: latest && latest.model, trigger: stdinInput.tool_name || null` to `recordZoneTransition` and add `fillPct, cap, model` to the `'zone feedback'` intel log. In `si-stop.js:139-145` read `readPeak(safeSid)` instead of the budget file.

- [ ] **Step 4: Run `node --test tests/suggest-compact.test.js`** then `npm test && npm run test:node22` — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "fix(si): zone decisions read the transcript only; zone rows carry fill%, cap, model"`

### Task 6: Unit unification — compact rows, history and snapshot carry `contextTokens`

**Files:**
- Create: `lib/compact-record.js`
- Modify: `hooks/si-pre-compact.js:689-770` (replace the inline history/DB/snapshot literals with one `buildCompactRecord` call — net shrink), `hooks/si-token-budget.js:66-67,111-145` (3 chars/token, rename), `lib/compact-history.js` (JSDoc for new entry fields only)
- Test: `tests/compact-record.test.js`, `tests/agent-tracker.test.js` (append one token-budget assertion)

**Interfaces:**
- Consumes: Task 4 `readLatestUsage`; Task 1 cap helpers; Task 3 `recordCompact` fields.
- Produces: `buildCompactRecord(...)` as locked in File Structure (`dbRow` is the exact `recordCompact` argument; `snapshot` carries `t, tokens, contextCap, fillPct, cost, hotDirs, warmDirs, droppedDirs, callsSince: 0, regretHits: [], softRegretHits: [], positiveHits: []`); token-budget writes `toolIoEstimate` with `CHARS_PER_TOKEN = 3`.

- [ ] **Step 1: Write the failing tests**

```js
test('buildCompactRecord stamps contextTokens as `tokens`, plus cap/fill/model/trigger and the estimate as toolIoEstimate', () => {
  const latest = { contextTokens: 480000, model: 'claude-fable-5-1', usage: {}, source: 'transcript' };
  const entries = [{ t: 1, tok: 1580000, tool: 'Read', root: 'src', file: 'src/a.js', event: null }];
  const { historyEntry, dbRow, snapshot } = buildCompactRecord({ latest, cap: 1000000, entries, trigger: 'auto', cwd: '/r', sessionId: 's', cost: 1.5, costAtCompactUsd: null, analysis: null });
  assert.equal(historyEntry.tokens, 480000); assert.equal(historyEntry.contextTokens, 480000);
  assert.equal(historyEntry.contextCap, 1000000); assert.equal(historyEntry.fillPct, 48);
  assert.equal(historyEntry.model, 'claude-fable-5-1'); assert.equal(historyEntry.trigger, 'auto');
  assert.equal(historyEntry.toolIoEstimate, 1580000);
  assert.equal(dbRow.tokens, 480000); assert.equal(dbRow.fillPct, 48);
  assert.equal(snapshot.tokens, 480000); assert.equal(snapshot.contextCap, 1000000); assert.equal(snapshot.callsSince, 0);
});
test('buildCompactRecord with no usage stamps tokens 0 and fillPct 0 (never the estimate)', () => {
  const { historyEntry } = buildCompactRecord({ latest: null, cap: 1000000, entries, trigger: 'manual', ... });
  assert.equal(historyEntry.tokens, 0); assert.equal(historyEntry.fillPct, 0); assert.equal(historyEntry.toolIoEstimate, 1580000);
});
// agent-tracker.test.js: a 3,000-char tool_output adds ceil(3000/3)+100 = 1100 to the budget file (was 850 at 4 chars/token)
```

- [ ] **Step 2: Run the two test files** — Expected: FAIL (module missing; budget delta 850).

- [ ] **Step 3: Implement** `lib/compact-record.js` (pure; returns new objects) and call it from `si-pre-compact.js:693-770` with `latest = readLatestUsage(stdinInput.transcript_path, { sessionId })` and `cap` from `resolveContextCap({ model: latest && latest.model, env: process.env, settings: loadSettingsForCwd(cwd), configCap: siCfg.statusline && siCfg.statusline.contextCap })`. In `si-token-budget.js` set `CHARS_PER_TOKEN = 3`, rename log meta `cumulative` → `toolIoEstimate`, and update the header comment (lines 11-16) to say the estimate is a tool-I/O share diagnostic, not context size.

- [ ] **Step 4: Run `npm test && npm run test:node22`** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "fix(si): compact rows and history use per-call contextTokens; estimate recalibrated to 3 chars/token"`

### Task 7: Learner reads fill % instead of the cumulative estimate

**Files:**
- Modify: `lib/compact-history.js:153-253`, `statusline/statusline-intel.js:1966-1979` (pass `cap`), `hooks/si-suggest-compact.js:230-238` (pass `cap`)
- Test: `tests/compact-history.test.js` (append)

**Interfaces:**
- Consumes: history entries with `fillPct` (Task 6); `cap` from callers (Task 1/5).
- Produces: `adaptiveZones(history, defaults, { cwd, cap, currentCost })` → `{ yellow, orange, red, adaptive, bucket, sampleCount, p50Fill, p90Fill, regretRate, costTightened, reason? }`; entries without finite `fillPct > 0` are ignored; `reason: 'no-cap' | 'insufficient-fill-samples'` when not adaptive; `YELLOW_GAP_FRACTION = 0.08`, `RED_GAP_FRACTION = 0.06` exported under `_thresholds`.

- [ ] **Step 1: Write the failing tests**

```js
test('adaptiveZones learns from fillPct × cap and ignores legacy cumulative entries', () => {
  for (const f of [20, 25, 30, 35, 40]) compactHistory.appendHistory(fakeEntry({ fillPct: f, contextCap: 1000000, tokens: f * 10000 }));
  for (let i = 0; i < 5; i++) compactHistory.appendHistory(fakeEntry({ tokens: 1580000 })); // legacy, no fillPct
  const z = compactHistory.adaptiveZones(compactHistory.readHistory(), { yellow: 200000, orange: 300000, red: 400000 }, { cap: 1000000 });
  assert.equal(z.adaptive, true); assert.equal(z.sampleCount, 5);
  assert.equal(z.orange, 270000);   // round(p50 30% × 0.9 × 1M)
  assert.equal(z.yellow, 190000);   // max(140000, 270000 − 0.08 × 1M)
  assert.equal(z.red, 440000);      // max(270000 + 0.06 × 1M, min(520000, round(p90 40% × 1.1 × 1M)))
});
test('adaptiveZones is not adaptive with fewer than 5 fillPct entries even when tokens are present', () => {
  for (let i = 0; i < 6; i++) compactHistory.appendHistory(fakeEntry({ tokens: 250000 }));
  const z = compactHistory.adaptiveZones(compactHistory.readHistory(), defaults, { cap: 1000000 });
  assert.equal(z.adaptive, false); assert.equal(z.reason, 'insufficient-fill-samples');
});
test('adaptiveZones returns the defaults with reason no-cap when cap is missing', () => { assert.equal(compactHistory.adaptiveZones(history, defaults, {}).reason, 'no-cap'); });
test('adaptiveZones scales the same fill history to a 200K cap', () => {
  for (const f of [20, 25, 30, 35, 40]) compactHistory.appendHistory(fakeEntry({ fillPct: f, contextCap: 200000, tokens: f * 2000 }));
  const z = compactHistory.adaptiveZones(compactHistory.readHistory(), { yellow: 40000, orange: 60000, red: 80000 }, { cap: 200000 });
  assert.equal(z.orange, 54000);  // round(30% × 0.9 × 200K), inside the clamp [42000, 78000]
  assert.equal(z.yellow, 38000);  // max(28000, 54000 − 0.08 × 200K)
  assert.equal(z.red, 88000);     // max(54000 + 0.06 × 200K, min(104000, round(40% × 1.1 × 200K)))
});
```
(Existing cost-tightening tests must still pass; update their `fakeEntry` calls to include `fillPct: 25, contextCap: 1000000` and pass `cap: 1000000`.)

- [ ] **Step 2: Run `node --test tests/compact-history.test.js`** — Expected: FAIL.

- [ ] **Step 3: Implement** in `adaptiveZones`: `samples = workingHistory.filter(h => Number.isFinite(h.fillPct) && h.fillPct > 0)`; percentiles over `fillPct`; `orangeTarget = Math.round(p.p50 / 100 * cap * 0.9)`, `red` target `Math.round(p.p90 / 100 * cap * 1.1)`; `yellow = max(round(base.yellow × 0.7), orange − round(0.08 × cap))`, `red = max(orange + round(0.06 × cap), min(round(base.red × 1.3), redTarget))`; everything else unchanged. Callers: statusline passes `cap` from `resolveContextCap({ contextWindowSize, model, configCap })`, suggest-compact passes the `cap` computed in Task 5.

- [ ] **Step 4: Run `npm test && npm run test:node22`** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "fix(si): adaptive zones learn from fill% of the window, not the cumulative estimate"`

### Task 8: Zones as fractions of the window; delete the token-budget duplicate

**Files:**
- Modify: `lib/config.js:72-81` (defaults), `:350-428` (env), `:553-569` (`getZoneThresholds`), `hooks/si-token-budget.js:308-352` (delete zone messages + `DEFAULT_ZONES` + `resolveZones` + `getZone`), `hooks/si-suggest-compact.js:218-229`, `statusline/statusline-intel.js:1153-1173` (zones via `getZoneThresholds(cfg, { cap })`), `README.md:52-61`, `tests/README.md` (remove the "token budget zone resolution" bullet)
- Test: `tests/config.test.js` (append), `tests/agent-tracker.test.js` (append)

**Interfaces:**
- Consumes: Task 1 `resolveContextCap`.
- Produces: `getZoneThresholds(cfg, { cap })` → `{ yellow, orange, red, mode, cap }`; config keys `statusline.zoneMode`, `statusline.zoneFractions`, `statusline.contextCap`; env `CLAUDE_SI_ZONE_MODE`.

- [ ] **Step 1: Write the failing tests**

```js
test('DEFAULTS ship zoneMode fraction with 0.20/0.30/0.40', () => {
  assert.equal(DEFAULTS.statusline.zoneMode, 'fraction');
  assert.deepEqual(DEFAULTS.statusline.zoneFractions, { yellow: 0.20, orange: 0.30, red: 0.40 });
});
test('getZoneThresholds: fractions × cap give today\'s absolutes on 1M and scale on 200K', () => {
  assert.deepEqual(getZoneThresholds({}, { cap: 1000000 }), { yellow: 200000, orange: 300000, red: 400000, mode: 'fraction', cap: 1000000 });
  const cap200 = resolveContextCap({ model: 'claude-opus-5-5', env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' } }).cap;
  assert.deepEqual(getZoneThresholds({}, { cap: cap200 }), { yellow: 40000, orange: 60000, red: 80000, mode: 'fraction', cap: 200000 });
});
test('getZoneThresholds: absolute mode honours statusline.zones verbatim', () => {
  const cfg = { statusline: { zoneMode: 'absolute', zones: { yellow: 150000, orange: 250000, red: 350000 } } };
  assert.deepEqual(getZoneThresholds(cfg, { cap: 200000 }), { yellow: 150000, orange: 250000, red: 350000, mode: 'absolute', cap: 200000 });
});
test('getZoneThresholds assumes 1M when cap is omitted', () => assert.equal(getZoneThresholds({}).cap, 1000000));
test('CLAUDE_SI_ZONE_MODE=absolute overrides config', () => { /* set env, loadConfig(), assert zoneMode absolute, restore env */ });
// agent-tracker.test.js: si-token-budget with a 3,000,000 pre-seeded budget file writes NO '[TokenBudget]' line to stderr
```

- [ ] **Step 2: Run the two test files** — Expected: FAIL.

- [ ] **Step 3: Implement.** `getZoneThresholds(cfg, opts)` returns a new object; fraction mode reads `cfg.statusline.zoneFractions` with the 0.20/0.30/0.40 fallback. Delete `si-token-budget.js:308-352` (the hook no longer emits zone messages; the zone owner is suggest-compact) and its `log` import if unused. suggest-compact and statusline call `getZoneThresholds(fullCfg, { cap })`. README "Token Zones" table becomes fraction-based with the sentence: "No official degradation point exists for Claude 5; these fractions are calibrated to the Opus 4.6 evidence and Claude Code's own API defaults of 100K for clearing and 150K for compaction. Set `statusline.zoneMode: "absolute"` to keep fixed token thresholds."

- [ ] **Step 4: Run `npm test && npm run test:node22`** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(si): zones are fractions of the resolved window (0.20/0.30/0.40); drop duplicate zone logic"`

- [ ] **Step 6: Sync the live plugin (end of Tier 1)**

Run: `npm run sync && ls ~/.claude/plugins/cache/session-intelligence/session-intelligence/1.0.0/lib/context-cap.js ~/.claude/plugins/cache/session-intelligence/session-intelligence/1.0.0/lib/transcript-usage.js`
Expected: both paths listed; then in a live Claude Code session confirm `grep -c 'tokenSource.*estimate' ~/.claude/logs/session-intel-$(date +%F).log` prints `0` after a few tool calls.

---

## Tier 2 — Pruner

### Task 9: Pure prune decisions (`lib/prune.js`) and the `prune` config block

**Files:**
- Create: `lib/prune.js`
- Modify: `lib/config.js:274-291` (add `prune` block after `toolArchive`), `:350-428` (env `CLAUDE_SI_PRUNE`, `CLAUDE_SI_PRUNE_FLOOR`)
- Test: `tests/prune.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `decidePrune`, `buildExcerpt`, `rewriteCommand`, `inputHash`, `DEFAULT_INPUT_RULES` as locked; `DEFAULTS.prune` as locked.

- [ ] **Step 1: Write the failing tests**

```js
const cfg = DEFAULTS.prune;
test('DEFAULTS.prune floor is 50000 chars with 2000/1500 head/tail', () => {
  assert.equal(cfg.outputFloorChars, 50000); assert.equal(cfg.headChars, 2000); assert.equal(cfg.tailChars, 1500);
  assert.deepEqual(cfg.tools, ['Read', 'Bash', 'Grep', 'Glob', 'WebFetch']);
});
test('decidePrune prunes a 60000-char Read and leaves 49999 chars alone', () => {
  const big = decidePrune({ toolName: 'Read', toolUseId: 'toolu_01ABC', body: 'a'.repeat(60000), cfg });
  assert.equal(big.pruned, true); assert.equal(big.originalChars, 60000); assert.ok(big.output.length < 4000);
  assert.deepEqual(decidePrune({ toolName: 'Read', toolUseId: 'toolu_x', body: 'a'.repeat(49999), cfg }), { pruned: false, reason: 'below-floor' });
});
test('decidePrune never touches a non-string (JSON) result', () =>
  assert.deepEqual(decidePrune({ toolName: 'mcp__x__y', toolUseId: 'toolu_j', body: { content: [{ type: 'text', text: 'z'.repeat(70000) }] }, cfg }), { pruned: false, reason: 'not-string' }));
test('decidePrune respects tools allowlist, enabled flag and missing id', () => {
  assert.equal(decidePrune({ toolName: 'Edit', toolUseId: 'toolu_e', body: 'a'.repeat(60000), cfg }).reason, 'tool-excluded');
  assert.equal(decidePrune({ toolName: 'Read', toolUseId: 'toolu_e', body: 'a'.repeat(60000), cfg: { ...cfg, enabled: false } }).reason, 'disabled');
  assert.equal(decidePrune({ toolName: 'Read', toolUseId: null, body: 'a'.repeat(60000), cfg }).reason, 'no-id');
});
test('buildExcerpt carries head, tail, omitted count and the /si expand hint', () => {
  const body = 'H'.repeat(2000) + 'M'.repeat(96500) + 'T'.repeat(1500);
  const out = buildExcerpt(body, { headChars: 2000, tailChars: 1500, archiveId: 'toolu_01ABC', toolName: 'Read', originalChars: body.length });
  assert.ok(out.startsWith('[SI pruned: Read result 100,000 chars → '));
  assert.match(out, /run `\/si expand toolu_01ABC` to replay it verbatim\.\]/);
  assert.match(out, /…\[96,500 chars omitted\]…/);
  assert.ok(out.includes('H'.repeat(2000)) && out.endsWith('T'.repeat(1500)));
});
test('rewriteCommand filters test runners with Anthropic\'s grep/head shape and names the rule', () => {
  const r = rewriteCommand('npm test');
  assert.equal(r.rule, 'test-runner');
  assert.equal(r.command, "npm test 2>&1 | grep -E -A 5 '(FAIL|ERROR|error:|not ok|# fail|# pass|passed|failed)' | head -100");
  assert.equal(rewriteCommand('cat server.log').command, 'cat server.log | tail -n 200');
});
test('rewriteCommand leaves redirects, existing filters, multi-line and unrelated commands alone', () => {
  for (const c of ['npm test > out.txt', 'npm test 2>&1 | tail -50', 'npm test\necho done', 'git status']) assert.deepEqual(rewriteCommand(c), { command: c, rule: null });
});
test('inputHash is stable across key order and 16 hex chars', () => {
  assert.equal(inputHash('Read', { file_path: '/a', limit: 5 }), inputHash('Read', { limit: 5, file_path: '/a' }));
  assert.match(inputHash('Bash', { command: 'ls' }), /^[0-9a-f]{16}$/);
});
```

- [ ] **Step 2: Run `node --test tests/prune.test.js`** — Expected: FAIL (module missing).

- [ ] **Step 3: Implement `lib/prune.js`** and the config block + env overrides (`CLAUDE_SI_PRUNE=0` → `enabled false`; `CLAUDE_SI_PRUNE_FLOOR` integer 1..10,485,760 → `outputFloorChars`). Number formatting in the excerpt uses `toLocaleString('en-US')`.

- [ ] **Step 4: Run `node --test tests/prune.test.js` and `node --test tests/config.test.js`** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(si): prune decisions lib — 50K-char floor excerpt and test-runner rewrite rules"`

### Task 10: `hooks/si-prune-output.js` + dispatcher stdout path + PreToolUse registration

**Files:**
- Create: `hooks/si-prune-output.js`
- Modify: `hooks/si-post-tool.js:17-49`, `hooks/hooks.json` (PreToolUse entry), `hooks/si-tool-archive.js:12-15` and `lib/tool-archive.js:20-23` (replace "Observational only" paragraphs with: "Archive first, prune second: `si-prune-output.js` only replaces results whose full body is already on disk here"), `lib/events-migrations.js` (guarded `tool_archives.pruned`), `lib/events.js` (`markArchivePruned`), `lib/events-stats.js` (`archives.pruned` in `aggregateStats`), `tools/stats.js` archive section (`Pruned N`)
- Test: `tests/prune-hook.test.js` (spawn), `tests/hooks-config.test.js` (append), `tests/events.test.js` (append)

**Interfaces:**
- Consumes: Task 9 `decidePrune`/`rewriteCommand`; `toolArchive.extractFromPayload`, `readArchive`, `writeArchive`.
- Produces: hook stdout JSON exactly as locked; dispatcher merge behaviour as locked; `events.markArchivePruned(toolUseId)`; `aggregateStats().archives.pruned`.

- [ ] **Step 1: Write the failing tests**

```js
test('PostToolUse: a 60000-char Read result is replaced by an excerpt and the archive is marked pruned', () => {
  const r = runHook('si-prune-output.js', { hook_event_name: 'PostToolUse', session_id: sid, tool_name: 'Read', tool_use_id: 'toolu_01', tool_input: { file_path: '/x' }, tool_response: 'a'.repeat(60000) });
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.ok(out.hookSpecificOutput.updatedToolOutput.startsWith('[SI pruned: Read result 60,000 chars'));
  assert.ok(r.stdout.length < 10000);
  assert.equal(toolArchive.readArchive(sid, 'toolu_01').chars, 60000, 'full body archived before pruning');
  assert.equal(archiveRow(home, 'toolu_01').pruned, 1);
});
test('PostToolUse: object (JSON) tool_response produces no stdout', () => {
  const r = runHook('si-prune-output.js', { hook_event_name: 'PostToolUse', session_id: sid, tool_name: 'mcp__x__y', tool_use_id: 'toolu_02', tool_response: { content: [{ type: 'text', text: 'z'.repeat(70000) }] } });
  assert.equal(r.status, 0); assert.equal(r.stdout, '');
});
test('PostToolUse: below-floor result produces no stdout', () => { /* 49999 chars → stdout '' */ });
test('PreToolUse: npm test is rewritten via updatedInput with no permissionDecision', () => {
  const r = runHook('si-prune-output.js', { hook_event_name: 'PreToolUse', session_id: sid, tool_name: 'Bash', tool_input: { command: 'npm test', description: 'run tests' } });
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.updatedInput.command, "npm test 2>&1 | grep -E -A 5 '(FAIL|ERROR|error:|not ok|# fail|# pass|passed|failed)' | head -100");
  assert.equal(out.hookSpecificOutput.updatedInput.description, 'run tests');
  assert.equal('permissionDecision' in out.hookSpecificOutput, false);
});
test('PreToolUse: run_in_background commands and non-Bash tools are left alone', () => { /* stdout '' for { command:'npm test', run_in_background:true } and for tool_name 'Read' */ });
test('dispatcher forwards the prune JSON on stdout and exits 0', () => {
  const r = runHook('si-post-tool.js', { ...sixtyKReadPayload, transcript_path: '' });
  assert.equal(r.status, 0); assert.ok(JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput);
});
test('dispatcher merges a zone callout into additionalContext when prune and crossing coincide', () => {
  // transcript with usage 210000 on a 1M model + 60K Read payload
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.ok(out.updatedToolOutput); assert.match(out.additionalContext, /\[StrategicCompact\]/); assert.doesNotMatch(out.additionalContext, /\x1b\[/);
  assert.equal(r.status, 0);
});
test('dispatcher still propagates exit 2 with stderr when nothing was pruned', () => { /* small payload + 210000 usage → status 2, stderr has [StrategicCompact], stdout '' */ });
// hooks-config.test.js: PreToolUse registers si-prune-output.js with matcher 'Bash' and a numeric timeout
```

- [ ] **Step 2: Run the three test files** — Expected: FAIL.

- [ ] **Step 3: Implement.** `si-prune-output.js`: read stdin JSON; branch on `payload.hook_event_name`. PostToolUse: `extractFromPayload`, pass the *raw* `tool_response` (not stringified) as `body` so objects are rejected; on `pruned`, ensure `readArchive(sid, id)` exists else `writeArchive(...)` (skip pruning if the write fails), `events.markArchivePruned(id)`, `intelLog('prune','info','pruned tool output', { id, tool, originalChars, excerptChars })`, write the JSON. PreToolUse: only `tool_name === 'Bash'`, not `run_in_background`, `cfg.prune.rewriteInput !== false`; emit `updatedInput` as `{ ...tool_input, command }` (new object). Dispatcher: spawn prune with `stdio: ['pipe','pipe','inherit']`, suggest-compact with `stdio: ['pipe','ignore','pipe']`, merge as locked (strip ANSI with `/\x1b\[[0-9;]*m/g`), and cap the merged `additionalContext` at 9,000 chars.

- [ ] **Step 4: Run `npm test && npm run test:node22`** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(si): PostToolUse updatedToolOutput pruner + PreToolUse updatedInput rewrite; dispatcher forwards hook JSON"`

### Task 11: Re-run counter and duplicate-read detection (`lib/shape-signals.js`)

**Files:**
- Create: `lib/shape-signals.js`
- Modify: `hooks/si-token-budget.js:220-242` (entries gain `chars`, `inputHash`; append when `root || event || chars >= 4096`; record reruns), `lib/context-shape.js:602-781` (`analyzeShape` returns `duplicates`, `largeResults`, `agentReturns` by calling the lib), `:790-807` (`draftMessage` appends `duplicateReadsPhrase(analysis.duplicates)`), `:814-892` (`formatCompactInjection` appends `renderDuplicateReadsBlock(analysis.duplicates, { stablePrefix })`) — at most 10 lines added to `context-shape.js` in total, `lib/events-migrations.js` (`tool_reruns` table), `lib/events.js` (`recordRerun`), `lib/events-stats.js` (`aggregateStats().reruns`), `tools/stats.js` archive section (`Re-runs (same tool+input ≤20 calls) N`)
- Test: `tests/shape-signals.test.js`, `tests/context-shape.test.js` (append), `tests/events.test.js` (append)

**Interfaces:**
- Consumes: Task 9 `inputHash`.
- Produces: `detectDuplicates`, `countLargeResults`, `agentReturns` as locked; shape entry shape `{ t, tok, tool, root, file, event, chars, inputHash }`; `events.recordRerun`.

- [ ] **Step 1: Write the failing tests**

```js
test('detectDuplicates finds repeated Reads of one path within the window', () => {
  const e = [...Array(3)].map((_, i) => ({ t: i, tok: 1000 * i, tool: 'Read', root: 'src', file: 'src/a.js', chars: 30000, inputHash: 'h1' }));
  const d = detectDuplicates(e);
  assert.deepEqual(d.reads, [{ file: 'src/a.js', count: 3, chars: 90000 }]);
});
test('detectDuplicates reports same-input re-runs within 20 calls but not beyond', () => {
  const run = (i, hash) => ({ t: i, tok: i, tool: 'Bash', root: null, file: null, chars: 500, inputHash: hash });
  const near = [run(0, 'x'), ...[...Array(10)].map((_, i) => run(i + 1, `o${i}`)), run(11, 'x')];
  assert.deepEqual(detectDuplicates(near).reruns, [{ tool: 'Bash', inputHash: 'x', count: 2, gapCalls: 11 }]);
  const far = [run(0, 'x'), ...[...Array(25)].map((_, i) => run(i + 1, `o${i}`)), run(26, 'x')];
  assert.deepEqual(detectDuplicates(far, { window: 40 }).reruns, []);
});
test('countLargeResults counts results ≥ 60000 chars in the last 40 entries', () => {
  const e = [...Array(50)].map((_, i) => ({ t: i, tok: i, tool: 'Read', root: 'src', chars: i % 10 === 0 ? 70000 : 100 }));
  assert.equal(countLargeResults(e), 4); // indices 10,20,30,40 fall in the last-40 window; 0 does not
});
test('agentReturns sums Agent entry chars', () => assert.deepEqual(agentReturns([{ tool: 'Agent', chars: 20000 }, { tool: 'Agent', chars: 5000 }, { tool: 'Read', chars: 9 }]), { count: 2, chars: 25000 }));
test('phrase and block renderers', () => {
  const d = { reads: [{ file: 'src/a.js', count: 3, chars: 90000 }], reruns: [] };
  assert.equal(duplicateReadsPhrase(d), 'dup reads: src/a.js ×3 (~30k tokens)');
  assert.equal(duplicateReadsPhrase({ reads: [], reruns: [] }), '');
  assert.match(renderDuplicateReadsBlock(d, { stablePrefix: false }), /\*\*Duplicate reads \(drop all but the latest\):\*\*\n- src\/a\.js ×3 \(~30k tokens\)/);
  assert.equal(renderDuplicateReadsBlock(d, { stablePrefix: true }).includes('30k'), false, 'stable mode omits the volatile size');
  assert.equal(agentReturnsPhrase({ count: 2, chars: 45000 }), 'agents: 2 returns ~15k tokens');
  assert.equal(agentReturnsPhrase({ count: 1, chars: 19999 }), '');
});
// context-shape.test.js: analyzeShape(entries with 3 duplicate reads).duplicates.reads[0].count === 3; draftMessage includes 'dup reads: src/a.js ×3'; formatCompactInjection includes '**Duplicate reads (drop all but the latest):**'
// events.test.js: recordRerun({ sid, t, tool:'Bash', inputHash:'x', gapCalls: 11, wasPruned: false }) → aggregateStats().reruns.n === 1
```

- [ ] **Step 2: Run the three test files** — Expected: FAIL.

- [ ] **Step 3: Implement** the lib (pure functions over the last `window` entries; duplicates keyed by `file` for `Read`, re-runs keyed by `inputHash` with `gapCalls` = index distance to the previous occurrence, counted only when `≤ rerunGap`). In token-budget compute `chars = outputStr.length`, `inputHash = inputHash(toolName, toolInput)`, and after `appendShape` call `detectDuplicates(readShape(sessionId, 40))`; when the newest entry is a rerun, `events.recordRerun({ ..., wasPruned: chars >= cfg.prune.outputFloorChars })`.

- [ ] **Step 4: Run `npm test && npm run test:node22`** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(si): detect duplicate reads and same-input re-runs in the shape log"`

### Task 12: Shape signals in the callout and the PreCompact drop list; Tier 2 sync

**Files:**
- Modify: `hooks/si-suggest-compact.js:374-376` (after `Observed:` push `Duplicate reads: <file> ×N — later reads add no information; prefer the latest copy.` for each `shape.duplicates.reads` entry, max 3), `hooks/si-pre-compact.js` (nothing new — `formatCompactInjection` from Task 11 already renders the list)
- Test: `tests/suggest-compact.test.js` (append)

**Interfaces:**
- Consumes: Task 11 `analyzeShape().duplicates`.
- Produces: callout body line exact copy above.

- [ ] **Step 1: Write the failing test**

```js
test('yellow callout names duplicate reads from the shape log', () => {
  // seed ~/.claude/state/claude-ctx-shape-<sid>.jsonl with 3 Read entries of src/a.js (chars 30000) + 5 other roots; usage 210000
  assert.match(r.stderr, /Duplicate reads: src\/a\.js ×3 — later reads add no information; prefer the latest copy\./);
});
```

- [ ] **Step 2: Run it** — Expected: FAIL. **Step 3: Implement** the body line. **Step 4: Run `npm test && npm run test:node22`** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(si): name duplicate reads in the zone callout"`

- [ ] **Step 6: Sync the live plugin (end of Tier 2)**

Run: `npm run sync && ls ~/.claude/plugins/cache/session-intelligence/session-intelligence/1.0.0/hooks/si-prune-output.js && grep -c '"PreToolUse"' ~/.claude/plugins/cache/session-intelligence/session-intelligence/1.0.0/hooks/hooks.json`
Expected: path listed and `1`. Then in a live session run a Bash `npm test` and confirm the permission prompt shows the rewritten command (this is the one behaviour the docs do not pin: `updatedInput` applying without `permissionDecision`). If the prompt shows the original command, record the finding in `session-context.md` Key Decisions and set `prune.rewriteInput: false` in the defaults before continuing.

---

## Tier 3 — Compaction

### Task 13: Typed constraint registry (`lib/constraint-registry.js`)

**Files:**
- Create: `lib/constraint-registry.js`
- Test: `tests/constraint-registry.test.js`

**Interfaces:**
- Consumes: `parseSessionContext`, `sectionByTitle` from `lib/session-context.js` (export `sectionByTitle`; it is currently module-private at `lib/session-context.js:91-99`); `getStateDir` from `lib/utils.js`.
- Produces: everything locked for this module.

- [ ] **Step 1: Write the failing tests**

```js
test('classifyConstraint maps the five types', () => {
  assert.equal(classifyConstraint('Never rewrite earlier transcript turns'), 'Action');
  assert.equal(classifyConstraint('Respond with JSON only'), 'Output');
  assert.equal(classifyConstraint('Run npm test before every commit'), 'Process');
  assert.equal(classifyConstraint('Prefer rsync over cp for cache refresh'), 'Preference');
  assert.equal(classifyConstraint('The events DB lives at ~/.claude/state/si-events.db'), 'Information');
});
test('buildRegistry reads Key Decisions, On Compact and CLAUDE.md compact instructions with sources', () => {
  const sections = parseSessionContext('## Key Decisions\n- Never rewrite earlier turns\n\n## On Compact\nPRESERVE: the pruner floor is 50000\n');
  const claudeMd = '# Compact instructions\n- Keep the test matrix green on Node 20 and 22\n\n# Other\n- ignored\n';
  const reg = buildRegistry({ sections, claudeMdText: claudeMd });
  assert.equal(reg.items.length, 3); assert.equal(reg.truncated, false);
  assert.deepEqual(reg.items.map((i) => i.source), ['key-decisions', 'on-compact', 'compact-instructions']);
  assert.deepEqual(reg.sources, ['key-decisions', 'on-compact', 'compact-instructions']);
});
test('buildRegistry caps at 25 items and 200 chars per item and flags truncation', () => {
  const sections = parseSessionContext('## Key Decisions\n' + [...Array(30)].map((_, i) => `- rule ${i} ${'x'.repeat(300)}`).join('\n'));
  const reg = buildRegistry({ sections, claudeMdText: '' });
  assert.equal(reg.items.length, 25); assert.equal(reg.truncated, true); assert.ok(reg.items.every((i) => i.text.length <= 200));
});
test('renderRegistryBlock emits typed lines under the heading and stays under 3000 chars', () => {
  const out = renderRegistryBlock(reg);
  assert.match(out, /^\n## CONSTRAINT REGISTRY \(must survive compaction\)\n/);
  assert.match(out, /- \[Action\] Never rewrite earlier turns/);
  assert.ok(out.length <= 3000); assert.equal(renderRegistryBlock({ items: [], truncated: false, sources: [] }), '');
});
test('retentionOf matches normalized substrings and ≥60% word overlap', () => {
  const items = [{ type: 'Action', text: 'Never rewrite earlier transcript turns' }, { type: 'Process', text: 'Run npm test before every commit' }, { type: 'Information', text: 'Pruner floor is fifty thousand chars' }];
  const summary = 'The plugin must NEVER   rewrite earlier transcript turns. Before each commit the tests (npm test) are run.';
  assert.deepEqual(retentionOf(items, summary), { total: 3, retained: 2, ratio: 0.67, missing: ['Pruner floor is fifty thousand chars'] });
});
test('write/readRegistryState round-trips under ~/.claude/state', () => { /* temp HOME; write { t, items }; read equals; path matches /claude-constraints-<sid>\.json$/ */ });
```

- [ ] **Step 2: Run `node --test tests/constraint-registry.test.js`** — Expected: FAIL.

- [ ] **Step 3: Implement** with the classification order Action → Output → Process → Preference → Information using these regexes: Action `/^(never|always|must|do not|don't|avoid|only|no )\b|\b(never|always|must not|must)\b/i`; Output `/\b(output|format|respond|reply|answer|print|render|report)\b/i` and `/\b(as|in|with|using)\b/i`; Process `/\b(before|after|then|first|whenever|every time|workflow|step)\b/i`; Preference `/\b(prefer|favou?r)\b|\buse\b.*\b(over|instead of|not)\b/i`. Bullets and `KEY:` lines under the sections become items (placeholder lines already stripped by `parseSessionContext`). `ratio` rounded to 2 decimals.

- [ ] **Step 4: Run the test file** — Expected: PASS. **Step 5: Commit** — `git commit -m "feat(si): typed constraint registry from session-context and CLAUDE.md compact instructions"`

### Task 14: PreCompact emits the registry first under a 10,000-char cap (`lib/hook-output.js`)

**Files:**
- Create: `lib/hook-output.js`
- Modify: `hooks/si-pre-compact.js:571-636` (replace the eight `emit` calls with one `assembleUnderCap` call), `:675-682` (NEXT footer joins the block list as optional), plus registry build + state write before the history block
- Test: `tests/hook-output.test.js`, `tests/pre-compact.test.js` (append, spawn-style)

**Interfaces:**
- Consumes: Task 13 registry; Task 6 `latest`/`cap`/`fillPct`.
- Produces: `assembleUnderCap` as locked; PreCompact block order `['registry'(required), 'hints', 'shape', 'memoryOffload', 'priorities', 'memoryCleanup', 'gitNexus', 'tip', 'archiveRecall', 'next']`; state file `claude-constraints-<sid>.json` = `{ t, items, contextTokens, contextCap, fillPct, model, trigger }` written on every PreCompact; intel log `'pre-compact','info','block assembled', { chars, dropped, overCap }`.

- [ ] **Step 1: Write the failing tests**

```js
test('assembleUnderCap keeps order and drops optional blocks from the end until under 10000', () => {
  const blocks = [{ name: 'registry', text: 'R'.repeat(500), required: true }, { name: 'hints', text: 'H'.repeat(3000) }, { name: 'shape', text: 'S'.repeat(12000) }, { name: 'tip', text: 'T'.repeat(100) }];
  const out = assembleUnderCap(blocks);
  assert.deepEqual(out.dropped, ['tip', 'shape']); assert.equal(out.overCap, false);
  assert.ok(out.chars < 10000); assert.ok(out.text.startsWith('R'.repeat(500)));
});
test('assembleUnderCap truncates when required blocks alone exceed the cap', () => {
  const out = assembleUnderCap([{ name: 'registry', text: 'R'.repeat(12000), required: true }]);
  assert.equal(out.overCap, true); assert.ok(out.chars <= 10000); assert.ok(out.text.endsWith('…[truncated]\n'));
});
test('assembleUnderCap returns empty text for empty blocks', () => assert.deepEqual(assembleUnderCap([]), { text: '', dropped: [], chars: 0, overCap: false }));
// pre-compact.test.js (spawn with sandbox HOME, project dir seeded with session-context.md Key Decisions, transcript with usage 480000):
test('PreCompact prints the registry before every other section, exits 0, never blocks', () => {
  assert.equal(r.status, 0); assert.doesNotMatch(r.stdout, /"decision"/);
  assert.ok(r.stdout.indexOf('## CONSTRAINT REGISTRY') < r.stdout.indexOf('## COMPACTION GUIDANCE'));
  assert.ok(r.stdout.length < 10000);
  const state = JSON.parse(fs.readFileSync(registryStatePath(sid), 'utf8'));
  assert.equal(state.items[0].text, 'Never rewrite earlier turns'); assert.equal(state.fillPct, 48); assert.equal(state.trigger, 'manual');
});
```

- [ ] **Step 2: Run both test files** — Expected: FAIL.

- [ ] **Step 3: Implement.** In pre-compact: `registry = buildRegistry({ sections, claudeMdText: readFile(path.join(cwd, 'CLAUDE.md')) || '' })`; `writeRegistryState(sessionId, { t: Date.now(), items: registry.items, contextTokens, contextCap: cap, fillPct, model, trigger: stdinInput.trigger || null })`; build the ordered block list, `const { text, dropped, chars, overCap } = assembleUnderCap(blocks)`; `process.stdout.write('\n# Session Intelligence — compaction guidance\n' + text)` when `text` is non-empty; keep the per-block `log('[PreCompact] Injected …')` stderr lines. The stablePrefix fingerprint input (line 645) becomes `text` minus the registry block. `si-pre-compact.js` must not exceed its current 836 lines (the replaced emit sequence is ~60 lines).

- [ ] **Step 4: Run `npm test && npm run test:node22`** — Expected: PASS. **Step 5: Commit** — `git commit -m "feat(si): constraint registry leads the PreCompact block; hook output assembled under the 10K cap"`

### Task 15: Re-inject constraints through the SessionStart `compact` handoff

**Files:**
- Modify: `lib/handoff.js:192-257` (`writeHandoff` gains `constraints`; strong-signal gate includes them), `:398-447` (`renderHandoffBlock` renders them), `hooks/si-pre-compact.js:779-791` (pass `constraints: registry.items`)
- Test: `tests/handoff.test.js` (append)

**Interfaces:**
- Consumes: `ConstraintItem[]` (Task 13).
- Produces: handoff JSON field `constraints: ConstraintItem[]`; rendered section header `Standing constraints (re-injected after compact — these survive regardless of the summary):` followed by `  - [Type] text` lines; `writeHandoff({ ..., constraints })` returns true when constraints are the only signal.

- [ ] **Step 1: Write the failing tests**

```js
test('writeHandoff writes when constraints are the only strong signal', () => {
  const wrote = handoff.writeHandoff({ projectDir: dir, cwd: dir, sessionId: 's', constraints: [{ type: 'Action', text: 'Never rewrite earlier turns', source: 'key-decisions' }] });
  assert.equal(wrote, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.si-handoff.json'), 'utf8')).constraints[0].type, 'Action');
});
test('renderHandoffBlock lists constraints before the current task', () => {
  const out = handoff.renderHandoffBlock({ t: Date.now(), currentTask: 'Refactor auth', constraints: [{ type: 'Process', text: 'Run npm test before every commit' }] });
  assert.ok(out.indexOf('Standing constraints (re-injected after compact') < out.indexOf('Current task'));
  assert.match(out, /  - \[Process\] Run npm test before every commit/);
});
test('renderHandoffBlock without constraints is unchanged', () => assert.doesNotMatch(handoff.renderHandoffBlock({ currentTask: 'x' }), /Standing constraints/));
```

- [ ] **Step 2: Run `node --test tests/handoff.test.js`** — Expected: FAIL. **Step 3: Implement** (new handoff object; `hasStrongSignal = currentTaskFresh || nextPriorities.length > 0 || constraints.length > 0`). **Step 4: Run `npm test && npm run test:node22`** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(si): re-inject the constraint registry through the SessionStart compact handoff"`

### Task 16: PostCompact hook — retention and fill telemetry; Tier 3 sync

**Files:**
- Create: `hooks/si-post-compact.js`
- Modify: `hooks/hooks.json` (PostCompact entry), `lib/events-migrations.js` (`compact_outcomes` table), `lib/events.js` (`recordCompactOutcome`, `stampCompactOutcomeAfter`), `lib/events-stats.js` (`aggregateStats().outcomes`), `hooks/si-token-budget.js:278-303` (after the one-shot cache-hit measurement call `events.stampCompactOutcomeAfter({ sid: sessionId, compactT: snap.t, fillAfter: fillPctOf(contextTokensOf(u), snap.contextCap) })`), `tools/stats.js` (new `COMPACT OUTCOMES` section: count, mean retention, mean summary chars, fill before auto/manual, fill after), `docs/context-engineering.md:458` (replace the sentence with: "Claude Code has exposed a PostCompact hook since v2.1.76; `hooks/si-post-compact.js` reads `compact_summary` and records constraint retention — the regret proxy below remains as the behavioural signal.")
- Test: `tests/post-compact.test.js` (spawn), `tests/events.test.js` (append), `tests/hooks-config.test.js` (append)

**Interfaces:**
- Consumes: Task 13 `readRegistryState`, `retentionOf`; Task 3 columns.
- Produces: `events.recordCompactOutcome(...)`, `events.stampCompactOutcomeAfter(...)` as locked; `aggregateStats().outcomes = { n, avg_retention, avg_summary_chars, avg_fill_before_auto, avg_fill_before_manual, avg_fill_after }`.

- [ ] **Step 1: Write the failing tests**

```js
test('si-post-compact records retention against the registry state and the trigger', () => {
  writeRegistryState(sid, { t: 1000, items: [{ type: 'Action', text: 'Never rewrite earlier turns' }, { type: 'Process', text: 'Run npm test before every commit' }], contextTokens: 480000, contextCap: 1000000, fillPct: 48, model: 'claude-opus-5-5', trigger: 'auto' });
  const r = runHook('si-post-compact.js', { hook_event_name: 'PostCompact', session_id: sid, cwd, trigger: 'auto', compact_summary: 'Summary: the plugin must never rewrite earlier turns. ' + 'x'.repeat(100) });
  assert.equal(r.status, 0); assert.equal(r.stdout, '');
  const row = outcomeRow(home, sid);
  assert.equal(row.constraints_total, 2); assert.equal(row.constraints_retained, 1); assert.equal(row.retention, 0.5);
  assert.equal(row.fill_before, 48); assert.equal(row.compact_t, 1000); assert.equal(row.trigger, 'auto');
  assert.equal(row.summary_chars, 154); assert.deepEqual(JSON.parse(row.missing), ['Run npm test before every commit']);
});
test('si-post-compact without a registry state still records summary length with NULL retention', () => { /* no state file → constraints_total null, retention null, exit 0 */ });
test('stampCompactOutcomeAfter fills fill_after on the matching compact_t', () => {
  events.recordCompactOutcome({ sid: 's', t: 2000, compactT: 1000, trigger: 'manual', summaryChars: 10, fillBefore: 48 });
  events.stampCompactOutcomeAfter({ sid: 's', compactT: 1000, fillAfter: 9.5 });
  assert.equal(events.aggregateStats({ sinceDays: 30 }).outcomes.avg_fill_after, 9.5);
});
// hooks-config.test.js: PostCompact registers si-post-compact.js with matcher '*'
```

- [ ] **Step 2: Run the three test files** — Expected: FAIL. **Step 3: Implement** (hook reads stdin, never writes stdout, exits 0 on every path, logs `'post-compact','info','recorded', { retention, summaryChars, trigger }`). **Step 4: Run `npm test && npm run test:node22`** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(si): PostCompact hook records constraint retention, summary length and fill before/after"`

- [ ] **Step 6: Sync the live plugin (end of Tier 3)**

Run: `npm run sync && grep -c '"PostCompact"' ~/.claude/plugins/cache/session-intelligence/session-intelligence/1.0.0/hooks/hooks.json && ls ~/.claude/plugins/cache/session-intelligence/session-intelligence/1.0.0/lib/constraint-registry.js`
Expected: `1` and the path. After the next live `/compact`, `node tools/stats.js --days=1` shows a `COMPACT OUTCOMES` row with `n ≥ 1`.

---

## Tier 4 — Callout, pricing, doctor, cache, agents, telemetry

### Task 17: Numbers back in the model-visible callout; `stablePrefix` default off

**Files:**
- Modify: `hooks/si-suggest-compact.js:361-403` (headline + numbers line), `lib/config.js:131-140` (`stablePrefix: false`, `calloutBucketPct: 5`), `README.md:633` (stablePrefix paragraph: default now off)
- Test: `tests/suggest-compact.test.js` (append), `tests/config.test.js` (append)

**Interfaces:**
- Consumes: Task 1 `bucketPct`, `windowLabel`, `resolveAutoCompactPoint`; Task 11 `countLargeResults`.
- Produces: headline `[StrategicCompact] <zone label> — context at ~<bucketed>% of a <window> window; auto-compaction at ~<point>k (~<away>k away). Advisory only — continue if the task needs full context.` where `<away>` is `point − contextTokens` floored to a 50,000-token bucket (so the line changes at most every 50K tokens), followed, when `largeResults > 0`, by the body line `<n> tool results ≥20K tokens in the last 40 calls.` The `$ spent` segment is removed (cost no longer argues for timing on these models).

- [ ] **Step 1: Write the failing tests**

```js
test('DEFAULTS.compact.stablePrefix is false and calloutBucketPct is 5', () => { assert.equal(DEFAULTS.compact.stablePrefix, false); assert.equal(DEFAULTS.compact.calloutBucketPct, 5); });
test('callout headline carries bucketed fill, window label and auto-compaction point', () => {
  // usage 488000 on claude-opus-5-5, no autoCompactWindow configured
  assert.match(r.stderr, /\[StrategicCompact\] High-risk zone — context at ~45% of a 1M window; auto-compaction at ~967k \(~450k away\)\. Advisory only/);
  assert.doesNotMatch(r.stderr, /spent/);
});
test('callout says 200k window under CLAUDE_CODE_DISABLE_1M_CONTEXT=1 and names the configured window', () => {
  // env CLAUDE_CODE_DISABLE_1M_CONTEXT=1, CLAUDE_CODE_AUTO_COMPACT_WINDOW=150000, usage 45000 → yellow (40000 at 200k)
  assert.match(r.stderr, /\[StrategicCompact\] Caution zone — context at ~20% of a 200k window; auto-compaction at ~150k \(~100k away\)/);
});
test('callout counts large results from the shape log', () => { /* 3 entries with chars 70000 → body has '3 tool results ≥20K tokens in the last 40 calls.' */ });
test('stablePrefix=true still omits the numbers segment', () => { /* CLAUDE_COMPACT_STABLE_PREFIX=1 → headline has no '%' */ });
```

- [ ] **Step 2: Run both files** — Expected: FAIL. **Step 3: Implement** (`bucketed = bucketPct(fillPct, cfg.calloutBucketPct)`, point from `resolveAutoCompactPoint({ cap, model, env: process.env, settings })`, `away = Math.max(0, Math.floor((point − tokenBudget) / 50000) × 50000)`, `k` formatting via the existing `formatTokens`). **Step 4: Run `npm test && npm run test:node22`** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(si): callout states bucketed fill%, window and auto-compaction point; stablePrefix off by default"`

### Task 18: Fewer, boundary-aligned compactions — drop cost tightening, phase-marker moments, `/clear` handoff

**Files:**
- Modify: `lib/compact-history.js:211-228` (delete cost tightening; remove `costTightened` from the result and `currentCost` from opts), `hooks/si-suggest-compact.js:399-403` (delete the cost-tightened footnote) and after the diagnosis (phase line), `hooks/si-task-change.js:520-544` (write a handoff when recommending `/clear`), `lib/tips.js:27-31` (red tip 3 → "if the current topic is done, `/clear` is cheaper than another /compact — SI writes a handoff so the constraints and task survive the clear.")
- Test: `tests/compact-history.test.js` (replace the three cost-tightening tests), `tests/suggest-compact.test.js`, `tests/task-change.test.js` (append), `tests/tips.test.js` (append)

**Interfaces:**
- Consumes: `analysis.events` (phase markers) from `analyzeShape`; `handoff.writeHandoff` (Task 15 signature).
- Produces: `adaptiveZones` result has no `costTightened`; callout body line `A <commit|push|pr> just landed — natural compaction boundary; \`/compact\` now carries the least in-flight state.` when the newest phase event is within the last 5 shape entries; task-change calls `writeHandoff({ projectDir, cwd, sessionId, constraints })` before printing the `/clear` hint.

- [ ] **Step 1: Write the failing tests**

```js
test('adaptiveZones no longer tightens on cost', () => {
  for (const cost of [10, 20, 30, 40, 50]) compactHistory.appendHistory(fakeEntry({ fillPct: 25, contextCap: 1000000, cost }));
  const z = compactHistory.adaptiveZones(compactHistory.readHistory(), defaults, { cap: 1000000, currentCost: 500 });
  assert.equal('costTightened' in z, false); assert.equal(z.orange, 225000);
});
test('callout names a fresh phase marker as a compaction boundary', () => { /* last shape entry event:'commit' → body matches /A commit just landed — natural compaction boundary/ */ });
test('task-change writes a handoff before recommending /clear', () => { /* existing task-change spawn fixture with a different-domain prompt → .si-handoff.json exists in projectDir with constraints [] and currentTask */ });
test('red tip pool mentions the /clear handoff', () => assert.ok(TIP_POOLS.red.some((t) => /\/clear/.test(t) && /handoff/.test(t))));
```

- [ ] **Step 2: Run the four files** — Expected: FAIL. **Step 3: Implement.** **Step 4: Run `npm test && npm run test:node22`** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(si): drop cost-driven zone tightening; phase markers and /clear handoff steer boundary-aligned compaction"`

### Task 19: Claude 5 pricing table, tiered Haiku 5.5, 1h cache writes, schema v4 reprice

**Files:**
- Modify: `lib/cost-estimation.js:38-88` (`PRICING_BY_MODEL`, `tierFor`, `costFromUsage`), `lib/events-migrations.js` (`migrateV4` → `repriceAgentInvocations`, `SCHEMA_VERSION = 4`)
- Test: `tests/cost-estimation.test.js` (append), `tests/events-migrations.test.js` (append)

**Interfaces:**
- Consumes: Task 2 `repriceAgentInvocations`.
- Produces: rows `'claude-fable-5-1'` and `'claude-mythos-5-1'` `{ input: 10, cache_creation: 12.50, cache_creation_1h: 20, cache_read: 0.25, output: 50 }`; `'claude-opus-5-5'` `{ 4, 5, 8, 0.20, 20 }`; `'claude-sonnet-5-5'` `{ 2, 2.50, 4, 0.10, 10 }`; `'claude-haiku-5-5'` `{ tiers: [{ upToContextTokens: 100000, input: 0.10, cache_creation: 0.125, cache_creation_1h: 0.20, cache_read: 0.01, output: 0.50 }, { input: 0.50, cache_creation: 0.625, cache_creation_1h: 1, cache_read: 0.05, output: 2.50 }] }`; `tierFor(prices, contextTokens)` → flat price object; `costFromUsage(u, prices)` bills `u.cache_creation.ephemeral_1h_input_tokens` at `cache_creation_1h` (fallback `cache_creation × 1.6`) and the remainder of `cache_creation_input_tokens` at the 5m rate.

- [ ] **Step 1: Write the failing tests**

```js
test('Claude 5.5-era rows win over family prefixes', () => {
  assert.deepEqual(knownPriceForModel('claude-fable-5-1'), { input: 10, cache_creation: 12.50, cache_creation_1h: 20, cache_read: 0.25, output: 50 });
  assert.deepEqual(knownPriceForModel('claude-opus-5-5'), { input: 4, cache_creation: 5, cache_creation_1h: 8, cache_read: 0.20, output: 20 });
  assert.deepEqual(knownPriceForModel('claude-sonnet-5-5', Date.parse('2026-10-19')), { input: 2, cache_creation: 2.50, cache_creation_1h: 4, cache_read: 0.10, output: 10 });
  assert.equal(knownPriceForModel('claude-fable-5').cache_read, 1.00, 'Fable 5 row unchanged');
});
test('Haiku 5.5 tiers at 100,000 context tokens', () => {
  const p = knownPriceForModel('claude-haiku-5-5');
  assert.equal(costFromUsage({ input_tokens: 100000 }, p), 0.01);
  assert.ok(Math.abs(costFromUsage({ input_tokens: 100001 }, p) - 0.0500005) < 1e-9);
  assert.equal(tierFor(p, 50000).input, 0.10); assert.equal(tierFor(p, 150000).input, 0.50);
});
test('costFromUsage bills 1h cache writes at the 1h rate when the breakdown is present', () => {
  const p = knownPriceForModel('claude-fable-5-1');
  assert.equal(costFromUsage({ cache_creation_input_tokens: 1000000, cache_creation: { ephemeral_1h_input_tokens: 1000000, ephemeral_5m_input_tokens: 0 } }, p), 20);
  assert.equal(costFromUsage({ cache_creation_input_tokens: 1000000 }, p), 12.5);
  assert.equal(costFromUsage({ cache_creation_input_tokens: 1000000, cache_creation: { ephemeral_1h_input_tokens: 500000 } }, p), 16.25);
});
test('v4 migration reprices an Opus 5.5 agent row from the generic Opus rate', () => {
  // seed 1,000,000 input tokens model claude-opus-5-5 cost_usd 5.0 at user_version 3 → reopen → cost 4.0, user_version 4
});
```

- [ ] **Step 2: Run both files** — Expected: FAIL. **Step 3: Implement** (`knownPriceForModel` returns the tiered object unchanged; `costFromUsage` resolves the tier from the usage's own `input + cache_creation + cache_read`). **Step 4: Run `npm test && npm run test:node22`** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "fix(si): Claude 5.5-era pricing (Fable 5.1 cache read 0.25, Opus 5.5, Sonnet 5.5, tiered Haiku 5.5), 1h writes; schema v4 reprice"`

### Task 20: `/si doctor` window advice and statusline "% to compaction"

**Files:**
- Modify: `hooks/si-doctor.js:109-186` (new `Context window` section; accept `model` on stdin or `--model`), `statusline/statusline-intel.js:1440-1452` (`contextPct` against `resolveAutoCompactPoint`), `README.md` (`/si doctor` section at 440-444; `contextPct` row at 281; new "Recommended: autoCompactWindow on 1M models" subsection under Token Zones), `commands/si.md` doctor paragraph (mention the window check)
- Test: `tests/doctor.test.js` (spawn), `tests/statusline-contextpct.test.js` (spawn the statusline with fields `['contextPct']`)

**Interfaces:**
- Consumes: Task 1 `resolveContextCap`, `resolveAutoCompactPoint`, `loadSettingsForCwd`, `RECOMMENDED_AUTO_COMPACT`.
- Produces: doctor lines, exact copy: `  ✓ resolved cap  — 1,000,000 (model-id: claude-opus-5-5)` and, when no window is configured on a 1M cap, `  ! autoCompactWindow not set — Claude Code compacts this 1M model at ~967K; recommend 400000–500000 via \`/autocompact 450k\` (saved per model under modelSettings) or "autoCompactWindow": 450000 in ~/.claude/settings.json`; when configured, `  ✓ autoCompactWindow — 450000 (model-settings)`. Statusline `contextPct` renders `cmp:<pct>%` = `round(tokens / point × 100)` with the same colour bands.

- [ ] **Step 1: Write the failing tests**

```js
test('doctor recommends autoCompactWindow on a 1M model with no window configured', () => {
  const r = spawn(doctor, { session_id: sid, cwd, model: 'claude-opus-5-5' }, { HOME: home });
  assert.match(r.stdout, /resolved cap  — 1,000,000 \(model-id: claude-opus-5-5\)/);
  assert.match(r.stdout, /! autoCompactWindow not set — Claude Code compacts this 1M model at ~967K; recommend 400000–500000/);
});
test('doctor reports a configured window and its source', () => { /* ~/.claude/settings.json modelSettings → '✓ autoCompactWindow — 450000 (model-settings)' */ });
test('contextPct renders against the auto-compaction point, not the full window', () => {
  // transcript usage 450000, CLAUDE_CODE_AUTO_COMPACT_WINDOW=500000, fields ['contextPct'] → stdout contains 'cmp:90%'
});
```

- [ ] **Step 2: Run both files** — Expected: FAIL. **Step 3: Implement.** **Step 4: Run `npm test && npm run test:node22`** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(si): /si doctor recommends a per-model autoCompactWindow; contextPct measures distance to compaction"`

### Task 21: Cold-resume advice and per-turn cache-hit series

**Files:**
- Create: `lib/resume-advice.js`
- Modify: `hooks/si-bootstrap.js:974-989` (add `buildResumeCacheContext(input)` to the `emitAdditionalContext` parts — call site only), `hooks/si-suggest-compact.js` (after `readLatestUsage`, record the cache hit once per `messageId`), `lib/events-migrations.js` (`cache_hits` table + unique index), `lib/events.js` (`recordCacheHit`), `lib/events-stats.js` (`aggregateStats().cacheHits`), `tools/stats.js` (line `Cache hit (mean per model)` in the headline section)
- Test: `tests/resume-advice.test.js`, `tests/suggest-compact.test.js` (append), `tests/events.test.js` (append)

**Interfaces:**
- Consumes: SessionStart input fields `source`, `seconds_since_last_response`, `context_tokens`, `prompt_cache_likely_expired`, `estimated_cache_write_usd`; Task 4 `LatestUsage.messageId`; `cacheHitRatio` from `lib/cost-estimation.js`.
- Produces: `buildResumeCacheContext(input)` → `''` unless `source ∈ {resume, fork}` and `prompt_cache_likely_expired === true`; exact copy: `Resume notice: <N> min since the last response; the prompt cache has likely expired (estimated rebuild $<usd>). If the previous topic is finished, \`/clear\` costs nothing; \`/compact\` on a cold resume re-reads the whole prefix at the cache-write rate.`; `events.recordCacheHit` as locked (dedupe via `UNIQUE(sid, message_id)` + `INSERT OR IGNORE`); `aggregateStats().cacheHits = [{ model, n, avg_ratio }]`. No TTL timer is built.

- [ ] **Step 1: Write the failing tests**

```js
test('buildResumeCacheContext advises /clear on a cold resume', () => {
  const out = buildResumeCacheContext({ source: 'resume', seconds_since_last_response: 5400, context_tokens: 480000, prompt_cache_likely_expired: true, estimated_cache_write_usd: 6.25 });
  assert.equal(out, 'Resume notice: 90 min since the last response; the prompt cache has likely expired (estimated rebuild $6.25). If the previous topic is finished, `/clear` costs nothing; `/compact` on a cold resume re-reads the whole prefix at the cache-write rate.');
});
test('buildResumeCacheContext is silent for startup/compact/clear sources and warm resumes', () => {
  assert.equal(buildResumeCacheContext({ source: 'startup' }), '');
  assert.equal(buildResumeCacheContext({ source: 'resume', prompt_cache_likely_expired: false, seconds_since_last_response: 30 }), '');
  assert.equal(buildResumeCacheContext({ source: 'compact', prompt_cache_likely_expired: true }), '');
});
test('suggest-compact records one cache_hits row per message id', () => {
  // run twice on the same transcript (same msg id) → 1 row with ratio 200000/(200000+0) = 1 and model claude-opus-5-5
});
test('recordCacheHit ignores duplicates and aggregateStats averages per model', () => { /* two inserts same (sid, message_id) → n 1; ratios 0.5 and 1 on different ids → avg 0.75 */ });
```

- [ ] **Step 2: Run the three files** — Expected: FAIL. **Step 3: Implement** (`lastRecordedMessageId` stored in the usage cache file from Task 4 so the hook does not hit the DB on every call). **Step 4: Run `npm test && npm run test:node22`** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(si): cold-resume /clear advice from SessionStart cache fields; per-turn cache-hit series"`

### Task 22: Agent returns in the shape diagnosis and a concrete delegation prompt

**Files:**
- Modify: `hooks/si-token-budget.js:220-242` (append an entry for `tool_name ∈ {Agent, Task}` with `tool: 'Agent'`, `chars`, `root: null`; append condition becomes `root || event || isAgent || chars >= 4096`), `lib/context-shape.js:790-807` (`draftMessage` appends `agentReturnsPhrase(analysis.agentReturns)` — one line), `hooks/si-suggest-compact.js` (body line when `shape.largeResults >= 3`), `lib/tips.js:22-26` (orange tip 1 → `'delegate the next wide grep/read to a subagent (frontmatter \`autoCompactWindow: 400000\`) — keep the conclusion, not the output.'`), `hooks/si-agent-tracker.js:95-111` (no change; `responseChars` already recorded — the shape entry is the new feed), `README.md` (new "Subagent frontmatter" snippet showing `autoCompactWindow: 400000` with the note that the plugin ships no agents of its own, so the value is a recommendation for user-defined agents)
- Test: `tests/shape-signals.test.js` (append `largeReadDelegationLine`), `tests/context-shape.test.js` (append), `tests/suggest-compact.test.js` (append), `tests/agent-tracker.test.js` (append), `tests/tips.test.js` (append)

**Interfaces:**
- Consumes: Task 11 `agentReturns`, `countLargeResults`.
- Produces: `largeReadDelegationLine(n)` exact copy: `Large results detected: <n> tool results ≥20K tokens in the last 40 calls. Delegate the next wide read/grep to a subagent (frontmatter \`autoCompactWindow: 400000\`) and keep the conclusion, not the output.`

- [ ] **Step 1: Write the failing tests**

```js
test('si-token-budget appends an Agent shape entry with chars', () => { /* spawn with tool_name 'Agent', tool_response 'r'.repeat(25000) → last shape line has tool 'Agent', chars 25000, root null */ });
test('draftMessage names agent returns above 20K chars', () => { /* analysis.agentReturns {count:2, chars:45000} → /agents: 2 returns ~15k tokens/ */ });
test('callout adds the delegation prompt at ≥3 large results', () => { /* 3 shape entries chars 70000 → stderr matches largeReadDelegationLine(3) */ });
test('orange tip 1 names autoCompactWindow: 400000', () => assert.match(TIP_POOLS.orange[0], /autoCompactWindow: 400000/));
```

- [ ] **Step 2: Run the files** — Expected: FAIL. **Step 3: Implement.** **Step 4: Run `npm test && npm run test:node22`** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(si): agent returns feed the shape diagnosis; concrete delegation prompt on large reads"`

### Task 23: Telemetry hygiene; Tier 4 sync and final matrix

**Files:**
- Modify: `lib/events.js:286-330` (`recordCompact` ensures a `sessions` row via `INSERT OR IGNORE` and both writers resolve `project` as `COALESCE((SELECT project FROM sessions WHERE sid = ?), ?)`), `:348-380` (`recordAgentInvocation` computes `costUsd` from tokens + model when absent), `lib/events-stats.js` (compacts `total_cost` = `SUM` over per-sid `MAX(cost)`), new `events.reconcileCompactHistory(entries)`, `lib/events-migrations.js` (`compacts_sid_t_idx` index), `hooks/si-bootstrap.js:904-911` (call `events.reconcileCompactHistory(compactHistory.readHistory(200))` after `reconcileDb` — call site only), `tools/stats.js:377` (label `Session cost at last compact (sum)`)
- Test: `tests/events.test.js` (append)

**Interfaces:**
- Consumes: `readHistory(limit)` from `lib/compact-history.js`.
- Produces: `events.reconcileCompactHistory(entries) → number` (rows inserted for `(sid, t)` pairs missing from `compacts`, mapping `contextTokens|tokens, contextCap, fillPct, model, trigger, cost, costAtCompactUsd, hotDirs, warmDirs, droppedDirs, hadShift, cwd`).

- [ ] **Step 1: Write the failing tests**

```js
test('reconcileCompactHistory inserts missing (sid, t) rows and is idempotent', () => {
  events.recordSessionStart({ sid: 'a', project: 'P', startedAt: now });
  events.recordCompact({ sid: 'a', t: 1000, tokens: 100000 });
  const entries = [{ sid: 'a', t: 1000, tokens: 100000 }, { sid: 'a', t: 2000, contextTokens: 300000, fillPct: 30, contextCap: 1000000, trigger: 'manual', cwd: '/r' }];
  assert.equal(events.reconcileCompactHistory(entries), 1); assert.equal(events.reconcileCompactHistory(entries), 0);
  assert.equal(events.aggregateStats({ sinceDays: 3650 }).compacts.n, 2);
});
test('compacts total_cost sums each session\'s last cumulative cost, not every row', () => {
  // sid a: compacts cost 10 then 25; sid b: cost 5 → total_cost 30 (was 40)
});
test('recordCompact and recordZoneTransition take the canonical project from the sessions row', () => {
  events.recordSessionStart({ sid: 's', project: 'CSM', cwd: '/x/CSM', startedAt: now });
  events.recordCompact({ sid: 's', project: 'dashboard', t: now, tokens: 1 });
  events.recordZoneTransition({ sid: 's', project: 'mm', toZone: 'red', tokens: 1 });
  assert.equal(events.aggregateStats({ sinceDays: 30, project: 'CSM' }).compacts.n, 1);
  assert.equal(events.aggregateStats({ sinceDays: 30, project: 'CSM' }).zones.find((z) => z.zone === 'red').n, 1);
});
test('recordCompact for an unknown sid creates a minimal sessions row so per-project tables see it', () => {
  events.recordCompact({ sid: 'orphan', project: 'ReelCuts', cwd: '/r', t: now, tokens: 1 });
  assert.equal(events.aggregateStats({ sinceDays: 30 }).perProject.find((p) => p.project === 'ReelCuts').compacts, 1);
});
test('recordAgentInvocation prices a row from tokens when costUsd is absent', () => {
  events.recordAgentInvocation({ sid: 's', toolUseId: 't', subagentType: 'x', t: now, model: 'claude-opus-5-5', inputTokens: 1000000 });
  assert.ok(Math.abs(events.aggregateStats({ sinceDays: 30 }).agents.cost_usd - 4.0) < 1e-9);
});
```

- [ ] **Step 2: Run `node --test tests/events.test.js`** — Expected: FAIL. **Step 3: Implement.** **Step 4: Run `npm test && npm run test:node22`** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "fix(si): reconcile JSONL/DB compacts, canonical project at write time, per-session compact cost, priced agent rows"`

- [ ] **Step 6: Sync the live plugin (end of Tier 4) and run the full matrix**

Run: `npm run test:matrix && npm run sync && node tools/stats.js --days=1 | grep -E 'Fill at compact|COMPACT OUTCOMES|Pruned|Re-runs|Cache hit'`
Expected: both Node runs green; the four new stats labels print (values may be `—` until the next live compact). Then verify the live copy: `diff -rq lib ~/.claude/plugins/cache/session-intelligence/session-intelligence/1.0.0/lib` prints nothing.

---

## Self-review notes

- **Spec coverage:** row 1 → Tasks 3, 6, 7; row 2 → Tasks 4, 5; row 3 → Tasks 1, 8; row 4 → Tasks 9, 10; row 5 → Tasks 11, 12; row 6 → Tasks 13, 14, 15; row 7 → Task 16; row 8 → Task 18; row 9 → Task 17; row 10 → Task 19; row 11 → Task 20; row 12 → Task 21; row 13 → Task 22; row 14 → Task 23. The "should explicitly not do" paragraph is the Global Constraints list; Task 14's spawn test asserts PreCompact never emits a `decision`, Task 10 asserts no `permissionDecision`, Task 6 asserts the estimate never becomes `tokens`.
- **Type consistency:** `contextTokens`, `contextCap`, `fillPct`, `model`, `trigger` are the only names used for the five new values across history, snapshot, DB and hooks; `LatestUsage`, `ConstraintItem`, `PruneDecision`, `OutputBlock` typedefs are defined once in File Structure and referenced by task.
- **Proportion:** bodies appear only where the signature and tests leave an algorithm open (Task 4 scan order, Task 13 classification order, Task 14 cap policy, Task 10 dispatcher merge).
