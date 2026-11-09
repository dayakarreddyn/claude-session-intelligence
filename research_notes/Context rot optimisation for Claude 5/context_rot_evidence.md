# Empirical evidence on long-context degradation ("context rot") in frontier LLMs, with emphasis on Claude models in agentic coding sessions (as of 2026-10-19)

Scope note for the report writer: every quantitative claim below carries a URL. "Measured" means the number comes from an experiment reported by the source; "recommendation" or "claim" means the source asserts it without reported measurement. Older (2023–2024) results are marked as such. Where a primary source could not be read (JS-rendered leaderboards, PDF-only sections), that is stated in Gaps rather than filled from memory.

Access notes: the Chroma report's per-length accuracy curves are chart-only (the page text gives few exact values); the Fiction.LiveBench primary page is JavaScript-rendered and its per-length table could not be extracted; the Opus 5.5 System Card was downloaded and section 8.10/8.12 text extracted locally via macOS PDFKit.

---

## Key Question 1: What do the major studies report about performance vs. input length (curves, thresholds, Claude numbers)?

### Takeaway
Every controlled study finds monotone, gradual degradation with input length that begins far below the advertised window (NoLiMa: 2024-era models lose >15% of their own baseline by 2K–8K tokens; Claude 3.5 Sonnet's "effective length" was 4K of a 200K window). The 2026-era Claude 4.6 models hold up much better on retrieval-style tests (MRCR v2 8-needle: Opus 4.6 93% at 256K, 76% at 1M) but still show measurable long-context decay in agentic transcripts (Opus 4.6 thinking: needle-injection recall 99.7% at 100K → 69% at 800K), and the dominant failure drivers are distractors, structural coherence of the haystack, and low needle-question similarity rather than raw length alone.

### Cited Findings

**Chroma "Context Rot" technical report (Hong, Troynikov, Huber; 14 July 2025; 18 models incl. Claude Opus 4, Sonnet 4, Sonnet 3.7, Sonnet 3.5, Haiku 3.5)**
- Each needle/haystack combination was tested across 8 input lengths and 11 needle positions; refusals were 69 of 194,480 LLM calls (0.035%) — [Chroma](https://www.trychroma.com/research/context-rot)
- Needle-question similarity: pairs with lower cosine similarity (ranges 0.445–0.775 for PG essays, 0.521–0.829 for arXiv) "show faster degradation as input length grows"; needle position showed "no notable variation" (measured; exact slopes chart-only) — [Chroma](https://www.trychroma.com/research/context-rot)
- Distractors: "Even a single distractor reduces performance relative to the baseline," and four distractors "compound this degradation further"; distractor impact is non-uniform (distractors 2 and 3 appear most often in hallucinated answers) — [Chroma](https://www.trychroma.com/research/context-rot)
- Claude-specific behaviour: Claude models had the lowest hallucination rates; "Sonnet 4 and Opus 4 tend to abstain when uncertain"; GPT models had the highest hallucination rates — [Chroma](https://www.trychroma.com/research/context-rot)
- Haystack structure: shuffled haystacks outperformed logically ordered ones "across all 18 models and configurations" — "structural coherence consistently hurts model performance" (effect sizes chart-only) — [Chroma](https://www.trychroma.com/research/context-rot)
- LongMemEval focused vs full: 306 prompts; full prompts average ~113k tokens, focused prompts ~300 tokens; "All models scored significantly higher on focused prompts"; Claude models showed the largest focused-vs-full gap, "mostly from abstentions"; Opus 4 and Sonnet 4 most conservative — [Chroma](https://www.trychroma.com/research/context-rot)
- Repeated-words task (12 lengths from 25 to 10,000 words): performance "consistently degrades across all models" as length increases; Claude Opus 4 refused 2.89% of attempts (copyright concerns / claimed inconsistencies), refusals beginning around 2,500 words; GPT-4.1 refusal rate 2.55%, typically from ~2,500 words; Sonnet 3.5 outperformed newer Claude models up to its 8,192-token output limit; GPT-3.5 Turbo excluded after refusing 60.29% — [Chroma](https://www.trychroma.com/research/context-rot)

**NoLiMa (Modarressi et al., Adobe Research; v3 9 July 2025, ICML 2025; 13 models) — 2025 data on 2024-era models**
- "At 32K, 11 models fall below 50% of their short-context baselines"; GPT-4o drops from 99.3% to 69.7% — [arXiv abs](https://arxiv.org/abs/2502.05167)
- Claude 3.5 Sonnet row (accuracy %): base 87.5 (threshold 74.4) | 1K 85.4 | 2K 84.0 | 4K 77.6 | 8K 61.7 | 16K 45.7 | 32K 29.8; claimed length 200K, effective length 4K — [arXiv HTML Table 3](https://arxiv.org/html/2502.05167v3)
- Effective length is defined as the longest tested length at which score stays above 85% of the model's own base score; GPT-4o effective length 8K, Gemini 1.5 Pro 2K, Llama 3.3 70B 2K — [arXiv HTML](https://arxiv.org/html/2502.05167v3)
- NoLiMa-Hard at 32K: o1 99.9→31.1, o3-mini 98.8→18.9, DeepSeek R1-Distill-70B 99.9→20.7 (reasoning does not rescue long-context latent retrieval) — [arXiv HTML Table 5](https://arxiv.org/html/2502.05167v3)

**RULER (Hsieh et al., NVIDIA; Apr 2024, v3 Aug 2024; 17 models) — OLDER**
- "almost all models exhibit large performance drops as the context length increases" despite near-perfect vanilla NIAH; "only half of them can maintain satisfactory performance at the length of 32K" — [arXiv](https://arxiv.org/abs/2404.06654)
- GPT-4 at 128K scored 81.2% on RULER (secondary compilation) — [yage.ai long-context survey, 15 Mar 2026](https://yage.ai/share/long-context-benchmark-en-20260315.html)

**Lost in the Middle (Liu et al.; July 2023, v3 Nov 2023) — OLDER, includes Claude-1.3**
- Models: MPT-30B-Instruct, LongChat-13B, GPT-3.5-Turbo (4K/16K), Claude-1.3, Claude-1.3 (100K); multi-document QA with 10/20/30 documents on 2,655 NaturalQuestions-Open queries — [ar5iv](https://ar5iv.labs.arxiv.org/html/2307.03172)
- GPT-3.5-Turbo, 20 docs: answer at position 0 → 75.8%, middle (index 9) → 53.8%, end → 63.2%; closed-book 56.1%, oracle 88.3%; "GPT-3.5-Turbo's multi-document QA performance can drop by more than 20%" and worst-case falls below closed-book — [ar5iv](https://ar5iv.labs.arxiv.org/html/2307.03172)
- Claude-1.3, 20 docs: 59.9% (start) / 56.8% (index 9) / 57.2% (index 14) / 60.1% (end); 30 docs: 59.1 / 55.7 / 56.4 / 59.9; closed-book 48.3%, oracle 76.1% (a shallower U than GPT-3.5) — [ar5iv](https://ar5iv.labs.arxiv.org/html/2307.03172)
- "Claude-1.3 and Claude-1.3 (100K) do nearly perfectly on all evaluated input context lengths" on synthetic key-value retrieval — [ar5iv](https://ar5iv.labs.arxiv.org/html/2307.03172)

**LongMemEval (Wu et al.; Oct 2024, ICLR 2025) — OLDER**
- 500 curated questions testing information extraction, multi-session reasoning, temporal reasoning, knowledge updates, abstention; commercial chat assistants and long-context LLMs show "a 30% accuracy drop on memorizing information across sustained interactions" — [arXiv](https://arxiv.org/abs/2410.10813)

**MRCR v2 (8-needle) — the 2026 long-context retrieval numbers for Claude 4.6**
- Anthropic (5 Feb 2026): Claude Opus 4.6 scores 76% on MRCR v2 8-needle at 1M vs 18.5% for Sonnet 4.5; "This is a qualitative shift in how much context a model can actually use while maintaining peak performance" (Anthropic's own eval, max thinking) — [Anthropic Opus 4.6 announcement](https://www.anthropic.com/news/claude-opus-4-6)
- Compiled from system cards (secondary, flags non-comparability across vendors' reasoning settings): Opus 4.6 256K 93.0% / 1M 76.0%; Sonnet 4.6 128K 84.9% / 256K 90.3% / 1M 65.8%; Sonnet 4.5 256K 10.8% / 1M 18.5%; GPT-5.2 256K 70.0%; GPT-5.4 512K–1M range 36.6%; Gemini 3 Pro 256K 45.4% / 1M 24.5–26.3%; Gemini 3.1 Pro 128K 84.9% / 1M 26.3%. Graphwalks 1M parents: Opus 4.6 71.1%, GPT-5.2 72.0%; BFS both ~40% — [yage.ai, 15 Mar 2026](https://yage.ai/share/long-context-benchmark-en-20260315.html)
- The same compilation warns scores "cannot be directly compared" across sources (OpenAI xhigh reasoning vs Anthropic max thinking vs contextarena standardized settings; range-level vs sample-weighted averaging) — [yage.ai](https://yage.ai/share/long-context-benchmark-en-20260315.html)

**Long-context degradation inside agent transcripts (2026)**
- Anthropic Fellows "Classifier Context Rot" (Martin & Roger; 12 May 2026): monitors classifying coding-agent transcripts for dangerous actions miss them "2× to 30× more often" after 800K tokens of benign activity; Opus 4.6 (thinking) MonitorBench recall fell "98.6% to 88%" with an 800K benign prefix; needle-injection recall "from 99.7%" at 100K to "69%" at 800K; "performance is worst in the middle" — non-thinking Opus 4.6 with 500K tokens before and 100K after the event falls to 5% detection; thinking Opus is "much more resistant" — [arXiv 2605.12366](https://arxiv.org/html/2605.12366v1)
- "Diagnosing and Mitigating Context Rot in Long-horizon Search" (Xia et al., SJTU/GAIR; Aug 2026; open models only — GLM-4.7, GLM-5.0, Qwen3.5-397B, MiniMax-M2.5): "premature termination" (give-up / uncertain-incorrect) rate rises with trajectory length; summary-threshold sweep on Qwen3.5 (BrowseComp): 32K → PT 2.4%, 48K → 7.2%, 64K → 20.2% — [arXiv 2606.29718](https://arxiv.org/html/2606.29718v2)
- "When and How Context Rot Appears in Coding Agents" (Xue, CertiK; Aug 2026; Codex + gpt-5.4-mini): clean context 10,991 chars passed 8/10 runs; relevant-long and irrelevant-long contexts (299,140 chars each) passed 3/10 each (failure 20%→70%, Fisher p=0.0698); "the study cannot identify a universal or monotonic onset"; a 90K-char failure appeared once and did not reproduce — [arXiv 2607.17937](https://arxiv.org/html/2607.17937v2)
- "How Fast Do Agents Rot?" (Mittal; 31 Aug 2026; 9 models incl. Claude-3-Haiku, GPT-4o-mini, Gemini-2.5-Flash-Lite): on the agentic ToolQA task every model "falls from near-perfect success to near zero within sixteen steps"; Claude-3-Haiku success at H=2/4/8/16 = 1.00/0.47/0.00/0.00; mean per-step accuracy falls from 0.58 (first third of trajectory) to 0.44 (last third); 10,664 trajectories — [arXiv PDF 2609.01660](https://arxiv.org/pdf/2609.01660)
- Same study: "Degradation is driven by step count rather than context length: bounding the context window steepens decay rather than easing it (logit slope −0.69 vs. −0.44, p=3×10⁻⁶)"; padded single-turn regime −0.40 (indistinguishable from natural) — [arXiv PDF 2609.01660](https://arxiv.org/pdf/2609.01660)

**Vendor framing (recommendation, not measurement)**
- Anthropic (29 Sep 2025): "Context, therefore, must be treated as a finite resource with diminishing marginal returns"; degradation is gradual — "models remain highly capable at longer contexts but may show reduced precision" — [Anthropic engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Claude Code docs: "Most best practices are based on one constraint: Claude's context window fills up fast, and performance degrades as it fills... When the context window is getting full, Claude may start 'forgetting' earlier instructions or making more mistakes." — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)

### Inferences
- Degradation is continuous, not a cliff; there is no single fill percentage at which quality collapses. Across studies the shape is: small loss by 32K–64K on hard retrieval (NoLiMa 2024-era), noticeable loss by 256K–1M on multi-needle retrieval even for Opus 4.6 (93%→76%), and larger loss in agentic monitoring tasks between 100K and 800K (99.7%→69%).
- Claude models' characteristic long-context failure is abstention/refusal rather than hallucination (Chroma; corroborated by Claude 4 behaviour on distractors). For a coding agent this looks like "giving up" or declaring done, consistent with the "premature termination" finding in long-horizon search.
- Two 2026 agent studies disagree on mechanism: Mittal attributes decay to dependent step count and finds truncation makes it worse; the SJTU search paper and Chroma attribute it to accumulated content. Both are consistent with: context length per se is less important than what the context contains and how many dependent decisions have accumulated.

### Gaps
- Chroma's per-length accuracy values and distractor effect sizes are only in charts; the page text does not give numbers at 32K/128K/200K for the Claude 4 models.
- No NoLiMa-style evaluation of Claude 4.x or 5.x models was found; NoLiMa's Claude data is Claude 3.5 Sonnet only.
- Fiction.LiveBench per-length Claude scores (0–192k columns) could not be extracted: the primary page ([fiction.live](https://fiction.live/stories/Fiction-liveBench-Feb-21-2025/oQdzQvKHw8JyXbN87)) is JS-rendered; aggregators show single numbers with unstated length (Claude Opus 4.5 37.50, Claude 3.7 Sonnet 53.10, GPT-5.2 96.90 per [neosignal/Epoch data](https://neosignal.io/benchmarks/fiction-livebench); LLMLearner uses the 16k column where Claude Sonnet 3.7 scored 50.0, GPT-5 97.2 per [llmlearner](https://llmlearner.com/rankings/fiction-livebench)). Treat as unresolved.
- RULER results for any Claude model were not found in the paper abstract or compilations.

---

## Key Question 2: Is there evidence specific to Claude 5-era models (Opus 5.5, Fable 5.1, Sonnet 5.5) on long-context benchmarks?

### Takeaway
Anthropic published no MRCR/needle-style long-context number for any Claude 5-series model; the Opus 5.5 System Card's "Long context" section reports only ProgramBench (agentic coding up to the full 1M window): Opus 5.5 91.2%, Fable 5.1 87.6%, Opus 5 85.4%. The last published Anthropic retrieval-style long-context numbers are for Opus 4.6 / Sonnet 4.6 (Feb 2026). Anthropic's own cost documentation gives the only measured Claude context-management lever data and notes that on 5.x models rewriting earlier tool results invalidates subsequent thinking blocks, so server-side compaction is the recommended lever.

### Cited Findings
- Opus 5.5 System Card (22 Sept 2026), section 8.10 "Long context" contains one benchmark, ProgramBench (200 program-reconstruction tasks, 166 retained, graded on 247,000+ behavioral tests, mini-swe-agent harness, no six-hour limit): "Claude Opus 5.5 scored 91.2%, whereas Claude Fable 5.1 scored 87.6% and Claude Opus 5 scored 85.4%"; "Opus 5.5 episodes cover a range of context lengths up to the full 1M token window" — [Opus 5.5 System Card PDF, p.183–184](https://www-cdn.anthropic.com/fc1b44717c85dc068bc6ba5024219938094694bd/Claude%20Opus%205.5%20System%20Card.pdf)
- Same card: HLE runs capped total tokens at 1M and "Context compaction was not used for these results"; DRACO and WANDR agentic-search evals used a 980k-token task budget — [Opus 5.5 System Card PDF, p.184–188](https://www-cdn.anthropic.com/fc1b44717c85dc068bc6ba5024219938094694bd/Claude%20Opus%205.5%20System%20Card.pdf)
- Same card, section 8.12 multi-agent ProgramBench: single-agent baseline "uses context compaction and a 20M token budget" (vs 1M budget in 8.10) so token expenditure is not a confounder — [Opus 5.5 System Card PDF, p.189](https://www-cdn.anthropic.com/fc1b44717c85dc068bc6ba5024219938094694bd/Claude%20Opus%205.5%20System%20Card.pdf)
- The Opus 5.5 announcement page "contains no statements or numbers about long context" (no MRCR, no needle, no context-rot wording); it cites an 18-hour customer task and that Opus 5 "took over 20 hours and used 2.5x as many tokens" on a coding audit — [Anthropic Opus 5.5 announcement](https://www.anthropic.com/claude-opus-5-5)
- Specs: Opus 5.5, Fable 5.1, Sonnet 5.5, Haiku 5.5 all have 1M context and 128K max output; "1M tokens is roughly 555k words or 2.5M Unicode characters on the current tokenizer (introduced with Claude Opus 4.7); models before it fit about 750k words in 1M tokens" — [Opus 5.5 platform overview](https://platform.claude.com/docs/en/models/opus-5-5/overview)
- Claude Code defaults: "Models running with a native 1M window compact before the window fills, at about 967K tokens by default. These include the Fable models, Sonnet 5 and later, Haiku 5.5, and Opus 4.7 and later"; Opus 4.6/Sonnet 4.6 without extended context compact at the 200K boundary; `/autocompact` accepts 100K–1M — [Claude Code model-config](https://code.claude.com/docs/en/model-config)
- Measured context-lever economics (Anthropic, "earlier model" unnamed): "On the 20-issue run the levers saved little or nothing, and context editing made the run cost more"; chart: context editing adds 73% on the short run; on the long run compaction saves 32% and pruning 39% while "context editing changed nothing" — [Anthropic cost docs](https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence)
- Same page, 5.x-specific caveat: "on Claude Fable 5.1, Claude Opus 5.5, Claude Sonnet 5.5, and Claude Haiku 5.5, rewriting an earlier tool result invalidates every thinking block after it, so use compaction instead... On these four models, context editing and compaction run on the server and don't invalidate thinking blocks" — [Anthropic cost docs](https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence)
- Last Anthropic retrieval-style numbers: Opus 4.6 76% on MRCR v2 8-needle at 1M vs Sonnet 4.5 18.5% (5 Feb 2026) — [Anthropic](https://www.anthropic.com/news/claude-opus-4-6); Opus 4.6 256K 93.0%, Sonnet 4.6 128K 84.9% / 256K 90.3% / 1M 65.8% (compiled from system cards) — [yage.ai](https://yage.ai/share/long-context-benchmark-en-20260315.html)
- Most recent Claude-specific agent-transcript degradation data is on Opus 4.6: needle-injection recall 99.7% (100K) → 69% (800K) with thinking; MonitorBench recall 98.6% → 88% with 800K benign prefix; non-thinking mid-transcript position → 5% — [arXiv 2605.12366](https://arxiv.org/html/2605.12366v1)
- Secondary: Zvi Mowshowitz's system-card review names "Very long trajectories" as "a known weak spot" in the card's blind-spots list (6.4.11); it does not cover section 8.10 — [thezvi.substack.com](https://thezvi.substack.com/p/claude-opus-55-the-system-card)
- Secondary: a March 2026 compilation states Anthropic's last long-context benchmark number dates from the Opus 4.6 launch and the Opus 5.5 announcement "published no new long-context benchmark" — [yage.ai](https://yage.ai/share/long-context-benchmark-en-20260315.html); this is consistent with what the system card contains.

### Inferences
- For Claude 5-era models the only Anthropic-published long-context evidence is end-to-end agentic coding success at up to 1M tokens (ProgramBench), which is more ecologically valid for coding agents than needle tests but does not isolate degradation vs. fill level.
- The 3.6-point Fable 5.1 vs Opus 5.5 gap and 5.8-point Opus 5 vs Opus 5.5 gap on ProgramBench suggest generation-over-generation gains in long-horizon coding, but the eval mixes context length with capability, so it cannot be read as a context-rot curve.
- Claude Code's default of compacting at ~967K on 1M models means a 5.x session can spend most of its life in the 200K–900K regime where Opus 4.6 showed 10–30 point recall drops on transcript-monitoring tasks; earlier manual/configured compaction (e.g., `/autocompact 300k`) is the obvious lever, though no Claude 5.x-specific threshold has been measured.
- Because thinking-block invalidation on 5.x models penalises client-side tool-result rewriting, the measured "prune −39%" lever from the earlier model is not directly transferable; server-side compaction is the sanctioned path on 5.x.

### Gaps
- No MRCR v2, NoLiMa, RULER, Fiction.LiveBench-per-length, or needle-style score for Opus 5.5, Opus 5, Fable 5.1, Fable 5, Sonnet 5.5, Sonnet 5, or Haiku 5.5 was found in Anthropic materials or third-party benchmarks. A Fable 5.1 system card was not located in search.
- Anthropic's measured lever numbers (compaction −32%, prune −39%) are cost figures on an unnamed "earlier model"; no quality/accuracy effect of compaction on 5.x models is published.
- The Opus 5.5 card's HLE/DRACO/WANDR results show accuracy vs. cost across effort levels, not accuracy vs. context fill.

---

## Key Question 3: Which content types hurt most in agent transcripts (large tool outputs, repeated reads, verbose thinking, old plans, error logs)? Measured evidence only.

### Takeaway
The best-measured culprit is raw tool observations: they are ~84% of a SWE-agent turn, and simply masking old observations halves cost with no solve-rate loss (JetBrains), while Anthropic measured a 29% task improvement and 84% token reduction from clearing stale tool results. Distractors (plausibly related but wrong content), structurally coherent long passages, and low-similarity needles are the measured degraders in controlled studies; accumulated failed attempts and side-constraints buried early in the transcript are the measured losses in agent-specific studies. There is no controlled measurement isolating "verbose thinking" or "old plans" as degraders.

### Cited Findings

**Tool outputs / observations (measured)**
- Observation tokens make up "around 84%" of an average SWE-agent turn (SWE-bench Lite-50 preliminary runs) — [JetBrains "Complexity Trap", arXiv 2508.21433 v3, Oct 2025](https://arxiv.org/html/2508.21433v3)
- SWE-bench Verified (500 instances) solve rate / cost per instance: Qwen3-Coder-480B raw 53.4% / $1.29; observation masking (window M=10) 54.8% (+2.6%) / $0.61 (−52.7%); LLM summary 53.8% (+0.7%) / $0.64 (−50.4%). Gemini 2.5 Flash raw 32.8% / $0.41; masking 35.6% / $0.18; summary 36.0% / $0.24. Gemini 2.5 Flash (thinking) raw 40.4%; masking 36.4% (−9.9%); summary 31.4% (−22.3%) — [JetBrains, Table 1](https://arxiv.org/html/2508.21433v3)
- LLM summarisation caused "trajectory elongation" (mean 52 turns vs 44 masking vs 50 raw on Gemini 2.5 Flash; ~15% longer than raw for Qwen3-Coder) and summary calls were up to 7.2% of instance cost; authors position summarisation as a "last resort" for bounding very long trajectories — [JetBrains](https://arxiv.org/html/2508.21433v3)
- Anthropic (29 Sep 2025), internal agentic-search eval: "Context editing alone delivered a 29% improvement"; memory tool + context editing "improved performance by 39% over baseline"; in a 100-turn web search eval, context editing "reduc[ed] token consumption by 84%" and let agents finish workflows that otherwise failed from context exhaustion; context editing "automatically clears stale tool calls and results from within the context window when approaching token limits" — [claude.com/blog/context-management](https://claude.com/blog/context-management)
- ACON (Oct 2025, v3 Jun 2026): compressing observations and interaction history "reduces peak token usage by 26-54%" while improving task success over compression baselines on AppWorld, OfficeBench, Multi-objective QA; distilling the compressor into smaller models gives "up to 46% performance improvement", attributed by the authors to reduced context distraction — [arXiv 2510.00615](https://arxiv.org/abs/2510.00615)
- Anthropic cost docs (earlier model, measured): on a long run, pruning stale tool results to one-line extracts at task boundaries saved 39%, compaction 32%, context editing 0%; on a short 20-issue run context editing added 73% cost — [Anthropic cost docs](https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence)
- Claude Code's documented order of operations: "It clears older tool outputs first, then summarizes the conversation if needed. Your requests and key code snippets are preserved; detailed instructions from early in the conversation may be lost." — [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)

**Distractors / near-duplicate / structurally coherent content (measured, non-agent)**
- A single distractor reduces performance; four compound it; Claude 4 models abstain rather than hallucinate — [Chroma](https://www.trychroma.com/research/context-rot)
- Logically coherent (unshuffled) haystacks hurt all 18 models vs. shuffled — [Chroma](https://www.trychroma.com/research/context-rot)
- Repeated-word output degrades with length for all models; Claude Opus 4 begins refusing around 2,500 words (2.89% of attempts) — [Chroma](https://www.trychroma.com/research/context-rot)
- Needles with low lexical overlap to the question degrade fastest (NoLiMa: effective lengths 2K–8K for 2024-era models) — [arXiv 2502.05167](https://arxiv.org/html/2502.05167v3)

**Relevant vs irrelevant padding in coding-agent context (measured)**
- Relevant-long and irrelevant-long 299K-char contexts produced the same 3/10 pass rate vs 8/10 clean, i.e., topical relevance of the padding did not matter; the reproducible loss was a sparse, critical obligation ("a required array in task T002 ... never appears") rather than global collapse; 38 of 44 failed rows ended with a success/completion claim — [arXiv 2607.17937](https://arxiv.org/html/2607.17937v2)

**Accumulated failed attempts / step count (measured)**
- Mean per-step accuracy falls 0.58 → 0.44 from first to last third of trajectories; "once an agent errs it rarely recovers"; format/tool-call drift affects 21% of trajectories and rises with horizon; naive context truncation "is likely to backfire rather than help" — [arXiv PDF 2609.01660](https://arxiv.org/pdf/2609.01660)
- Trajectories ending in give-up/uncertain answers more often contain "repeated failed attempts or no progress" — [arXiv 2606.29718](https://arxiv.org/html/2606.29718v2)

**Early instructions / side-constraints (measured losses under compaction; see KQ4)**
- Compactors retain only 17% of injected session constraints on average — [arXiv 2608.11242](https://arxiv.org/html/2608.11242)

**Vendor claims / recommendations (not measured)**
- Tool-result clearing is "one of the safest lightest touch forms of compaction": "once a tool has been called deep in the message history, why would the agent need to see the raw result again?" — [Anthropic engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- "If you've corrected Claude more than twice on the same issue in one session, the context is cluttered with failed approaches. Run `/clear`"; "Bloated CLAUDE.md files cause Claude to ignore your actual instructions!"; "The infinite exploration... Claude reads hundreds of files, filling the context" — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- "File reads dominate context usage" (tip in the interactive context-window simulation) — [Claude Code context window](https://code.claude.com/docs/en/context-window)
- Third-party, unverified: large tool results above roughly 50K characters are written to a file with only a preview in context; microcompact replaces old tool results with placeholders — [search summary citing claudelog/morphllm; not confirmed in official docs](https://claudelog.com/faqs/what-is-micro-compact/)

### Inferences
- Priority order for what to drop, by strength of evidence: (1) raw tool observations older than ~10 turns (JetBrains, Anthropic context editing, Claude Code's own ordering); (2) repeated/near-duplicate passages and large coherent dumps (Chroma structure + repeated-words results); (3) failed-attempt trails (step-count hazard, best-practices guidance). "Verbose thinking" and "old plans" have no direct measurement; on 5.x models thinking blocks are server-managed and Anthropic warns against rewriting history before them.
- Masking/pruning beats summarising for the tool-output layer: equal or better solve rate, lower cost, no warm-up delay, no trajectory elongation (JetBrains). Summarisation should be reserved for the dialogue/decision layer, matching Anthropic's "compaction for dialogue-heavy sessions, clearing for re-fetchable tool results" guidance in its docs search results — [Claude Code docs](https://code.claude.com/docs/en/how-claude-code-works).
- Because relevant and irrelevant padding degrade equally (CertiK), "keeping it because it's related" is not a safe rule; keep by obligation/decision, not by topic.

### Gaps
- No study measured verbose extended-thinking blocks or stale plans as independent degraders in agent context.
- No Claude-model result exists for the JetBrains masking-vs-summary comparison (models were Qwen3 and Gemini 2.5 Flash); ACON and TRACE likewise used open/other models.
- Microcompact thresholds and the ~50K-char file spill are third-party reverse-engineering claims, not documented by Anthropic.

---

## Key Question 4: What is measured about summarisation/compaction quality (information loss, summary drift over repeated compactions, structured vs free-form)?

### Takeaway
Compaction is measured to be badly lossy for standing instructions: across datasets, compactors retained only 17% of injected session constraints (best category 36%), and Claude Code's `/compact` prompt on Sonnet 4.6 preserved 53% of safety rules after one round and 10% after five. Summary drift compounds: in a reference experiment, irreversible summarisation held 0.33–0.56 recall vs ~0.95 for reversible retrieval, worst at the highest compaction frequency. Structured side-channels (a constraint registry, typed retention policies) measurably restore 90–96% retention, and simple FIFO truncation is competitive with LLM summaries except at the tightest budgets.

### Cited Findings

**Constraint loss (single compaction)**
- "Lost in Context Compaction" (Wang et al., Penn State / IBM; v2 11 Oct 2026; COMPINT benchmark): "The evaluated compactors retain only 17% of injected SCs on average"; non-LLM compactors (Recent-5 truncation, LLMLingua-2) 0% retention; gpt-oss-120b with Anthropic's compaction prompt ~9–24%, with Pi prompt ~24–38%; Qwen3-30B (Anthropic prompt) ~0.9–2.5%; GPT-5.4-mini "as high as 98%" and "as low as 6.7%"; "even the best result (Preference under gpt-oss (Pi), at 36%) loses nearly two-thirds of constraints"; on SWE-Natural "no compactor retains more than 28.6% of SCs" — [arXiv 2608.11242](https://arxiv.org/html/2608.11242)
- Same paper: five SC categories (Action, Information, Process, Preference, Output); a plug-in SC-aware extractor achieved registry retention of 93.7% (Hermes Agent), 95.1% (OpenResearcher), 90.3% (WildChat) and compliance "93.4–96.3%" when the registry is appended, vs compacted-only retention 11.6% / 5.4% / 1.1% — [arXiv 2608.11242](https://arxiv.org/html/2608.11242)
- Secondary reporting of the same paper: no-compaction baseline compliance was ~59–71% depending on scenario — [The Decoder](https://the-decoder.com/ai-systems-quietly-drop-user-instructions-when-they-compress-context/) (not verified in the paper text read)

**Repeated compaction / summary drift**
- "The Compaction Cliff" (Zerhoudi, Mitrovic, Granitzer; 24 Aug 2026; CIKM 2026): Claude Code's `/compact` prompt on Sonnet 4.6 "preserves 53% of safety rules after one compaction round and 10% after five"; type-aware TypeCompact "preserves 2–4× more safety rules than the strongest single-shot LLM compactor at every ratio, with 96% recall over five rounds"; downstream it beat the production Sonnet compactor on medical compliance (McNemar p<10⁻⁸, N=200), retail pass rate (p<0.01, N=115), airline (p=0.024) — [arXiv 2608.22752](https://arxiv.org/abs/2608.22752)
- Rate–distortion survey (Colaco & Lahjouji, UC Irvine; 9 Jul 2026), reference experiment with Qwen2.5-1.5B on an RTX 4060: "The reversible operator holds recall near 0.95 at every compaction frequency... The irreversible operator runs far below it, between 0.33 and 0.56, and is weakest at the highest compaction frequency, because each summary throws away facts the next summary can no longer see"; authors flag absolute numbers as small-scale illustrations — [arXiv 2607.08032](https://arxiv.org/html/2607.08032v1)
- CertiK coding-agent study: a fresh worker "lost an opaque contract after three native compactions and recovered it by reading prohibited material" (single run, "mechanism evidence") — [arXiv 2607.17937](https://arxiv.org/html/2607.17937v2)

**Summary vs truncation vs no compression (task success)**
- TRACE study (Min et al.; v2 Oct 2026; AppWorld test-normal, 168 tasks, MiniMax-M3, 4,096-token compression window): accuracy no-compression 85.7; FIFO 63.7; LLMLingua-2 68.2; Prompting-O (OpenClaw prompt) 71.4; Prompting-H (Hermes prompt) 65.2; ACON-UT 62.5; TRACE 77.1 — [arXiv 2608.06503](https://arxiv.org/html/2608.06503v2)
- Same: "FIFO matches or slightly exceeds summary-based compaction at the larger budgets"; only at the tightest budget does summary win (72.8% vs FIFO 42.2%); at the smallest budget the summary condition terminated in only 44.6% of samples vs FIFO 77.2% and full history 66.6% — [arXiv 2608.06503](https://arxiv.org/html/2608.06503v2)
- Same: compression attenuates recent interactions — mean total-variation divergence from full-history behaviour 0.149 when the raw latest update was kept, 0.233 when compressed into the summary, 0.289 when omitted; the first action after compaction produced 0.108 more blocked/error actions and 0.031 more refetch/replay actions (590 boundaries, 4,640 rollouts) — [arXiv 2608.06503](https://arxiv.org/html/2608.06503v2)
- Long-horizon search paper: context management (compaction / trimming / isolation variants) raised Qwen3.5 overall accuracy from 54.4 (ReAct) to 64.9 (FoldAgent) and GLM-4.7 from 51.8 to 60.4 ("Summary, Length"); "discard-all" trimming reached 60.3; BrowseComp premature termination fell 53.4 → 6.4 — [arXiv 2606.29718](https://arxiv.org/html/2606.29718v2)
- JetBrains: LLM summary (N=21 turns summarised, last M=10 kept verbatim) did not consistently or significantly beat observation masking; critic-enhanced summaries did not improve solve rate and produced longer trajectories — [arXiv 2508.21433](https://arxiv.org/html/2508.21433v3)

**Vendor/production compaction behaviour (documented, not measured)**
- Claude Code compaction summary "keeps: your requests and intent, key technical concepts, files examined or modified with important code snippets, errors and how they were fixed, pending tasks, and current work. It replaces the verbatim conversation: full tool outputs and intermediate reasoning are gone"; after compaction Claude Code "re-reads up to five of the files modified most recently and re-injects the skills you invoked" (capped at 5,000 tokens per skill); "The skill listing does not reload" — [Claude Code context window](https://code.claude.com/docs/en/context-window)
- "Claude compacts automatically, but instructions from early in the conversation can get lost. Put persistent rules in CLAUDE.md"; "Compact Instructions" section in CLAUDE.md or `/compact <focus>` control what is preserved; auto-compaction stops after a few attempts if a single large output refills the window — [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- Anthropic: "Compaction typically serves as the first lever"; tune the compaction prompt by "maximizing recall... then precision" (recommendation) — [Anthropic engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Anthropic long-running-agent harness (26 Nov 2025): feature list kept as JSON because "the model is less likely to inappropriately change or overwrite JSON files compared to Markdown files"; progress file + git history let a fresh context "quickly understand the state of work"; observed failure: agent "ran out of context" leaving "a feature half-implemented and undocumented"; no quantitative metrics reported — [Anthropic engineering](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

**Secondary / vendor-blog figures (lower confidence)**
- Factory.ai evaluation as relayed by a competitor blog: over 36,000 production messages, structured summarisation scored 3.70 vs Anthropic default compaction 3.44 vs OpenAI 3.35 (1–5 scale); "multi-session information retention was only 37%" with summarisation — [Morph blog, secondhand](https://www.morphllm.com/compaction-vs-summarization); primary Factory post not located.
- A widely shared DEV post on Claude Code compaction (Sept 2026) reports no experiments; its thresholds (e.g., 160K trigger) and "what gets lost" lists are author opinion — [dev.to](https://dev.to/jsmanifest/claude-code-session-compaction-in-2026-how-context-summarization-works-and-what-your-agent-forgets-am0)

### Inferences
- The measured loss is concentrated in standing rules and obligations (constraints, safety rules, API contracts), not in the narrative of what was done. Anything the agent must still obey after compaction should live outside the summary: CLAUDE.md / Compact Instructions, a typed constraint registry, or a JSON state file.
- Drift is superlinear in compaction count (53%→10% over five rounds; 0.33–0.56 vs 0.95 reversible). Fewer, larger, boundary-aligned compactions beat many small ones, and reversibility (keeping raw transcripts or files retrievable) matters more than summary prompt quality.
- For the tool-output layer, truncation/masking is as good as summarising at moderate budgets; summarising only earns its cost when the budget is very tight, and even then it reduces terminal completion. For a coding agent this favours: mask/clear old tool results continuously, compact dialogue rarely and at task boundaries.
- Compaction also changes behaviour immediately after the boundary (more blocked/repeated actions), so re-reading the most recently modified files (as Claude Code does) and restating the current step are evidence-aligned.

### Gaps
- No published measurement of Claude 5.x server-side compaction quality (retention or downstream accuracy); the only Claude-specific compaction retention numbers are for the `/compact` prompt run on Sonnet 4.6 (Compaction Cliff) and for Anthropic's compaction prompt run on open models (Lost in Context Compaction).
- No controlled study compares free-form vs structured handoff notes head-to-head on coding tasks; the structured-wins evidence is from constraint registries (COMPINT), typed retention (Compaction Cliff), and the CertiK checklist (5/10→10/10, p=0.0325), plus Anthropic's qualitative JSON-over-Markdown observation.
- The "37% retention" and 3.70/3.44/3.35 Factory numbers are secondhand.

---

## Key Question 5: Evidence that multi-agent / fresh-context delegation reduces degradation

### Takeaway
Anthropic's own measurements show large gains from parallel, fresh-context subagents on research tasks (multi-agent Opus 4 + Sonnet 4 subagents +90.2% over single Opus 4; token usage explains 80% of variance) and, for Opus 5.5, latency gains at equal score on long-horizon coding (five-agent team reaches score 0.6 ~2.7× faster) rather than accuracy gains. Independent evidence is thinner: context-isolation variants improved open-model search agents by ~10 points, but one coding-agent study found delegation did not contain rot in a fresh worker that itself compacted three times, and no SWE-bench ablation isolating fresh-context delegation was found.

### Cited Findings
- Anthropic multi-agent research system (13 Jun 2025): "a multi-agent system with Claude Opus 4 as the lead agent and Claude Sonnet 4 subagents outperformed single-agent Claude Opus 4 by 90.2% on our internal research eval"; on BrowseComp "token usage by itself explains 80% of the variance" and three factors (tokens, tool calls, model choice) explain 95%; agents use ~4× and multi-agent systems ~15× the tokens of chat — [Anthropic engineering](https://www.anthropic.com/engineering/multi-agent-research-system)
- Same post: "Subagents facilitate compression by operating in parallel with their own context windows"; "When context limits approach, agents can spawn fresh subagents with clean contexts"; lead agent context truncated beyond 200,000 tokens, so it saves its plan to memory; subagents "pass lightweight references back to the coordinator"; parallelisation cut research time "by up to 90%" — [Anthropic engineering](https://www.anthropic.com/engineering/multi-agent-research-system)
- Opus 5.5 System Card, multi-agent ProgramBench (166 tasks, compaction + 20M token budget for all configurations): "the five-agent team achieves a 2.7x latency improvement over the single agent to reach the same score of 0.6"; async subagents "improving on the single agent but by a smaller margin"; teams "reach a given score faster at a higher cost" — [Opus 5.5 System Card PDF p.189–191](https://www-cdn.anthropic.com/fc1b44717c85dc068bc6ba5024219938094694bd/Claude%20Opus%205.5%20System%20Card.pdf)
- Same card, DRACO (13–71 min tasks): "multi-agent teams can take longer than their single-agent counterparts to finish a task due to their coordination overhead" when unpressed; at a 0.5× latency budget the five-agent team "more than match[es] single-agent performance, with a roughly 2.8x speedup"; at tight budgets async-subagent leads spawn less and "prefer to act as a single agent" — [Opus 5.5 System Card PDF p.191–193](https://www-cdn.anthropic.com/fc1b44717c85dc068bc6ba5024219938094694bd/Claude%20Opus%205.5%20System%20Card.pdf)
- Same card, large teams (1→100 agents, 24 h): scores "generally rise with team size, with diminishing returns"; Opus 5.5 beats Opus 5 and Fable 5.1 at every team size — [Opus 5.5 System Card PDF p.193–194](https://www-cdn.anthropic.com/fc1b44717c85dc068bc6ba5024219938094694bd/Claude%20Opus%205.5%20System%20Card.pdf)
- Long-horizon search (open models): the "isolation" family is one of three context-management categories tested; best variant (FoldAgent) lifted Qwen3.5 from 54.4 to 64.9 overall and cut BrowseComp premature termination from 53.4% to 6.4%; parallel sampling with behaviour-aware filtering added 2.6–4.9 points — [arXiv 2606.29718](https://arxiv.org/html/2606.29718v2)
- Counter-evidence: "Delegation did not contain rot. In a single fresh-worker run, the worker lost an opaque contract after three native compactions"; selective retrieval helped conditionally (GPT-5.5 Bundled Direct 3/3 vs Full Direct 1/3) — [arXiv 2607.17937](https://arxiv.org/html/2607.17937v2)
- Classifier context rot: "incremental monitoring" (classifying at multiple points rather than once over the whole transcript) benefited Opus 4.6 with and without thinking (no numeric gain in text) — [arXiv 2605.12366](https://arxiv.org/html/2605.12366v1)
- Anthropic recommendation: sub-agents return "a condensed, distilled summary of its work (often 1,000-2,000 tokens)" — [Anthropic engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Claude Code docs (illustrative simulation, not a benchmark): a research subagent read 6,100 tokens of files and returned a 420-token result; subagents start fresh (no conversation history, no main-session auto memory), and only the final text plus a metadata trailer returns — [Claude Code context window](https://code.claude.com/docs/en/context-window)
- Claude Code best practices (claims): "A fresh context improves code review since Claude won't be biased toward code it just wrote"; "A clean session with a better prompt almost always outperforms a long session with accumulated corrections"; practitioner caveat that each subagent "spends the first few turns rebuilding local understanding" so short tasks can cost more — [Claude Code best practices](https://code.claude.com/docs/en/best-practices); [search summary of practitioner guides](https://promptessor.com/blog/best-claude-code-subagents-and-custom-agent-examples-for-specialized-coding-workflows-in-2026)

### Inferences
- The measured wins for delegation are on breadth-parallelisable work (research, search, exploration) and on latency; the one measured attempt to use delegation as a rot-containment device in coding (CertiK) failed because the worker's own context also rotted and compacted. Delegation moves the problem rather than solving it unless the worker's task is short enough to finish inside one clean window.
- Anthropic's own multi-agent coding results used compaction plus a 20M budget for every configuration, so they say nothing about whether fresh contexts reduce degradation; they show throughput, not accuracy, gains.
- For a coding agent the evidence supports: delegate bounded exploration/verification (reads, logs, test output) to fresh subagents that return short summaries; keep the implementing context single and compact it at task boundaries; do not expect a subagent to carry a long-horizon contract across its own compactions.

### Gaps
- No controlled ablation (e.g., on SWE-bench Verified) isolating fresh-context subagents vs single-agent at equal token budget was found for any model.
- Anthropic's 90.2% figure is from an unspecified internal research eval (initial set ~20 queries); methodology and variance are not published.
- The Opus 5.5 multi-agent evaluations were run on "an alternate, broadly comparable snapshot" of the model, per the card.
