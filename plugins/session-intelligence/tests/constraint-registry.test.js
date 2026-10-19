const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseSessionContext } = require('../lib/session-context');
const {
  CONSTRAINT_TYPES, classifyConstraint, extractCompactInstructions, buildRegistry,
  renderRegistryBlock, fitRegistryToCap, registryStatePath, writeRegistryState, readRegistryState, retentionOf,
} = require('../lib/constraint-registry');

function sampleRegistry() {
  const sections = parseSessionContext('## Key Decisions\n- Never rewrite earlier turns\n\n## On Compact\nPRESERVE: the pruner floor is 50000\n');
  return buildRegistry({ sections, claudeMdText: '# Compact instructions\n- Keep the test matrix green on Node 20 and 22\n' });
}

test('classifyConstraint maps the five types', () => {
  assert.equal(classifyConstraint('Never rewrite earlier transcript turns'), 'Action');
  assert.equal(classifyConstraint('Respond with JSON only'), 'Output');
  assert.equal(classifyConstraint('Run npm test before every commit'), 'Process');
  assert.equal(classifyConstraint('Prefer rsync over cp for cache refresh'), 'Preference');
  assert.equal(classifyConstraint('The events DB lives at ~/.claude/state/si-events.db'), 'Information');
  assert.ok(Object.isFrozen(CONSTRAINT_TYPES));
});

test('extractCompactInstructions reads bullets up to the next heading, any level, case-insensitive', () => {
  const md = '## compact Instructions\n- one\n* two\nnot a bullet\n### Next\n- skipped\n';
  assert.deepEqual(extractCompactInstructions(md), ['one', 'two']);
  assert.deepEqual(extractCompactInstructions(''), []);
});

test('buildRegistry reads Key Decisions, On Compact and CLAUDE.md compact instructions with sources', () => {
  const sections = parseSessionContext('## Key Decisions\n- Never rewrite earlier turns\n\n## On Compact\nPRESERVE: the pruner floor is 50000\n');
  const claudeMd = '# Compact instructions\n- Keep the test matrix green on Node 20 and 22\n\n# Other\n- ignored\n';
  const reg = buildRegistry({ sections, claudeMdText: claudeMd });
  assert.equal(reg.items.length, 3); assert.equal(reg.truncated, false);
  assert.deepEqual(reg.items.map((i) => i.source), ['compact-instructions', 'on-compact', 'key-decisions']);
  assert.deepEqual(reg.sources, ['compact-instructions', 'on-compact', 'key-decisions']);
  assert.equal(reg.items[1].text, 'the pruner floor is 50000');
});

test('buildRegistry caps at 25 items and 200 chars per item and flags truncation', () => {
  const sections = parseSessionContext('## Key Decisions\n' + [...Array(30)].map((_, i) => `- rule ${i} ${'x'.repeat(300)}`).join('\n'));
  const reg = buildRegistry({ sections, claudeMdText: '' });
  assert.equal(reg.items.length, 25); assert.equal(reg.truncated, true); assert.ok(reg.items.every((i) => i.text.length <= 200));
});

test('buildRegistry tolerates empty inputs', () => {
  assert.deepEqual(buildRegistry({}), { items: [], truncated: false, sources: [] });
});

