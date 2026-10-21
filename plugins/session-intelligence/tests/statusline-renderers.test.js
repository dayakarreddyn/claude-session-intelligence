'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRenderers } = require('../statusline/renderers');
const { makeColors } = require('../statusline/format');
const { withTempHome } = require('./helpers/statusline-fixture');

test('modelSplit renders $·share per model and never a weekly-remaining estimate', (t) => {
  withTempHome(t);
  const R = buildRenderers(makeColors(false), { loadUsage: () => null });
  const input = { rate_limits: { seven_day: { used_percentage: 20, resets_at: 2e9 } } };
  const ctx = { sessionId: 'rs1', tokenTotals: { byModel: { 'claude-fable-5-1': 12, 'claude-haiku-5-5': 0.01 } } };
  const out = R.modelSplit(input, ctx);
  assert.doesNotMatch(out, /wr:/);
  assert.match(out, /fable-5-1:\$12·100%/);
  assert.doesNotMatch(out, /haiku/);
});

test('tokenSpeed renders nothing when the transcript yields no speed sample', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-tps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n');
  const R = buildRenderers(makeColors(false), {});
  const input = { transcript_path: transcript, cost: { total_api_duration_ms: 3_600_000 }, context_window: { total_output_tokens: 503_000 } };
  assert.equal(R.tokenSpeed(input, { tokenTotals: { output: 503_000 } }), '');
});

const FAR_RESET = Math.floor(Date.now() / 1000) + 3 * 86400;
const WINDOWS = {
  five_hour: { used_percentage: 36, resets_at: FAR_RESET },
  seven_day: { used_percentage: 95, resets_at: FAR_RESET },
};

test('stdin rate_limits never triggers the usage poller', (t) => {
  withTempHome(t);
  let calls = 0;
  const R = buildRenderers(makeColors(false), { loadUsage: () => { calls++; return null; } });
  const input = { rate_limits: WINDOWS };
  R.blockUsage(input, {}); R.weekUsage(input, {}); R.modelQuota(input, {}); R.spendLimit(input, {});
  assert.equal(calls, 0);
});

test('a rate_limits object missing one window renders nothing for it and skips the poller', (t) => {
  withTempHome(t);
  let calls = 0;
  const R = buildRenderers(makeColors(false), { loadUsage: () => { calls++; return { weeklyUsage: 50 }; } });
  const input = { rate_limits: { five_hour: WINDOWS.five_hour } };
  assert.equal(R.weekUsage(input, {}), '');
  assert.equal(calls, 0);
});

test('missing rate_limits object falls back to the poller', (t) => {
  withTempHome(t);
  let calls = 0;
  const R = buildRenderers(makeColors(false), { loadUsage: () => { calls++; return { sessionUsage: 36, weeklyUsage: 10, modelQuotas: { opus: { utilization: 12 } } }; } });
  assert.match(R.blockUsage({}, {}), /^b:36%/);
  assert.match(R.weekUsage({}, {}), /^w:10%/);
  assert.equal(R.modelQuota({}, {}), 'opus:12/88%');
  assert.equal(calls, 3);
});

test('a stale-by-age cache renders with ~', (t) => {
  withTempHome(t);
  const R = buildRenderers(makeColors(false), { loadUsage: () => ({ sessionUsage: 36, weeklyUsage: 10, stale: true, error: false, modelQuotas: { opus: { utilization: 12 } } }) });
  assert.match(R.blockUsage({}, {}), /~b:36%|b:~36%/);
  assert.match(R.weekUsage({}, {}), /w:~10%/);
  assert.match(R.modelQuota({}, {}), /opus:~12\/88%/);
});

test('spend_limit renders as a budget, never as a model quota', (t) => {
  withTempHome(t);
  const R = buildRenderers(makeColors(false), { loadUsage: () => null });
  const input = { rate_limits: { spend_limit: { used_percentage: 42, resets_at: FAR_RESET, used_usd: 21, limit_usd: 50, period: 'weekly' } } };
  assert.match(R.spendLimit(input, {}), /^sl:\$21\/\$50w r:\d/);
  assert.equal(R.modelQuota(input, {}), '');
  assert.equal(R.spendLimit({ rate_limits: WINDOWS }, {}), '');
});

test('spend_limit over 100 % is red and percent-only without USD fields', (t) => {
  withTempHome(t);
  const C = makeColors(true);
  const R = buildRenderers(C, { loadUsage: () => null });
  const out = R.spendLimit({ rate_limits: { spend_limit: { used_percentage: 120, resets_at: FAR_RESET } } }, {});
  assert.ok(out.includes(`${C.red}sl:120%`), out);
});

