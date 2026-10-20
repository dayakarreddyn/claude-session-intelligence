'use strict';
/**
 * Pure formatting for the model-visible zone callout numbers segment.
 * Fill is bucketed and the distance to auto-compaction is floored to a
 * 50K-token bucket so the text is stable across many consecutive calls.
 */
const { bucketPct, windowLabel } = require('./context-cap');
const { largeReadDelegationLine } = require('./shape-signals');

const AWAY_BUCKET_TOKENS = 50000;

function formatK(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** @returns {string} e.g. ' — context at ~45% of a 1M window; auto-compaction at ~967k (~450k away)' */
function numbersSegment({ fillPct, cap, point, contextTokens, bucketStep }) {
  const pct = bucketPct(fillPct, bucketStep > 0 ? bucketStep : undefined);
  const away = Math.max(0, Math.floor((point - contextTokens) / AWAY_BUCKET_TOKENS) * AWAY_BUCKET_TOKENS);
  return ` — context at ~${pct}% of a ${windowLabel(cap)} window; auto-compaction at ~${formatK(point)} (~${formatK(away)} away)`;
}

const DELEGATION_MIN_RESULTS = 3;

function largeResultsLine(count) {
  if (count >= DELEGATION_MIN_RESULTS) return largeReadDelegationLine(count);
  return count > 0 ? `${count} tool results ≥20K tokens in the last 40 calls.` : '';
}

const PHASE_RECENCY_ENTRIES = 5;

/** Boundary line when the newest phase marker is within the last 5 shape entries, else ''. */
function phaseBoundaryLine(entries) {
  const recent = (Array.isArray(entries) ? entries : []).slice(-PHASE_RECENCY_ENTRIES);
  const hit = [...recent].reverse().find((e) => e && e.event);
  return hit
    ? `A ${hit.event} just landed — natural compaction boundary; \`/compact\` now carries the least in-flight state.`
    : '';
}

/** Task-change hint tail for a domain shift that recommends /clear. */
function clearHandoffHint(wroteHandoff, constraintCount) {
  if (!wroteHandoff) return 'Consider `/clear` before heavy new work.';
  const n = constraintCount > 0 ? ` and ${constraintCount} constraint${constraintCount === 1 ? '' : 's'}` : '';
  return `Consider \`/clear\` with a fresh handoff — SI just saved the current task${n}, restored on the next session start.`;
}

module.exports = {
  numbersSegment, largeResultsLine, phaseBoundaryLine, clearHandoffHint, AWAY_BUCKET_TOKENS,
};
