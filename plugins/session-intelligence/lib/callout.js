'use strict';
/**
 * Pure formatting for the model-visible zone callout numbers segment.
 * Fill is bucketed and the distance to auto-compaction is floored to a
 * 50K-token bucket so the text is stable across many consecutive calls.
 */
const { bucketPct, windowLabel } = require('./context-cap');

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

function largeResultsLine(count) {
  return count > 0 ? `${count} tool results ≥20K tokens in the last 40 calls.` : '';
}

module.exports = { numbersSegment, largeResultsLine, AWAY_BUCKET_TOKENS };
