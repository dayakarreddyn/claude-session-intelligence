<!-- BEGIN session-intelligence:rules -->
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

#### Memory Offloading
Before compacting, write to memory anything that:
- Took >3 attempts to discover (non-obvious finding)
- Is an architectural decision not captured in code/comments
- Would cost significant re-investigation if lost in compaction
<!-- END session-intelligence:rules -->
