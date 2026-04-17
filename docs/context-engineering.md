# Context Engineering: Mechanics, Rot, and Adaptive Compaction

A design-and-research document for the Session Intelligence plugin. Covers what "context" actually is inside a transformer, how it degrades across the window, why static compaction thresholds are wrong, and how the plugin's four-part pipeline — observation, grounded diagnosis, auto-injection, adaptive learning — attempts to do better.

Written for engineers integrating with Claude Code who want to understand the *why* behind the thresholds, not just the *what*.

---

## TL;DR

1. **Context is the model's working memory, not a database.** Every token in the window is re-attended to on every turn. "Unused" context is not free.
2. **Degradation is task-dependent and gradual, not a cliff.** Retrieval holds to 1M; multi-step coding starts drifting at ~150–250k; complex synthesis with distractors degrades from ~300k.
3. **Static zone thresholds (200k/300k/400k) are starting points, not truth.** They match empirical inflection points for multi-turn coding, which is the workload the plugin is calibrated for.
4. **The plugin replaces "compact now" with four grounded signals:** what shifted (domain), what's cold (droppable), what's hot (preserve), and what it's costing you ($).
5. **User types plain `/compact`.** PreCompact hook auto-injects PRESERVE/DROP bands — no hint syntax to learn.
6. **Thresholds learn from your actual pattern.** After 5 compacts, yellow/orange/red anchor to P50/P90 of your historical compact points (bounded ±30%). Re-touching dropped dirs dampens future drop eagerness automatically.

---

## Part 1 — How context actually works

### 1.1 Attention is the mechanism, and it's global

A transformer processes every token in the context window against every other token via self-attention. On a 1M token window, for each output token the model consults an attention-weighted combination of the entire 1M preceding tokens. This is the central fact behind every "long context" observation.

Modern implementations don't pay the naive O(n²) cost:

- **Flash Attention** restructures the memory access pattern so the wall-clock cost is closer to O(n · √n)
- **Sliding-window attention** limits some layers to local neighbourhoods
- **Grouped-query attention (GQA) / Multi-query attention (MQA)** share keys/values across heads to cut KV cache size
- **KV cache** avoids re-computing attention for already-seen tokens on subsequent turns — this is what makes long conversations affordable

But the *conceptual* cost remains: the model's decision on any given token is a function of every token it has seen. Cache read tokens are billed cheaper by Anthropic ($1.50/M vs $15/M for input, $18.75/M for cache creation, $75/M for output — see Anthropic's pricing), but they still participate in attention.

### 1.2 "Context size" is not one number

What the transformer actually tracks:

| Concept | What it measures |
|---|---|
| **Input tokens** | Newly-provided context on this turn (system prompt, user message, tool results) |
| **Cache creation tokens** | Input tokens written into the KV cache for reuse next turn |
| **Cache read tokens** | Tokens served from the cache this turn instead of re-processed |
| **Output tokens** | Tokens the model generated |

Anthropic bills these differently. The plugin sums all three "context" variants when displaying token count, because that's what's actually in the window during the current turn:

```
total_in_window = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
```

This matches the number Anthropic's API would report for that turn, and is the number the plugin's status line shows as "tokens."

### 1.3 The KV cache changes cost, not quality

A common misconception: "if I have 400k tokens but most of them are cache reads, attention is fine."

Cache reads are a **billing and latency** optimization. The model's output still flows from an attention function over the entire cached set. If you have 400k tokens of abandoned exploration in cache, every subsequent decision is influenced by 400k tokens of abandoned exploration — the cache just made it cheap to re-read, not less influential.

This is why the plugin's learning loop cares about cost-band (`expensive` vs `cheap`) as **telemetry**, not as a reason to skip compacting. A 400k cache-heavy context is cheap per turn but just as prone to rot as a 400k uncached context.

### 1.4 The context window is shared across turns

Every message in a Claude Code conversation sits in the same window:

- System prompt (including CLAUDE.md injection)
- Entire conversation history (user messages + assistant messages)
- Every tool result your session has produced
- The current user turn

Tool results dominate long sessions. A single Read of a 2000-line file is ~8000 tokens. A Grep with 50 matches can be 10-30k. Twenty Bash calls producing 500 lines each is 40k. The model re-processes all of it on every subsequent turn until compaction.

