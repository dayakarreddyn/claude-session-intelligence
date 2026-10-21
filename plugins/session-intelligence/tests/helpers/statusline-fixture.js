'use strict';

// Shared helpers for spawning statusline/statusline-intel.js against a
// throwaway HOME/TMPDIR. Nothing here touches the real ~/.claude or the real
// os.tmpdir(), and every render pre-seeds a fresh usage cache so the
// background usage-refresh worker is never spawned.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const STATUSLINE = path.join(__dirname, '..', '..', 'statusline', 'statusline-intel.js');
const TRANSCRIPT_MODEL = 'claude-fable-5-1';
const ROW_SPACING_MS = 10_000;
const ASSISTANT_ROWS = 3;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const DEFAULT_FIELDS = null;

function uid() {
  try { return String(os.userInfo().uid); } catch { return 'default'; }
}

/** Fresh temp HOME (also TMPDIR) with .claude/ and a non-git work/ dir; removed after the test. */
function makeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'si-sl-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, 'work'), { recursive: true });
  if (t && typeof t.after === 'function') {
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  }
  return home;
}

function usageRow(id, ts) {
  return {
    type: 'assistant',
    timestamp: new Date(ts).toISOString(),
    message: {
      id,
      role: 'assistant',
      model: TRANSCRIPT_MODEL,
      usage: {
        input_tokens: 2000,
        cache_creation_input_tokens: 8000,
        cache_read_input_tokens: 470000,
        output_tokens: 128,
        output_tokens_details: { thinking_tokens: 701 },
      },
    },
  };
}

/** One user row plus three assistant rows 10 s apart. Returns the transcript path. */
function writeTranscript(home, rows) {
  const file = path.join(home, 'transcript.jsonl');
  const base = Date.UTC(2026, 9, 21, 9, 0, 0);
  const defaults = [{ type: 'user', timestamp: new Date(base).toISOString(), message: { role: 'user', content: 'hello' } }];
  for (let i = 1; i <= ASSISTANT_ROWS; i++) defaults.push(usageRow(`msg_${i}`, base + i * ROW_SPACING_MS));
  const out = Array.isArray(rows) ? rows : defaults;
  fs.writeFileSync(file, out.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

/** Fresh usage cache so readAndRefreshIfStale returns without spawning a worker. */
function writeFreshUsageCache(tmpdir) {
  const now = Date.now();
  fs.writeFileSync(path.join(tmpdir, `claude-usage-cache-${uid()}.json`),
    JSON.stringify({ fetchedAt: now, goodAt: now, sessionUsage: 36, weeklyUsage: 95, error: false }));
}

function writeConfig(home, fields) {
  const statusline = { preset: 'verbose' };
  if (fields) statusline.fields = fields;
  fs.writeFileSync(path.join(home, '.claude', 'session-intelligence.json'), JSON.stringify({ statusline }));
}

function stripAnsi(s) { return String(s).replace(ANSI_RE, ''); }

function normalise(s) {
  return stripAnsi(s)
    .replace(/(?<![A-Za-z])r:\S+/g, 'r:<dur>')
    .replace(/\b\d+(?:d|h|m|s|hr|min)(?:\s?\d+(?:h|m|s|min|hr))*\s+ago\b/g, '<dur> ago')
    .replace(/(?:\/private)?\/var\/folders\/\S*/g, '<tmp>')
    .replace(/(?:\/private)?\/tmp\/\S*/g, '<tmp>');
}

/**
 * Spawn the statusline. opts: { home, fields, env, usageCache (false to skip the seed), transcript (false to omit) }.
 * Returns { stdout, stderr, status, lines } with ANSI disabled via NO_COLOR.
 */
function render(payload, opts = {}) {
  const { home, fields = DEFAULT_FIELDS, env = {} } = opts;
  writeConfig(home, fields);
  const transcriptPath = opts.transcript === false ? undefined : writeTranscript(home);
  if (opts.usageCache !== false) writeFreshUsageCache(home);
  const input = {
    ...payload,
    cwd: path.join(home, 'work'),
    session_id: `golden-${opts.name || 'render'}`,
    ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
  };
  const base = { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: home, NO_COLOR: '1' };
  for (const k of ['CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_CODE_DISABLE_1M_CONTEXT', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
    'CLAUDE_STATUSLINE_FIELDS', 'CLAUDE_STATUSLINE_PRESET', 'CLAUDE_CODE_MAX_CONTEXT_TOKENS']) delete base[k];
  const r = spawnSync(process.execPath, [STATUSLINE], {
    input: JSON.stringify(input), env: { ...base, ...env }, encoding: 'utf8',
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status, lines: r.stdout.split('\n') };
}

module.exports = { STATUSLINE, makeHome, writeTranscript, writeFreshUsageCache, writeConfig, render, stripAnsi, normalise, uid };
