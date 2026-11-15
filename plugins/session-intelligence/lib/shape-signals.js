/**
 * Session Intelligence — window signals over shape-log entries.
 *
 * Pure functions over the last `window` entries: duplicate Reads, same-input
 * re-runs, oversized results, Agent returns. Kept out of context-shape.js to
 * hold that file's size down. Entries are never mutated.
 */

'use strict';

const SIGNAL_WINDOW = 40;
const RERUN_GAP_CALLS = 20;
const LARGE_RESULT_CHARS = 60000;
const CHARS_PER_TOKEN = 3;
const AGENT_RETURNS_MIN_CHARS = 20000;
const MAX_PHRASE_FILES = 2;

function lastWindow(entries, window) {
  if (!Array.isArray(entries)) return [];
  const n = Number.isFinite(window) && window > 0 ? window : SIGNAL_WINDOW;
  return entries.slice(-n).filter((e) => e && typeof e === 'object');
}

const charsOf = (e) => (Number.isFinite(e.chars) ? e.chars : 0);

function detectReads(recent) {
  const byFile = new Map();
  for (const e of recent) {
    if (e.tool !== 'Read' || !e.file) continue;
    const prev = byFile.get(e.file) || { file: e.file, count: 0, chars: 0 };
    byFile.set(e.file, { ...prev, count: prev.count + 1, chars: prev.chars + charsOf(e) });
  }
  return [...byFile.values()]
    .filter((r) => r.count >= 2)
    .sort((a, b) => b.chars - a.chars || b.count - a.count);
}

function detectReruns(recent, rerunGap) {
  const byKey = new Map();
  recent.forEach((e, i) => {
    if (!e.inputHash) return;
    const key = `${e.tool}\n${e.inputHash}`;
    const prev = byKey.get(key) || { tool: e.tool, inputHash: e.inputHash, count: 1, gapCalls: 0, lastIdx: i };
    const gap = i - prev.lastIdx;
    const hit = prev.lastIdx !== i && gap <= rerunGap;
    byKey.set(key, hit
      ? { ...prev, count: prev.count + 1, gapCalls: gap, lastIdx: i }
      : { ...prev, lastIdx: i });
  });
  return [...byKey.values()]
    .filter((r) => r.count >= 2)
    .map(({ tool, inputHash, count, gapCalls }) => ({ tool, inputHash, count, gapCalls }));
}

function detectDuplicates(entries, { window = SIGNAL_WINDOW, rerunGap = RERUN_GAP_CALLS } = {}) {
  const recent = lastWindow(entries, window);
  return { reads: detectReads(recent), reruns: detectReruns(recent, rerunGap) };
}

/** The rerun described by the newest entry (gap to its previous occurrence), or null. */
function newestRerun(entries, { window = SIGNAL_WINDOW, rerunGap = RERUN_GAP_CALLS } = {}) {
  const recent = lastWindow(entries, window);
  const last = recent[recent.length - 1];
  if (!last || !last.inputHash) return null;
  for (let i = recent.length - 2; i >= 0; i--) {
    const e = recent[i];
    if (e.tool !== last.tool || e.inputHash !== last.inputHash) continue;
    const gap = recent.length - 1 - i;
    return gap <= rerunGap ? { tool: last.tool, inputHash: last.inputHash, gapCalls: gap } : null;
  }
  return null;
}

function countLargeResults(entries, { window = SIGNAL_WINDOW, minChars = LARGE_RESULT_CHARS } = {}) {
  return lastWindow(entries, window).filter((e) => charsOf(e) >= minChars).length;
}

function agentReturns(entries, { window = SIGNAL_WINDOW } = {}) {
  return lastWindow(entries, window)
    .filter((e) => e.tool === 'Agent')
    .reduce((acc, e) => ({ count: acc.count + 1, chars: acc.chars + charsOf(e) }), { count: 0, chars: 0 });
}

function largeReadDelegationLine(n) {
  return `Large results detected: ${n} tool results ≥20K tokens in the last 40 calls. Delegate the next wide read/grep to a subagent (frontmatter \`autoCompactWindow: 400000\`) and keep the conclusion, not the output.`;
}

const tokensK = (chars) => `~${Math.round(chars / CHARS_PER_TOKEN / 1000)}k tokens`;

function duplicateReadsPhrase(duplicates) {
  const reads = (duplicates && duplicates.reads) || [];
  if (!reads.length) return '';
  const items = reads.slice(0, MAX_PHRASE_FILES).map((r) => `${r.file} ×${r.count} (${tokensK(r.chars)})`);
  return `dup reads: ${items.join(', ')}`;
}

function renderDuplicateReadsBlock(duplicates, { stablePrefix } = {}) {
  const reads = (duplicates && duplicates.reads) || [];
  if (!reads.length) return '';
  const lines = reads.map((r) => (stablePrefix
    ? `- ${r.file} ×${r.count}`
    : `- ${r.file} ×${r.count} (${tokensK(r.chars)})`));
  return ['', '**Duplicate reads (drop all but the latest):**', ...lines].join('\n');
}

function agentReturnsPhrase(returns) {
  if (!returns || !(returns.chars >= AGENT_RETURNS_MIN_CHARS)) return '';
  return `agents: ${returns.count} returns ${tokensK(returns.chars)}`;
}

module.exports = {
  SIGNAL_WINDOW, RERUN_GAP_CALLS, LARGE_RESULT_CHARS, CHARS_PER_TOKEN,
  detectDuplicates, newestRerun, countLargeResults, agentReturns, largeReadDelegationLine,
  duplicateReadsPhrase, renderDuplicateReadsBlock, agentReturnsPhrase,
};
