# Claude Code 2.1.x context machinery (facts as of 2026-10-19)

Sourced facts as of 2026-10-19. Each line cites the page it came from. "Not documented" means I searched the pages I could read and found no statement. Some Claude Code pages were read in chunks, so I flag where a section was not reached.

## 1. Auto-compact

- Default trigger: Claude Code "compacts when the conversation reaches the model's context limit", except for listed cases (Cloud sessions; Sonnet 4.6/Opus 4.6 without extended context compact at the 200K boundary; with `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`, native-1M models compact at 200K). Source: https://code.claude.com/docs/en/model-config
- Native-1M models (Fable 5.1, Fable 5, Sonnet 5+, Haiku 5.5, Opus 4.7+) "compact before the window fills, at about 967K tokens by default." Source: https://code.claude.com/docs/en/model-config
- The default percentage behind that 967K figure is not stated in the text I read. The docs give the 967K number, not a percentage rule.
- Setting: `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (1-100; lower values only; "values above the default percentage are ignored"; applies to subagents too). Source: https://code.claude.com/docs/en/env-vars and https://code.claude.com/docs/en/sub-agents
- Window setting: `autoCompactWindow` in settings (100K-1M, capped at model window); env `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (plain integer; overrides the setting and `/autocompact`); `/autocompact <size>` (e.g. `500k`, `auto` to reset); `--autocompact` flag. Source: https://code.claude.com/docs/en/model-config
- Other compaction settings: `idleCompaction: false` disables idle compaction (Claude Code v2.1.290+); `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` (default 200000). Source: https://code.claude.com/docs/en/prompt-caching and https://code.claude.com/docs/en/env-vars
- `DISABLE_COMPACT` is referenced as needed for `CLAUDE_CODE_MAX_CONTEXT_TOKENS` to apply to recognized model IDs. Source: https://code.claude.com/docs/en/model-config
- `CLAUDE_CODE_MAX_OUTPUT_TOKENS` raises the output reservation and "reduces the effective context window available before auto-compaction triggers." Source: https://code.claude.com/docs/en/env-vars
- Context window for Opus 5.5 and Fable 5.1: 1M tokens, no beta header needed for 1M ("1M is the default"). Source: https://platform.claude.com/docs/en/build-with-claude/context-windows
- Claude Code treats Opus 4.7+ as native 1M with no `[1m]` suffix needed. The `[1m]` variant is only needed for Opus 4.6 and Sonnet 4.6. Source: https://code.claude.com/docs/en/model-config

## 2. /compact, PreCompact, and summary shaping

- `/compact [instructions]` takes optional focus instructions for the summary. Source: https://code.claude.com/docs/en/commands
- PreCompact fires before compaction. Matcher values: `manual` (`/compact`) and `auto` (auto-compact and idle compaction). Source: https://code.claude.com/docs/en/hooks
- PreCompact input fields beyond the common fields: `trigger` ("manual" or "auto") and `custom_instructions` (the text passed to `/compact`, or `null` when none was given, and always `null` for auto). Example: `{"hook_event_name":"PreCompact","trigger":"manual","custom_instructions":null}`. Source: https://code.claude.com/docs/en/hooks
- PreCompact output: exit code 2 blocks compaction (stderr shown to user on manual). `{"decision":"block"}` also blocks. A blocked proactive compaction is skipped and the conversation continues. `systemMessage` and `continue` are discarded. No documented field lets PreCompact change the summary or inject content. Source: https://code.claude.com/docs/en/hooks
- PostCompact fires after compaction with `trigger` and `compact_summary` (the generated summary). It has no decision control and "can't affect the compaction result." Source: https://code.claude.com/docs/en/hooks
- Preservation levers that are documented: a "Compact Instructions" section in CLAUDE.md; `/compact <focus>`; and SessionStart hooks matching the `compact` source, whose output is added to the compacted context. Source: https://code.claude.com/docs/en/how-claude-code-works , https://code.claude.com/docs/en/costs , https://code.claude.com/docs/en/context-window
- SessionStart `source` values: `startup`, `resume`, `clear`, `compact`, `fork`. Output shape: `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}`. Source: https://code.claude.com/docs/en/hooks
- After compaction Claude Code re-reads up to five recently modified files (files over 5,000 tokens come back as a path reference only). Invoked skills are re-injected with a 5,000-token cap per skill. Path-scoped rules and nested CLAUDE.md files are summarized away unless they reload. The skill listing does not reload. Source: https://code.claude.com/docs/en/context-window
- Compaction summarization request inherits the session's extended-thinking setting (v2.1.198+). Source: https://code.claude.com/docs/en/context-window

