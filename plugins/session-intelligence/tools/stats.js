#!/usr/bin/env node
/**
 * /si stats — print aggregate session/compact/zone metrics from the events DB.
 *
 * Usage:
 *   node tools/stats.js                         # last 30 days, all projects
 *   node tools/stats.js --days=7                # last 7 days (alias: --since)
 *   node tools/stats.js --project=CSM           # filter to one project
 *   node tools/stats.js --recent                # show last 20 compacts
 *   node tools/stats.js --json                  # machine-readable output
 */

const path = require('path');
const fs = require('fs');

function resolveSiLibDir() {
  const candidates = [
    path.join(__dirname, '..', 'lib'),
    path.join(__dirname, '..', 'session-intelligence', 'lib'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'events.js'))) return dir;
  }
  return candidates[0];
}
const events = require(path.join(resolveSiLibDir(), 'events'));
let siConfig = {};
try { siConfig = require(path.join(resolveSiLibDir(), 'config')).loadConfig() || {}; }
catch { /* config optional — budget features disable cleanly */ }
const budget = (siConfig && siConfig.usageBudget) || { daily: 0, weekly: 0 };

function parseArgs(argv) {
  const flags = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
    else flags[a.slice(2)] = true;
  }
  return flags;
}

// ─── Formatters ─────────────────────────────────────────────────────────────

function fmtUsd(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 10) return `$${n.toFixed(1)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(Math.round(n));
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${n} B`;
}

function fmtAge(t) {
  if (!Number.isFinite(t)) return '—';
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function fmtPct(num, denom) {
  if (!Number.isFinite(num) || !Number.isFinite(denom) || denom <= 0) return '—';
  return `${Math.round((num / denom) * 100)}%`;
}

function fmtPctRaw(p) {
  if (!Number.isFinite(p)) return '—';
  return `${Math.round(p * 100)}%`;
}

function fmtDelta(p) {
  if (!Number.isFinite(p)) return '—';
  const pct = Math.round(p * 100);
  if (pct > 0) return `▲${pct}%`;
  if (pct < 0) return `▼${Math.abs(pct)}%`;
  return '—';
}

// Three modes: 0/null/unset → disabled, "unlimited" → tracking with no cap,
// number → cap with %-of-budget color bands matching the zone vocabulary
// the user already reads in stop-hook nudges.
function isBudgetEnabled(limit) {
  return limit === 'unlimited' || (Number.isFinite(limit) && limit > 0);
}

function fmtBudgetCap(limit) {
  if (limit === 'unlimited') return c('dim', 'unlimited');
  if (Number.isFinite(limit) && limit > 0) return fmtUsd(limit);
  return c('dim', '—');
}

function colorBudgetPct(spent, limit) {
  if (limit === 'unlimited') return c('cyan', '∞');
  if (!Number.isFinite(spent) || !Number.isFinite(limit) || limit <= 0) return c('dim', '—');
  const frac = spent / limit;
  const text = `${Math.round(frac * 100)}%`;
  if (frac >= 1.0)  return c('red', text);
  if (frac >= 0.85) return c('orange', text);
  if (frac >= 0.60) return c('yellow', text);
  return c('green', text);
}

function colorDelta(p) {
  if (!Number.isFinite(p)) return c('dim', '—');
  if (p > 0.10) return c('red', fmtDelta(p));
  if (p > 0)    return c('yellow', fmtDelta(p));
  if (p < -0.10) return c('green', fmtDelta(p));
  if (p < 0)    return c('cyan', fmtDelta(p));
  return c('dim', '—');
}

// ─── Rendering primitives ───────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  orange: '\x1b[38;5;208m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
};
const NO_COLOR = !!process.env.NO_COLOR || !process.stdout.isTTY;
const c = (color, text) => (NO_COLOR ? text : `${C[color] || ''}${text}${C.reset}`);

function header(title, subtitle) {
  const line = c('bold', title);
  return subtitle ? `${line}  ${c('dim', subtitle)}` : line;
}

function rule() {
  return c('dim', '─'.repeat(64));
}

const SPARK = '▁▂▃▄▅▆▇█';
function sparkline(values) {
  if (!values.length) return '';
  const max = Math.max(...values);
  if (max <= 0) return SPARK[0].repeat(values.length);
  return values.map((v) => {
    if (v <= 0) return ' ';
    const idx = Math.min(SPARK.length - 1, Math.floor((v / max) * (SPARK.length - 1)));
    return SPARK[idx];
  }).join('');
}

