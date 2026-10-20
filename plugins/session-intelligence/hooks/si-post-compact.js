#!/usr/bin/env node
/**
 * Session Intelligence — PostCompact hook (Claude Code >= 2.1.76).
 *
 * Pure telemetry: PostCompact has no decision control and cannot affect the
 * compaction result. Reads `trigger` + `compact_summary`, scores how many of
 * the constraint-registry items written at PreCompact survive in the summary,
 * and records one `compact_outcomes` row. Writes nothing to stdout and exits
 * 0 on every path.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SI_LIB = path.join(__dirname, '..', 'lib');

function intelLog(...args) {
  try { require(path.join(SI_LIB, 'intel-debug')).intelLog(...args); } catch { /* best-effort */ }
}

function readStdinJson() {
  try {
    const parsed = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function finiteOrNull(n) { return Number.isFinite(n) ? n : null; }

function main() {
  const input = readStdinJson();
  const sid = input.session_id || process.env.CLAUDE_SESSION_ID;
  if (!sid || typeof input.compact_summary !== 'string') {
    intelLog('post-compact', 'debug', 'nothing to record', { hasSid: Boolean(sid) });
    return;
  }
  const summary = input.compact_summary;

  const registry = require(path.join(SI_LIB, 'constraint-registry'));
  const state = registry.readRegistryState(sid);
  const items = state && Array.isArray(state.items) ? state.items : null;
  const result = items ? registry.retentionOf(items, summary) : null;

  let project = null;
  try { project = require(path.join(SI_LIB, 'context-shape')).projectKeyOf(input.cwd); } catch { /* optional */ }

  const trigger = input.trigger || (state && state.trigger) || null;
  const recorded = require(path.join(SI_LIB, 'events')).recordCompactOutcome({
    sid, project, t: Date.now(),
    compactT: state ? finiteOrNull(state.t) : null,
    trigger,
    summaryChars: summary.length,
    constraintsTotal: result ? result.total : null,
    constraintsRetained: result ? result.retained : null,
    retention: result ? result.ratio : null,
    missing: result ? result.missing : null,
    fillBefore: state ? finiteOrNull(state.fillPct) : null,
    contextCap: state ? finiteOrNull(state.contextCap) : null,
    model: (state && state.model) || null,
  });
  intelLog('post-compact', 'info', 'recorded', {
    recorded, retention: result ? result.ratio : null, summaryChars: summary.length, trigger,
  });
}

try { main(); } catch (err) {
  intelLog('post-compact', 'error', 'hook failed', { err: err && err.message });
}
process.exit(0);