The plugin's `token-budget-tracker.js` approximates this by summing tool I/O at 4 chars/token (conservative for code, generous for natural language). The authoritative number comes from `transcript_path.message.usage` — the plugin prefers this when available, falls back to the estimate otherwise.

---

## Part 2 — Where context degrades

### 2.1 Empirical benchmarks

Published long-context benchmarks show different curves for different task families:

| Benchmark | What it measures | Where degradation shows |
|---|---|---|
| **NIAH** (Needle in a Haystack) | Retrieve a single planted fact | Near-perfect to 1M on Claude Opus |
| **RULER** | Mixed retrieval + multi-hop + aggregation | Retrieval holds; multi-hop degrades from ~128k in most frontier models |
| **LongBench v2** | Single-doc QA, multi-doc QA, summarization, code | Code tasks degrade fastest; QA holds longest |
| **NoCha** (Novel Challenge) | Plot reasoning over full books | Frontier models ~60% accuracy at 500k context |
| **RepoBench / SWE-Bench in long context** | Code edit planning across many files | Steep drop past ~200k for frontier models |

The generalization: **retrieval is solved; reasoning over retrieved content in a long window is not.**

### 2.2 The coding-specific curve

Claude Code sessions are a worst-case profile for long-context performance because:

1. **Many dependent decisions** — each Edit/Write depends on prior file state the model was told about
2. **Heavy tool I/O** — Reads and Bash outputs dominate the token budget with data the model doesn't need verbatim past the decision it informed
3. **Implicit instructions layered over time** — user preferences stated early in the session still bind the model's behaviour, and competing guidance later in the session causes drift
4. **High cost of a wrong decision** — breaking a file takes one token sequence; recognizing it took 30k tokens of context