function table(rows, opts = {}) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const widths = cols.map((col) => Math.max(
    col.length,
    ...rows.map((r) => String(r[col] ?? '').length),
  ));
  const sep = '  ';
  const align = opts.align || {};
  const fmtCell = (col, val, w) => {
    const s = String(val ?? '');
    return align[col] === 'right' ? s.padStart(w) : s.padEnd(w);
  };
  const lines = [];
  lines.push(c('dim', cols.map((col, i) => fmtCell(col, col.toUpperCase(), widths[i])).join(sep)));
  for (const r of rows) {
    lines.push(cols.map((col, i) => fmtCell(col, r[col], widths[i])).join(sep));
  }
  return lines.join('\n');
}

// ─── Sections ───────────────────────────────────────────────────────────────

function renderHeadline(stats, sinceDays, project) {
  const sub = project ? `last ${sinceDays}d · project=${project}` : `last ${sinceDays}d · all projects`;
  const lines = [header('SESSION INTELLIGENCE — usage report', sub), ''];

  const totalCost = stats.sessions.cost || 0;
  const sessionN = stats.sessions.n || 0;
  const avgCost = sessionN > 0 ? totalCost / sessionN : 0;
  const dailyAvg = totalCost / Math.max(sinceDays, 1);

  // This-week / today snapshots from the daily+weekly series the aggregator
  // already built. Today = last entry of dailySeries; this week = last entry
  // of weeklySeries. Both are zero-filled, so safe to slice without checks.
  const today = stats.dailySeries.length ? stats.dailySeries[stats.dailySeries.length - 1] : null;
  const thisWeek = stats.weeklySeries.length ? stats.weeklySeries[stats.weeklySeries.length - 1] : null;

  const rows = [
    ['Total spend',   c('bold', fmtUsd(totalCost))],
    ['Sessions',      String(sessionN)],
    ['Avg / session', fmtUsd(avgCost)],
    ['Avg / day',     fmtUsd(dailyAvg)],
    ['Tool calls',    fmtTokens(stats.sessions.tool_calls)],
    ['Peak tokens (max / avg)',
      `${fmtTokens(stats.sessions.max_peak)} / ${fmtTokens(stats.sessions.avg_peak)}`],
  ];
  // Budget rows render whenever tracking is enabled (number cap OR "unlimited").
  // Unlimited prints "spend / unlimited (∞)" so the user sees the row but no alert.
  if (isBudgetEnabled(budget.daily) && today) {
    rows.push(['Today vs daily budget',
      `${fmtUsd(today.cost)} / ${fmtBudgetCap(budget.daily)}  (${colorBudgetPct(today.cost, budget.daily)})`]);
  }
  if (isBudgetEnabled(budget.weekly) && thisWeek) {
    rows.push(['This week vs weekly budget',
      `${fmtUsd(thisWeek.cost)} / ${fmtBudgetCap(budget.weekly)}  (${colorBudgetPct(thisWeek.cost, budget.weekly)})`]);
  }
  const w = Math.max(...rows.map((r) => r[0].length));
  for (const [k, v] of rows) lines.push(`  ${c('dim', k.padEnd(w))}   ${v}`);
  return lines.join('\n');
}

function renderDailyTrend(daily, sinceDays) {
  if (!daily || !daily.length) return '';
  const lines = [header('DAILY TREND', `${sinceDays} days`), ''];
  // Sparkline by cost; show last N days at the end.
  const window = daily.slice(-Math.min(daily.length, sinceDays));
  const costSpark = sparkline(window.map((d) => d.cost));
  const sessSpark = sparkline(window.map((d) => d.sessions));
  lines.push(`  ${c('dim', 'cost    ')} ${c('cyan', costSpark)}`);
  lines.push(`  ${c('dim', 'sessions')} ${c('green', sessSpark)}`);
  // Show last 7 days as a small table for readability.
  const tail = window.slice(-7);
  if (tail.length > 1) {
    lines.push('');
    const rows = tail.map((d) => {
      const row = {
        day: d.day.slice(5),
        cost: fmtUsd(d.cost),
        '%tot': fmtPctRaw(d.pct),
        sessions: String(d.sessions),
        compacts: String(d.compacts),
      };
      if (isBudgetEnabled(budget.daily)) row['%budg'] = colorBudgetPct(d.cost, budget.daily);
      return row;
    });
    lines.push('  ' + table(rows, { align: { cost: 'right', '%tot': 'right', '%budg': 'right', sessions: 'right', compacts: 'right' } }).replace(/\n/g, '\n  '));
  }
  return lines.join('\n');
}

