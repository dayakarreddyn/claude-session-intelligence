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

const { formatCompactionHints, STALENESS_MS } = require('../hooks/si-pre-compact');

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
  assert.match(out, /5 day\(s\) old/);
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
  assert.match(out, /of unknown age/);
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
