# SI Statusline Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the twelve audited statusline defects (and the stale CLAUDE.md injection template) in the Session Intelligence plugin without changing any cell the audit found correct.

**Architecture:** One mechanical split of `statusline/statusline-intel.js` into six modules guarded by a golden-output test over seven captured stdin payloads; then one small, unit-tested fix per defect in the module that owns it; economics scanning consolidates into `lib/cost-estimation.js` with chunked, bounded reads and state-dir caches; quota and thinking cells read the fields Claude Code actually sends; docs regenerate from the golden render.

**Tech Stack:** Node ≥ 20 CommonJS, `node:test` + `node:assert/strict`, SQLite via `lib/sqlite-driver.js`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-21-si-statusline-fixes-design.md` (decisions 1–9). Audit: `~/.claude/projects/-Users-0xd-DWS-claude-session-intelligence/memory/reference_statusline_audit_2026_10_19.md`. Stdin schema: `memory/reference_statusline_stdin_schema.md`.

All paths below are relative to `plugins/session-intelligence/` unless they start with `docs/`, `README.md`, `CLAUDE.md` or `AGENTS.md` (repo root). Line numbers are HEAD c061b79 and shift after Task 1; locate by function name after that.

## Global Constraints

- The statusline process must never exit non-zero or print nothing: keep the final `try { main(); } catch { process.stdout.write('claude'); }` behaviour (a non-zero exit or empty stdout blanks the line in Claude Code). Hooks likewise never exit non-zero on error paths.
- Every `statusline/*.js` and `lib/*.js` file ≤ 800 lines after its task; `statusline/renderers.js` ≤ 760.
- Immutable style (spread, no in-place mutation of shared objects); no `console.log` outside tests (use `intelLog` from `lib/intel-debug.js`).
- Tests never touch the real `~/.claude` or the real `os.tmpdir()`: spawn tests set `HOME`, `USERPROFILE` and `TMPDIR` to a fresh `fs.mkdtempSync` dir and remove it in `after`; in-process tests that need `getStateDir()` set `process.env.HOME` to a temp dir for the test's duration.
- Tests never reach the network: any test that could reach `loadUsage` either injects a stub via `buildRenderers(C, { loadUsage })` or writes a fresh usage cache at `path.join(tmpdir, 'claude-usage-cache-<uid>.json')` (uid from `os.userInfo().uid`) with `{ fetchedAt: Date.now(), goodAt: Date.now(), sessionUsage: 36, weeklyUsage: 95, error: false }` so `triggerRefresh` returns without spawning.
- Golden fixtures (`tests/fixtures/statusline/golden/*.txt`) change only in a task whose brief says so; the task's commit includes the golden diff and the task report quotes it.
- Full matrix before each commit that touches `lib/`: `npm test`, `npm run test:node22`, `SI_SQLITE_DRIVER=node:sqlite npm run test:node22` all green (4 skips on Node 20 are expected).
- Commit messages `<type>: <description>` (feat/fix/refactor/docs/test/chore), no attribution trailers. Never stage `AGENTS.md`, root `CLAUDE.md`, `plugins/session-intelligence/CLAUDE.md`, `research_notes/`, `reports/`, `.superpowers/`.

## Review Focus

1. A render whose stdin carries `rate_limits.five_hour` and `.seven_day` must spawn no usage-refresh worker (Task 7 counts `loadUsage` calls; Task 1's golden run with a fresh cache file is the spawn guard).
2. A 550 MB transcript must never be read into one Buffer or string: Task 5's chunk test with `chunkBytes: 48` and `maxBytesPerPass` smaller than the file proves the boundary and the bounded pass.
3. Streamed transcripts repeat one message's usage across several rows: Task 4 asserts a three-row message counts 701 thinking tokens once.
4. An unknown model with no `context_window` on stdin must not render a bar or a percentage against a guessed cap: Task 8 asserts `175.7k/?` for the `e2_unknown_model_no_cw` fixture.
5. A per-project `zones` override must survive the adaptive learner: Task 8's `resolveZones` test with an adaptive result in `absolute` mode returns the user's zones unchanged.

## File Structure

Created:
- `statusline/lib-loader.js` — `resolveLibDir`, every lazy `load*Lib`, `loadUsage` memo (`resetForTests()`), `agentModelCostsSafe`, `knownPriceForModelSafe`.
- `statusline/format.js` — `makeColors`, `fmtTokens`, `fmtTokensTight`, `fmtUsd`, `fmtUsdShort`, `fmtDuration`, `fmtDurationTight`, `truncate`, `truncateMiddle`, `projectLabel`, `resetAtMs`, `renderUsageCell`, `readIntFile`.
- `statusline/git-info.js` — git helpers, `extractIssueNumber`, project/task resolution, deploy breadcrumb, output style, SI plugin gate, health cache/probe, `readSessionStartTime`.
- `statusline/economics.js` — `contextCap`, `totalTokensFromUsage`, `loadEstimate`, cost snapshot read/write, `lastCompactMsForSession`, `minutesSinceLastCompact`, `costAtLastCompact`, `costFromUsage`, `savedFromUsage`, `DEFAULT_PRICES`, `totalsFromTranscript`, `costsSinceCompact` (the last two delegate to `lib/cost-estimation.js` from Task 5).
- `statusline/zones.js` — `resolveZones(cfg, { cap, cwd, history, adaptiveZones })`.
- `statusline/renderers.js` — `buildRenderers(C, deps)`, `renderContextBar`, `zoneFor`, `pickEmoji`, `pickEmojiSecond`.
- `tests/helpers/statusline-fixture.js` — `makeHome()`, `writeTranscript(home, rows)`, `writeFreshUsageCache(tmpdir)`, `render(payload, { home, fields })`, `stripAnsi`, `normalise` (replaces `r:<dur>`, `<dur> ago`, `/var/folders/...` and `/tmp/...` paths).
- `tests/fixtures/statusline/payloads/*.json` (7, copied from the audit scratchpad), `tests/fixtures/statusline/golden/*.txt` (7).
- `tests/statusline-golden.test.js`, `tests/statusline-format.test.js`, `tests/statusline-renderers.test.js`, `tests/statusline-economics.test.js`, `tests/statusline-zones.test.js`, `tests/thinking.test.js`, `tests/templates.test.js`, `tests/readme-statusline.test.js`.

Modified: `statusline/statusline-intel.js` (entry only), `lib/cost-estimation.js`, `lib/thinking.js`, `lib/config.js`, `lib/events.js`, `hooks/si-bootstrap.js` (sweep regex), `templates/claude-md-rules.md`, `README.md`, existing tests that leak into `os.tmpdir()`.

Locked interfaces (every task's implementer and reviewer gets this block):
- `buildRenderers(C, deps = {}) → { [field]: (input, ctx) => string }`; `deps.loadUsage` defaults to `libLoader.loadUsage`; renderers never throw (caller wraps anyway).
- `resolveZones(cfg, { cap, cwd, history, adaptiveZones }) → { yellow, orange, red, source: 'absolute'|'fraction'|'adaptive' }`.
- `contextCap(input, cfg) → { cap: number, source: 'config'|'statusline'|'env-max-context'|'env-disable-1m'|'model-id'|'fallback' }` (wraps `lib/context-cap.resolveContextCap`).
- `lib/cost-estimation.totalsFromTranscript(transcriptPath, sessionId, prices, opts = {}) → { cost, saved, input, output, cached, creation, byModel, partial }` with `opts.chunkBytes` (default `4 * 1024 * 1024`), `opts.maxBytesPerPass` (default `64 * 1024 * 1024`), `opts.cacheDir` (default `getStateDir()`), `opts.priceFor(model) → prices|null`.
- `lib/cost-estimation.costsSinceCompact(transcriptPath, sessionId, compactMs, prices, opts = {}) → { cost, saved, partial }` same `opts`.
- `lib/thinking.estimateThinkingTokens(transcriptPath, opts) → { total, turns, recent, lastTurnAgo, exact: boolean }`.
- `loadEstimate(sessionId) → { tokens, tools, id }` reading `getStateDir()` first, `os.tmpdir()` second.

---

### Task 1: Split the statusline into modules behind a golden test

**Files:**
- Create: `statusline/lib-loader.js`, `statusline/format.js`, `statusline/git-info.js`, `statusline/economics.js`, `statusline/zones.js`, `statusline/renderers.js`, `tests/helpers/statusline-fixture.js`, `tests/fixtures/statusline/payloads/{a_fable_1m_48pct,b_fable_200k_48pct,c_no_context_window,d_no_prompt_cache,e_unknown_model_with_cw,e2_unknown_model_no_cw,g_no_rate_limits_cache_fallback}.json`, `tests/fixtures/statusline/golden/*.txt`, `tests/statusline-golden.test.js`
- Modify: `statusline/statusline-intel.js` (keep header, `readStdinSync` 304-306, `safeParse` 308-310, `loadConfig` 241-277, `main` 1912-2130; everything else moves), `tests/statusline-contextpct.test.js` (use the shared helper)
- Source payloads: `/private/tmp/claude-501/-Users-0xd-DWS-claude-session-intelligence/333ad4d3-053f-4052-83dd-87c5d2e245f3/scratchpad/statusline-audit/payloads/*.json` (copy verbatim; the helper overrides `cwd`, `session_id`, `transcript_path` at render time).

**Interfaces:**
- Produces: every module's exports listed in File Structure; `statusline-intel.js` ends with `if (require.main === module) { try { main(); } catch { process.stdout.write('claude'); } }` and `module.exports = { main, loadConfig }`.
- Produces: `tests/helpers/statusline-fixture.js` — `render(payload, { home, fields, env }) → { stdout, stderr, status, lines }` spawning `statusline/statusline-intel.js` with `HOME=USERPROFILE=TMPDIR=home`, `NO_COLOR=1`, config `{ statusline: { preset: 'verbose', fields } }` written to `home/.claude/session-intelligence.json`, `cwd` = `home/work` (a non-git dir), `transcript_path` = `home/transcript.jsonl`, `session_id` = `golden-<name>`; `writeTranscript` writes one user row plus three assistant rows (`message.id` `msg_1..3`, model `claude-fable-5-1`, usage `{ input_tokens: 2000, cache_creation_input_tokens: 8000, cache_read_input_tokens: 470000, output_tokens: 128, output_tokens_details: { thinking_tokens: 701 } }`, timestamps 10 s apart) in the row shape `tests/statusline-contextpct.test.js:12-24` already uses; `writeFreshUsageCache(home)` per Global Constraints, and `render` calls it before every spawn unless `opts.usageCache === false`, so no golden render can start the poller.

- [ ] **Step 1: Write the golden test against the UNSPLIT file and capture goldens**

```js
// tests/statusline-golden.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path');
const { makeHome, render, normalise } = require('./helpers/statusline-fixture');
const PAYLOADS = path.join(__dirname, 'fixtures', 'statusline', 'payloads');
const GOLDEN = path.join(__dirname, 'fixtures', 'statusline', 'golden');
for (const file of fs.readdirSync(PAYLOADS).filter((f) => f.endsWith('.json'))) {
  const name = file.replace(/\.json$/, '');
  test(`golden render: ${name}`, (t) => {
    const home = makeHome(t);
    const payload = JSON.parse(fs.readFileSync(path.join(PAYLOADS, file), 'utf8'));
    const r = render(payload, { home });
    assert.equal(r.status, 0, r.stderr);
    const actual = normalise(r.stdout);
    const goldenPath = path.join(GOLDEN, `${name}.txt`);
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(goldenPath, actual);
    assert.equal(actual, fs.readFileSync(goldenPath, 'utf8'));
  });
}
test('golden renders spawn no usage-refresh worker', (t) => {
  const home = makeHome(t);
  const payload = JSON.parse(fs.readFileSync(path.join(PAYLOADS, 'a_fable_1m_48pct.json'), 'utf8'));
  render(payload, { home });
  assert.equal(fs.existsSync(path.join(home, `claude-usage-lock-${require('os').userInfo().uid}.json`)), false);
});
```

- [ ] **Step 2: Run with `UPDATE_GOLDEN=1` once to capture, then run plain to verify it passes against the unsplit file**

Run: `UPDATE_GOLDEN=1 node --test tests/statusline-golden.test.js && node --test tests/statusline-golden.test.js`
Expected: 8 pass; seven `.txt` files exist, each with five lines for the verbose preset (line 5 may be ` `), none containing `\x1b[`.

- [ ] **Step 3: Commit the fixtures and the test (behaviour baseline)**

```bash
git add tests/statusline-golden.test.js tests/helpers/statusline-fixture.js tests/fixtures/statusline
git commit -m "test(si): golden statusline renders over seven captured payloads"
```

- [ ] **Step 4: Move code into the six modules, pure move, no edits beyond `require`/`module.exports` wiring**

Rules: each moved function keeps its body byte-for-byte; module-level caches (`_eventsLibCached`, `_usageCached`, `_costLibCached`, `_agentCostsCached`) move with their functions into `lib-loader.js` and gain `resetForTests()`; `statusline-intel.js` requires the siblings with `require('./lib-loader')` etc. (same directory, no `resolveLibDir` needed); `buildRenderers(C, deps = {})` takes `deps.loadUsage` (default `libLoader.loadUsage`) and the three usage call sites use it; `contextCap` returns the number for now (Task 8 changes it); `zones.js` holds `resolveZones` implementing exactly `main` 1937-1954 today (fraction thresholds then adaptive replacement in every mode) and `main` calls it.

- [ ] **Step 5: Run the golden test and the whole suite**

Run: `node --test tests/statusline-golden.test.js && npm test`
Expected: goldens identical (no `UPDATE_GOLDEN`), suite green. Then: `wc -l statusline/*.js` — every file ≤ 800, `renderers.js` ≤ 760.

- [ ] **Step 6: Commit**

```bash
git add statusline tests/statusline-contextpct.test.js
git commit -m "refactor(si): split statusline-intel.js into loader/format/git/economics/zones/renderers modules"
```

---

### Task 2: `tools` cell reads the state dir (D1)

**Files:**
- Modify: `statusline/economics.js` (`loadEstimate`, was 342-355), `tests/statusline-contextpct.test.js` (the 3,000,000 estimate file moves to `home/.claude/state/`)
- Test: `tests/statusline-economics.test.js`

**Interfaces:**
- Produces: `loadEstimate(sessionId)` tries `path.join(getStateDir(), 'claude-token-budget-<sid>')` / `claude-tool-count-<sid>` first, then the same names under `os.tmpdir()`; `getStateDir` via `lib-loader`'s `loadUtilsLib()` (add that loader; fall back to `os.tmpdir()` when the lib is missing).

- [ ] **Step 1: Write the failing tests**

```js
test('loadEstimate reads tool count from the state dir the hook writes to', (t) => {
  const home = withTempHome(t);                      // sets process.env.HOME, restores in t.after
  fs.mkdirSync(path.join(home, '.claude', 'state'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'state', 'claude-tool-count-sidA'), '612');
  assert.equal(loadEstimate('sidA').tools, 612);
});
test('loadEstimate still reads a legacy tmpdir file', (t) => { /* TMPDIR=home, file in home, HOME state dir empty → tools 7 */ });
test('loadEstimate returns zeros when neither exists', (t) => { assert.deepEqual(loadEstimate('nope'), { tokens: 0, tools: 0, id: 'nope' }); });
```

- [ ] **Step 2: Run to verify the first test fails** — Run: `node --test tests/statusline-economics.test.js` — Expected: FAIL `612 !== 0`.
- [ ] **Step 3: Implement** the two-location lookup in `loadEstimate`.
- [ ] **Step 4: Golden check** — Run: `npm test`. Expected: green; goldens unchanged (fixtures carry no tool-count file).
- [ ] **Step 5: Commit** — `git add statusline/economics.js statusline/lib-loader.js tests/statusline-economics.test.js tests/statusline-contextpct.test.js && git commit -m "fix(si): statusline tools cell reads the state dir the token-budget hook writes to"`

---

### Task 3: Drop the fabricated `wr:` cell by cherry-picking f36d096 (D3)

**Files:**
- Modify: `statusline/renderers.js` (`modelSplit`), `statusline/format.js` (add `fmtUsdShort` from f36d096), `README.md:316` (row), `lib/events.js` (`weeklyModelSpend` removed if no other caller: check with `grep -rn weeklyModelSpend lib hooks tools statusline tests`)
- Test: `tests/statusline-renderers.test.js` (new), golden update for fixtures whose line 5 shows `wr:`

**Interfaces:**
- Consumes: `buildRenderers(C, deps)`; `ctx.tokenTotals.byModel` shape as produced by `totalsFromTranscript` (confirm: `{ [model]: costUsd }` or `{ [model]: { cost } }` and adapt the test's ctx accordingly).

- [ ] **Step 1: Write the failing test**

```js
test('modelSplit renders $·share per model and never a weekly-remaining estimate', (t) => {
  withTempHome(t);
  const R = buildRenderers(makeColors(false), { loadUsage: () => null });
  const input = { rate_limits: { seven_day: { used_percentage: 20, resets_at: 2e9 } } };
  const ctx = { sessionId: 'rs1', tokenTotals: { byModel: { 'claude-fable-5-1': 12, 'claude-haiku-5-5': 0.01 } } };
  const out = R.modelSplit(input, ctx);
  assert.doesNotMatch(out, /wr:/);
  assert.match(out, /fable-5-1:\$12·100%/);
  assert.doesNotMatch(out, /haiku/);   // rounds to 0 % → dropped
});
```

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL on `/wr:/` (or on `sc$`/`sp` format).
- [ ] **Step 3: Apply the fix**: `git show f36d096 -- plugins/session-intelligence/statusline/statusline-intel.js README.md | git apply --3way` will not apply after the split; instead port the hunks by hand into `renderers.js`/`format.js` (the diff is the spec: `fmtUsdShort`, the `$·%` loop, drop the `weeklyUsed/weekSpend` block and the orphaned comment above `tokenSpeed`). Delete `weeklyModelSpend` from `lib/events.js` only if the grep shows no other caller.
- [ ] **Step 4: Re-capture goldens** — Run: `UPDATE_GOLDEN=1 node --test tests/statusline-golden.test.js && git diff --stat tests/fixtures` — Expected: only line 5 of fixtures with a model split changes (`·wr:~NN%` gone, `sc$…·sp…%` → `$…·…%`); quote the diff in the report. Then `npm test` green.
- [ ] **Step 5: Commit** — `git add statusline lib/events.js README.md tests && git commit -m "fix(si): drop fabricated per-model weekly-remaining from modelSplit (ports f36d096)"`

---

### Task 4: Exact thinking tokens (D4)

**Files:**
- Modify: `lib/thinking.js` (header doc + `estimateThinkingTokens`), `statusline/renderers.js` (`thinking` cell: `~` prefix when `exact === false`)
- Test: `tests/thinking.test.js` (new), `tests/statusline-renderers.test.js`

**Interfaces:**
- Produces: `estimateThinkingTokens(transcriptPath, opts) → { total, turns, recent, lastTurnAgo, exact }`. Exact mode when any scanned assistant row carries `message.usage.output_tokens_details.thinking_tokens` (number): per `message.id` the LAST row's value wins; a turn counts when its value > 0; `recent` = sum of the last `opts.recentWindow` (default 30) turns; `lastTurnAgo` as today. Otherwise the existing residual path, `exact: false`.

- [ ] **Step 1: Write the failing tests**

```js
test('counts a streamed message once using exact thinking_tokens', () => {
  const p = writeRows([asst('m1', { thinking_tokens: 701 }), asst('m1', { thinking_tokens: 701 }), asst('m1', { thinking_tokens: 701 })]);
  assert.deepEqual(pick(estimateThinkingTokens(p)), { total: 701, turns: 1, exact: true });
});
test('sums exact thinking across messages', () => { /* m1 701, m2 1200 → total 1901, turns 2, recent 1901 */ });
test('falls back to the residual estimate when the field is absent', () => {
  const p = writeRows([asstLegacy('m1', { output_tokens: 900, text: 'x'.repeat(400) })]);   // residual 900 − 100 = 800
  const r = estimateThinkingTokens(p);
  assert.equal(r.exact, false); assert.equal(r.total, 800);
});
test('thinking cell carries ~ when the count is estimated', (t) => {
  const R = buildRenderers(makeColors(false), {});
  const exact = R.thinking({}, { cfg: { thinkingMinDisplay: 0 }, thinking: { recent: 1901, exact: true } });
  const est   = R.thinking({}, { cfg: { thinkingMinDisplay: 0 }, thinking: { recent: 1901, exact: false } });
  assert.doesNotMatch(exact, /~/); assert.match(est, /~/);
});
```

- [ ] **Step 2: Run to verify they fail** — Expected: first test FAIL `total 2103` (or similar), fourth FAIL (no `~`).
- [ ] **Step 3: Implement** exact mode in `lib/thinking.js` (keep the 512 KB tail scan and the partial-first-line drop), rewrite the header doc (exact field first, residual as legacy fallback, drop the "within ~5%" claim), add the `~` prefix in the `thinking` renderer.
- [ ] **Step 4: Goldens** — `UPDATE_GOLDEN=1 node --test tests/statusline-golden.test.js`; expected diff: the `thinking` cell on line 4 of fixtures (fixture transcript rows carry `thinking_tokens: 701` with distinct ids → exact 2103, so the cell changes from the residual value to the exact one, if above `thinkingMinDisplay` 5000 it stays absent — quote whichever). `npm test` green; matrix green (lib changed).
- [ ] **Step 5: Commit** — `git commit -m "fix(si): thinking cell uses exact output_tokens_details.thinking_tokens deduped per message"`

---

### Task 5: One chunked, bounded transcript scanner with state-dir caches (D2)

**Files:**
- Modify: `lib/cost-estimation.js` (`totalsFromTranscript` 167-~280 → chunked; add `costsSinceCompact`; shared `scanTranscript`), `statusline/economics.js` (delete its `totalsFromTranscript` and `costsSinceCompact` bodies; delegate to the lib through `lib-loader.loadCostLib()`, returning the empty shape when the lib is missing), `hooks/si-bootstrap.js:617` (sweep regex gains `cost` so `claude-cost-*` and `claude-cost-sincecompact-*` in the state dir are swept at 7 days)
- Test: `tests/cost-estimation.test.js` (extend), `tests/statusline-economics.test.js`

**Interfaces:**
- Produces: the locked `totalsFromTranscript(…, opts)` and `costsSinceCompact(…, opts)` signatures. Internals: `scanTranscript(transcriptPath, fromOffset, onRow, { chunkBytes, maxBytesPerPass }) → { offset, partial }` reads `chunkBytes` at a time with one `Buffer.alloc(chunkBytes)` reused, carries the trailing partial line across chunks, stops at the last newline once `maxBytesPerPass` is consumed and reports `partial: true`. Cache files: `<cacheDir>/claude-cost-<sid>.v5.json` and `<cacheDir>/claude-cost-sincecompact-<sid>.v4.json`; `seenIds` retained as the last 5,000 ids. Statusline-side price lookup passes `opts.priceFor = knownPriceForModelSafe`.
- Consumes: `getStateDir` from `lib/utils.js`.

- [ ] **Step 1: Write the failing tests**

```js
test('totalsFromTranscript is chunk-boundary safe', (t) => {
  const p = writeTranscript(t, threeAssistantRows());                     // each row > 48 bytes
  const whole = totalsFromTranscript(p, 'sA', PRICES, { cacheDir: dirA(t) });
  const chunked = totalsFromTranscript(p, 'sB', PRICES, { cacheDir: dirB(t), chunkBytes: 48 });
  assert.deepEqual(chunked, whole);
  assert.equal(chunked.partial, false);
});
test('totalsFromTranscript bounds one pass and resumes from the persisted offset', (t) => {
  const p = writeTranscript(t, threeAssistantRows());
  const firstRowLen = fs.readFileSync(p, 'utf8').indexOf('\n') + 1;
  const a = totalsFromTranscript(p, 'sC', PRICES, { cacheDir: d, chunkBytes: 32, maxBytesPerPass: firstRowLen });
  assert.equal(a.partial, true); assert.equal(a.input, 2000);
  const b = totalsFromTranscript(p, 'sC', PRICES, { cacheDir: d, chunkBytes: 32, maxBytesPerPass: 1 << 20 });
  assert.equal(b.partial, false); assert.equal(b.input, 6000);
  assert.ok(fs.existsSync(path.join(d, 'claude-cost-sC.v5.json')));
});
test('costsSinceCompact counts only rows after compactMs, chunked', (t) => { /* rows at t0, t0+10s, t0+20s; compactMs = t0+5s → cost of rows 2+3; chunkBytes 48 */ });
test('MAX chunk constant is bounded', () => { assert.ok(DEFAULT_CHUNK_BYTES <= 16 * 1024 * 1024); });
test('statusline economics delegates to the lib and survives a missing lib', (t) => { /* economics.totalsFromTranscript(path, sid) equals lib result; with lib-loader stubbed to null → empty shape */ });
```

- [ ] **Step 2: Run to verify they fail** — Expected: `opts` ignored → `partial` undefined, cache in tmpdir.
- [ ] **Step 3: Implement** the scanner and both functions; delete the statusline copies (`economics.js` shrinks by ~200 lines); keep the per-model pricing and dedupe semantics the existing lib tests pin.
- [ ] **Step 4: Verify** — `npm test`; full matrix; goldens unchanged (same totals); `wc -l lib/cost-estimation.js` ≤ 800.
- [ ] **Step 5: Commit** — `git commit -m "fix(si): chunked, bounded transcript economics in one lib scanner; caches move to the state dir"`

---

### Task 6: Delete the whole-session `tps` fallback (D7)

**Files:**
- Modify: `statusline/renderers.js` (`tokenSpeed`, fallback block was 1466-1473), `README.md:317`
- Test: `tests/statusline-renderers.test.js`

- [ ] **Step 1: Failing test**

```js
test('tokenSpeed renders nothing when the transcript yields no speed sample', (t) => {
  const R = buildRenderers(makeColors(false), {});
  const input = { transcript_path: writeRows(t, []), cost: { total_api_duration_ms: 3_600_000 }, context_window: { total_output_tokens: 503_000 } };
  assert.equal(R.tokenSpeed(input, { tokenTotals: { output: 503_000 } }), '');
});
```

- [ ] **Step 2: Verify it fails** (`tps:140` rendered). **Step 3:** delete the fallback; the primary path (`lib/token-speed`) is untouched. **Step 4:** `npm test`; goldens: fixture transcripts have three timed rows so `tps:` stays or goes per the lib; quote. **Step 5:** `git commit -m "fix(si): drop the misleading session-average tps fallback"`

---

### Task 7: Quota cells read stdin truthfully; poller only without `rate_limits` (D6, D8)

**Files:**
- Modify: `statusline/renderers.js` (`blockUsage`, `weekUsage`, `modelQuota`, new `spendLimit`), `statusline/format.js` (`renderUsageCell` stale flag from `u.stale || u.error`), `lib/config.js` (presets: `verbose` and `verbose-cache` line 5 become `'weekUsage', 'spendLimit', 'modelQuota', 'modelSplit'`), `README.md:276-278, 318`
- Test: `tests/statusline-renderers.test.js`, `tests/config.test.js`

**Interfaces:**
- Produces: `spendLimit(input)`: from `input.rate_limits.spend_limit`; with finite `used_usd` and `limit_usd` → `sl:$<used>/$<limit><period[0]>` (`fmtUsdShort`, period letter d/w/m), else `sl:<used>%`; red when `used_percentage ≥ 100`; `r:<dur>` from `resets_at` like the other cells; empty when absent.
- Produces: `modelQuota(input, ctx)`: empty whenever `input.rate_limits` is an object; otherwise renders `deps.loadUsage()`'s `modelQuotas` with `~` when `u.stale || u.error`.
- Produces: `blockUsage`/`weekUsage`: stdin window when present; `deps.loadUsage()` only when `input.rate_limits` is not an object; `~` when `u.stale || u.error`.

- [ ] **Step 1: Failing tests**

```js
test('stdin rate_limits never triggers the usage poller', () => {
  let calls = 0; const R = buildRenderers(C, { loadUsage: () => { calls++; return null; } });
  const input = { rate_limits: { five_hour: { used_percentage: 36, resets_at: far }, seven_day: { used_percentage: 95, resets_at: far } } };
  R.blockUsage(input, {}); R.weekUsage(input, {}); R.modelQuota(input, {}); R.spendLimit(input, {});
  assert.equal(calls, 0);
});
test('missing rate_limits object falls back to the poller once', () => { /* calls === 1 across the three cells thanks to memo; cell shows b:36% */ });
test('a stale-by-age cache renders with ~', () => { /* loadUsage → { sessionUsage: 36, stale: true, error: false } → /~b:36%/ */ });
test('spend_limit renders as a budget, never as a model quota', () => {
  const input = { rate_limits: { spend_limit: { used_percentage: 42, resets_at: far, used_usd: 21, limit_usd: 50, period: 'weekly' } } };
  assert.match(R.spendLimit(input, {}), /^sl:\$21\/\$50w/); assert.equal(R.modelQuota(input, {}), '');
});
test('spend_limit over 100 % is red and percent-only without USD fields', () => { /* used_percentage 120, no usd → /sl:120%/ and colour red when C has colours */ });
test('verbose presets carry spendLimit after weekUsage', () => { /* config presets */ });
```

- [ ] **Step 2: Verify they fail** (modelQuota renders `spend_limit:42/58%`; poller called). **Step 3: Implement.** **Step 4:** `npm test`; goldens: fixture `g_no_rate_limits_cache_fallback` is the only one without `rate_limits` (its cells now carry `~` if the fresh cache is marked stale — it is fresh, so no `~`); line 5 gains nothing for fixtures without `spend_limit`; quote the diff. **Step 5:** `git commit -m "fix(si): spend_limit renders as a budget; usage poller runs only when stdin has no rate_limits"`

---

### Task 8: Zones honoured in absolute mode; honest bar for unknown caps; clean k/M formatting (D9, D10)

**Files:**
- Modify: `statusline/zones.js` (`resolveZones`), `lib/config.js` (`resolveStatuslineForCwd` 560-~590: a per-project override carrying `zones` sets `zoneMode: 'absolute'` unless the override sets `zoneMode` itself), `statusline/economics.js` (`contextCap` → `{ cap, source }`), `statusline/renderers.js` (`tokens` cell; `renderContextBar` callers), `statusline/format.js` (`fmtTokens`, `fmtTokensTight`: strip trailing `.0`, `≥ 1e6` → `1M`/`1.5M`), `README.md:437-454` (perProject example gains `zoneMode`)
- Test: `tests/statusline-zones.test.js`, `tests/statusline-format.test.js`, `tests/statusline-renderers.test.js`, `tests/config.test.js`

- [ ] **Step 1: Failing tests**

```js
test('resolveZones keeps user zones in absolute mode even when the learner is confident', () => {
  const cfg = { zoneMode: 'absolute', zones: { yellow: 100000, orange: 150000, red: 180000 } };
  const z = resolveZones(cfg, { cap: 200000, cwd: '/x', history: [], adaptiveZones: () => ({ adaptive: true, yellow: 1, orange: 2, red: 3 }) });
  assert.deepEqual(z, { yellow: 100000, orange: 150000, red: 180000, source: 'absolute' });
});
test('resolveZones applies the learner in fraction mode', () => { /* source 'adaptive', values from the stub */ });
test('per-project zones override implies absolute mode', () => { /* resolveStatuslineForCwd(cfg with perProject {'/p': {zones:{red:500000}}}, '/p/sub').zoneMode === 'absolute' */ });
test('tokens cell renders used/? without bar or percent when the cap is a fallback', (t) => { /* input = e2_unknown_model_no_cw payload, ctx.tokens 175700, usedTranscript true → /175\.7k\/\?/ and no '▰' and no '%' */ });
test('fmtTokens drops trailing zeros and uses M', () => {
  assert.equal(fmtTokens(200000), '200k'); assert.equal(fmtTokens(175700), '175.7k');
  assert.equal(fmtTokens(1000000), '1M'); assert.equal(fmtTokens(1500000), '1.5M'); assert.equal(fmtTokens(999), '999');
});
```

- [ ] **Step 2: Verify they fail.** **Step 3: Implement** (keep `fmtTokens`' existing tiers apart from trailing-zero stripping and the M tier; `contextCap` callers use `.cap`). **Step 4:** goldens: `e2_unknown_model_no_cw` line 1 changes to `175.7k/?`; `b_fable_200k_48pct` shows `…/200k` instead of `…/200.0k`; quote. `npm test` + matrix (config.js changed). **Step 5:** `git commit -m "fix(si): honour absolute zones, honest tokens cell for unknown caps, clean k/M formatting"`

---

### Task 9: Honest cache-savings labelling (D5)

**Files:**
- Modify: `statusline/renderers.js` (`costSaved` 1194-1214, `compactCost` 1344-1386: the saved cell renders `~s$`), `README.md` row for `costSaved`/`compactCost` (method: list-price savings × official/transcript cost ratio; `~` = SI estimate)
- Test: `tests/statusline-renderers.test.js`

- [ ] **Step 1: Failing test** — `costSaved` with `ctx = { officialCostUsd: 119, tokenTotals: { cost: 45 }, cacheSavedUsd: 250 }` → matches `/~s\$/` and the amount is `250 × 119/45 ≈ 661` (`~s$661`). **Step 2: fails** (`s$661`). **Step 3: Implement.** **Step 4:** goldens line 1/2 gain `~` before `s$`; quote. **Step 5:** `git commit -m "fix(si): label calibrated cache savings as an estimate"`

---

### Task 10: Hygiene: dead code, driver log, sweep, test litter, injection template (D12 + template)

**Files:**
- Modify: `lib/cost-estimation.js` (delete `costBand` 310-331 and its export), `statusline/economics.js` (delete `readCostSnapshot`), `lib/events.js:59-62` (log `sqlite driver` only when `opened.driver !== 'better-sqlite3'`), `hooks/si-bootstrap.js:617` (`STALE_TEMP_PREFIX_RE` gains `compact-prefix|compact-snapshot|health|usage-lock`; `cost` added in Task 5), `templates/claude-md-rules.md` (tool-archive path → `~/.claude/state/claude-tool-archive-<sid>/`), the tests that leak into `os.tmpdir()` (find with `grep -ln "compact-snapshot-test\|cost-totals-test\|cost-dedupe-test\|cost-permodel-test\|compact-prefix" tests/*.js`: they get `TMPDIR`/`HOME` temp dirs or `t.after` cleanup)
- Test: `tests/templates.test.js` (new), `tests/events.test.js` (driver log), `tests/hooks-bootstrap*.test.js` or the existing sweep regex test from the previous tier (extend)
- Also: `git checkout -- CLAUDE.md plugins/session-intelligence/CLAUDE.md` (the working-tree copies carry the stale template text; HEAD is correct) — do NOT stage them afterwards.

- [ ] **Step 1: Failing tests**

```js
test('injection template names the real tool-archive dir', () => {
  const t = fs.readFileSync(path.join(__dirname, '..', 'templates', 'claude-md-rules.md'), 'utf8');
  assert.match(t, /~\/\.claude\/state\/claude-tool-archive-<sid>\//); assert.doesNotMatch(t, /\$\{TMPDIR\}\/claude-tool-archive/);
});
test('sqlite driver line is logged only for the fallback driver', (t) => { /* HOME temp, CLAUDE_INTEL_DEBUG=1: open with default driver → log file has no 'sqlite driver'; SI_SQLITE_DRIVER=node:sqlite (spawned) → has it */ });
test('stale sweep regex covers cost, compact-prefix, compact-snapshot, health and usage-lock files', () => { /* extend the existing regex test */ });
test('costBand is gone', () => { assert.equal(require('../lib/cost-estimation').costBand, undefined); });
```

- [ ] **Step 2: Verify they fail.** **Step 3: Implement.** **Step 4: Verify no litter**: `D=$(mktemp -d); TMPDIR=$D HOME=$D npm test > /dev/null; ls $D | grep -c '^claude-'` — Expected: `0` (if a test still leaks, fix it before committing). Full matrix green. **Step 5:** `git commit -m "chore(si): remove dead cost code, quiet the driver log, widen the stale sweep, stop test litter, fix the CLAUDE.md template path"`

---

### Task 11: README and config comment regenerated from the golden render (D11)

**Files:**
- Modify: `README.md` 263-320 (statusline section), 385-410 (chain-wrapper example + perf note), 413-425 (env table), 437-454 (perProject); `lib/config.js:34-48` (comment: five lines, list them as the preset renders)
- Test: `tests/readme-statusline.test.js` (new)

**Interfaces:**
- Consumes: `tests/fixtures/statusline/golden/a_fable_1m_48pct.txt` (post-Task-10 content) as the README example; the test normalises temp paths in both.

- [ ] **Step 1: Failing test**

```js
test('README statusline example matches the golden render of a_fable_1m_48pct', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'README.md'), 'utf8');
  const block = readme.match(/<!-- statusline-example -->\n```\n([\s\S]*?)\n```/)[1];
  const golden = fs.readFileSync(GOLDEN('a_fable_1m_48pct'), 'utf8').trim();
  assert.equal(block.trim(), golden);
});
test('README statusline section has no stale claims', () => {
  for (const stale of ['wr:~', 'four lines', 'sid:82cc15b9', 'first 8 chars', 'longer than 60 chars', 'compact:1hr 22m ago', '/tmp/claude-cost-sincecompact-<sid>', 'zero API requests']) assert.ok(!readme.includes(stale), stale);
  for (const fresh of ['spendLimit', '~s$', 'thinking_tokens', 'six characters', 'claude-cost-<sid>.v5.json']) assert.ok(readme.includes(fresh), fresh);
});
```

- [ ] **Step 2: Verify it fails.** **Step 3: Rewrite** the section: the example block wrapped in `<!-- statusline-example -->` + fenced code, copied from the golden file; rows updated for every cell this plan changed (tools, thinking `~`, modelSplit `$·%`, spendLimit, modelQuota, tps, costSaved `~s$`, tokenFlow definition `↓ input_tokens · ↑ output · c = cache_read + cache_creation`, sid six chars, cwd 36, compactCost cache path, quota paragraph: stdin on ≥ 2.1.90 with no poller; poller only on older builds; `~` = stale or errored cache), measured perf (`time` of 20 renders of the fixture through the entry file, warm) replaces the stale numbers; `config.js` comment. **Step 4:** `npm test` green. **Step 5:** `git commit -m "docs(si): regenerate the statusline section from the golden render; drift test"`

---

### Task 12: Sync, matrix, live render check

**Files:**
- Modify: none expected; `README.md` only if the live check reveals a mismatch.

- [ ] **Step 1: Size and matrix** — `wc -l statusline/*.js lib/*.js | sort -rn | head -5` all ≤ 800; `npm test && npm run test:node22 && SI_SQLITE_DRIVER=node:sqlite npm run test:node22` green.
- [ ] **Step 2: Sync** — `npm run sync` then `diff -rq statusline ~/.claude/plugins/cache/session-intelligence/session-intelligence/1.0.0/statusline && diff -rq lib …/lib && diff -rq templates …/templates` → no differences.
- [ ] **Step 3: Live render** — `NO_COLOR=1 bash ~/.claude/scripts/si-statusline-chain.sh < tests/fixtures/statusline/payloads/a_fable_1m_48pct.json` (with `CLAUDE_STATUSLINE_NO_PREV=1`) → first five lines are the intel lines; exit 0; no `wr:`; then with the real current session payload if one is capturable (`~/.claude/state` tool-count file for this session exists → `NNN tools` cell renders). Record the output in the task report.
- [ ] **Step 4: Litter check** — `D=$(mktemp -d); TMPDIR=$D HOME=$D npm test >/dev/null; ls $D | grep -c '^claude-'` → `0`.
- [ ] **Step 5: Commit** (only if something changed) — `git commit -m "chore(si): statusline tier sync"`.
