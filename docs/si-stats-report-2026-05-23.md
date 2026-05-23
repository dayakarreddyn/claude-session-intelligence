# Session Intelligence — Cross-Project Usage Report

**Generated:** 2026-05-23 · **Window:** trailing 365 days · **Source:** `~/.claude/state/si-events.db`
**Command:** `node tools/stats.js --days=365`

---

## Headline

| Metric | Value |
|---|---|
| Total spend (session cost) | **$5,622.49** |
| Sessions | 42 |
| Avg / session | $133.87 (all) · $193.88 (sessions with cost) |
| Avg / day | $15.40 |
| Tool calls | ~6,000 |
| Compacts | 88 |
| Zone crossings emitted | 292 (135 yellow / 126 orange / 31 red) |
| Tool-response archives | 6,263 snapshots · 218 MB on disk |

> **Two cost numbers, two meanings.** Headline "total spend" ($5.6k) is the sum of per-session
> end cost. The COMPACTS section's "total cost" ($30.9k) is the sum of cost-at-compact-time
> snapshots — cumulative session cost captured *each* compact, so a long session that compacts
> 10× contributes its running total 10 times. Use $5.6k for actual spend; $30.9k is a
> compact-burden indicator, not additional money.

---

## Per-Project Breakdown

| Project | Sessions | Cost | % of spend | Compacts | Archives |
|---|---:|---:|---:|---:|---:|
| **CSM** | 24 | **$4,902.01** | 87.2% | 68 | 5,178 |
| kodi | 2 | $347.42 | 6.2% | 0 | 263 |
| e2e | 1 | $168.96 | 3.0% | 2 | 162 |
| admin | 1 | $155.37 | 2.8% | 3 | 72 |
| claude-session-intelligence | 9 | $48.73 | 0.9% | 1 | 107 |
| kodi.scaffold-bak-39110 | 1 | — | — | 2 | 319 |
| proj-a | 1 | — | — | 4 | 0 |
| proj-b | 1 | — | — | 4 | 0 |

**CSM dominates everything** — 87% of spend, 77% of compacts (68/88), 83% of archives (5,178/6,263).
Any tuning of compact thresholds or archive retention should be validated against CSM data, not the
SI repo's own thin dataset. `proj-a`/`proj-b`/`kodi.scaffold-bak` carry null cost and look like
synthetic/test fixtures.

---

## Compact Behavior

| | |
|---|---:|
| Count | 88 |
| Avg tokens at compact | 294k |
| p50 / p90 tokens | 235k / 583k |
| min / max tokens | 14k / **1.34M** |
| With domain shift | 58 (66%) |

The recommended compact line is 200–300k tokens. **p90 is 583k and the max is 1.34M** — the long
tail compacts far too late. The 8 most-recent compacts (all CSM, all `manual`) show a monotonic
climb in one sitting:

```
317k → 344k → 364k → 408k → 450k → 477k → 522k → 556k
```

This is the classic "compact repeatedly without clearing, each pass starting heavier than the last"
pattern. 66% domain-shift rate reinforces it — most compacts span a topic boundary, where a `/clear`
+ handoff brief would be cheaper than dragging context forward.

---

## Zone Discipline

```
yellow  135  ████████████████████████
orange  126  ██████████████████████··
red      31  ██████··················
```

31 red-zone crossings = **11% of all crossings**. Sessions routinely push past the recommended
compact line before acting — consistent with the late-compact pattern above.

---

## Tool-Response Archive

| | |
|---|---:|
| Snapshots | 6,263 |
| Recalled | 20 (**0.3%**) |
| Total size | 218 MB |

The post-compact retrieval feature is **effectively unused**: 218 MB written across 6,263 snapshots,
recalled 20 times total. Either (a) the `/si expand` workflow isn't reaching for archives after
compact, or (b) the 4,096-char threshold over-captures. Worth a deliberate decision: raise the
threshold, add a retention cap, or surface archive availability more aggressively post-compact.

---

## Data-Quality Issues (actionable for SI itself)

1. **Peak tokens not populating.** `avg_peak` / `max_peak` are `null` for every session and every
   project. The headline "Peak tokens (max / avg)" renders `— / —`. The sessions table isn't
   receiving peak-token values from the shape tracker.

2. **Agent invocations = 0.** Despite the recently shipped `si-agent-tracker.js` /
   `agent_invocations` pipeline (verified end-to-end #31341–31342), the production DB shows
   `agents.n = 0`, so the AGENT INVOCATIONS section is suppressed entirely. Either the tracker
   isn't wired into the live plugin cache, or no Task calls have been recorded since deploy.
   Worth confirming the hook is firing in real sessions, not just the synthetic test.

3. **`red%` can exceed 100%.** `claude-session-intelligence` renders **200%** (reds=2, compacts=1).
   `renderProjects()` computes `fmtPct(reds, compacts)` — but red-zone crossings and compacts are
   distinct event types, so the ratio is meaningless once reds > compacts. Either rename the column
   to reflect "red crossings per compact" or denominate red% against total zone crossings.

---

## Top-Line Takeaways

- **One project (CSM) is the entire signal.** Treat the other rows as noise/fixtures.
- **Compact late, compact often.** p90 583k / max 1.34M and the 317k→556k same-session climb are the
  clearest cost lever — earlier `/compact` and topic-boundary `/clear` would cut the heavy tail.
- **Archives are write-only.** 218 MB, 0.3% recall. Decide whether to keep, cap, or surface.
- **Three telemetry gaps** (peak tokens, agent invocations, red% math) are degrading the report's
  own fidelity and are fixable in the SI codebase.
