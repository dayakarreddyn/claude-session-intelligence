/**
 * Tests for lib/prune.js — pure prune decisions, excerpt builder, input rewrite.
 */

'use strict';

const { spawnSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const { decidePrune, buildExcerpt, rewriteCommand, inputHash, DEFAULT_INPUT_RULES } = require('../lib/prune');
const { DEFAULTS, loadConfig } = require('../lib/config');

const cfg = DEFAULTS.prune;

test('DEFAULTS.prune floor is 50000 chars with 2000/1500 head/tail', () => {
  assert.equal(cfg.outputFloorChars, 50000);
  assert.equal(cfg.headChars, 2000);
  assert.equal(cfg.tailChars, 1500);
  assert.deepEqual(cfg.tools, ['Read', 'Bash', 'Grep', 'Glob', 'WebFetch']);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.rewriteInput, true);
});

test('decidePrune prunes a 60000-char Read and leaves 49999 chars alone', () => {
  const big = decidePrune({ toolName: 'Read', toolUseId: 'toolu_01ABC', body: 'a'.repeat(60000), cfg });
  assert.equal(big.pruned, true);
  assert.equal(big.originalChars, 60000);
  assert.equal(big.archiveId, 'toolu_01ABC');
  assert.equal(big.excerptChars, big.output.length);
  assert.ok(big.output.length < 4000);
  assert.deepEqual(
    decidePrune({ toolName: 'Read', toolUseId: 'toolu_x', body: 'a'.repeat(49999), cfg }),
    { pruned: false, reason: 'below-floor' },
  );
});

test('decidePrune never touches a non-string (JSON) result', () => {
  const body = { content: [{ type: 'text', text: 'z'.repeat(70000) }] };
  assert.deepEqual(
    decidePrune({ toolName: 'mcp__x__y', toolUseId: 'toolu_j', body, cfg: { ...cfg, tools: ['mcp__x__y'] } }),
    { pruned: false, reason: 'not-string' },
  );
  assert.deepEqual(
    decidePrune({ toolName: 'Read', toolUseId: 'toolu_j', body, cfg }),
    { pruned: false, reason: 'not-string' },
  );
  assert.equal(decidePrune({ toolName: 'Read', toolUseId: 'toolu_j', body: null, cfg }).reason, 'not-string');
});

test('decidePrune respects tools allowlist, enabled flag and missing id', () => {
  const body = 'a'.repeat(60000);
  assert.equal(decidePrune({ toolName: 'Edit', toolUseId: 'toolu_e', body, cfg }).reason, 'tool-excluded');
  assert.equal(decidePrune({ toolName: 'Read', toolUseId: 'toolu_e', body, cfg: { ...cfg, enabled: false } }).reason, 'disabled');
  assert.equal(decidePrune({ toolName: 'Read', toolUseId: null, body, cfg }).reason, 'no-id');
  assert.equal(decidePrune({ toolName: 'Read', toolUseId: '', body, cfg }).reason, 'no-id');
});

test('buildExcerpt carries head, tail, omitted count and the /si expand hint', () => {
  const body = 'H'.repeat(2000) + 'M'.repeat(96500) + 'T'.repeat(1500);
  const out = buildExcerpt(body, { headChars: 2000, tailChars: 1500, archiveId: 'toolu_01ABC', toolName: 'Read', originalChars: body.length });
  assert.ok(out.startsWith('[SI pruned: Read result 100,000 chars → '));
  assert.match(out, /run `\/si expand toolu_01ABC` to replay it verbatim\.\]/);
  assert.match(out, /…\[96,500 chars omitted\]…/);
  assert.ok(out.includes('H'.repeat(2000)) && out.endsWith('T'.repeat(1500)));
  assert.match(out, new RegExp(`→ ${out.length.toLocaleString('en-US')}-char excerpt\\.`));
});

const WRAP = (cmd, pattern) =>
  `( set -o pipefail; ( ${cmd}\n rc=$?; echo "[exit=$rc]"; exit $rc ) 2>&1 | grep -E -A 5 '${pattern}|\\[exit=' | head -100 )`;
const TEST_PATTERN = '(FAIL|ERROR|error:|not ok|# fail|# pass|passed|failed|^ok\\b)';

test('rewriteCommand wraps test runners with exit-preserving grep/head shape and names the rule', () => {
  const r = rewriteCommand('npm test');
  assert.equal(r.rule, 'test-runner');
  assert.equal(r.command, WRAP('npm test', TEST_PATTERN));
  assert.equal(rewriteCommand('cat server.log').command, 'cat server.log | tail -n 200');
  assert.equal(rewriteCommand('cat server.log').rule, 'log-cat');
});

test('rewriteCommand leaves redirects, existing filters, multi-line and unrelated commands alone', () => {
  for (const c of ['npm test > out.txt', 'npm test 2>&1 | tail -50', 'npm test | grep x', 'npm test\necho done', 'git status', 'npm test &', 'npm test  & ', 'npm test # note']) {
    assert.deepEqual(rewriteCommand(c), { command: c, rule: null });
  }
});

test('rewritten wrapper surfaces a failing exit status and prints [exit=N]', () => {
  const cmd = "sh -c 'echo FAIL; exit 3'";
  const r = spawnSync('bash', ['-c', WRAP(cmd, '(FAIL)')], { encoding: 'utf8' });
  assert.equal(r.status, 3);
  assert.match(r.stdout, /\[exit=3\]/);
  assert.match(r.stdout, /FAIL/);
});

