#!/usr/bin/env node
/**
 * Tool-Archive Expand CLI.
 *
 * Retrieves a tool_response payload that the PostToolUse archive hook captured
 * before /compact wiped it from context.
 *
 * Usage:
 *   node tools/expand.js <tool_use_id>           # print archived body
 *   node tools/expand.js --list [--sid=<sid>]    # index rows, newest last
 *   node tools/expand.js --prune [--sid=<sid>]   # manual TTL sweep
 *
 * Without --sid, the tool tries (in order): CLAUDE_SESSION_ID env, the most
 * recently-modified archive dir under os.tmpdir(). That "most-recent" fallback
 * is the common case — the user just /compacted and wants the last session's
 * archive — but is noisy across concurrent sessions, hence the override.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function resolveSiLibDir() {
  const candidates = [
    path.join(__dirname, '..', 'lib'),
    path.join(__dirname, '..', 'session-intelligence', 'lib'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'tool-archive.js'))) return dir;
  }
  return candidates[0];
}
const SI_LIB = resolveSiLibDir();
const toolArchive = require(path.join(SI_LIB, 'tool-archive'));

function parseArgs(argv) {
  const args = { positional: [], flags: {} };
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) args.flags[a.slice(2, eq)] = a.slice(eq + 1);
      else args.flags[a.slice(2)] = true;
    } else {
      args.positional.push(a);
    }
  }
  return args;
}

function findLatestSessionSid() {
  const root = os.tmpdir();
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  const hits = entries
    .filter((e) => e.isDirectory() && e.name.startsWith('claude-tool-archive-'))
    .map((e) => {
      const full = path.join(root, e.name);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch { /* ignore */ }
      return { sid: e.name.slice('claude-tool-archive-'.length), mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return hits.length ? hits[0].sid : null;
}

function resolveSid(flags) {
  if (flags.sid) return String(flags.sid);
  if (process.env.CLAUDE_SESSION_ID) return process.env.CLAUDE_SESSION_ID;
  const latest = findLatestSessionSid();
  return latest || 'default';
}

function fmtChars(n) {
  if (!Number.isFinite(n)) return '?';
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`;
  if (n >= 1024) return `${Math.round(n / 1024)}K`;
  return String(n);
}

function fmtTimeAgo(t) {
  if (!Number.isFinite(t)) return '';
  const age = Math.max(0, Date.now() - t);
  const m = Math.floor(age / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ''} ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function cmdList(sid) {
  const rows = toolArchive.listArchives(sid);
  if (!rows.length) {
    console.error(`[tool-archive] no archives for session ${sid}`);
    process.exit(0);
  }
  console.log(`# Archive index — session ${sid}`);
  console.log(`# dir: ${toolArchive.archiveDir(sid)}`);
  console.log('');
  const header = `${'ID'.padEnd(32)}  ${'TOOL'.padEnd(12)}  ${'SIZE'.padStart(6)}  ${'AGE'.padStart(10)}  PREVIEW`;
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of rows) {
    const id = String(r.id || '').padEnd(32);
    const tool = String(r.tool || '-').padEnd(12);
    const size = fmtChars(r.chars).padStart(6);
    const age = fmtTimeAgo(r.t).padStart(10);
    const preview = String(r.preview || '').slice(0, 80);
    const missing = r.exists === false ? ' (missing)' : '';
    console.log(`${id}  ${tool}  ${size}  ${age}  ${preview}${missing}`);
  }
}

function cmdPrune(sid) {
  const n = toolArchive.sweepTtl(sid, 7);
  console.error(`[tool-archive] pruned ${n} stale archive(s) for session ${sid}`);
}

function cmdExpand(sid, id) {
  const rec = toolArchive.readArchive(sid, id);
  if (!rec) {
    // Fall back: scan all session dirs for a matching id — useful when the
    // user copies an id from an older session.
    const fallback = findArchiveAcrossSessions(id);
    if (fallback) {
      return printExpand(fallback);
    }
    console.error(`[tool-archive] no archive found for id=${id} (session=${sid})`);
    process.exit(1);
  }
  printExpand(rec);
}

function findArchiveAcrossSessions(id) {
  const root = os.tmpdir();
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('claude-tool-archive-')) continue;
    const sid = e.name.slice('claude-tool-archive-'.length);
    const rec = toolArchive.readArchive(sid, id);
    if (rec) return rec;
  }
  return null;
}

function printExpand(rec) {
  // Render something the model can consume directly. Header in comment lines
  // so the model's parser (if it pipes the result back into another tool) can
  // strip them cheaply, body flows through unchanged.
  console.log(`# tool-archive expand: id=${rec.id} tool=${rec.tool || '-'} chars=${rec.chars} at=${new Date(rec.t).toISOString()}`);
  if (rec.tool_input) {
    try { console.log(`# input=${JSON.stringify(rec.tool_input)}`); } catch { /* ignore */ }
  }
  console.log(rec.body);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sid = resolveSid(args.flags);

  if (args.flags.list) return cmdList(sid);
  if (args.flags.prune) return cmdPrune(sid);

  const id = args.positional[0];
  if (!id) {
    console.error('Usage: node tools/expand.js <tool_use_id> [--sid=<sid>]');
    console.error('       node tools/expand.js --list [--sid=<sid>]');
    console.error('       node tools/expand.js --prune [--sid=<sid>]');
    process.exit(2);
  }
  cmdExpand(sid, id);
}

main();