test('renderRegistryBlock emits typed lines under the heading and stays under 3000 chars', () => {
  const out = renderRegistryBlock(sampleRegistry());
  assert.match(out, /^\n## CONSTRAINT REGISTRY \(must survive compaction\)\n/);
  assert.match(out, /- \[Action\] Never rewrite earlier turns/);
  assert.ok(out.length <= 3000); assert.equal(renderRegistryBlock({ items: [], truncated: false, sources: [] }), '');
  const big = { items: [...Array(25)].map(() => ({ type: 'Action', text: 'y'.repeat(200), source: 'key-decisions' })), truncated: false, sources: [] };
  assert.ok(renderRegistryBlock(big).length <= 3000);
});

test('retentionOf matches normalized substrings and >=60% word overlap', () => {
  const items = [{ type: 'Action', text: 'Never rewrite earlier transcript turns' }, { type: 'Process', text: 'Run npm test before every commit' }, { type: 'Information', text: 'Pruner floor is fifty thousand chars' }];
  const summary = 'The plugin must NEVER   rewrite earlier transcript turns. Before each commit the tests (npm test) are run.';
  assert.deepEqual(retentionOf(items, summary), { total: 3, retained: 2, ratio: 0.67, missing: ['Pruner floor is fifty thousand chars'] });
  assert.deepEqual(retentionOf([], 'x'), { total: 0, retained: 0, ratio: 0, missing: [] });
});

test('write/readRegistryState round-trips under a sandboxed ~/.claude/state', () => {
  const home = fs.mkdtempSync(path.join(require('os').tmpdir(), 'si-constraints-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const sid = 'sess-1';
    const file = registryStatePath(sid);
    assert.match(file, /claude-constraints-sess-1\.json$/);
    assert.ok(file.startsWith(path.join(home, '.claude', 'state')));
    assert.equal(readRegistryState(sid), null);
    const data = { t: 123, items: [{ type: 'Action', text: 'Never x', source: 'key-decisions' }] };
    assert.equal(writeRegistryState(sid, data), true);
    assert.deepEqual(readRegistryState(sid), data);
    fs.writeFileSync(file, '{bad');
    assert.equal(readRegistryState(sid), null);
    assert.equal(registryStatePath('../evil'), null);
  } finally {
    process.env.HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('fitRegistryToCap keeps only whole items in priority order and flags truncation', () => {
  const items = [...Array(25)].map((_, i) => ({ type: 'Action', text: `${String(i).padStart(2, '0')} ${'y'.repeat(197)}`, source: 'key-decisions' }));
  const reg = { items, truncated: false, sources: ['key-decisions'] };
  const fitted = fitRegistryToCap(reg);
  assert.notEqual(fitted, reg);
  assert.equal(reg.items.length, 25);
  assert.ok(fitted.items.length < 25 && fitted.items.length > 0);
  assert.equal(fitted.truncated, true);
  assert.deepEqual(fitted.items, items.slice(0, fitted.items.length));
  const out = renderRegistryBlock(fitted);
  assert.ok(out.length <= 3000);
  assert.equal(out.split('\n- [').length - 1, fitted.items.length);
  const dropped = items.slice(fitted.items.length);
  const { missing } = retentionOf(fitted.items, 'nothing relevant');
  for (const d of dropped) assert.ok(!missing.includes(d.text));
  const small = fitRegistryToCap({ items: items.slice(0, 2), truncated: false, sources: [] });
  assert.equal(small.truncated, false);
  assert.equal(small.items.length, 2);
});

test('buildRegistry prioritises compact instructions, then On Compact, then Key Decisions', () => {
  const sections = parseSessionContext('## Key Decisions\n- kd\n\n## On Compact\nPRESERVE: oc\n');
  const reg = buildRegistry({ sections, claudeMdText: '# Compact instructions\n- ci\n' });
  assert.deepEqual(reg.items.map((i) => i.text), ['ci', 'oc', 'kd']);
});

test('section parsing accepts prose Key: value, numbered items, and skips drop lines', () => {
  const sections = parseSessionContext('## Key Decisions\nRuling: never rewrite earlier turns\n1. Pin the floor at 50000\n2) Use rsync\n- Safe to drop: old notes\nDROP: scratch\nplain prose rule\n\n## On Compact\nPRESERVE: keep me\nSafe to drop: gone\n');
  const texts = buildRegistry({ sections }).items.map((i) => i.text);
  assert.deepEqual(texts, ['keep me', 'never rewrite earlier turns', 'Pin the floor at 50000', 'Use rsync', 'plain prose rule']);
});

test('buildRegistry de-duplicates case-insensitively', () => {
  const sections = parseSessionContext('## Key Decisions\n- Never X\n- never x\n');
  assert.equal(buildRegistry({ sections }).items.length, 1);
});

test('retentionOf handles empty summaries and ignores stop words and partial-word hits', () => {
  const items = [{ type: 'Action', text: 'Never rewrite turns' }];
  assert.deepEqual(retentionOf(items, ''), { total: 1, retained: 0, ratio: 0, missing: ['Never rewrite turns'] });
  assert.deepEqual(retentionOf(items, null).retained, 0);
  // stop words are not evidence: old substring rule counted with/that/from/this/into
  const stop = [{ type: 'Information', text: 'Verify cache with that from this into' }];
  assert.equal(retentionOf(stop, 'with that from this into long prose').retained, 0);
  // whole-word match: "latest" is not "test"
  const proc = [{ type: 'Process', text: 'run tests before commit' }];
  assert.equal(retentionOf(proc, 'the latest build before shipping').retained, 0);
  assert.equal(retentionOf(proc, 'tests run before the commit').retained, 1);
  // a long summary of generic words does not inflate
  const eval_ = [{ type: 'Action', text: 'Never use eval with user input' }];
  assert.equal(retentionOf(eval_, 'with that this from into prose').retained, 0);
});
