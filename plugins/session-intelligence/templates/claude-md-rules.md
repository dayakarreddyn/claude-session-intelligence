### Session Discipline & Context Management

> Add this section to your project's CLAUDE.md to enforce session intelligence rules.

#### Task Boundaries (CRITICAL)
- **Update `session-context.md`** when starting each new task (type, files, decisions, preserve/drop hints)
- **After completing a task**: update session-context with "safe to drop" before starting next task
- **Never stack 3+ unrelated tasks** without compacting — context rot starts at ~300k tokens
- **Rewind > Correct** — if an approach fails, `esc esc` back to before the attempt instead of stacking "that didn't work" corrections

#### Compact Strategy
- **Proactive > Reactive** — compact at 200-300k tokens (yellow/orange zone), not at the limit
- **`/compact [hints]`** — always include what to preserve: `/compact preserve auth refactor context, drop test debugging`
- **`/clear`** — for totally new topics; write a handoff brief first
- **Token budget hook** tracks approximate usage — follow its zone warnings (yellow/orange/red)

#### Subagent Delegation
Use subagents (Agent tool) for work that produces large intermediate output:
- **File exploration** — searching for patterns across the codebase
- **E2E test execution** — running and verifying test suites
- **Browser testing** — automation verification sessions
- **Impact analysis** — blast radius checks before refactors
- Mental test: *"Will I need this tool output again, or just the conclusion?"*

#### Capture Insights As They Happen (CRITICAL)
Don't wait for `/compact` to catch up — the pre-compact block is a safety net, not the primary capture surface. When a finding surfaces mid-session, persist it **before moving on to the next step**:

Triggers (any of these in your own output or your thinking):
- `★ Insight`, `gotcha`, `non-obvious`, `worth remembering`, `heads up`, `trap`
- Bug that took >2 debugging attempts to isolate
- Library quirk or version incompatibility (e.g. `slowapi + __future__ annotations` class of issue)
- Decision that won't be obvious from reading the code later

Where it goes (pick one):
- **`session-context.md` → `## Key Decisions`** — small, this-session-only, the next task will still care
- **`session-context.md` → `## On Compact` (PRESERVE line)** — must explicitly survive the next compact
- **`memory/reference_<slug>.md`** — reusable recipe that future sessions/projects want (type: reference, one-line pointer in `MEMORY.md`)
- **`memory/project_session_YYYY_MM_DD.md`** — this-project session log, extend in place

Append *as the insight surfaces*. A single Edit or Write call, then continue the task. Do NOT batch these until pre-compact — by then detail has collapsed.

#### Memory Offloading
SI now nudges this automatically at zone crossover (orange/red stderr feedback) and injects an explicit **MEMORY OFFLOAD CHECKPOINT** block into the pre-compact summary with the concrete path to `~/.claude/projects/<encoded>/memory/`.

When the nudge fires — or any time before `/compact` if you'd rather not wait — write to auto-memory anything that:
- Took >3 attempts to discover (non-obvious finding)
- Is an architectural decision not captured in code/comments
- Would cost significant re-investigation if lost in compaction
- Is a reusable recipe other sessions would benefit from (→ `reference_<pattern>.md`, type: reference)

The pre-compact block suggests two filenames:
- `project_session_YYYY_MM_DD.md` — this-session decisions, files touched, follow-ups
- `reference_<pattern>.md` — only if a reusable recipe was discovered

Always update `MEMORY.md` with a one-line pointer. Don't duplicate prior memory content — update in place.

Disable either surface with `compact.memoryOffload: false` in `~/.claude/session-intelligence.json` or `CLAUDE_COMPACT_MEMORY_OFFLOAD=0`.
