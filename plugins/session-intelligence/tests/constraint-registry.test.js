const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseSessionContext } = require('../lib/session-context');
const {
  CONSTRAINT_TYPES, classifyConstraint, extractCompactInstructions, buildRegistry,
  renderRegistryBlock, registryStatePath, writeRegistryState, readRegistryState, retentionOf,
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
  assert.deepEqual(reg.items.map((i) => i.source), ['key-decisions', 'on-compact', 'compact-instructions']);
  assert.deepEqual(reg.sources, ['key-decisions', 'on-compact', 'compact-instructions']);
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

test('write/readRegistryState round-trips under ~/.claude/state', () => {
  const sid = `t13-${process.pid}-${Date.now()}`;
  const file = registryStatePath(sid);
  try {
    assert.match(file, /claude-constraints-.*\.json$/);
    assert.ok(file.includes(path.join('.claude', 'state')));
    assert.equal(readRegistryState(sid), null);
    const data = { t: 123, items: [{ type: 'Action', text: 'Never x', source: 'key-decisions' }] };
    writeRegistryState(sid, data);
    assert.deepEqual(readRegistryState(sid), data);
    fs.writeFileSync(file, '{bad');
    assert.equal(readRegistryState(sid), null);
  } finally {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
  assert.equal(registryStatePath('../evil'), null);
});
