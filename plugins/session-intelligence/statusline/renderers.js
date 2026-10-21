'use strict';

// Field renderers (buildRenderers), context bar, zone colouring and emoji pickers.

const path = require('path');
const os = require('os');
const { resolveLibDir, loadContextShapeLib, loadTokenSpeedLib, loadEventsLib, agentModelCostsSafe, loadUsage: defaultLoadUsage } = require('./lib-loader');
const { renderUsageCell: _renderUsageCellImpl, fmtTokens, fmtTokensTight, fmtUsd, fmtDurationTight, truncate, truncateMiddle, projectLabel } = require('./format');
const { gitBranch, gitDirtyCount, gitDiffStat, extractIssueNumber, readDeployBreadcrumb, detectOutputStyle, detectSiPluginGate, probeHealthIfStale } = require('./git-info');
const { contextCap, minutesSinceLastCompact, costAtLastCompact, costsSinceCompact, DEFAULT_PRICES } = require('./economics');

/**
 * Render a Unicode progress bar as a segmented gradient. Each filled slot
 * is coloured by the zone the tokens AT THAT SLOT POSITION belong to
 * (green → yellow → orange → red), so zone boundaries are visible even
 * mid-fill. Empty slots stay dim. This replaces the prior mono-colour fill
 * (whole bar = current zone's colour) that made zone progression invisible
 * until the bar flipped wholesale.
 *
 * `zoneColorName` is no longer used for the fill — it's accepted for
 * source compatibility with callers that still pass it. Unfilled tail
 * colour is always dim.
 *
 * Returns an ANSI-coloured string of visible width `width`.
 */
function renderContextBar(used, cap, zones, C, _zoneColorName, width) {
  const w = Math.max(8, Math.min(40, width || 20));
  const ratio = cap > 0 ? Math.max(0, Math.min(1, used / cap)) : 0;
  const filled = Math.round(ratio * w);
  if (cap <= 0) {
    return `${C.dim}${'▱'.repeat(w)}${C.reset}`;
  }
  let out = '';
  let prevColor = '';
  for (let i = 0; i < filled; i++) {
    // Classify each slot by the tokens at its upper edge so a slot that
    // crosses a zone threshold takes the new zone's colour (visual bias
    // toward "this is the zone you've reached").
    const slotTokens = ((i + 1) / w) * cap;
    const color = C[zoneFor(slotTokens, zones).color] || C.reset;
    if (color !== prevColor) {
      out += `${C.reset}${color}`;
      prevColor = color;
    }
    out += '▰';
  }
  out += `${C.reset}${C.dim}${'▱'.repeat(w - filled)}${C.reset}`;
  return out;
}

function zoneFor(tokens, zones) {
  if (tokens >= zones.red)    return { name: 'red',    color: 'red',    icon: '▰▰▰▰' };
  if (tokens >= zones.orange) return { name: 'orange', color: 'orange', icon: '▰▰▰▱' };
  if (tokens >= zones.yellow) return { name: 'yellow', color: 'yellow', icon: '▰▰▱▱' };
  return { name: 'green', color: 'green', icon: '▰▱▱▱' };
}

// ─── Intelligent emoji ───────────────────────────────────────────────────────
// Priority (first match wins):
//   🔥 red zone
//   ⚠️  orange zone
//   🚀 deploy breadcrumb < 15 min old
//   🐛 task mentions bug/fix/issue
//   🏗️ task mentions build/feat/add
//   ✏️  dirty working tree mid-task
//   🟡 yellow zone
//   ✨ clean idle — tree clean + green zone + idle task
//   🟢 fallback green
function pickEmoji(ctx, input) {
  const zone = zoneFor(ctx.tokens, ctx.cfg.zones).name;
  if (zone === 'red') return '🔥';
  if (zone === 'orange') return '⚠️';

  const deploy = readDeployBreadcrumb();
  if (deploy && deploy.ageMs < 15 * 60 * 1000) return '🚀';

  const task = (ctx.task || '').toLowerCase();
  if (/\b(bug|fix|issue|error|crash)\b/.test(task)) return '🐛';
  if (/\b(build|feat|add|implement|create)\b/.test(task)) return '🏗️';
  if (/\b(refactor|cleanup|simpl)\b/.test(task)) return '🧹';
  if (/\b(test|spec)\b/.test(task)) return '🧪';
  if (/\b(deploy|ship|release)\b/.test(task)) return '🚀';
  if (/\b(doc|readme)\b/.test(task)) return '📝';

  const dirty = gitDirtyCount(input.cwd || process.cwd());
  if (dirty > 0) return '✏️';

  if (zone === 'yellow') return '🟡';

  if (/\b(idle|done|clean|ended|ready)\b/.test(task)) return '✨';
  return '🟢';
}

