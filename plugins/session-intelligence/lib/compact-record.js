/**
 * Pure builder for the three artifacts a compaction leaves behind: the
 * compact-history entry, the events-DB row and the post-compact regret
 * snapshot. Every `tokens` field is the per-call `contextTokens` of the latest
 * assistant usage block. The cumulative chars/token tool-I/O estimate survives
 * only as `toolIoEstimate` on the history entry (a tool-I/O share diagnostic,
 * never context size). All returned objects are new; inputs are not mutated.
 */

const { fillPctOf } = require('./context-cap');

const COST_DECIMALS = 4;

function mapRoots(list) {
  return Array.isArray(list) ? list.map((x) => x.root) : [];
}

function lastEstimate(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return 0;
  return entries[entries.length - 1].tok || 0;
}

/**
 * @returns {{ historyEntry: object, dbRow: object, snapshot: object }}
 *   dbRow is the recordCompact argument minus `project` (caller adds it).
 */
function buildCompactRecord({ latest, cap, entries, trigger, cwd, sessionId, cost, costAtCompactUsd, analysis }) {
  const contextTokens = latest && latest.contextTokens > 0 ? latest.contextTokens : 0;
  const fillPct = fillPctOf(contextTokens, cap);
  const model = (latest && latest.model) || null;
  const hotDirs = mapRoots(analysis && analysis.hot);
  const warmDirs = mapRoots(analysis && analysis.warm);
  const droppedDirs = mapRoots(analysis && analysis.cold);
  const t = Date.now();
  const roundedCost = Number((Number(cost) || 0).toFixed(COST_DECIMALS));
  const hasCostAt = costAtCompactUsd !== null && costAtCompactUsd !== undefined;

  const historyEntry = {
    t,
    sid: sessionId,
    cwd,
    tokens: contextTokens,
    contextTokens,
    contextCap: cap,
    fillPct,
    model,
    trigger: trigger || null,
    toolIoEstimate: lastEstimate(entries),
    cost: roundedCost,
    hotDirs: [...hotDirs],
    warmDirs: [...warmDirs],
    droppedDirs: [...droppedDirs],
    hadShift: !!(analysis && analysis.shift),
    regretCount: 0, // upgraded later when the snapshot window closes
    ...(hasCostAt ? { costAtCompactUsd } : {}),
  };

  const dbRow = {
    sid: sessionId,
    cwd,
    t,
    tokens: contextTokens,
    cost: roundedCost,
    costAtCompactUsd: hasCostAt ? costAtCompactUsd : null,
    hotDirs: [...hotDirs],
    warmDirs: [...warmDirs],
    droppedDirs: [...droppedDirs],
    hadShift: historyEntry.hadShift,
    trigger: historyEntry.trigger,
    contextCap: cap,
    fillPct,
    model,
  };

  const snapshot = {
    t,
    tokens: contextTokens,
    contextCap: cap,
    fillPct,
    cost: roundedCost,
    hotDirs: [...hotDirs],
    warmDirs: [...warmDirs],
    droppedDirs: [...droppedDirs],
    callsSince: 0,
    regretHits: [],
    softRegretHits: [],
    positiveHits: [],
  };

  return { historyEntry, dbRow, snapshot };
}

module.exports = { buildCompactRecord };