## 3. Automatic context editing short of compaction

- Claude Code docs say: "It clears older tool outputs first, then summarizes the conversation if needed." Source: https://code.claude.com/docs/en/how-claude-code-works
- The prompt-cache stats text refers to "clearing old tool results from context" as an "expected rebuild." Source: https://code.claude.com/docs/en/costs
- Not documented for Claude Code: the names of the tool-result clearing mechanism, its trigger threshold, and its settings. Not documented: whether Claude Code strips thinking blocks.
- `/context` shows a colored grid by category with optimization suggestions. When the conversation exceeds the window, it shows how far over. Source: https://code.claude.com/docs/en/commands and https://code.claude.com/docs/en/errors
- Size limits on tool output that are documented:
  - `BASH_MAX_OUTPUT_LENGTH`: default 30000 characters, max 150000 (overridden by the `bashOutputMaxChars` setting). Source: https://code.claude.com/docs/en/env-vars
  - `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`: default 25,000 tokens. Source: https://code.claude.com/docs/en/env-vars
  - Hook output over 10,000 characters is saved to a file, with a preview of up to 2,000 characters and the path. Source: https://code.claude.com/docs/en/hooks
- `MAX_MCP_OUTPUT_TOKENS`: not verified (not reached in the pages I read).
- API context editing (not documented as used by Claude Code): beta header `context-management-2025-06-27`; `clear_tool_uses_20250919` (default trigger 100,000 input tokens; `keep` 3 tool uses; `clear_at_least` none; `exclude_tools`; `clear_tool_inputs` false); `clear_thinking_20251015`; available on all supported models. Source: https://platform.claude.com/docs/en/build-with-claude/context-editing
- API server-side compaction: `compact-2026-09-04` plus top-level `compaction` (on-demand, per the compaction overview). Threshold variant: `compaction` trigger `input_tokens`, default 150,000, minimum 50,000, beta header listed on that page as `compact-2026-01-12`. Source: https://platform.claude.com/docs/en/build-with-claude/compaction and https://platform.claude.com/docs/en/build-with-claude/compaction-threshold
- The threshold page does not mention Claude Code, so Claude Code's use of it is not documented.

## 4. Prompt caching in Claude Code

- Cache TTL is per request bucket. Main conversation: 1 hour on a Claude subscription within plan usage; 5 minutes on API key or cloud provider (or on subscription usage credits). Subagents, compaction, forks, titles, and other helper requests: 5 minutes (except server-controlled helper requests on subscription). Source: https://code.claude.com/docs/en/prompt-caching
- TTL controls: `promptCacheTtl` setting or `CLAUDE_CODE_PROMPT_CACHE_TTL` (`5m` or `1h`, v2.1.242+); `subagentPromptCacheTtl` or `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`; `ENABLE_PROMPT_CACHING_1H=1`; `FORCE_PROMPT_CACHING_5M=1`; subagent frontmatter `experimental.cacheTtl` (v2.1.248+). Priority order is in the prompt-caching page. Source: https://code.claude.com/docs/en/prompt-caching and https://code.claude.com/docs/en/settings-reference
- Disable caching: `DISABLE_PROMPT_CACHING`, plus per-family `DISABLE_PROMPT_CACHING_HAIKU`, `_SONNET`, `_OPUS`, `_FABLE`. Source: https://code.claude.com/docs/en/prompt-caching
- Documented cache invalidators: model switch (each model has its own cache); effort change (except on Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1 with API key or subscription); fast mode turned on (header in cache key); MCP server connect or tool add when tools load upfront (no invalidation when tool search defers tools); removing a tool on purpose (deny rule on bare tool name when tool search is unavailable); plugin enable/disable that brings MCP servers; `/compact`; removal of old images when limits are hit; Claude Code upgrade; `/model` switch or skill/command `model` frontmatter switch. Source: https://code.claude.com/docs/en/prompt-caching
- Documented cache-preserving actions: editing repo files (appends a system-reminder); editing CLAUDE.md mid-session (cache kept, but the edit does not apply until `/clear`, `/compact`, or restart); permission mode change; output-style change (sent as a message); skill and command invocation (inject as user messages); `/recap`; `/rewind`; spawning a subagent. Source: https://code.claude.com/docs/en/prompt-caching
- MCP tool-list changes are cache-invalidating only when tools load upfront. With tool search deferring tools (default on supported models), they are not. Source: https://code.claude.com/docs/en/prompt-caching
- Settings-based control: "For normal use, leave caching enabled." Caching policy can be set in managed settings `env`. Source: https://code.claude.com/docs/en/prompt-caching
- Not documented: whether a UserPromptSubmit `additionalContext` string is cached as part of the prefix. The docs say appended conversation messages (plan mode, skills) leave the cached prefix intact, which is the closest statement.
- The cache is scoped per machine and directory (system prompt embeds auto-memory paths and the directory announcement). Source: https://code.claude.com/docs/en/prompt-caching
- Minimum cacheable prompt for Opus 5.5: 512 tokens. Source: https://platform.claude.com/docs/en/models/opus-5-5/overview
- Cache counts are visible in `/usage` ("Prompt cache (main)" line, v2.1.251+) and the status line `prompt_cache` object. Source: https://code.claude.com/docs/en/costs and https://code.claude.com/docs/en/prompt-caching

