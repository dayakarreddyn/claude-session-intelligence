/**
 * Tests for hooks/si-pre-compact.js — specifically the staleness gate on
 * user-managed session-context.md sections. Autofill-sentinel'd sections
 * refresh per-commit and always pass through; hand-written ones are gated
 * by file mtime so multi-week-stale guidance doesn't leak into every
 * compact (regression: 2026-04-17 CSM "statusline v2 / session 28"
 * bleed-through).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  formatCompactionHints,
  buildMemoryCleanupBlock,
  buildGitNexusRefreshBlock,
  buildArchiveRecallBlock,
  STALENESS_MS,
} = require('../hooks/si-pre-compact');

const toolArchive = require('../lib/tool-archive');
const { spawnSync } = require('node:child_process');
const { openDatabase } = require('../lib/sqlite-driver');

const DAY_MS = 24 * 60 * 60 * 1000;
const FIXED_NOW = Date.UTC(2026, 3, 22); // 2026-04-22, anchor for deterministic age math

test('autofill-sentinel section is injected regardless of mtime age', () => {
  const sections = {
    'Current Task':
      '<!-- si:autofill sha=abc1234 -->\n' +
      'type: feat — wire auth middleware\n' +
      'description: derived from last commit on `main`\n',
  };
  const ancient = FIXED_NOW - 30 * DAY_MS; // 30 days old
  const out = formatCompactionHints(sections, { mtimeMs: ancient, nowMs: FIXED_NOW });

  assert.match(out, /LAST TASK:/);
  assert.match(out, /wire auth middleware/);
  assert.doesNotMatch(out, /NOTE: skipped/);
});

test('user-managed section is injected when mtime is fresh', () => {
  const sections = {
    'Current Task': 'type: feat — hand-written fresh task\ndescription: recent work',
  };
  const fresh = FIXED_NOW - 1 * DAY_MS; // 1 day old — under staleness window
  const out = formatCompactionHints(sections, { mtimeMs: fresh, nowMs: FIXED_NOW });

  assert.match(out, /LAST TASK:/);
  assert.match(out, /hand-written fresh task/);
  assert.doesNotMatch(out, /NOTE: skipped/);
});

test('user-managed section is skipped when mtime is stale, replaced with refresh pointer', () => {
  const sections = {
    'Current Task':
      'type: feat — statusline v2: real tokens, configurable fields, intelligent emoji\n' +
      'description: Unify tool counter, read transcript, push to public repo.',
    'On Compact':
      'PRESERVE: next-up priorities ordering, gateway gate contract\nDROP: all session 28 details',
  };
  const stale = FIXED_NOW - 5 * DAY_MS; // 5 days old — over default 3-day window
  const out = formatCompactionHints(sections, { mtimeMs: stale, nowMs: FIXED_NOW });

  // Stale body must NOT appear verbatim.
  assert.doesNotMatch(out, /statusline v2/);
  assert.doesNotMatch(out, /session 28/);
  assert.doesNotMatch(out, /LAST TASK:/);
  assert.doesNotMatch(out, /COMPACTION INSTRUCTIONS:/);

  // Pointer is present with staleness + sentinel guidance.
  assert.match(out, /NOTE: skipped user-managed section\(s\)/);
  assert.match(out, /`Current Task`/);
  assert.match(out, /`On Compact`/);
  assert.match(out, /si:autofill sha=/);
});

test('stale + autofill in same file: autofill still injects, user-managed still skips', () => {
  const sections = {
    'Current Task':
      '<!-- si:autofill sha=def5678 -->\n' +
      'type: fix — patch compact hints\n' +
      'description: derived from last commit on `main`\n',
    'On Compact': 'PRESERVE: multi-week-old curated guidance that should not leak',
  };
  const stale = FIXED_NOW - 10 * DAY_MS;
  const out = formatCompactionHints(sections, { mtimeMs: stale, nowMs: FIXED_NOW });

  assert.match(out, /LAST TASK:/);
  assert.match(out, /patch compact hints/);
  assert.doesNotMatch(out, /multi-week-old curated guidance/);
  assert.match(out, /NOTE: skipped user-managed section\(s\) `On Compact`/);
});

test('missing mtime (mtimeMs=0) is treated as unknown age and skips user-managed sections', () => {
  const sections = {
    'Current Task': 'type: feat — hand-written\ndescription: no mtime available',
  };
  const out = formatCompactionHints(sections, { mtimeMs: 0, nowMs: FIXED_NOW });

  assert.doesNotMatch(out, /hand-written/);
  assert.match(out, /NOTE: skipped user-managed section\(s\)/);
  assert.match(out, /carries no `<!-- si:autofill sha=\.\.\. -->` sentinel/);
});

test('empty sections + no skipped → empty string (no header for nothing)', () => {
  assert.equal(formatCompactionHints({}), '');
  assert.equal(formatCompactionHints({ 'Current Task': '' }), '');
});

test('explicit stalenessMs override lets callers tune the window', () => {
  const sections = { 'Current Task': 'type: feat — recent-ish\ndescription: a bit old' };
  const twoDaysOld = FIXED_NOW - 2 * DAY_MS;
  // Default window (3 days): injects
  const defaultOut = formatCompactionHints(sections, { mtimeMs: twoDaysOld, nowMs: FIXED_NOW });
  assert.match(defaultOut, /recent-ish/);
  // Tighter 1-day window: skips
  const strictOut = formatCompactionHints(sections, {
    mtimeMs: twoDaysOld,
    nowMs: FIXED_NOW,
    stalenessMs: 1 * DAY_MS,
  });
  assert.doesNotMatch(strictOut, /recent-ish/);
  assert.match(strictOut, /NOTE: skipped/);
});

test('STALENESS_MS export is 3 days (the tuned default)', () => {
  assert.equal(STALENESS_MS, 3 * DAY_MS);
});

test('buildMemoryCleanupBlock returns "" when projectDir is null', () => {
  assert.equal(buildMemoryCleanupBlock(null), '');
  assert.equal(buildMemoryCleanupBlock(undefined), '');
});

test('buildMemoryCleanupBlock returns "" when memory dir is missing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'si-precompact-'));
  try {
    assert.equal(buildMemoryCleanupBlock(tmp), '');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildMemoryCleanupBlock emits cleanup directive when memory dir exists', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'si-precompact-'));
  const memoryDir = path.join(tmp, 'memory');
  fs.mkdirSync(memoryDir);
  try {
    const out = buildMemoryCleanupBlock(tmp);
    assert.match(out, /STALE MEMORY CLEANUP \(pre-compact\)/);
    assert.match(out, /MEMORY\.md/);
    assert.match(out, /project_session_\*\.md/);
    assert.match(out, /reference_\*\.md/);
    assert.match(out, /cleaned N lines/);
    assert.ok(out.includes(memoryDir), 'directive must name the concrete memory path');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildGitNexusRefreshBlock returns "" when disabled / skipped / empty', () => {
  assert.equal(buildGitNexusRefreshBlock(null), '');
  assert.equal(buildGitNexusRefreshBlock(undefined), '');
  assert.equal(buildGitNexusRefreshBlock({ skipped: true }), '');
  assert.equal(buildGitNexusRefreshBlock({ refreshed: false, anchors: 5, sinceDays: 90 }), '');
  assert.equal(buildGitNexusRefreshBlock({ refreshed: true, anchors: 0, sinceDays: 90 }), '');
  assert.equal(buildGitNexusRefreshBlock({ refreshed: true, anchors: 10, sinceDays: 0 }), '');
});

test('buildGitNexusRefreshBlock emits refresh note with anchor count + sinceDays', () => {
  const out = buildGitNexusRefreshBlock({ refreshed: true, anchors: 12, sinceDays: 90 });
  assert.match(out, /REPO GRAPH \(git-nexus refreshed\)/);
  assert.match(out, /last 90d of commit history/);
  assert.match(out, /12 anchor\(s\) cached/);
  assert.match(out, /preserveGlobs/);
});

// ─── Recallable-archives block ────────────────────────────────────────────────

test('buildArchiveRecallBlock is empty when the session has no archives', () => {
  assert.equal(buildArchiveRecallBlock(''), '');
  assert.equal(buildArchiveRecallBlock(`pc-none-${Date.now()}`), '');
});

test('buildArchiveRecallBlock lists recallable ids largest-first with /si expand', () => {
  const sid = `pc-recall-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    toolArchive.writeArchive(sid, 'toolu_small', { tool_name: 'Bash' }, 'a'.repeat(5000));
    toolArchive.writeArchive(sid, 'toolu_big', { tool_name: 'Read' }, 'b'.repeat(20000));
    const out = buildArchiveRecallBlock(sid);
    assert.match(out, /RECALLABLE ARCHIVES \(post-compact\)/);
    assert.match(out, /\/si expand <id>/);
    assert.match(out, /toolu_big/);
    assert.match(out, /toolu_small/);
    // Largest body must be listed before the smaller one.
    assert.ok(out.indexOf('toolu_big') < out.indexOf('toolu_small'), 'largest archive listed first');
  } finally {
    try { fs.rmSync(toolArchive.archiveDir(sid), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('si-pre-compact stamps contextTokens/cap/fill on the history entry and compacts row', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'si-home-'));
  try {
    const sid = 'sid-pc-units';
    const cwd = path.join(home, 'proj');
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(path.join(home, '.claude', 'state'), { recursive: true });
    const transcript = path.join(home, 'transcript.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({
      type: 'assistant', timestamp: '2026-10-19T00:00:00Z',
      message: { id: 'msg_1', model: 'claude-opus-5-5', role: 'assistant', content: [],
        usage: { input_tokens: 400000, cache_creation_input_tokens: 0, cache_read_input_tokens: 80000, output_tokens: 10 } },
    }) + '\n');
    const seed = spawnSync(process.execPath, ['-e',
      `require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'events'))}).recordSessionStart({sid:${JSON.stringify(sid)},project:'p',cwd:${JSON.stringify(cwd)},startedAt:1})`],
    { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.equal(seed.status, 0, seed.stderr);
    const env = { ...process.env, HOME: home, CLAUDE_SESSION_ID: sid };
    for (const k of ['CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_DISABLE_1M_CONTEXT', 'DISABLE_COMPACT']) delete env[k];
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'si-pre-compact.js')], {
      input: JSON.stringify({ session_id: sid, cwd, transcript_path: transcript, trigger: 'auto', hook_event_name: 'PreCompact' }),
      env, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(r.status, 0, r.stderr);
    const lines = fs.readFileSync(path.join(home, '.claude', 'logs', 'compact-history.jsonl'), 'utf8').trim().split('\n');
    const entry = JSON.parse(lines[lines.length - 1]);
    assert.equal(entry.tokens, 480000); assert.equal(entry.contextTokens, 480000);
    assert.equal(entry.contextCap, 1000000); assert.equal(entry.fillPct, 48);
    assert.equal(entry.model, 'claude-opus-5-5'); assert.equal(entry.trigger, 'auto');
    const { db } = openDatabase(path.join(home, '.claude', 'state', 'si-events.db'));
    try {
      const row = db.prepare('SELECT tokens, fill_pct, context_cap FROM compacts WHERE sid = ?').get(sid);
      assert.equal(row.tokens, 480000); assert.equal(row.fill_pct, 48); assert.equal(row.context_cap, 1000000);
    } finally { db.close(); }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// --- Task 14: registry-first, capped PreCompact output ----------------------

function runPreCompact({ sessionContext, sid, extraShapeLines = 0 }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'si-home-'));
  const cwd = path.join(home, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'state'), { recursive: true });
  const transcript = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({
    type: 'assistant', timestamp: '2026-10-19T00:00:00Z',
    message: { id: 'msg_1', model: 'claude-opus-5-5', role: 'assistant', content: [],
      usage: { input_tokens: 400000, cache_creation_input_tokens: 0, cache_read_input_tokens: 80000, output_tokens: 10 } },
  }) + '\n');
  const projectDir = path.join(home, '.claude', 'projects', path.resolve(cwd).replace(/\//g, '-'));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'session-context.md'), sessionContext);
  const env = { ...process.env, HOME: home, CLAUDE_SESSION_ID: sid };
  for (const k of ['CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_DISABLE_1M_CONTEXT', 'DISABLE_COMPACT']) delete env[k];
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'si-pre-compact.js')], {
    input: JSON.stringify({ session_id: sid, cwd, transcript_path: transcript, trigger: 'manual', hook_event_name: 'PreCompact' }),
    env, encoding: 'utf8', timeout: 15000,
  });
  const statePath = path.join(home, '.claude', 'state', `claude-constraints-${sid}.json`);
  return { r, home, statePath, readState: () => JSON.parse(fs.readFileSync(statePath, 'utf8')) };
}

test('PreCompact prints the registry before every other section, exits 0, never blocks', () => {
  const ctx = '# Session Context\n\n## Current Task\ntype: feat — thing\ndescription: do the thing\n\n'
    + '## Key Decisions\n- Never rewrite earlier turns\n\n## On Compact\nPRESERVE: the auth contract\n';
  const { r, home, readState } = runPreCompact({ sessionContext: ctx, sid: 'sid-pc-reg' });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /"decision"/);
    const reg = r.stdout.indexOf('## CONSTRAINT REGISTRY');
    assert.ok(reg >= 0, r.stdout);
    assert.ok(reg < r.stdout.indexOf('## COMPACTION GUIDANCE'));
    assert.ok(r.stdout.length < 10000);
    const state = readState();
    assert.ok(state.items.some((i) => i.text === 'Never rewrite earlier turns'));
    assert.equal(state.fillPct, 48); assert.equal(state.contextTokens, 480000);
    assert.equal(state.contextCap, 1000000); assert.equal(state.trigger, 'manual');
    assert.equal(state.model, 'claude-opus-5-5');
    for (const item of state.items) assert.ok(r.stdout.includes(item.text), `state item "${item.text}" must be in stdout`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('PreCompact over the cap keeps the registry intact, drops optional blocks from the end, and logs it', () => {
  const ctx = '# Session Context\n\n## Key Decisions\n- Never rewrite earlier turns\n\n'
    + '## On Compact\nPRESERVE: ' + 'x'.repeat(9000) + '\n\n## Current Task\ntype: feat — thing\ndescription: ' + 'y'.repeat(6000) + '\n';
  const { r, home, readState } = runPreCompact({ sessionContext: ctx, sid: 'sid-pc-cap' });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.length < 10000, `stdout was ${r.stdout.length}`);
    assert.doesNotMatch(r.stdout, /"decision"/);
    const state = readState();
    assert.ok(state.items.length >= 1);
    for (const item of state.items) assert.ok(r.stdout.includes(item.text));
    assert.match(r.stdout, /Never rewrite earlier turns/);
    const logDir = path.join(home, '.claude', 'logs');
    const log = fs.readdirSync(logDir).filter((f) => f.startsWith('session-intel-'))
      .map((f) => fs.readFileSync(path.join(logDir, f), 'utf8')).join('\n');
    assert.match(log, /block assembled/);
    const line = log.split('\n').find((l) => l.includes('block assembled'));
    const dropped = JSON.parse(line.slice(line.indexOf('{'))).dropped;
    assert.equal(dropped[0], 'next');
    assert.ok(!dropped.includes('registry'));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('PreCompact still injects the registry when the state dir is unwritable', { skip: process.getuid && process.getuid() === 0 }, () => {
  const ctx = '# Session Context\n\n## Key Decisions\n- Never rewrite earlier turns\n';
  const sid = 'sid-pc-ro';
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'si-home-'));
  const stateDir = path.join(home, '.claude', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const projectDir = path.join(home, '.claude', 'projects', path.join(home, 'proj').replace(/\//g, '-'));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(home, 'proj'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'session-context.md'), ctx);
  fs.chmodSync(stateDir, 0o500);
  try {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'si-pre-compact.js')], {
      input: JSON.stringify({ session_id: sid, cwd: path.join(home, 'proj'), trigger: 'manual', hook_event_name: 'PreCompact' }),
      env: { ...process.env, HOME: home, CLAUDE_SESSION_ID: sid }, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /## CONSTRAINT REGISTRY/);
    assert.match(r.stdout, /Never rewrite earlier turns/);
  } finally {
    fs.chmodSync(stateDir, 0o700);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('PreCompact with an unreadable transcript still writes the regret snapshot, exits 0, and never records cap 0', () => {
  const sid = 'sid-pc-nousage';
  const snapFile = path.join(os.tmpdir(), `claude-compact-snapshot-${sid}.json`);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'si-home-'));
  try {
    fs.rmSync(snapFile, { force: true });
    const cwd = path.join(home, 'proj');
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(path.join(home, '.claude', 'state'), { recursive: true });
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'si-pre-compact.js')], {
      input: JSON.stringify({ session_id: sid, cwd, transcript_path: path.join(home, 'missing.jsonl'), trigger: 'auto', hook_event_name: 'PreCompact' }),
      env: { ...process.env, HOME: home, CLAUDE_SESSION_ID: sid }, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(snapFile), 'regret snapshot must be written without usage evidence');
    const dbFile = path.join(home, '.claude', 'state', 'si-events.db');
    if (fs.existsSync(dbFile)) {
      const { db } = openDatabase(dbFile);
      try {
        const row = db.prepare('SELECT context_cap FROM compacts WHERE sid = ?').get(sid);
        assert.ok(!row || row.context_cap !== 0);
      } finally { db.close(); }
    }
  } finally {
    fs.rmSync(snapFile, { force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
