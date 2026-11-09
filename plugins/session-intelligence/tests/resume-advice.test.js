/** Unit tests for the cold-resume advice line. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildResumeCacheContext } = require('../lib/resume-advice');

test('buildResumeCacheContext advises /clear on a cold resume', () => {
  const out = buildResumeCacheContext({ source: 'resume', seconds_since_last_response: 5400, context_tokens: 480000, prompt_cache_likely_expired: true, estimated_cache_write_usd: 6.25 });
  assert.equal(out, 'Resume notice: 90 min since the last response; the prompt cache has likely expired (estimated rebuild $6.25). If the previous topic is finished, `/clear` costs nothing; `/compact` on a cold resume re-reads the whole prefix at the cache-write rate.');
});

test('buildResumeCacheContext also fires on fork', () => {
  const out = buildResumeCacheContext({ source: 'fork', seconds_since_last_response: 3600, prompt_cache_likely_expired: true, estimated_cache_write_usd: 1 });
  assert.match(out, /^Resume notice: 60 min since the last response/);
});

test('buildResumeCacheContext is silent for startup/compact/clear sources and warm resumes', () => {
  assert.equal(buildResumeCacheContext({ source: 'startup' }), '');
  assert.equal(buildResumeCacheContext({ source: 'resume', prompt_cache_likely_expired: false, seconds_since_last_response: 30 }), '');
  assert.equal(buildResumeCacheContext({ source: 'compact', prompt_cache_likely_expired: true }), '');
  assert.equal(buildResumeCacheContext({ source: 'clear', prompt_cache_likely_expired: true }), '');
  assert.equal(buildResumeCacheContext(null), '');
  assert.equal(buildResumeCacheContext(undefined), '');
});

test('buildResumeCacheContext tolerates missing numeric fields', () => {
  const out = buildResumeCacheContext({ source: 'resume', prompt_cache_likely_expired: true });
  assert.ok(out.startsWith('Resume notice: '));
  assert.ok(!out.includes('NaN') && !out.includes('undefined'), out);
});
