#!/usr/bin/env node
/**
 * /si stats — print aggregate session/compact/zone metrics from the events DB.
 *
 * Usage:
 *   node tools/stats.js                         # last 30 days, all projects
 *   node tools/stats.js --since=7               # last 7 days
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

function fmtUsd(n) {
  if (!Number.isFinite(n)) return '—';
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

function fmtAge(t) {
  if (!Number.isFinite(t)) return '—';
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const sinceDays = Number(flags.since) || 30;
  const project = flags.project || null;

  if (!events.isAvailable()) {
    console.error('[si stats] events DB unavailable (better-sqlite3 not installed?).');
    console.error(`           expected at: ${events.getEventsDbPath()}`);
    process.exit(1);
  }

  if (flags.recent) {
    const rows = events.listRecentCompacts({ limit: 20, project });
    if (flags.json) { console.log(JSON.stringify(rows, null, 2)); return; }
    console.log(`# Recent compacts ${project ? `(project=${project})` : ''}`);
    console.log('');
    const header = `${'WHEN'.padStart(8)}  ${'PROJECT'.padEnd(20)}  ${'TOK'.padStart(6)}  ${'COST'.padStart(6)}  ${'SHIFT'.padStart(5)}  TRIGGER`;
    console.log(header);
    console.log('-'.repeat(header.length));
    for (const r of rows) {
      const w = fmtAge(r.t).padStart(8);
      const p = String(r.project || '—').padEnd(20).slice(0, 20);
      const t = fmtTokens(r.tokens).padStart(6);
      const c = fmtUsd(r.cost).padStart(6);
      const s = (r.had_shift ? 'yes' : '—').padStart(5);
      console.log(`${w}  ${p}  ${t}  ${c}  ${s}  ${r.trigger || '—'}`);
    }
    return;
  }

  const stats = events.aggregateStats({ sinceDays, project });
  if (!stats) {
    console.error('[si stats] failed to aggregate');
    process.exit(1);
  }
  if (flags.json) { console.log(JSON.stringify(stats, null, 2)); return; }

  console.log(`# Session Intelligence — last ${sinceDays}d ${project ? `(project=${project})` : ''}`);
  console.log(`  db: ${events.getEventsDbPath()}`);
  console.log('');
  console.log('Sessions:');
  console.log(`  count       ${stats.sessions.n || 0}`);
  console.log(`  total cost  ${fmtUsd(stats.sessions.cost)}`);
  console.log(`  avg peak    ${fmtTokens(stats.sessions.avg_peak)} tokens`);
  console.log('');
  console.log('Compacts:');
  console.log(`  count       ${stats.compacts.n || 0}`);
  console.log(`  avg tokens  ${fmtTokens(stats.compacts.avg_tokens)}`);
  console.log(`  avg cost    ${fmtUsd(stats.compacts.avg_cost)}`);
  console.log(`  with shift  ${stats.compacts.shifts || 0}`);
  console.log('');
  console.log('Zone callouts:');
  if (!stats.zones.length) {
    console.log('  (none)');
  } else {
    for (const z of stats.zones) {
      console.log(`  ${z.zone.padEnd(7)}  ${z.n}`);
    }
  }
  console.log('');
  console.log('Tool archives:');
  console.log(`  count       ${stats.archives.n || 0}`);
  console.log(`  recalled    ${stats.archives.recalled || 0}`);
  console.log(`  total bytes ${fmtTokens(stats.archives.bytes)}`);
  if (stats.topProjects && stats.topProjects.length) {
    console.log('');
    console.log('Top projects (by session count):');
    for (const p of stats.topProjects) {
      console.log(`  ${String(p.project).padEnd(24)}  ${String(p.sessions).padStart(4)} sessions   ${fmtUsd(p.cost)}`);
    }
  }
}

main();