/**
 * Second-line emoji — reflects activity signals (tools/time/cost/deploy),
 * not state. Priority order:
 *   🚀 very recent deploy (<5min)
 *   💸 cost above threshold (default $3)
 *   🕐 long session (>2h)
 *   🔧 heavy tool use (>100 calls)
 *   📊 default (metrics/stats)
 */
function pickEmojiSecond(ctx) {
  const deploy = readDeployBreadcrumb();
  if (deploy && deploy.ageMs < 5 * 60 * 1000) return '🚀';

  if (ctx.costUsd && ctx.costUsd >= 3) return '💸';
  if (ctx.sessionDurationMs && ctx.sessionDurationMs > 2 * 60 * 60 * 1000) return '🕐';
  if (ctx.tools && ctx.tools > 100) return '🔧';

  return '📊';
}

// ─── Field renderers ─────────────────────────────────────────────────────────
// Each renderer returns a string (possibly with ANSI) or '' to skip.

function buildRenderers(C, deps = {}) {
  const loadUsage = typeof deps.loadUsage === 'function' ? deps.loadUsage : defaultLoadUsage;
  return {
    /** Intelligent leading emoji — picks based on zone, dirty tree, task intent, deploy. */
    emoji: (input, ctx) => pickEmoji(ctx, input),

    /** Activity-aware emoji for line 2 (tools/time/cost/deploy). */
    emoji2: (_input, ctx) => pickEmojiSecond(ctx),

    // Colour policy (see README "Statusline palette"): line 1 is all dim
    // except `tokens`, which is the one signal worth a colour because the
    // whole bar exists to warn about context pressure. Every other field is
    // context FOR that signal — making them bright just adds noise.
    model: (input) => {
      const raw = input.model?.display_name || input.model?.id || 'claude';
      // Trim trailing parenthetical metadata like " (1M context)" from the
      // display name — the context window is implicit and the cell stays
      // identity-only ("Opus 4.7"). output_style now renders as its own
      // cell (`outputStyle` below), so this keeps `model` single-purpose.
      const m = raw.replace(/\s*\([^)]*\)\s*$/, '').trim() || raw;
      return `${C.dim}${m}${C.reset}`;
    },

    project: (input) => `${C.dim}${projectLabel(input.cwd)}${C.reset}`,

    branch: (input, ctx) => {
      const b = gitBranch(input.cwd);
      if (!b) return '';
      // Long branch names (feat/some-very-long-task-name-here) blow past the
      // last status line on narrow terminals and the row vanishes mid-render.
      // Middle-truncate so the prefix (`feat/`, `fix/`) and the trailing slug
      // both survive — both carry signal.
      const max = Number.isFinite(ctx.cfg.maxBranchLength)
        && ctx.cfg.maxBranchLength > 5
        ? Math.floor(ctx.cfg.maxBranchLength)
        : 28;
      return `${C.dim}${truncateMiddle(b, max)}${C.reset}`;
    },

    dirty: (input) => {
      const n = gitDirtyCount(input.cwd);
      if (n === 0) return '';
      return `${C.yellow}\u00b1${n}${C.reset}`;
    },

    tokens: (input, ctx) => {
      const t = ctx.tokens;
      const zone = zoneFor(t, ctx.cfg.zones);
      const color = C[zone.color] || C.reset;
      const sourceTag = ctx.cfg.tokenSource === 'estimate' || !ctx.usedTranscript
        ? `${C.dim}~${C.reset}` : '';
      // Idle bar: skip the fill bar entirely, just show the zone icon.
      if (t <= 0) {
        return `${C.dim}${sourceTag}${zone.icon} idle${C.reset}`;
      }
      const cap = contextCap(input, ctx.cfg);
      const segs = Number.isFinite(ctx.cfg.maxBarSegments) ? ctx.cfg.maxBarSegments : 14;
      const bar = renderContextBar(t, cap, ctx.cfg.zones, C, zone.color, segs);
      const used = fmtTokens(t);
      const total = cap >= 1_000_000 ? '1M' : fmtTokens(cap);
      const pct = cap > 0 ? Math.round((t / cap) * 100) : 0;
      // `175.7k/1M 18%` — keep the cap visible so the absolute scale is
      // unambiguous; percent stays trailing, dim, sans `()` to keep the
      // cell tight.
      return `${bar}${C.reset} ${color}${sourceTag}${used}${C.reset}${C.dim}/${total}${C.reset} ${C.dim}${pct}%${C.reset}`;
    },

    zone: (input, ctx) => {
      const zone = zoneFor(ctx.tokens, ctx.cfg.zones);
      return `${C[zone.color] || ''}${zone.name}${C.reset}`;
    },

    tools: (_input, ctx) => {
      if (ctx.tools <= 0) return '';
      const label = ctx.tools === 1 ? 'tool' : 'tools';
      return `${C.dim}${ctx.tools} ${label}${C.reset}`;
    },

    session: (_input, ctx) => {
      if (!ctx.sessionDurationMs) return '';
      return `${C.dim}${fmtDurationTight(ctx.sessionDurationMs)}${C.reset}`;
    },

    /**
     * Recent thinking-token estimate. Renders only when the tail-window
     * estimate crosses `statusline.thinkingMinDisplay` so an idle bar stays
     * quiet. Dim — thinking is context for the tokens field, not its own
     * zone alert.
     */
    thinking: (_input, ctx) => {
      const recent = ctx.thinking && ctx.thinking.recent;
      if (!recent) return '';
      const minDisplay = Number.isFinite(ctx.cfg.thinkingMinDisplay)
        ? ctx.cfg.thinkingMinDisplay : 5000;
      if (recent < minDisplay) return '';
      return `${C.dim}think:${fmtTokens(recent)}${C.reset}`;
    },

    task: (_input, ctx) => {
      if (!ctx.task) return '';
      // Line 2 stays dim/grey so the status bar has one loud voice (tokens +
      // compact alerts on line 1) and one quiet voice (the context on line 2).
      // Keyword colouring here competed with the real signal and made the bar
      // look carnival-bright. See statusline colour policy in README.
      return `${C.dim}${ctx.task}${C.reset}`;
    },

    /**
     * Short session id (first 8 chars of the UUID) — handy when you have
     * multiple Claude Code windows open and want to tell them apart on
     * the status line. Hidden when no session id is present.
     */
    sessionId: (input, _ctx) => {
      const sid = input.session_id || input.sessionId || '';
      if (!sid) return '';
      // 6-char prefix is plenty to disambiguate a handful of open windows.
      // Keep the `sid:` label — it's the established convention for the
      // session-id cell and reads more clearly than a bare `id:`.
      const short = String(sid).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 6);
      return short ? `${C.dim}sid:${short}${C.reset}` : '';
    },

    cost: (_input, ctx) => {
      if (!ctx.costUsd) return '';
      return `${C.dim}$${ctx.costUsd.toFixed(2)}${C.reset}`;
    },

    /**
     * Combined cost + cache-savings: `c$0.45 / s$1.23`. Merges what used to be
     * two adjacent fields (`cost` + `cacheSaved`) into one token-economics
     * cell so line 2 stays compact. Omits either side when zero; hides
     * entirely when both are zero.
     */
    costSaved: (_input, ctx) => {
      const cost = ctx.costUsd || 0;
      // Cache-savings is transcript-priced (Anthropic doesn't expose a
      // saved-by-cache field). DEFAULT_PRICES tracks list price for the
      // top tier; for any session billed at a discount (newer model
      // generations, plan caps), the raw transcript savings overstates by
      // the same ratio the transcript-cost overstates `total_cost_usd`.
      // Auto-calibrate by that ratio when both numbers are available, so
      // savings stays denominated in the same currency the user sees on
      // their bill.
      const transcriptCost = ctx.tokenTotals && ctx.tokenTotals.cost;
      const calibration = (ctx.officialCostUsd && transcriptCost > 0)
        ? (ctx.officialCostUsd / transcriptCost)
        : 1;
      const saved = (ctx.cacheSavedUsd || 0) * calibration;
      const parts = [];
      if (cost > 0) parts.push(`c${fmtUsd(cost)}`);
      if (saved >= 0.1) parts.push(`s${fmtUsd(saved)}`);
      if (!parts.length) return '';
      return `${C.dim}${parts.join('/')}${C.reset}`;
    },

    /**
     * Live prompt-cache hit ratio from the latest assistant turn's usage
     * block: cache_read / (cache_read + cache_creation). Shown as `cache:92%`.
     * Colour-gated: dim green ≥70% (good hit rate), dim yellow 30-70%
     * (mediocre), dim red <30% (cache mostly missing — the stablePrefix
     * feature isn't paying off). Empty when there's no cacheable prefix on
     * the latest turn (first turn of a session).
     */
    cacheHit: (_input, ctx) => {
      const u = ctx.usage;
      if (!u) return '';
      const read = u.cache_read_input_tokens || 0;
      const creation = u.cache_creation_input_tokens || 0;
      const denom = read + creation;
      if (denom <= 0) return '';
      const ratio = read / denom;
      const pct = Math.round(ratio * 100);
      // Dim colour tier so line 3 stays visually quiet; just enough accent
      // to catch a bad hit rate out of the corner of the eye.
      let tier = C.dim;
      if (ratio >= 0.7) tier = `${C.dim}${C.green}`;
      else if (ratio < 0.3) tier = `${C.dim}${C.red}`;
      else tier = `${C.dim}${C.yellow}`;
      return `${tier}cache:${pct}%${C.reset}`;
    },

    /**
     * Per-turn prefix breakdown: `prefix:<read>k/<creation>k` where read is
     * served from cache and creation is the new-to-cache portion of this
     * turn's prompt. A low read + high creation on a stable working set is
     * the warning sign stablePrefix is leaking a volatile value somewhere.
     */
    cacheTokens: (_input, ctx) => {
      const u = ctx.usage;
      if (!u) return '';
      const read = u.cache_read_input_tokens || 0;
      const creation = u.cache_creation_input_tokens || 0;
      if (read + creation <= 0) return '';
      return `${C.dim}prefix:${fmtTokens(read)}/${fmtTokens(creation)}${C.reset}`;
    },

    /**
     * Cumulative USD saved across the session by prefix-cache hits versus the
     * counterfactual of paying the uncached input rate. Hidden when savings
     * are trivially small — under $0.10 isn't worth a whole field.
     */
    cacheSaved: (_input, ctx) => {
      if (!ctx.cacheSavedUsd || ctx.cacheSavedUsd < 0.1) return '';
      return `${C.dim}saved:$${ctx.cacheSavedUsd.toFixed(2)}${C.reset}`;
    },

    /**
     * Cumulative token flow across the session, format matching ccstatusline
     * and Claude Code's own context-window summary so both surfaces agree
     * on the same numbers. `<total> ↓<in> ↑<out> c<cached>`:
     *   total = input + cache_creation + cache_read + output  (all tokens
     *           Anthropic billed for at any rate)
     *   ↓ in  = input_tokens                                  (fresh, uncached
     *           input — what you paid the full input rate for)
     *   ↑ out = output_tokens                                 (model output)
     *   c     = cache_read + cache_creation                   (all cache
     *           activity — reads served AND first-time writes)
     * Invariant: in + out + c = total, so the three components partition the
     * session's token spend cleanly. Hidden when no transcript data yet.
     */
    tokenFlow: (_input, ctx) => {
      const t = ctx.tokenTotals;
      if (!t) return '';
      const total = t.input + t.output + t.cached + t.creation;
      if (total <= 0) return '';
      const cacheActivity = t.cached + t.creation;
      // Mirror the `c<cache>` suffix style on the total: `t33M ↓540 ↑160k c33M`.
      // Single-letter prefixes line up visually with the in/out/cache parts
      // and read as one cohesive cell. Use fmtTokensTight so 26.08M collapses
      // to 26M.
      return `${C.dim}t${fmtTokensTight(total)} ↓${fmtTokensTight(t.input)} ↑${fmtTokensTight(t.output)} c${fmtTokensTight(cacheActivity)}${C.reset}`;
    },

    /**
     * Git diff-stat: (+N,-M) across all uncommitted changes in HEAD + untracked.
     * Skipped silently when clean. All dim — see colour policy above.
     */
    diffstat: (input, _ctx) => {
      const s = gitDiffStat(input.cwd);
      if (!s.added && !s.deleted) return '';
      return `${C.gray}(${C.green}+${s.added}${C.gray},${C.red}-${s.deleted}${C.gray})${C.reset}`;
    },

    /** GH issue number (#164) parsed from branch or current task. */
    issue: (input, ctx) => {
      const branch = gitBranch(input.cwd);
      const iss = extractIssueNumber(branch, ctx.task);
      return iss ? `${C.dim}${iss}${C.reset}` : '';
    },

    /** Minutes since last compaction event IN THIS SESSION (pre-compact
     *  hook writes compact-history.jsonl keyed by session id). Empty when
     *  the current session hasn't compacted yet — a global last-compact
     *  age would surface other tabs' compacts and misrepresent this run.
     *  The only line-2 field that escalates colour — red is reserved for
     *  the "you should compact now" alert so it stands out against the
     *  otherwise dim second line:
     *    <120m  dim  — fresh enough, no action
     *    >=120m red  — overdue, compact strongly suggested */
    compactAge: (input, _ctx) => {
      const sid = input.session_id || input.sessionId || '';
      const mins = minutesSinceLastCompact(sid);
      if (mins === null) return '';
      const label = fmtDurationTight(mins * 60 * 1000);
      const color = mins >= 120 ? C.red : C.dim;
      // `cpt:3h23m ago` — `cpt` abbrev + tight duration + `ago` suffix
      // (the elapsed sense reads naturally with the trailing word).
      return `${color}cpt:${label} ago${C.reset}`;
    },

    /** Cost + cache-savings accrued since last /compact. Pairs with
     *  compactAge to answer "how much has this post-compact run cost so
     *  far, and how much is the prefix cache earning me." Hidden when
     *  both are trivially small (<$0.10) or when no compact has happened
     *  yet. Always dim — volume signal, not a warning.
     *
     *  Cost source preference: when both Claude Code's authoritative
     *  `total_cost_usd` AND a stamped `costAtCompactUsd` from history are
     *  available, return `current - atCompact` — a strict subset of the
     *  whole-session cost. Fallback to the transcript-priced estimate
     *  when either is missing (pre-fix history entries, fresh sessions
     *  before the snapshot writes, or environments where Claude Code
     *  doesn't expose `total_cost_usd`). */
    compactCost: (input, ctx) => {
      const sid = input.session_id || input.sessionId || '';
      const atCompact = costAtLastCompact(sid);
      const haveAuthoritative = atCompact !== null
        && ctx.officialCostUsd !== null
        && Number.isFinite(ctx.officialCostUsd);
      const tc = costsSinceCompact(
        input.transcript_path || input.transcriptPath || '',
        sid,
        ctx.cfg.prices || DEFAULT_PRICES,
      );
      // Calibrate transcript-derived numbers to billing reality. Preferred:
      // post-compact ratio (cost-since-compact / transcript-since-compact)
      // when authoritative is available. Fallback: whole-session ratio
      // (officialCostUsd / tokenTotals.cost). Both apply to savings; the
      // whole-session ratio also rescues the cost cell when authoritative
      // post-compact isn't computable (e.g. compact entry predates the
      // cost-stamp). Without dedupe this would have been wildly wrong;
      // with dedupe (msg.id) the transcript token counts are accurate and
      // the only remaining drift is the per-token price, which the ratio
      // captures.
      let calibration = 1;
      let costSource = 'none';
      let cost = 0;
      if (haveAuthoritative) {
        cost = Math.max(0, ctx.officialCostUsd - atCompact);
        costSource = 'authoritative';
        if (tc.cost > 0) calibration = cost / tc.cost;
      } else if (ctx.officialCostUsd && ctx.tokenTotals && ctx.tokenTotals.cost > 0) {
        calibration = ctx.officialCostUsd / ctx.tokenTotals.cost;
        cost = tc.cost * calibration;
        costSource = 'calibrated';
      }
      const saved = tc.saved * calibration;
      const parts = [];
      if (costSource !== 'none' && cost >= 0.01) parts.push(`c${fmtUsd(cost)}`);
      if (saved >= 0.1) parts.push(`s${fmtUsd(saved)}`);
      if (!parts.length) return '';
      // Tight `c$20/s$94` instead of `c$20.31 / s$94.59` — saves ~8 cols
      // per cell. The `c`/`s` prefixes carry the labelling so the slash
      // can sit flush without ambiguity.
      return `${C.dim}${parts.join('/')}${C.reset}`;
    },

    /** Distance to auto-compaction: context tokens / the resolved
     *  auto-compaction point (env, modelSettings, settings, else the model
     *  default), as `cmp:43%`. Silent without a real usage line.
     *  Zone-colored: <60% green · 60-85% yellow · 85-95% orange · >=95% red */
    contextPct: (input, ctx) => {
      const dir = resolveLibDir();
      if (!ctx.usedTranscript || !dir) return '';
      let pct = null;
      try {
        const lib = require(path.join(dir, 'context-cap.js'));
        const model = input.model && (input.model.id || input.model.display_name);
        const cap = contextCap(input, ctx.cfg);
        const { point } = lib.resolveAutoCompactPoint({ cap, model, env: process.env, settings: lib.loadSettingsForCwd(input.cwd) });
        pct = lib.pctToCompaction({ contextTokens: ctx.tokens, point });
      } catch { return ''; }
      if (pct === null) return '';
      let col = C.green;
      if (pct >= 95) col = C.red;
      else if (pct >= 85) col = C.orange;
      else if (pct >= 60) col = C.yellow;
      return `${col}cmp:${pct}%${C.reset}`;
    },

    /** Claude Code 5-hour block usage + time until reset, as `b:47% · r:3hr12m`.
     *
     *  Source order:
     *   1. `rate_limits.five_hour` from the statusline stdin JSON — Claude
     *      Code ≥2.1.90 hands us the quota directly, fresh every redraw,
     *      zero API requests.
     *   2. Fallback for older builds: the cached /api/oauth/usage poller.
     *      That endpoint aggressively 429s pollers (anthropic/claude-code
     *      #31637, closed not-planned), so it's strictly a fallback; while
     *      it errors the cache carries the last good values and the cell
     *      renders them with a `~` marker instead of vanishing. */
    blockUsage: (input, _ctx) => {
      const fh = input && input.rate_limits && input.rate_limits.five_hour;
      if (fh && typeof fh.used_percentage === 'number') {
        return _renderUsageCellImpl('b', fh.used_percentage, fh.resets_at, C, 'dim', false);
      }
      const u = loadUsage();
      if (!u || typeof u.sessionUsage !== 'number') return '';
      return _renderUsageCellImpl('b', u.sessionUsage, u.sessionResetAt, C, 'dim', !!u.error);
    },

    /** Weekly (7-day) usage + time until reset. Same shape and source
     *  order as blockUsage with a `w` prefix. Format: `w:31% · r:4d12hr`. */
    weekUsage: (input, _ctx) => {
      const sd = input && input.rate_limits && input.rate_limits.seven_day;
      if (sd && typeof sd.used_percentage === 'number') {
        return _renderUsageCellImpl('w', sd.used_percentage, sd.resets_at, C, 'zone', false);
      }
      const u = loadUsage();
      if (!u || typeof u.weeklyUsage !== 'number') return '';
      return _renderUsageCellImpl('w', u.weeklyUsage, u.weeklyResetAt, C, 'zone', !!u.error);
    },

    /** Per-model share of this session's transcript spend, e.g.
     *  `fable-5:72% opus-4-8:21% haiku-4-5:7%`. Answers "which models are
     *  burning the budget" at a glance. Cost share (not token share) so a
     *  cheap-but-chatty Haiku doesn't dwarf an expensive Fable turn. There
     *  is no per-model QUOTA — stdin rate_limits only carries the two
     *  account-wide windows — so share-of-session-spend is the honest
     *  per-model percentage. Top 4 models; empty until usage exists. */
    /** Output-token generation speed, `tps:235` (tokens/sec). Median of
     *  the last few streamed turns — per-message chunk-timestamp spans are
     *  pure generation time, so this tracks the model's real throughput
     *  (fast mode, load, long-output turns all show up). Falls back to the
     *  whole-session average (total output / total API time from stdin)
     *  when no streamed turn in the tail is usable. */
    tokenSpeed: (input, ctx) => {
      let tps = null;
      const lib = loadTokenSpeedLib();
      if (lib && typeof lib.estimateTokenSpeed === 'function') {
        try {
          const est = lib.estimateTokenSpeed(input.transcript_path || input.transcriptPath);
          if (est && Number.isFinite(est.tps) && est.tps > 0) tps = est.tps;
        } catch { /* degrade to fallback */ }
      }
      if (tps === null) {
        const apiMs = input && input.cost && input.cost.total_api_duration_ms;
        const outTok = (ctx.tokenTotals && ctx.tokenTotals.output)
          || (input && input.context_window && input.context_window.total_output_tokens);
        if (Number.isFinite(apiMs) && apiMs > 0 && Number.isFinite(outTok) && outTok > 0) {
          tps = outTok / (apiMs / 1000);
        }
      }
      if (tps === null || !(tps > 0)) return '';
      const v = tps >= 10 ? String(Math.round(tps)) : tps.toFixed(1);
      return `${C.dim}tps:${v}${C.reset}`;
    },

    modelSplit: (input, ctx) => {
      // Parent-conversation turns from the transcript accumulator...
      const byModel = (ctx.tokenTotals && ctx.tokenTotals.byModel) || {};
      const merged = { ...byModel };
      // ...plus subagent runs from the events DB (their usage lives in
      // separate transcripts and never appears in the parent transcript).
      for (const row of agentModelCostsSafe(ctx.sessionId)) {
        if (!row || !row.model || !(row.cost_usd > 0)) continue;
        merged[row.model] = (merged[row.model] || 0) + row.cost_usd;
      }
      const entries = Object.entries(merged).filter(([, c]) => c > 0);
      const total = entries.reduce((sum, [, c]) => sum + c, 0);
      if (!entries.length || total <= 0) return '';
      entries.sort((a, b) => b[1] - a[1]);

      const events = loadEventsLib();
      // Persist this session's per-model split so weeklyModelSpend can see
      // parent-session spend across sessions (agents are already in the DB).
      try {
        if (events && typeof events.upsertSessionModelCosts === 'function' && ctx.sessionId) {
          events.upsertSessionModelCosts(ctx.sessionId, byModel);
        }
      } catch { /* telemetry is best-effort */ }

      // Per-model weekly-remaining ESTIMATE (`wr:~61%`): Anthropic exposes
      // no per-model weekly quota (seven_day_<model> buckets are null on
      // plans without per-model limits — verified 2026-07-17), so attribute
      // the account weekly used% across models by their share of this
      // week's tracked spend: wr(model) = 100 − weeklyUsed × spendShare.
      // `~` marks it as SI's estimate, not an Anthropic number.
      let weeklyUsed = null;
      const sd = input && input.rate_limits && input.rate_limits.seven_day;
      if (sd && typeof sd.used_percentage === 'number') weeklyUsed = sd.used_percentage;
      let weekSpend = null;
      if (weeklyUsed !== null && events && typeof events.weeklyModelSpend === 'function') {
        try { weekSpend = events.weeklyModelSpend(); } catch { weekSpend = null; }
      }
      const weekTotal = weekSpend ? weekSpend.reduce((sum, r) => sum + (r.cost_usd || 0), 0) : 0;
      const weekByModel = weekSpend
        ? Object.fromEntries(weekSpend.map((r) => [r.model, r.cost_usd || 0]))
        : {};

      const parts = entries.slice(0, 4).map(([m, c]) => {
        const name = m.replace(/^claude-/, '').replace(/-20\d{6,}$/, '');
        const usd = fmtUsd(c);
        let cell = `${name}:sc${usd || '$0'}\u00b7sp${Math.round((c / total) * 100)}%`;
        if (weeklyUsed !== null && weekTotal > 0) {
          const share = (weekByModel[m] || 0) / weekTotal;
          const wr = Math.max(0, Math.min(100, Math.round(100 - weeklyUsed * share)));
          cell += `\u00b7wr:~${wr}%`;
        }
        return cell;
      });
      return `${C.dim}${parts.join(' ')}${C.reset}`;
    },

    /** Per-model QUOTA used/available — dormant until real data exists.
     *  Neither stdin rate_limits (only five_hour/seven_day account windows)
     *  nor this account's oauth payload carries per-model limits today: the
     *  schema HAS seven_day_opus/_sonnet/_cowork buckets but they're null
     *  on plans without per-model limits (verified 2026-07-17 via a raw
     *  200). Sources, both future-proof: (1) any extra rate_limits key on
     *  stdin with a used_percentage, (2) modelQuotas captured by the usage
     *  worker from non-null seven_day_<model> buckets. Renders e.g.
     *  `opus:12/88% sonnet:4/96%` the day either source lights up. */
    modelQuota: (input, _ctx) => {
      const parts = [];
      const rl = (input && input.rate_limits) || {};
      for (const [k, v] of Object.entries(rl)) {
        if (k === 'five_hour' || k === 'seven_day') continue;
        if (v && typeof v.used_percentage === 'number') {
          const name = k.replace(/^(five_hour|seven_day)_/, '');
          const used = Math.round(v.used_percentage);
          parts.push(`${name}:${used}/${Math.max(0, 100 - used)}%`);
        }
      }
      if (!parts.length) {
        const u = loadUsage();
        if (u && u.modelQuotas) {
          for (const [name, q] of Object.entries(u.modelQuotas)) {
            if (!q || typeof q.utilization !== 'number') continue;
            const used = Math.round(q.utilization);
            parts.push(`${name}:${u.error ? '~' : ''}${used}/${Math.max(0, 100 - used)}%`);
          }
        }
      }
      return parts.length ? `${C.dim}${parts.join(' ')}${C.reset}` : '';
    },

    /** Full working directory, ccstatusline-style. Collapses $HOME to `~`
     *  and middle-truncates when longer than 60 chars (keeps the leaf dir,
     *  which carries most of the signal). Dim — reference context only. */
    cwd: (input, ctx) => {
      const raw = input.cwd || '';
      if (!raw) return '';
      const home = os.homedir();
      // Show full path, just middle-truncate (single ellipsis) when it
      // exceeds maxCwdLength. `~` substituted for $HOME first so the prefix
      // stays informative. Default MAX=36; clamp >8 at read time.
      const MAX = Number.isFinite(ctx.cfg.maxCwdLength) && ctx.cfg.maxCwdLength > 8
        ? Math.floor(ctx.cfg.maxCwdLength) : 36;
      let display = raw;
      if (raw === home) display = '~';
      else if (raw.startsWith(home + '/')) display = '~' + raw.slice(home.length);
      return `${C.dim}${truncateMiddle(display, MAX)}${C.reset}`;
    },

    /** "Where Claude is touching files now" — latest root recorded in the
     *  per-session shape log. Unlike `cwd` (which is the static session
     *  shell directory), this updates as tool calls land in different
     *  subtrees. Hidden when no shape entries exist or when the latest
     *  root is `.` / matches the session cwd's leaf (no signal). */
    activeRoot: (input, ctx) => {
      const sid = input.session_id || input.sessionId || '';
      if (!sid) return '';
      const lib = loadContextShapeLib();
      if (!lib || typeof lib.readShape !== 'function') return '';
      let entries;
      try { entries = lib.readShape(sid, 5); } catch { return ''; }
      if (!Array.isArray(entries) || entries.length === 0) return '';
      // Walk back from the latest entry to find a non-blank root. When
      // `activeRootShowAtRoot` is on we keep `.` so the field still
      // signals liveness while Claude is parked at cwd root.
      // Also skip absolute paths outside the session cwd (e.g. tool
      // calls touching ~/.claude/* would otherwise surface
      // `/Users/<name>` and shadow real in-project navigation).
      const showAtRoot = !!ctx.cfg.activeRootShowAtRoot;
      const cwdAbs = input.cwd || '';
      const isInProject = (r) => {
        if (!r || r === '.') return true;
        if (!r.startsWith('/')) return true; // already a relative root
        if (!cwdAbs) return true;
        return r === cwdAbs || r.startsWith(cwdAbs + '/');
      };
      let root = '';
      for (let i = entries.length - 1; i >= 0; i--) {
        const r = entries[i] && typeof entries[i].root === 'string' ? entries[i].root : '';
        if (!r) continue;
        if (!isInProject(r)) continue;
        if (r !== '.' || showAtRoot) { root = r; break; }
      }
      if (!root) return '';
      // Hide when the active root is just the cwd's basename — the `cwd`
      // field already covers it, no point doubling up. Skip suppression
      // when the per-project flag asks for "always show."
      const cwd = input.cwd || '';
      if (!showAtRoot && cwd && root === path.basename(cwd)) return '';
      const home = os.homedir();
      let display = root;
      if (root.startsWith(home + '/')) display = '~' + root.slice(home.length);
      const MAX = Number.isFinite(ctx.cfg.maxActiveRootLength) && ctx.cfg.maxActiveRootLength > 6
        ? Math.floor(ctx.cfg.maxActiveRootLength) : 30;
      return `${C.dim}→${truncateMiddle(display, MAX)}${C.reset}`;
    },

    /** Self-diagnosis tag — empty when SI is healthy on this project, a red
     *  warning when the project's `enabledPlugins` whitelist is suppressing
     *  us. Without this the dark state is invisible: the bar still renders
     *  (statusline is wired separately) but the SI-fed fields stay blank
     *  forever and the user has no way to distinguish "nothing happened
     *  yet" from "hooks are off." Only renders the warning, never a green
     *  "live" tag — silence is success. */
    siHealth: (input, _ctx) => {
      const cwd = input.cwd || input.workspace?.current_dir || '';
      const gate = detectSiPluginGate(cwd);
      if (gate === 'ok') return '';
      const reason = gate === 'dark-disabled' ? 'disabled' : 'off';
      return `${C.red}⚠ si-${reason}${C.reset}${C.dim} (run /si doctor)${C.reset}`;
    },

    /** Last deploy target + how fresh, read from ~/.claude/logs/deploy-breadcrumb.
     *  Always dim — the interesting signal about a fresh deploy already shows
     *  up as the 🚀 line-2 emoji (see pickEmojiSecond). The text itself is
     *  just reference context and shouldn't fight for attention. */
    deploy: (_input, _ctx) => {
      const b = readDeployBreadcrumb();
      if (!b) return '';
      const mins = Math.floor(b.ageMs / 60000);
      const when = mins < 1 ? 'now' : mins < 60 ? `${mins}m ago` : `${Math.floor(mins / 60)}h${mins % 60}m ago`;
      return `${C.dim}deploy:${b.target} ${when}${C.reset}`;
    },

    /** Output style indicator — explanatory, default, etc. */
    outputStyle: (input, _ctx) => {
      const s = detectOutputStyle(input);
      return s ? `${C.blue}style:${s}${C.reset}` : '';
    },

    /** Colored dot per configured service URL; polls in background, reads cache. */
    health: (_input, ctx) => {
      const services = (ctx.cfg.serviceHealth || []);
      if (!services.length) return '';
      const dots = services.map((svc) => {
        const cached = probeHealthIfStale(svc);
        if (!cached) return `${C.gray}○${C.reset}`;
        const code = cached.status;
        const ok = /^2\d\d$/.test(code);
        const redirect = /^3\d\d$/.test(code);
        const color = ok ? C.green : (redirect ? C.yellow : C.red);
        return `${color}●${C.reset}`;
      });
      return `${C.dim}[${C.reset}${dots.join('')}${C.dim}]${C.reset}`;
    },
  };
}

module.exports = {
  renderContextBar,
  zoneFor,
  pickEmoji,
  pickEmojiSecond,
  buildRenderers,
};