## 5. Subagents and context

- Each subagent starts with a fresh isolated context window and does not see conversation history, invoked skills, or files already read. The parent gets a delegation message; the subagent "returns only the summary." For a fork, "only its final result comes back." Source: https://code.claude.com/docs/en/sub-agents
- Size cap on returned results: not documented.
- Forks share the parent's prompt cache ("Prompt cache: Shared with main session"); fork system prompt and tools match the parent. Non-fork subagents use a separate cache. Source: https://code.claude.com/docs/en/sub-agents
- Subagents support auto-compaction, triggered by their own window. `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` applies. Per-subagent frontmatter `autoCompactWindow` accepts 100000-1000000. Source: https://code.claude.com/docs/en/sub-agents
- Subagent requests fall into the "everything else" TTL bucket (5 minutes by default). Source: https://code.claude.com/docs/en/prompt-caching
- Fork mode is on by default in interactive sessions (v2.1.232+); `CLAUDE_CODE_FORK_SUBAGENT` overrides. Source: https://code.claude.com/docs/en/sub-agents

## 6. Context rot and effective context

- Anthropic: "As token count grows, accuracy and recall degrade, a phenomenon known as context rot." Source: https://platform.claude.com/docs/en/build-with-claude/context-windows
- "More context isn't automatically better." Source: same URL.
- Recommended maximum working context: not documented (no number). The docs point to the blog post "Effective context engineering for AI agents" (https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents). I did not fetch that post.
- Context awareness (token-budget injection) applies to Sonnet 5, Sonnet 4.6, Sonnet 4.5, and Haiku 4.5. It does NOT apply to Opus 4.7+, Sonnet 5.5, Fable 5.1, Mythos 5.1, Fable 5, Mythos 5, or Haiku 5.5, which get no injected budget tags (task budgets, a beta feature, are the alternative). Source: https://platform.claude.com/docs/en/build-with-claude/context-windows
- Thinking blocks on Opus 5.5, Fable 5.1, and Haiku 5.5 are kept by default and count toward the context window. Source: https://platform.claude.com/docs/en/build-with-claude/context-windows
- Memory tool guidance: just-in-time retrieval from `/memories`; memory is client-side; "ASSUME INTERRUPTION" framing; multisession initializer pattern. Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- Whether Claude Code uses the API memory tool: not documented. Claude Code's own auto memory (MEMORY.md, first 200 lines or 25KB loaded at start) is documented at https://code.claude.com/docs/en/memory .

## 7. Model facts

- Claude Fable 5.1 (model ID `claude-fable-5-1`, released Sept 1, 2026): context 1M, max output 128K, default effort `high`, adaptive thinking always on. Pricing: input $10, output $50, 5m cache write $12.50 (1.25x), 1h cache write $20 (2x), cache read $0.25 (0.025x). Source: https://platform.claude.com/docs/en/models/fable-5-1/overview and https://platform.claude.com/docs/en/about-claude/pricing
- Claude Opus 5.5 (model ID `claude-opus-5-5`, released Sept 22, 2026): context 1M, max output 128K (Batch API beta up to 300K with `output-300k-2026-03-24`), default effort `medium`. Pricing: input $4, output $20, 5m cache write $5 (1.25x), 1h cache write $8 (2x), cache read $0.20 (0.05x). Source: https://platform.claude.com/docs/en/models/opus-5-5/overview and https://platform.claude.com/docs/en/about-claude/pricing
- Fast mode on Opus 5.5 is priced separately: input $8, output $40 per MTok. Source: https://platform.claude.com/docs/en/about-claude/pricing
- Long-context pricing: 1M context is at standard rates for Claude 4.6+ models (except Haiku 5.5). Claude Haiku 5.5 is tiered at 100,000 input tokens: up to 100K is $0.10 input, $0.50 output, $0.125 5m write, $0.20 1h write, $0.01 cache read; over 100K is $0.50 input, $2.50 output, $0.625 5m write, $1 1h write, $0.05 cache read. Source: https://platform.claude.com/docs/en/about-claude/pricing
- Data residency with `inference_geo` US-only: 1.1x multiplier on all categories. Source: https://platform.claude.com/docs/en/about-claude/pricing
- Sonnet 5.5, for reference: $2 input, $10 output, $2.50 5m write, $4 1h write, $0.10 cache read (0.05x). Source: https://platform.claude.com/docs/en/about-claude/pricing

