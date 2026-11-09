/**
 * Guards on .github/workflows/test.yml — the GitHub Actions job that gates PRs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..', '..');
const WORKFLOW = path.join(REPO, '.github', 'workflows', 'test.yml');

test('every setup-node cache-dependency-path in the test workflow is a git-tracked file', (t) => {
  // setup-node resolves cache-dependency-path with a glob over the checkout.
  // A path that is gitignored exists locally but not in CI, and the step
  // aborts with "Some specified paths were not resolved, unable to cache
  // dependencies" before npm ci ever runs. Every CI run before this guard
  // existed failed that way.
  if (!fs.existsSync(path.join(REPO, '.git')) || !fs.existsSync(WORKFLOW)) return t.skip('not a git checkout');
  const yml = fs.readFileSync(WORKFLOW, 'utf8');
  const declared = [...yml.matchAll(/cache-dependency-path:\s*(\S+)/g)].map((m) => m[1].replace(/^['"]|['"]$/g, ''));
  assert.ok(declared.length > 0, 'workflow declares no cache-dependency-path');
  const tracked = execFileSync('git', ['ls-files', '--', ...declared], { cwd: REPO, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  for (const p of declared) {
    assert.ok(tracked.includes(p), `${p} is not tracked by git; setup-node cannot resolve it in CI`);
  }
});
