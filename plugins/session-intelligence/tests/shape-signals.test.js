'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectDuplicates, countLargeResults, agentReturns, newestRerun,
  duplicateReadsPhrase, renderDuplicateReadsBlock, agentReturnsPhrase,
} = require('../lib/shape-signals');

test('detectDuplicates finds repeated Reads of one path within the window', () => {
  const e = [...Array(3)].map((_, i) => ({ t: i, tok: 1000 * i, tool: 'Read', root: 'src', file: 'src/a.js', chars: 30000, inputHash: 'h1' }));
  const d = detectDuplicates(e);
  assert.deepEqual(d.reads, [{ file: 'src/a.js', count: 3, chars: 90000 }]);
});

test('detectDuplicates ignores single reads and non-Read tools', () => {
  const e = [
    { tool: 'Read', file: 'a', chars: 1 },
    { tool: 'Edit', file: 'b', chars: 1 },
    { tool: 'Edit', file: 'b', chars: 1 },
  ];
  assert.deepEqual(detectDuplicates(e).reads, []);
});

test('detectDuplicates reports same-input re-runs within 20 calls but not beyond', () => {
  const run = (i, hash) => ({ t: i, tok: i, tool: 'Bash', root: null, file: null, chars: 500, inputHash: hash });
  const near = [run(0, 'x'), ...[...Array(10)].map((_, i) => run(i + 1, `o${i}`)), run(11, 'x')];
  assert.deepEqual(detectDuplicates(near).reruns, [{ tool: 'Bash', inputHash: 'x', count: 2, gapCalls: 11 }]);
  const far = [run(0, 'x'), ...[...Array(25)].map((_, i) => run(i + 1, `o${i}`)), run(26, 'x')];
  assert.deepEqual(detectDuplicates(far, { window: 40 }).reruns, []);
});

test('detectDuplicates only looks at the last window entries and never mutates input', () => {
  const e = [{ tool: 'Bash', inputHash: 'x' }, { tool: 'Bash', inputHash: 'y' }, { tool: 'Bash', inputHash: 'x' }];
  const snapshot = JSON.stringify(e);
  assert.deepEqual(detectDuplicates(e, { window: 2 }).reruns, []);
  assert.equal(detectDuplicates(e).reruns.length, 1);
  assert.equal(JSON.stringify(e), snapshot);
});

test('detectDuplicates tolerates junk', () => {
  assert.deepEqual(detectDuplicates(null), { reads: [], reruns: [] });
  assert.deepEqual(detectDuplicates([null, {}, 3]), { reads: [], reruns: [] });
});

test('newestRerun returns the rerun only when the newest entry is the repeat', () => {
  const a = { tool: 'Bash', inputHash: 'x' };
  const b = { tool: 'Bash', inputHash: 'y' };
  assert.deepEqual(newestRerun([a, b, a]), { tool: 'Bash', inputHash: 'x', gapCalls: 2 });
  assert.equal(newestRerun([a, a, b]), null);
  assert.equal(newestRerun([]), null);
});

test('countLargeResults counts results >= 60000 chars in the last 40 entries', () => {
  const e = [...Array(50)].map((_, i) => ({ t: i, tok: i, tool: 'Read', root: 'src', chars: i % 10 === 0 ? 70000 : 100 }));
  assert.equal(countLargeResults(e), 4);
});

test('agentReturns sums Agent entry chars', () => {
  assert.deepEqual(agentReturns([{ tool: 'Agent', chars: 20000 }, { tool: 'Agent', chars: 5000 }, { tool: 'Read', chars: 9 }]), { count: 2, chars: 25000 });
});

test('phrase and block renderers', () => {
  const d = { reads: [{ file: 'src/a.js', count: 3, chars: 90000 }], reruns: [] };
  assert.equal(duplicateReadsPhrase(d), 'dup reads: src/a.js ×3 (~30k tokens)');
  assert.equal(duplicateReadsPhrase({ reads: [], reruns: [] }), '');
  assert.equal(duplicateReadsPhrase(null), '');
  assert.match(renderDuplicateReadsBlock(d, { stablePrefix: false }), /\*\*Duplicate reads \(drop all but the latest\):\*\*\n- src\/a\.js ×3 \(~30k tokens\)/);
  assert.equal(renderDuplicateReadsBlock(d, { stablePrefix: true }).includes('30k'), false, 'stable mode omits the volatile size');
  assert.equal(renderDuplicateReadsBlock({ reads: [], reruns: [] }, {}), '');
  assert.equal(agentReturnsPhrase({ count: 2, chars: 45000 }), 'agents: 2 returns ~15k tokens');
  assert.equal(agentReturnsPhrase({ count: 1, chars: 19999 }), '');
});

test('token-budget hook logs chars/inputHash and records a same-input re-run', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const { openDatabase } = require('../lib/sqlite-driver');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'si-rerun-'));
  try {
    const payload = JSON.stringify({
      session_id: 'sx', cwd: home, tool_name: 'Bash',
      tool_input: { command: 'ls' }, tool_output: 'a'.repeat(5000),
    });
    const env = { ...process.env, HOME: home, CLAUDE_PLUGIN_ROOT: path.join(__dirname, '..') };
    for (let i = 0; i < 2; i++) {
      const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'si-token-budget.js')], { input: payload, env });
      assert.equal(r.status, 0);
    }
    const state = path.join(home, '.claude', 'state');
    const lines = fs.readFileSync(path.join(state, 'claude-ctx-shape-sx.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].chars, 5000);
    assert.equal(lines[0].inputHash, lines[1].inputHash);
    const { db } = openDatabase(path.join(state, 'si-events.db'));
    const rows = db.prepare('SELECT gap_calls FROM tool_reruns').all();
    db.close();
    assert.deepEqual(rows.map((r) => r.gap_calls), [1]);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('largeReadDelegationLine emits the exact delegation copy', () => {
  const { largeReadDelegationLine } = require('../lib/shape-signals');
  assert.equal(
    largeReadDelegationLine(3),
    'Large results detected: 3 tool results ≥20K tokens in the last 40 calls. Delegate the next wide read/grep to a subagent (frontmatter `autoCompactWindow: 400000`) and keep the conclusion, not the output.',
  );
});

test('token-budget hook always appends Agent and Task shape entries, even when small', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'si-agent-'));
  try {
    const env = { ...process.env, HOME: home, CLAUDE_PLUGIN_ROOT: path.join(__dirname, '..') };
    const calls = [['Agent', 'r'.repeat(25000)], ['Task', 'tiny']];
    for (const [tool_name, tool_output] of calls) {
      const payload = JSON.stringify({ session_id: 'sa', cwd: home, tool_name, tool_input: { prompt: 'x' }, tool_response: tool_output });
      const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'si-token-budget.js')], { input: payload, env });
      assert.equal(r.status, 0);
    }
    const lines = fs.readFileSync(path.join(home, '.claude', 'state', 'claude-ctx-shape-sa.jsonl'), 'utf8')
      .trim().split('\n').map(JSON.parse);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((l) => [l.tool, l.chars, l.root]), [['Agent', 25000, null], ['Agent', 4, null]]);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