test('rewritten wrapper exits 0 for a passing command whose output matches nothing', () => {
  const r = spawnSync('bash', ['-c', WRAP('true', '(FAIL)')], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\[exit=0\]/);
});

test('rewriteCommand output for a real rule runs end to end', () => {
  const rule = { name: 'x', match: '^sh\\b', pattern: '(FAIL)' };
  const { command, rule: name } = rewriteCommand("sh -c 'echo FAIL; exit 2'", [rule]);
  assert.equal(name, 'x');
  const r = spawnSync('bash', ['-c', command], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});

test('DEFAULT_INPUT_RULES is frozen and survives config JSON cloning', () => {
  assert.ok(Object.isFrozen(DEFAULT_INPUT_RULES));
  assert.deepEqual(cfg.inputRules, DEFAULT_INPUT_RULES);
  assert.equal(rewriteCommand('pytest -q', cfg.inputRules).rule, 'test-runner');
});

test('inputHash is stable across key order and 16 hex chars', () => {
  assert.equal(inputHash('Read', { file_path: '/a', limit: 5 }), inputHash('Read', { limit: 5, file_path: '/a' }));
  assert.match(inputHash('Bash', { command: 'ls' }), /^[0-9a-f]{16}$/);
  assert.notEqual(inputHash('Bash', { command: 'ls' }), inputHash('Bash', { command: 'pwd' }));
});

test('env CLAUDE_SI_PRUNE and CLAUDE_SI_PRUNE_FLOOR override config', () => {
  const saved = { p: process.env.CLAUDE_SI_PRUNE, f: process.env.CLAUDE_SI_PRUNE_FLOOR, h: process.env.HOME };
  try {
    process.env.HOME = require('os').tmpdir() + '/si-prune-nohome';
    process.env.CLAUDE_SI_PRUNE = '0';
    process.env.CLAUDE_SI_PRUNE_FLOOR = '12345';
    const c = loadConfig();
    assert.equal(c.prune.enabled, false);
    assert.equal(c.prune.outputFloorChars, 12345);
    process.env.CLAUDE_SI_PRUNE = '1';
    process.env.CLAUDE_SI_PRUNE_FLOOR = '99999999999';
    const d = loadConfig();
    assert.equal(d.prune.enabled, true);
    assert.equal(d.prune.outputFloorChars, 50000);
  } finally {
    for (const [k, v] of [['CLAUDE_SI_PRUNE', saved.p], ['CLAUDE_SI_PRUNE_FLOOR', saved.f], ['HOME', saved.h]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('rewritten wrapper inserts the command verbatim, preserving $ and backticks', () => {
  const cmd = 'echo \'cost $5\' "tick \\`x\\`"';
  const r = spawnSync('bash', ['-c', WRAP(cmd, '(cost)')], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('cost $5 tick `x`'), r.stdout);
});

test('custom rule pattern with a single quote is escaped', () => {
  const { command } = rewriteCommand("sh -c 'echo it'", [{ name: 'q', match: '^sh', pattern: "(it's)" }]);
  const r = spawnSync('bash', ['-c', command], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(command, /\(it'\\''s\)/);
});

test('buildExcerpt never overlaps head and tail on a short body', () => {
  const body = 'abcdefghij';
  const out = buildExcerpt(body, { headChars: 8, tailChars: 8, archiveId: 'toolu_s', toolName: 'Read', originalChars: 10 });
  assert.match(out, /…\[0 chars omitted\]…/);
  assert.equal(out.split('\n').slice(1).join(''), 'abcdefgh…[0 chars omitted]…ij');
});

test('decidePrune prunes exactly 50000 chars and rejects an empty body as below-floor', () => {
  assert.equal(decidePrune({ toolName: 'Read', toolUseId: 'toolu_f', body: 'a'.repeat(50000), cfg }).pruned, true);
  assert.deepEqual(decidePrune({ toolName: 'Read', toolUseId: 'toolu_f', body: '', cfg }), { pruned: false, reason: 'below-floor' });
});

test('inputHash is stable across nested key order', () => {
  assert.equal(inputHash('X', { a: { b: 1, c: 2 } }), inputHash('X', { a: { c: 2, b: 1 } }));
});

test('extractPrunableText: string, Bash, Read shapes rebuild in place; others return null', () => {
  const { extractPrunableText } = require('../lib/prune');
  assert.equal(extractPrunableText({ toolName: 'Read', toolResponse: 'abc' }).rebuild('X'), 'X');
  const bash = { stdout: 'o', stderr: 'e', interrupted: false, isImage: false };
  const b = extractPrunableText({ toolName: 'Bash', toolResponse: bash });
  assert.equal(b.text, 'o');
  assert.deepEqual(b.rebuild('X'), { stdout: 'X', stderr: 'e', interrupted: false, isImage: false });
  assert.equal(bash.stdout, 'o', 'input not mutated');
  const read = { type: 'text', file: { filePath: '/f', content: 'c', numLines: 1 } };
  assert.deepEqual(extractPrunableText({ toolName: 'Read', toolResponse: read }).rebuild('X'),
    { type: 'text', file: { filePath: '/f', content: 'X', numLines: 1 } });
  for (const v of [null, undefined, 5, [], {}, { content: [{ type: 'text', text: 'z' }] }, { type: 'text', file: {} }]) {
    assert.equal(extractPrunableText({ toolName: 'mcp__x', toolResponse: v }), null);
  }
});