function renderWeeklyRollup(weeks) {
  if (!weeks || weeks.length === 0) return '';
  // Drop leading empty weeks (cost=0 AND sessions=0) so the table starts at
  // the first active week. WoW is recomputed against the first kept entry.
  let firstActive = weeks.findIndex((w) => w.cost > 0 || w.sessions > 0);
  if (firstActive === -1) firstActive = weeks.length - 1;
  const active = weeks.slice(firstActive);
  if (active.length === 0) return '';
  const lines = [header('WEEKLY ROLLUP', `${active.length} active week(s) · WoW = week-over-week cost change`), ''];
  // Sparkline of weekly cost over the active range
  const spark = sparkline(active.map((w) => w.cost));
  lines.push(`  ${c('dim', 'cost')}  ${c('cyan', spark)}`);
  lines.push('');
  // Tail to last 8 weeks max so the table stays compact
  const tail = active.slice(-8);
  const rows = tail.map((w) => {
    const row = {
      'week starting': w.week,
      cost:    fmtUsd(w.cost),
      '%tot':  fmtPctRaw(w.pct),
      sessions: String(w.sessions),
      compacts: String(w.compacts),
      wow:     w.wow === null ? '—' : colorDelta(w.wow),
    };
    if (isBudgetEnabled(budget.weekly)) row['%budg'] = colorBudgetPct(w.cost, budget.weekly);
    return row;
  });
  lines.push('  ' + table(rows, {
    align: { cost: 'right', '%tot': 'right', '%budg': 'right', sessions: 'right', compacts: 'right', wow: 'right' },
  }).replace(/\n/g, '\n  '));
  return lines.join('\n');
}

function renderCompacts(stats) {
  const c0 = stats.compacts;
  const lines = [header('COMPACTS'), ''];
  if (!c0.n) {
    lines.push(c('dim', '  (no compacts in window)'));
    return lines.join('\n');
  }
  const totalCost = c0.total_cost || 0;
  const shiftPct = fmtPct(c0.shifts, c0.n);
  const rows = [
    ['Count',           String(c0.n)],
    ['Total cost',      fmtUsd(totalCost)],
    ['Avg cost',        fmtUsd(c0.avg_cost)],
    ['Tokens (avg)',    fmtTokens(c0.avg_tokens)],
    ['Tokens (p50/p90)',
      `${fmtTokens(stats.compactPercentiles.p50)} / ${fmtTokens(stats.compactPercentiles.p90)}`],
    ['Tokens (min/max)',
      `${fmtTokens(c0.min_tokens)} / ${fmtTokens(c0.max_tokens)}`],
    ['With domain shift', `${c0.shifts || 0} (${shiftPct})`],
  ];
  const w = Math.max(...rows.map((r) => r[0].length));
  for (const [k, v] of rows) lines.push(`  ${c('dim', k.padEnd(w))}   ${v}`);
  return lines.join('\n');
}

function renderZones(stats) {
  const lines = [header('ZONE CALLOUTS', 'crossings emitted to assistant'), ''];
  if (!stats.zones.length) {
    lines.push(c('dim', '  (no zone events in window)'));
    return lines.join('\n');
  }
  const total = stats.zones.reduce((s, z) => s + z.n, 0);
  const counts = { yellow: 0, orange: 0, red: 0 };
  for (const z of stats.zones) counts[z.zone] = z.n;
  const max = Math.max(1, ...Object.values(counts));
  const barW = 24;
  const renderBar = (n, color) => {
    const filled = Math.round((n / max) * barW);
    return c(color, '█'.repeat(filled)) + c('dim', '·'.repeat(barW - filled));
  };
  lines.push(`  ${c('yellow', 'yellow')}  ${String(counts.yellow).padStart(3)}  ${renderBar(counts.yellow, 'yellow')}`);
  lines.push(`  ${c('orange', 'orange')}  ${String(counts.orange).padStart(3)}  ${renderBar(counts.orange, 'orange')}`);
  lines.push(`  ${c('red',    'red   ')}  ${String(counts.red).padStart(3)}  ${renderBar(counts.red, 'red')}`);
  lines.push('');
  const redPct = fmtPct(counts.red, total);
  const reach = counts.red > 0
    ? c('red', `${counts.red} red-zone events (${redPct} of crossings) — sessions are routinely pushing past the recommended compact line`)
    : c('green', 'No red-zone events — compact discipline is healthy');
  lines.push(`  ${reach}`);
  return lines.join('\n');
}

