# Session Intelligence — launch thread

Target: Twitter/X. 11 tweets. Candid voice.
Images live in [`docs/assets/launch/`](./assets/launch/).

---

## 1/ 🧵 candid launch

shipped a Claude Code plugin after weeks of dogfooding: **session-intelligence**.

built it because i lost sleep. literal 3am sessions watching `/compact` nuke the exact file tree claude needed 20 minutes later, then watching it re-read, re-guess, re-drift.

1M context is a big room. doesn't stop it from getting messy.

grounded in @trq212's research on where coding sessions actually rot → https://x.com/trq212/status/2044548257058328723

---

## 2/ the myth of "just use a bigger context"

Anthropic shipped 1M. great. but context is the model's **working memory, not a database.**

every token is re-processed every turn. attention compute scales. signal-to-noise degrades as irrelevant tokens pile in. empty space in the window isn't free — used context shapes every decision, even the parts that stopped being load-bearing hours ago.

**Image:** `B-working-memory-not-database.svg`

---

## 3/ rot is task-dependent, not a cliff

from my own dogfood notes:

| task | where quality slips |
|---|---|
| needle-in-haystack | near-perfect to 1M |
| single-doc QA | strong to 500k+ |
| **multi-step coding (dependent decisions)** | **~150–250k** |
| maintaining voice/style | ~200k |
| scattered requirements across sessions | ~250–350k |
| complex synthesis, distractor-heavy | ~300k |

coding hits the sharpest curve. every stale choice becomes a distractor for the next one.

**Image:** `A-rot-is-task-dependent.svg`

---

## 4/ the sleepless-nights version

you've felt this:

→ claude cites a decision from 80k tokens ago that no longer applies
→ it re-reads a file it wrote itself
→ it "forgets" the pattern it established in turn 12
→ auto-compact fires and the resume feels like a stranger wrote your code

that's not a bug. that's attention economics + lossy summarization meeting your 4-hour refactor.

---

## 5/ auto-compact isn't raw compression

it's **LLM summarization**. claude reads its own conversation and produces a 9-section structured summary (primary request, files, decisions, next step…). recent turns kept verbatim. older turns collapse.

intelligent in shape. still lossy. **no awareness of which details were load-bearing.** it guesses from recency + structure. that guess is where your afternoon disappears.

**Image:** `C-compact-is-summarization.svg`

---

## 6/ the USP: longer sessions without rot

SI doesn't replace compaction. it **makes compaction intelligent.**

- live statusline with zones: yellow 200k / orange 300k / red 400k — the empirical inflection points, not failure points
- **post-compact resume banner** — ground-truth map injected so the summarizer doesn't have to guess
- **regret detection** — three-band scoring of which dirs got touched after compact
- **adaptive zones** — after 5 compacts it learns *your* pattern. if you ship fine at 450k, orange drifts to 400k. if you drift at 250k, orange tightens

**Image:** `D-zones.svg`

---

## 7/ why this matters even if you have 1M

a 400k context costs ~5× more per turn than 80k. prompt cache helps on re-reads, not on attention compute against the cached blob.

compacting at 300k is a **quality habit AND a cost habit.** SI watches both. expensive session? warnings tighten inward. stable session? they relax outward.

**Image:** `F-cost-dimension.svg`

---

## 8/ regret, actually measured

after every compact, SI snapshots hot/warm/dropped dirs. every tool call post-compact is scored:

- 🔴 **hard regret** — you re-opened a *dropped* dir (compact threw away something load-bearing)
- 🟢 **positive hit** — *hot* dirs still in play (compact worked)
- 🟡 **soft regret** — *warm* dir pulled back (you compacted too early)

the plugin learns from itself. the thresholds that warned you today are informed by what you regretted yesterday.

**Image:** `E-three-band-regret.svg`

---

## 9/ the boring plumbing nobody tweets about

- SessionStart stdout is model-only. stderr is your only user-visible channel. compact suppresses stderr. so the resume banner has to ride `systemMessage` through a hookSpecificOutput JSON payload. took a week to figure out.
- hook registration has to be global or it gets stomped by per-project configs.
- rename-to-owned writes for POSIX-atomic snapshot consumes.

one line each now. 🫡

---

## 10/ what this buys you

→ 4-hour refactor sessions that don't forget their own decisions
→ resumed context that actually resumes
→ a statusline that tells you *when* to compact, not after
→ thresholds that adapt to your workflow instead of fighting it

not magic. just signals that were always there, now surfaced.

---

## 11/

```
/plugin install session-intelligence
```

or clone + `./install.sh`. MIT. dogfooded through the writing of this very thread.

if you've lost an evening to post-compact amnesia even once — try it for a day.

repo: [link] · issues welcome · candor appreciated.

---

## Image attachment plan

| tweet | attach |
|---|---|
| 2 | `B-working-memory-not-database.svg` (export PNG) |
| 3 | `A-rot-is-task-dependent.svg` ⭐ hero |
| 5 | `C-compact-is-summarization.svg` |
| 6 | `D-zones.svg` |
| 7 | `F-cost-dimension.svg` |
| 8 | `E-three-band-regret.svg` |

Export SVGs to PNG @ 1600×900 before uploading — Twitter doesn't render SVG attachments.

```sh
# quick batch with rsvg-convert (brew install librsvg)
for f in docs/assets/launch/*.svg; do
  rsvg-convert -w 1600 "$f" -o "${f%.svg}.png"
done
```