Empirically (Thariq's research on 1M Claude, public observations, and internal Anthropic guidance): instruction-following in coding sessions visibly degrades from ~150-250k tokens and becomes unreliable past ~400k for sessions with heavy tool use. This is why "auto-compact fires at 1M" is the wrong place — it fires after the damage is done.

### 2.3 "Context rot" as a user-facing phenomenon

What the engineer actually experiences as degradation:

- Claude cites decisions from 100k tokens ago that no longer apply
- Test code the model explicitly said was fixed gets reintroduced
- The model "forgets" a requirement stated in the first user message
- Suggestions start mixing solutions from different phases of the session (e.g. applying old architecture to new code)
- Voice/style drifts (formality, comment verbosity, commit message format)

None of these are "the model is broken." They are the statistical consequence of asking an attention function to weight the current decision against 300k+ tokens of noise with only a fraction of them being currently load-bearing.

### 2.4 Why 250k is the right "start warning" point

- Multi-step coding sessions show measurable drift starting ~150-250k in benchmarks
- Users report subjective quality degradation from ~200k in Claude Code specifically
- Cost at 250k is ~3× cost at 80k per turn, so warning before the inflection is cheap
- Cost of a wrong compact (losing needed context) is high, so warning *too* aggressively (e.g. 100k) produces false positives and gets ignored

The 200k / 300k / 400k bands match the empirical inflection for the workload the plugin targets. They aren't sacred — the adaptive zones feature (Part 6) recalibrates them to your actual pattern.

---

## Part 3 — The intervention problem

### 3.1 Why "just compact more often" doesn't work

Naïve approaches and why they fail:

| Approach | Why it fails |
|---|---|
| "Auto-compact at 200k, every time" | Destroys mid-task context. User loses the thread. Happens mid-refactor. |
| "Let auto-compact fire at 1M" | Too late — rot has already degraded many prior turns. |
| "Compact on every user prompt" | Destroys conversational continuity. User restates context every turn. |
| "Never compact, use subagents for everything" | Subagents have their own context budget; main thread still grows. |
| "Compact on Nth tool call" | N is arbitrary. Ten big Reads ≠ fifty Grep lookups. |

What actually works: **compact at natural phase boundaries, guided by what the context currently contains.**

A phase boundary is typically:

- End of a discrete task (feature done, bug fixed, refactor landed)
- Pivot from one domain to another (auth → billing)
- Just before a long-running sequence you know will chew context (running a test suite, searching the codebase)
- Right after a commit, push, or PR — natural "checkpoint" moments

### 3.2 The two failure modes

A bad intervention can be either:

**Too eager** — you compacted at 250k while mid-investigation of a bug. Claude lost the file paths, the hypotheses, the failed approaches. You spend the next 50k tokens re-establishing context.

**Too lax** — you let it drift to 500k on a multi-domain session. Claude starts mixing decisions from phase 1 into phase 3. You notice three commits later when behaviour is off.

The plugin's goal is to hit the narrow "right time" window more often, by:

1. Observing *what* is in the context (not just how much)
2. Surfacing the diagnosis (not just the token count)
3. Learning from the user's actual comfort zone (not a hardcoded threshold)
4. Watching for post-compact regret (not just "did they compact")

---

## Part 4 — Context Shaping: observation as the foundation

### 4.1 Why observe tool usage

Token count alone is a blunt instrument. The same 300k can represent:

- A focused 3-hour refactor of `src/auth/` with 200 Edit calls — compacting would destroy current working context
- An abandoned exploration of `tests/browser/` from 2 hours ago plus a new focus on `src/billing/` — compacting with "drop tests/browser" saves ~40% of the budget with zero cost to current work
- A grinding test-debugging session where the user is re-reading the same 10 files — compacting summarizes the earlier iterations and keeps the current hypothesis

You can only distinguish these by looking at **what the tool calls have been touching over time.** That's the data the shape tracker collects.

### 4.2 The observation log

Every `PostToolUse` hook fire appends one JSONL line to `/tmp/claude-ctx-shape-<sid>.jsonl`:

```json
{"t":1714000000,"tok":155432,"tool":"Read","root":"src/auth","file":"src/auth/login.ts"}
{"t":1714000012,"tok":156812,"tool":"Edit","root":"src/auth","file":"src/auth/login.ts"}
{"t":1714000145,"tok":184320,"tool":"Bash","root":null,"file":null,"event":"commit"}
```

Schema:

| Field | Meaning |
|---|---|
| `t` | Unix milliseconds — when the tool call happened |
| `tok` | Cumulative token budget at this call (from token-budget-tracker estimate) |
| `tool` | Tool name (Read, Edit, Write, Bash, Grep, Glob, etc.) |
| `root` | Two-segment rootDir signature (e.g. `src/auth`, `tests/browser`) or `null` |
| `file` | Original file path, for sampling in hint output |
| `event` | `commit`, `push`, or `pr` when Bash command matches a phase marker; otherwise `null` |

Three constraints on the log:

1. **Size-bounded** — 200 entries or 128 KB, whichever first. Older entries roll off.
2. **Signal-only** — entries without `root` or `event` are dropped. A pure `echo "hi"` adds no information.
3. **Best-effort writes** — observation failures never propagate. The log is telemetry, not critical path.

### 4.3 Root-dir signature choice

Every file path is reduced to its first two path segments:

```
src/auth/login.ts              → "src/auth"
tests/browser/spec/auth.ts     → "tests/browser"
README.md                      → "."
/tmp/scratch/file.ts           → "/tmp/scratch"
```

Why two segments specifically:

- **One segment** fragments too aggressively. `src/auth/login.ts` and `src/billing/invoice.ts` both group under `src` — the signal that you pivoted domains is lost.
- **Three segments** fragments too aggressively in the other direction. Each test file in its own bucket destroys the "you're working in tests/browser" signal.
- **Two** captures feature-level grouping (`src/auth` vs `src/billing`) without exploding the distinct-roots count.

### 4.4 Phase event detection

Certain Bash commands are strong "natural phase break" markers:

| Regex on `tool_input.command` | Event tagged |
|---|---|
| `^\s*git\s+commit\b` | `commit` |
| `^\s*git\s+push\b` | `push` |
| `^\s*gh\s+pr\s+(create\|merge)\b` | `pr` |

These get stored in the log and surfaced in the pre-compact injection as "PHASE MARKERS OBSERVED." They tell the compacting model that the user just completed a discrete unit of work, so aggressive summarization is safer.

### 4.5 Classification: HOT / WARM / COLD bands

`analyzeShape()` walks the log and classifies each rootDir by **when it was last touched** relative to the full token span:

| Band | Definition | Interpretation |
|---|---|---|
| **HOT** | Last-touched in the top 20% of token span | Current working set. Preserve. |
| **WARM** | Last-touched in the 20–60% range | Referenced recently but not active. Keep one-line summary. |
| **COLD** | Last-touched only in the first 40% | Abandoned tangent. Safe to drop. |

Bands are computed per compaction, not maintained as state. This matters: a rootDir that was COLD at one compact and then gets heavily touched post-compact will be HOT at the next compact. No state carries across.

### 4.6 Domain shift detection (Jaccard)

In addition to banding, the analyzer checks whether you've **pivoted domains** over the observed window:

```
head_set = rootDirs in the first 10 entries
tail_set = rootDirs in the last 10 entries
jaccard = |head ∩ tail| / |head ∪ tail|
shift   = jaccard < 0.3
```

A Jaccard of 0 means the rootDirs in the last 10 calls are disjoint from the first 10 — clear pivot. A Jaccard of 0.8 means you're grinding in the same directories throughout.

Why Jaccard and not something fancier: the signal is binary enough that a rank-based or embedding-based method adds cost without adding accuracy. And the threshold (0.3) is conservative — genuine "still working on the same thing" sessions rarely dip below 0.5 even across natural sub-task shifts.

### 4.7 Stale-token estimation

Rough heuristic for "how much of the current context is in COLD dirs":

```
stale_tokens ≈ total_span × (cold_calls / total_calls)
```

Proportional, not measured directly. A session with 40% of its tool calls in COLD dirs has roughly 40% of its token budget in cold context. This informs the "~82k stale in tests/browser" phrasing in the suggest-compact message.

---

## Part 5 — Auto-injection at /compact

### 5.1 The UX principle

**User types plain `/compact`. The plugin does everything else.**

No syntax to memorize. No "preserve X, drop Y" to type mid-flow when you're already distracted by the zone warning. Free-text `/compact preserve auth refactor` still works and composes on top of the auto-injection.

### 5.2 The injection channel

Claude Code exposes a `PreCompact` hook that fires before the compaction prompt reaches the model. Whatever the hook writes to stdout gets **prepended to Claude's compaction instructions.**

Our `pre-compact.js` writes two blocks:

1. **COMPACTION GUIDANCE (from session-context.md)** — user-authored, curated hints from the session context file (existing behaviour)
2. **OBSERVED CONTEXT SHAPE** — freshly regenerated PRESERVE/DROP bands from the shape log

The model sees both, user-curated first (stronger signal, manual intent), observed-shape second (grounded in what actually happened).

### 5.3 Example injection

Full stdout written by `pre-compact.js` at the moment of /compact:

```
COMPACTION GUIDANCE (from session-context.md):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CURRENT TASK:
type: refactor — auth middleware cleanup
description: remove legacy session-token storage per compliance ask
issue: #164

KEY FILES (must preserve):
- src/auth/middleware.ts
- src/auth/session.ts

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

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

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

The compacting model reads this verbatim as part of its instructions. "Keep only one-line summaries of what happened in the DROP section" is explicit guidance — not a suggestion the model may or may not follow.

### 5.4 Freshness guarantee

The injection is **regenerated fresh at compact time** from the live shape log, not stored as a file. If you ran `/compact` 20 minutes ago, added 30 Edit calls to `src/cache/`, and ran `/compact` again, the second injection reflects those 30 new calls. No stale handoff files lying around.

---

## Part 6 — Adaptive zone thresholds

### 6.1 Why static thresholds are wrong for you specifically

The default 200/300/400k zones are calibrated for a median Claude Code user doing multi-step coding work. Your actual profile might be:

- **Retrieval-heavy** — you mostly read files and ask questions; 500k is fine, 300k warnings are noise
- **Heavy edit, shallow context** — you edit many small files with little cross-file state; 250k rot
- **Single-file deep work** — you stay in one file for hours; rot comes from accumulated *conversation*, not cross-file drift
- **Agent-heavy** — you delegate to subagents constantly; main thread grows from returns only

Static thresholds can't know which profile you are. Adaptive zones figure it out.

### 6.2 The learning substrate

Every `/compact` appends an entry to `~/.claude/logs/compact-history.jsonl`:

```json
{"t":1714000000,"sid":"abc","cwd":"/proj","tokens":265000,"cost":2.14,
 "hotDirs":["src/auth"],"droppedDirs":["tests/browser","scripts/old"],
 "hadShift":true,"regretCount":0}
```

Cross-session, cross-project, per-user. Bounded at 200 entries / 256 KB with automatic rotation.

### 6.3 The derivation

With **≥5 compacts** in history, `adaptiveZones()` computes:

```
tokens_at_compact = [entry.tokens for entry in history]
P50 = percentile(tokens_at_compact, 0.50)
P90 = percentile(tokens_at_compact, 0.90)

orange_target = floor(P50 * 0.9)   # slightly below where you usually pull the trigger
yellow        = orange - 80000     # 80k cushion
red           = max(orange + 60000, P90 * 1.05)
```

The `* 0.9` on orange is deliberate: warnings should arrive **before** you've already decided to compact. If your median compact point is 270k, orange at 270k is redundant (you were going to compact anyway); orange at 243k gives you lead time.

### 6.4 The bounds

Adaptive zones are **clamped to ±30% of the static defaults**:

```
orange_min = 300000 × 0.7 = 210000
orange_max = 300000 × 1.3 = 390000
orange     = clamp(orange_target, orange_min, orange_max)
```

Why bounds exist: a user who compacts once at 100k because they got interrupted shouldn't thereafter get yellow warnings at 60k. A user who forgets to compact until 700k shouldn't thereafter have orange pushed to 600k. Bounds prevent a noisy history from silencing the warnings entirely.

### 6.5 The disclosure

When adaptive zones fire, the suggest-compact message includes a footnote:

> (Zones adapted to your history: orange=251k, red=317k, 7 past compacts.)

This is deliberate. Users should know when the thresholds they're reacting to came from their own pattern vs. hardcoded defaults. If the adaptive threshold feels wrong, that's a signal to change behaviour or delete the history file.

---

## Part 7 — Post-compact regret detection

### 7.1 The feedback loop problem

Zones adapt to *when* you compact. But there's a second signal that matters: whether the compact was **good** (flow resumed seamlessly) or **bad** (you had to re-explain / re-read dropped content).

Claude Code doesn't expose a PostCompact hook, so there's no direct way to ask "how did that go?" — but tool calls post-compact are a reliable proxy.

### 7.2 The snapshot mechanism

At the moment of `/compact`, `pre-compact.js` writes a per-session snapshot:

```json
{
  "t": 1714000000,
  "tokens": 265000,
  "cost": 2.14,
  "hotDirs": ["src/auth"],
  "droppedDirs": ["tests/browser", "scripts/old"],
  "callsSince": 0,
  "regretHits": []
}
```

File: `/tmp/claude-compact-snapshot-<sid>.json`.

The snapshot is the source of truth for "what did we tell the model to drop?" for the next monitoring window.

### 7.3 The monitoring window

For the next **30 tool calls** or **30 minutes** (whichever comes first), every `PostToolUse` hook fire calls `checkPostCompactRegret()`:

1. Extract the rootDir of the current tool call's file_path
2. Check: is this rootDir in `snapshot.droppedDirs`?
3. If yes → regret hit. Append to `snapshot.regretHits`.
4. If `callsSince > 30` or `(now - snapshot.t) > 30min` → window closed.

When the window closes:

1. Stamp the final `regretCount` into the corresponding `compact-history.jsonl` entry (via `t` match)
2. Delete the snapshot file

### 7.4 The dampening

Next time `adaptiveZones()` runs, it inspects the recent history for regret:

```
recent_regret = sum(h.regretCount for h in history[-10:])
regret_rate = recent_regret / min(10, len(history))
```

If `regret_rate >= 1` (user averages ≥1 regret per compact across recent compacts), the adaptive orange threshold pushes **out** by 10%:

```
orange = min(orange_max, round(orange * 1.1))
```

Interpretation: "the plugin has been recommending drops that the user later needed — be more conservative on the next suggestion."

This is a slow negative-feedback loop. One regret doesn't move anything; a pattern does.

### 7.5 What regret detection does *not* do

- Doesn't change what the PreCompact hook injects next time — that's recomputed from fresh shape each compact
- Doesn't override user-curated `session-context.md` — the dampening only touches the zone *thresholds*, not the drop content
- Doesn't surface regret to the user — it's silent telemetry; the disclosure footnote only reveals the current threshold, not the reason behind it

The design assumption is that the user doesn't need to think about regret tracking. They just experience the plugin getting better at knowing when to warn.

---

## Part 8 — Cost-band awareness

### 8.1 Cost as a decision input

Compaction trades a one-time compaction cost (the model summarizing 300k tokens ≈ $5-$10) against reduced per-turn cost across the next N turns (cheaper input + fewer cache reads if the summary is substantially smaller). Whether this trade is positive depends on the cost band of the current context.

### 8.2 The banding

`costBand(usage)` classifies the current turn:

```
total_tok = input + cache_creation + cache_read
cache_ratio = cache_read / total_tok

if cache_ratio >= 0.7   → band = 'cheap'
if cache_ratio <  0.3   → band = 'expensive'
else                    → band = 'normal'
```

- **Cheap** — heavy cache hits. Per-turn cost is low. Compacting saves less per turn.
- **Expensive** — mostly novel input. Each turn is expensive. Compacting pays off faster.

### 8.3 Current use

The cost-band signal is computed and logged, but the plugin doesn't yet use it to *modulate* thresholds. It surfaces as telemetry in the suggest-compact message:

> Context at ~260k tokens, $1.43 spent.

Future: shift the orange threshold inward when band=`expensive` (compact earlier to cap burn rate) and outward when band=`cheap` (more tolerant of long contexts since they're not costing much). Deferred pending enough history data to validate the heuristic.

---

## Part 9 — Status line design

### 9.1 The "one colour, one signal" rule

The status line exists to warn about context pressure. Everything else on the bar is **context for** that warning.

If every field competes for the user's eye with colour, the signal drowns in noise. So:

- Line 1 is dim except `tokens`, which carries the zone colour (green → yellow → orange → red)
- Line 2 is entirely dim except `compactAge`, which goes **red** when the last /compact was ≥2h ago (the only other alert worth raising)
- Separators `·` are grey
- Emojis removed from defaults (added width, added decision cost — "what does this glyph mean again?")

### 9.2 Example

```
Opus 4.7 (1M) · CSM · dev · (+22,-13) · ▰▰▰▰ 425k
70 tools · compact:2h13m ago · feat — statusline v2
```

The eye goes to the coloured token bar first. Everything else stays available but doesn't compete. If you're in the red zone AND the last compact was 3h ago, you see two red marks — both genuinely critical.

### 9.3 Why this isn't just aesthetic

Colour in a status line is a decision-support tool. Every coloured field is saying "look at me." If six fields say that simultaneously, the user does what users always do with over-decorated dashboards: tunes it out. The first time the bar screams about orange zone, it's only seen because it's the one thing shouting.

---

## Part 10 — Implementation map

### 10.1 Hooks

| Hook | Event | Responsibility |
|---|---|---|
| `bootstrap.js` | SessionStart | Seed session-context.md from git; wire statusline chain; inject CLAUDE.md rules |
| `token-budget-tracker.js` | PostToolUse | Sum tool I/O → `tokenBudget`; append shape entry; post-compact regret check |
| `suggest-compact.js` | PostToolUse | Adaptive zones; grounded diagnosis; zone-crossover stderr message |
| `pre-compact.js` | PreCompact | Inject session-context.md + observed shape; log history entry; write post-compact snapshot |
| `task-change-detector.js` | UserPromptSubmit | Heuristic same-domain score + Haiku tie-breaker on domain shift |

### 10.2 Libraries

| Lib | Purpose |
|---|---|
| `lib/context-shape.js` | `rootDirOf`, `appendShape`, `readShape`, `analyzeShape`, `draftMessage`, `formatCompactInjection` |
| `lib/compact-history.js` | `appendHistory`, `readHistory`, `adaptiveZones`, `writeSnapshot`, `readSnapshot`, `checkPostCompactRegret` |
| `lib/cost-estimation.js` | `costFromUsage`, `totalCostFromTranscript`, `costBand`, `formatUsd` |
| `lib/config.js` | `loadConfig`, `saveConfig`, `STATUSLINE_PRESETS`, dotted `get`/`set` |
| `lib/utils.js` | `readStdinJson`, `readTranscriptTokens`, `resolveProjectDir`, fs helpers |
| `lib/intel-debug.js` | `intelLog` — structured debug logging |

### 10.3 Data stores

| Path | Contents | Lifetime |
|---|---|---|
| `/tmp/claude-token-budget-<sid>` | Cumulative token estimate | per-session |
| `/tmp/claude-tool-count-<sid>` | Unified tool-call count | per-session |
| `/tmp/claude-compact-state-<sid>` | Last zone seen (for one-shot escalation) | per-session |
| `/tmp/claude-cost-<sid>` | Incremental cost-read cache | per-session |
| `/tmp/claude-ctx-shape-<sid>.jsonl` | Shape observation log | per-session |
| `/tmp/claude-compact-snapshot-<sid>.json` | Post-compact regret window state | 30 calls / 30 min |
| `~/.claude/logs/compact-history.jsonl` | Cross-session compact history | persistent, bounded |
| `~/.claude/logs/session-intel-YYYY-MM-DD.log` | Structured debug log | daily, 5 MB rotation |

### 10.4 Control flow for a typical session

```
SessionStart
  └─ bootstrap.js: seed session-context.md, wire statusline, inject rules

loop on user turn:

  UserPromptSubmit
    └─ task-change-detector.js: score domain shift, maybe offer /compact|/clear

  loop on tool call:

    (tool executes)

    PostToolUse
      ├─ token-budget-tracker.js:
      │     - sum tool I/O, update budget file
      │     - append shape entry (if file or event)
      │     - check post-compact regret (if snapshot live)
      │
      └─ suggest-compact.js:
            - load compact history, compute adaptive zones
            - evaluate zone for current budget
            - if crossover to orange/red:
                * read shape, draft diagnosis
                * read cost, format message
                * stderr the message, exit 2

  if user types /compact:
    PreCompact
      └─ pre-compact.js:
            - read session-context.md, format hints block
            - read shape, analyze, format shape-injection block
            - append to history; write snapshot
            - stdout both blocks
```

---

## Part 11 — Limitations and open questions

### 11.1 Known limitations

1. **Shape tracker can't see model "thinking" tokens.** Reasoning tokens before a tool call aren't observed. A session where Claude thinks heavily but calls few tools will look small in the shape log even though its context is large. The `tokens` field (from transcript usage) catches this; the *shape* does not.

2. **rootDir granularity is fixed at two segments.** Deep monorepos (`packages/core/src/auth/login.ts` → `packages/core`) can under-distinguish features. A `depth` config knob would help but isn't implemented.

3. **Phase event detection is Bash-only.** A user who commits via their IDE or via `gh` (e.g. `gh repo commit`) won't produce a commit event in the log. The plugin under-detects phase boundaries for those workflows.

4. **Adaptive zones need ≥5 compacts to activate.** First sessions use static defaults. Onboarding users experience the plugin's "pre-learning" behaviour as their default and may never realize it got better.

5. **Regret detection treats all re-touches equally.** Touching a dropped dir to clean up a leftover is different from re-reading it because you lost the context. No way to distinguish.

6. **Cross-project history blurs.** A user working in 5 repos has one history file. If one repo pushes the median compact point up, the others' thresholds drift with it. Per-cwd bucketing would help.

### 11.2 Open questions

- **What's the right window for regret detection?** 30 calls / 30 min is a guess. Longer catches more real regret at the cost of never-closing snapshots; shorter misses post-compact exploration.
- **Should cost-band actively modulate thresholds?** The data is there; the heuristic isn't.
- **Is two-segment rootDir right for all projects?** Probably not — needs empirical validation.
- **Should the plugin learn which *dirs* the user regrets dropping vs just the rate?** A per-dir regret score would let drop suggestions avoid specific paths even when the overall threshold is unchanged.
- **Can we detect a *good* compact?** No-regret isn't the same as positive signal. A no-op compact (user's next 30 calls touch nothing dropped, but also don't do much) is indistinguishable from a great compact right now.

### 11.3 Design tradeoffs accepted

- **Heuristic over principled** — Jaccard 0.3 for shift, HOT = last 20%, P50 × 0.9 for orange. All picked by inspection. A proper methodology would use held-out session traces. Deferred as "good enough to ship" pending real usage data.
- **No ML** — the plugin is deterministic classification over explicit features. An embedding-based similarity for "same task?" would be more accurate but would require a model call per hook fire. Haiku tie-breaker in task-change-detector is the only place we eat that cost.
- **Silent telemetry** — adaptive changes happen without prompting the user. A more interactive design would surface "your compact pattern has shifted, want new zones?" We chose silence on the theory that users want the plugin to work, not to be asked.

---

## Part 12 — Concrete user experience

### 12.1 Session 1 (fresh install, no history)

```
User: (starts work on auth refactor)
    [Claude does 40 Read/Edit calls in src/auth/]
    [context grows to ~245k]

[StrategicCompact] YELLOW ZONE — ~245k tokens. Good time to /compact between tasks.

User: (finishes auth work, runs tests, commits)
User: Now let's look at the billing side.

[task-change-detector.js: same-domain score 0.1, below threshold]
[offers: Compact / Clear / Continue]

User: Compact

[plugin observes: /compact typed]
    [pre-compact.js writes:
       - session-context.md hints
       - OBSERVED CONTEXT SHAPE:
           DOMAIN SHIFT DETECTED: src/auth → (tests pending)
           PRESERVE: src/auth, tests/auth
           (no SAFE TO DROP — nothing cold yet)
     ]
    [history entry logged: tokens=248k, cost=$2.10, hotDirs=[src/auth, tests/auth]]
    [snapshot: droppedDirs=[] — nothing to regret]

User: (continues with billing work)
    [context resumes at ~80k — clean slate with summary]
```

### 12.2 Session 3 (3 past compacts in history)

Static thresholds still in effect (need 5). Same behaviour as session 1.

### 12.3 Session 5+ (≥5 past compacts)

```
[plugin observes: median compact point across last 5 sessions = 255k]
[adaptive orange = 229k, red = 310k]

    [40 Read/Edit calls in src/billing, 20 in tests/billing]
    [context grows to ~235k]

[StrategicCompact] ORANGE ZONE — context rot risk. Context at ~235k tokens, $2.84 spent.
Observed: shifted src/auth → src/billing · hot: src/billing, tests/billing.
Run `/compact` — preserve/drop hints will be auto-injected from observed tool usage.
(Zones adapted to your history: orange=229k, red=310k, 5 past compacts.)
Silence this feedback with CLAUDE_COMPACT_AUTOBLOCK=0.
```

### 12.4 Session 7 (post-regret)

```
User compacted in session 5 at 235k. Dropped tests/browser.
In the next 30 tool calls, touched tests/browser 3 times.
regretCount=3 stamped into session-5 history entry.

[adaptive: recent regret rate 0.6 per compact — below dampening threshold]
[zones unchanged]

User compacts at 240k in session 6 after dropping tests/browser again.
Touches tests/browser 4 more times post-compact.
regretCount=4 stamped.

[adaptive: recent regret rate 1.4 per compact — triggers dampening]
[orange pushes from 229k → 252k on next computation]

Session 7: warnings fire later, reflecting "you keep needing that context."
```

The user hasn't configured anything. The plugin calibrated to their pattern across 7 sessions and now fires warnings at the point where *they* usually pull the trigger, with drop suggestions dampened because their history shows they regret the drops.

---

## References

Empirical long-context work:
- **NIAH** (Needle in a Haystack) — Kamradt, 2023; public benchmark for retrieval across long contexts
- **RULER** — Hsieh et al., "RULER: What's the Real Context Size of Your Long-Context Language Models?", 2024
- **LongBench** — Bai et al., "LongBench: A Bilingual, Multitask Benchmark for Long Context Understanding", 2024
- **NoCha** — Karpinska et al., "One Thousand and One Pairs: A 'novel' challenge for long-context language models", 2024

Anthropic-specific:
- [Anthropic pricing reference](https://docs.anthropic.com/en/docs/about-claude/pricing) — cache read / creation / input / output per-1M rates used by `lib/cost-estimation.js`
- [Thariq's research thread](https://x.com/trq212/status/2044548257058328723) — the empirical inflection points motivating the default 200/300/400k zones

Plugin source (this repo):
- `lib/context-shape.js` — observation log, band classification, shift detection, injection formatting
- `lib/compact-history.js` — history logging, adaptive zones, post-compact regret
- `lib/cost-estimation.js` — incremental cost-from-transcript, cost-band classification
- `hooks/pre-compact.js` — PreCompact injection + history logging + snapshot write
- `hooks/suggest-compact.js` — grounded diagnosis + adaptive thresholds
- `hooks/token-budget-tracker.js` — shape observation + regret detection

---

*This document reflects the state of the plugin as of commit [HEAD]. The mechanics are stable; the specific numeric heuristics (Jaccard 0.3, HOT at 20%, orange at P50×0.9) are subject to revision as usage data accumulates.*