function renderArchives(a) {
  const lines = [header('TOOL-RESPONSE ARCHIVE', 'snapshots for post-compact recall'), ''];
  const recallPct = fmtPct(a.recalled, a.n);
  const rows = [
    ['Snapshots',  String(a.n || 0)],
    ['Recalled',   `${a.recalled || 0} (${recallPct})`],
    ['Total size', fmtBytes(a.bytes)],
  ];
  const w = Math.max(...rows.map((r) => r[0].length));
  for (const [k, v] of rows) lines.push(`  ${c('dim', k.padEnd(w))}   ${v}`);
  if ((a.n || 0) > 50 && (a.recalled || 0) === 0) {
    lines.push('');
    lines.push(c('dim', '  hint: archives are accumulating but never recalled — consider /si expand <id>'));
  }
  return lines.join('\n');
}

function renderProjects(rows) {
  if (!rows || !rows.length) return '';
  const lines = [header('PROJECTS', 'top 10 by spend'), ''];
  const tableRows = rows.map((p) => ({
    project:  String(p.project).slice(0, 28),
    sessions: String(p.sessions),
    cost:     fmtUsd(p.cost),
    compacts: String(p.compacts || 0),
    'red%':   fmtPct(p.reds, p.compacts),
    archives: String(p.archives || 0),
    'recall%': fmtPct(p.archives_recalled, p.archives),
  }));
  lines.push('  ' + table(tableRows, {
    align: { sessions: 'right', cost: 'right', compacts: 'right', 'red%': 'right', archives: 'right', 'recall%': 'right' },
  }).replace(/\n/g, '\n  '));
  return lines.join('\n');
}

function renderRecentCompacts(rows) {
  if (!rows || !rows.length) return '';
  const lines = [header('RECENT COMPACTS', 'last 8 in window'), ''];
  const tableRows = rows.map((r) => ({
    when:    fmtAge(r.t),
    project: String(r.project || '—').slice(0, 24),
    tokens:  fmtTokens(r.tokens),
    cost:    fmtUsd(r.cost),
    shift:   r.had_shift ? 'yes' : '—',
    trigger: r.trigger || '—',
  }));
  lines.push('  ' + table(tableRows, {
    align: { tokens: 'right', cost: 'right' },
  }).replace(/\n/g, '\n  '));
  return lines.join('\n');
}

// ─── Entry ──────────────────────────────────────────────────────────────────

function main() {
  const flags = parseArgs(process.argv.slice(2));
  // Accept --days as alias for --since (more familiar terminology).
  const sinceDays = Number(flags.days || flags.since) || 30;
  const project = flags.project || null;

  if (!events.isAvailable()) {
    console.error('[si stats] events DB unavailable (better-sqlite3 not installed?).');
    console.error(`           expected at: ${events.getEventsDbPath()}`);
    process.exit(1);
  }

  if (flags.recent) {
    const rows = events.listRecentCompacts({ limit: 20, project });
    if (flags.json) { console.log(JSON.stringify(rows, null, 2)); return; }
    console.log(header('RECENT COMPACTS', project ? `project=${project}` : 'all projects'));
    console.log('');
    const tableRows = rows.map((r) => ({
      when:    fmtAge(r.t),
      project: String(r.project || '—').slice(0, 24),
      tokens:  fmtTokens(r.tokens),
      cost:    fmtUsd(r.cost),
      shift:   r.had_shift ? 'yes' : '—',
      trigger: r.trigger || '—',
    }));
    console.log('  ' + table(tableRows, {
      align: { tokens: 'right', cost: 'right' },
    }).replace(/\n/g, '\n  '));
    return;
  }

  const stats = events.aggregateStats({ sinceDays, project });
  if (!stats) {
    console.error('[si stats] failed to aggregate');
    process.exit(1);
  }
  if (flags.json) { console.log(JSON.stringify(stats, null, 2)); return; }

  const sections = [
    renderHeadline(stats, sinceDays, project),
    renderDailyTrend(stats.dailySeries, sinceDays),
    renderWeeklyRollup(stats.weeklySeries),
    renderCompacts(stats),
    renderZones(stats),
    renderArchives(stats.archives),
    renderProjects(stats.perProject),
    renderRecentCompacts(stats.recentCompacts),
  ].filter(Boolean);

  console.log('');
  console.log(sections.join(`\n\n${rule()}\n\n`));
  console.log('');
  console.log(c('dim', `db: ${events.getEventsDbPath()}`));
}

main();