## 8. Hooks relevant to context

- Hook events in the events table: SessionStart, Setup, UserPromptSubmit, UserPromptExpansion, PreToolUse, PermissionRequest, PermissionDenied, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, MessageDisplay, SubagentStart, SubagentStop, TaskCreated, TaskCompleted, Stop, StopFailure, TeammateIdle, InstructionsLoaded, ConfigChange, CwdChanged, DirectoryAdded, FileChanged, WorktreeCreate, WorktreeRemove, PreCompact, PostCompact, PreModelSwitch, PostModelSwitch, Elicitation, ElicitationResult, SessionEnd. Source: https://code.claude.com/docs/en/hooks
- `additionalContext` is read from `hookSpecificOutput.additionalContext` (must include `hookEventName`). Events that accept it: SessionStart, SubagentStart, UserPromptSubmit, UserPromptExpansion, PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Stop, SubagentStop, PostModelSwitch. Source: https://code.claude.com/docs/en/hooks
- `systemMessage` is a top-level field, shown to the user as a warning. Some events discard it (PreCompact and PostCompact discard it). Source: https://code.claude.com/docs/en/hooks
- Size limit: `additionalContext`, `systemMessage`, `initialUserMessage`, and plain stdout are each capped at 10,000 characters. Over the limit, output goes to a session file with a 2,000-character preview. "There is no setting or environment variable to raise it." Source: https://code.claude.com/docs/en/hooks
- UserPromptSubmit `additionalContext` "can't replace the prompt; it only injects additionalContext alongside it." It is wrapped as a system reminder read on the next model request and is not shown as a chat message. Docs advise writing it as factual statements, not imperative instructions. Source: https://code.claude.com/docs/en/hooks
- Common input fields include `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode`, `prompt_id`, `scratchpad_dir`, `effort` (object with `level`), plus `agent_id` and `agent_type` for subagents. Source: https://code.claude.com/docs/en/hooks
- PreToolUse/PostToolUse exit code 2 cannot block a PostToolUse tool that already ran (stderr is surfaced). Source: https://code.claude.com/docs/en/context-window (hook tip)

## Caveats on coverage

- The hooks reference was read in chunks. I confirmed the PreCompact/PostCompact sections and the event list, but did not read every event section.
- Not reached: MAX_MCP_OUTPUT_TOKENS, the `ENABLE_TOOL_SEARCH` row, and the full env-vars list past `CLAUDE_CODE_PROVIDER_MANAGED`.
- The subagent return-size cap is not documented in what I read.
- Source pages (all fetched 2026-10-19): https://code.claude.com/docs/en/context-window , https://code.claude.com/docs/en/model-config , https://code.claude.com/docs/en/env-vars , https://code.claude.com/docs/en/prompt-caching , https://code.claude.com/docs/en/hooks , https://code.claude.com/docs/en/sub-agents , https://code.claude.com/docs/en/costs , https://code.claude.com/docs/en/commands , https://code.claude.com/docs/en/how-claude-code-works , https://platform.claude.com/docs/en/build-with-claude/context-windows , https://platform.claude.com/docs/en/build-with-claude/context-editing , https://platform.claude.com/docs/en/build-with-claude/compaction , https://platform.claude.com/docs/en/build-with-claude/compaction-threshold , https://platform.claude.com/docs/en/about-claude/pricing , https://platform.claude.com/docs/en/models/fable-5-1/overview , https://platform.claude.com/docs/en/models/opus-5-5/overview , https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool

If anything here conflicts with what you see in your CLI build, check `/context`, `/usage`, and `claude --version`, and send the discrepancy via /feedback.
