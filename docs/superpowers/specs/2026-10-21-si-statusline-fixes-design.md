# SI statusline fixes — design

**Date:** 2026-10-21 · **Branch:** `feat/si-statusline-fixes` (off `fix/si-hook-robustness` @ c061b79) · **Source audit:** `~/.claude/projects/-Users-0xd-DWS-claude-session-intelligence/memory/reference_statusline_audit_2026_10_19.md` (12 ranked defects) · **Schema reference:** `memory/reference_statusline_stdin_schema.md` (docs fetched 2026-10-21) · **Code map:** scratchpad `statusline-code-map.md` (HEAD line anchors; regenerate if lost).

## Problem

`statusline/statusline-intel.js` (2,132 lines, no exports, no `require.main` guard) renders the SI status line on every redraw. The 2026-10-19 audit found twelve defects: one cell never renders, one cell is fabricated, one is ~5× overcounted, two caches live in a dir macOS wipes, a 550 MB transcript breaks the economics line every render, a quota cell triggers a network poll regardless of stdin, user zone config is silently overridden, unknown models render a 260 % bar, the README describes a different renderer, and dead code / log noise accumulate. None of it is unit-testable today because the file runs `main()` on `require`.

## Decisions

1. **Split first, fix second.** One mechanical, behaviour-preserving split of the statusline into `statusline/{lib-loader,format,git-info,economics,zones,renderers}.js` plus a thin entry file with a `require.main === module` guard, guarded by a golden-output test over the seven captured stdin payloads. Every later fix is then a small edit in a file under 800 lines with a direct unit test. Goldens are re-captured only by the task that intends the change; the golden diff is the behaviour-change record a reviewer checks.
2. **Truth source order for context size:** transcript usage (`lib/transcript-usage.js`) stays primary (it already carries the model and the per-call context for the zone gate); `context_window.context_window_size` from stdin stays the cap source. When the cap is a guess (`source === 'fallback'`: no stdin size, no config, model id unknown) the `tokens` cell renders `used/?` with no bar, no percentage and no zone colour rather than a bar against 200 k.
3. **Zones:** the adaptive learner never replaces zones in `absolute` mode, and a per-project `zones` override implies `absolute` for that project. Fraction mode keeps today's behaviour.
4. **Economics:** one chunked, bounded transcript scanner in `lib/cost-estimation.js` (4 MiB chunks, 64 MiB per render, offset persisted so a cold 550 MB transcript is absorbed over a few renders); the statusline's duplicate scanner is deleted; caches move to `~/.claude/state` (`claude-cost-<sid>.v5.json`, `claude-cost-sincecompact-<sid>.v4.json`). Cache-savings cells stay calibrated by the official/transcript cost ratio but are labelled `~s$` because that ratio is an SI estimate, and the README states the method.
5. **Quota cells:** stdin `rate_limits` is authoritative. `spend_limit` renders as a budget (`$used/$limit period` when the USD fields exist, else `sl:NN%`), never as a model quota. `modelQuota` renders only poller-derived per-model quotas, and the poller runs only when stdin carries no `rate_limits` object at all; a cache older than its TTL or carrying an error renders with `~`. `buildRenderers` takes `loadUsage` as an injectable dependency so tests count calls without touching the network.
6. **Thinking:** exact `usage.output_tokens_details.thinking_tokens`, last value per `message.id` wins (streamed rows repeat cumulative usage); the residual estimator survives only for transcripts without the field and its result renders with a `~` prefix.
7. **Token speed:** the whole-session fallback (output tokens ÷ total API time) is deleted; no speed, no cell.
8. **Hygiene:** `costBand`, `readCostSnapshot` and the fabricated `wr:` code go; `f36d096` is cherry-picked for the `modelSplit` cell; the `sqlite driver` debug line logs only when the fallback driver is in use; the SessionStart sweep covers `claude-cost-*`, `claude-compact-prefix-*`, `claude-compact-snapshot-*`, `claude-health-*`, `claude-usage-lock-*`; tests stop leaking fixtures into the real `os.tmpdir()`; the CLAUDE.md injection template states the real tool-archive dir (`~/.claude/state/…`, not `${TMPDIR}`).
9. **README:** the statusline section is regenerated from the golden render of the `a_fable_1m_48pct` fixture and guarded by a drift test; five lines, six-char `sid`, the real `tokenFlow` definition, the new cells, and a truthful quota paragraph.

## Out of scope

Reading `context_window.used_percentage` as the primary context source (the transcript reader is one tier old and already feeds the zone gate; revisit when `current_usage` nulls after compact are handled there), long-context pricing tiers for Claude 5 models (facts unknown), the `cmp:` cell semantics (already reworked), per-project colour themes.

## Verification

`npm test` (Node 20), `npm run test:node22`, `SI_SQLITE_DRIVER=node:sqlite npm run test:node22` all green; every `statusline/*.js` under 800 lines; `npm run sync`; a live render through `~/.claude/scripts/si-statusline-chain.sh` with a captured payload shows five lines, a `tools` cell, no `wr:`; a run of the suite with `TMPDIR` set to an empty directory leaves no `claude-*` files behind.