test('tokens cell renders used/? without bar or percent when the cap is a fallback', (t) => {
  withTempHome(t);
  const payload = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'statusline', 'payloads', 'e2_unknown_model_no_cw.json'), 'utf8'));
  const R = buildRenderers(makeColors(false), {});
  const out = R.tokens(payload, { tokens: 175700, usedTranscript: true, cfg: { zones: { yellow: 40000, orange: 60000, red: 80000 } } });
  assert.match(out, /175\.7k\/\?/);
  assert.doesNotMatch(out, /▰|%/);
});

test('tokens cell keeps bar and percent when the cap is known', (t) => {
  withTempHome(t);
  const R = buildRenderers(makeColors(false), {});
  const input = { model: { id: 'claude-fable-5-1' }, context_window: { context_window_size: 200000 } };
  const out = R.tokens(input, { tokens: 100000, usedTranscript: true, cfg: { zones: { yellow: 40000, orange: 60000, red: 80000 } } });
  assert.match(out, /100k\/200k/);
  assert.match(out, /50%/);
});

test('costSaved marks the calibrated saved cell as an SI estimate', (t) => {
  withTempHome(t);
  const R = buildRenderers(makeColors(false), {});
  const out = R.costSaved({}, { costUsd: 119, officialCostUsd: 119, tokenTotals: { cost: 45 }, cacheSavedUsd: 250 });
  assert.match(out, /~s\$/);
  assert.equal(out, 'c$119/~s$661');
});

test('savedCell label is shared by costSaved and compactCost', () => {
  const { savedCell } = require('../statusline/renderers');
  assert.equal(savedCell(661.1), '~s$661');
  assert.equal(savedCell(1.234), '~s$1.23');
  const src = fs.readFileSync(path.join(__dirname, '..', 'statusline', 'renderers.js'), 'utf8');
  assert.equal((src.match(/push\(savedCell\(saved\)\)/g) || []).length, 2);
  assert.doesNotMatch(src, /`s\$\{fmtUsd/);
});

test('quota-aware builds (version >= 2.1.90) never poll even before rate_limits arrives', (t) => {
  withTempHome(t);
  let calls = 0;
  const R = buildRenderers(makeColors(false), { loadUsage: () => { calls++; return { sessionUsage: 36, weeklyUsage: 10, modelQuotas: { opus: { utilization: 12 } } }; } });
  const input = { version: '2.1.303' };
  assert.equal(R.blockUsage(input, {}), '');
  assert.equal(R.weekUsage(input, {}), '');
  assert.equal(R.modelQuota(input, {}), '');
  assert.equal(calls, 0);
});

test('legacy or unparseable versions without rate_limits still poll', (t) => {
  withTempHome(t);
  for (const version of ['2.0.50', 'garbage', undefined]) {
    let calls = 0;
    const R = buildRenderers(makeColors(false), { loadUsage: () => { calls++; return null; } });
    R.blockUsage({ version }, {});
    assert.equal(calls, 1, `blockUsage polls for ${version}`);
  }
});

test('versionAtLeast compares numerically and tolerates garbage', () => {
  const { versionAtLeast, isQuotaAwareBuild } = require('../statusline/format');
  assert.equal(versionAtLeast('2.1.90', '2.1.90'), true);
  assert.equal(versionAtLeast('2.1.100', '2.1.90'), true);
  assert.equal(versionAtLeast('2.1.89', '2.1.90'), false);
  assert.equal(versionAtLeast('3.0.0', '2.1.90'), true);
  assert.equal(versionAtLeast(null, '2.1.90'), false);
  assert.equal(versionAtLeast('x.y', '2.1.90'), false);
  assert.equal(isQuotaAwareBuild({ rate_limits: {} }), true);
  assert.equal(isQuotaAwareBuild(null), false);
});

test('tokenFlow prefixes ~ only when the totals are still partial', (t) => {
  withTempHome(t);
  const R = buildRenderers(makeColors(false), { loadUsage: () => null });
  const totals = { input: 1, output: 2, cached: 3, creation: 4 };
  assert.match(R.tokenFlow({}, { tokenTotals: { ...totals, partial: true } }), /^~t/);
  assert.match(R.tokenFlow({}, { tokenTotals: { ...totals, partial: false } }), /^t/);
});

test('colour: usage cell and tokens cell carry red only in the red zone', (t) => {
  withTempHome(t);
  const C = makeColors(true);
  const { renderUsageCell } = require('../statusline/format');
  assert.ok(renderUsageCell('w', 95, 2e9, C, 'zone', false).includes(C.red));
  assert.ok(!renderUsageCell('w', 10, 2e9, C, 'zone', false).includes(C.red));
  const R = buildRenderers(C, { loadUsage: () => null });
  const cfg = { zones: { yellow: 100, orange: 200, red: 300 }, tokenSource: 'auto' };
  const out = R.tokens({ model: { id: 'claude-fable-5-1' }, context_window: { context_window_size: 1000000 } }, { tokens: 400, cfg, usedTranscript: true });
  assert.ok(out.includes(C.red));
});
