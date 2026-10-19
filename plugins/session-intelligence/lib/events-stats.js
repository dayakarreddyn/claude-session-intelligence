/**
 * Session Intelligence — events DB read-side aggregation.
 *
 * Extracted from lib/events.js. Takes an open db handle; never requires
 * lib/events.js (no circular dependency).
 */

'use strict';

function aggregateStats(db, { sinceDays = 30, project = null } = {}) {
  if (!db) return null;
  try {
    const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
    const projectClause = project ? 'AND project = ?' : '';
    const projectArgs = project ? [project] : [];

    const sessions = db.prepare(`
      SELECT COUNT(*) AS n, SUM(total_cost_usd) AS cost,
             AVG(peak_tokens) AS avg_peak, MAX(peak_tokens) AS max_peak,
             AVG(total_cost_usd) AS avg_cost, SUM(tool_calls) AS tool_calls
      FROM sessions WHERE started_at >= ? ${projectClause}
    `).get(cutoff, ...projectArgs);

    const compacts = db.prepare(`
      SELECT COUNT(*) AS n, AVG(tokens) AS avg_tokens, AVG(cost) AS avg_cost,
             SUM(cost) AS total_cost, SUM(had_shift) AS shifts,
             MIN(tokens) AS min_tokens, MAX(tokens) AS max_tokens
      FROM compacts WHERE t >= ? ${projectClause}
    `).get(cutoff, ...projectArgs);

    // Sorted token list → compute p50/p90 in JS (SQLite has no native percentile).
    const compactTokens = db.prepare(`
      SELECT tokens FROM compacts
      WHERE t >= ? ${projectClause} AND tokens IS NOT NULL
      ORDER BY tokens ASC
    `).all(cutoff, ...projectArgs).map((r) => r.tokens);
    const pct = (arr, p) => {
      if (!arr.length) return null;
      const i = Math.min(arr.length - 1, Math.floor(arr.length * p));
      return arr[i];
    };
    const compactPercentiles = {
      p50: pct(compactTokens, 0.5),
      p90: pct(compactTokens, 0.9),
    };

    const zones = db.prepare(`
      SELECT to_zone AS zone, COUNT(*) AS n
      FROM zone_transitions WHERE t >= ? ${projectClause}
      GROUP BY to_zone ORDER BY n DESC
    `).all(cutoff, ...projectArgs);

    const archives = db.prepare(`
      SELECT COUNT(*) AS n, SUM(recalled) AS recalled, SUM(chars) AS bytes
      FROM tool_archives WHERE t >= ?
        ${project ? 'AND sid IN (SELECT sid FROM sessions WHERE project = ?)' : ''}
    `).get(cutoff, ...projectArgs);

    // Agent (Task tool / subagent) usage. Aggregate totals + top-N by type.
    const agentProjectClause = project
      ? 'AND sid IN (SELECT sid FROM sessions WHERE project = ?)' : '';
    const agents = db.prepare(`
      SELECT COUNT(*) AS n,
             SUM(is_error) AS errors,
             AVG(duration_ms) AS avg_ms,
             SUM(duration_ms) AS total_ms,
             SUM(prompt_chars) AS prompt_chars,
             SUM(response_chars) AS response_chars,
             SUM(input_tokens) AS input_tokens,
             SUM(output_tokens) AS output_tokens,
             SUM(cache_creation_tokens) AS cache_creation_tokens,
             SUM(cache_read_tokens) AS cache_read_tokens,
             SUM(cost_usd) AS cost_usd
      FROM agent_invocations WHERE t >= ? ${agentProjectClause}
    `).get(cutoff, ...projectArgs);
    const agentTypes = db.prepare(`
      SELECT subagent_type AS type, COUNT(*) AS n,
             AVG(duration_ms) AS avg_ms,
             SUM(is_error) AS errors,
             SUM(input_tokens) AS input_tokens,
             SUM(output_tokens) AS output_tokens,
             SUM(cost_usd) AS cost_usd
      FROM agent_invocations
      WHERE t >= ? ${agentProjectClause} AND subagent_type IS NOT NULL
      GROUP BY subagent_type ORDER BY cost_usd DESC NULLS LAST, n DESC LIMIT 10
    `).all(cutoff, ...projectArgs);

    // Per-day series (cost + sessions + compacts). Local-day bucketed.
    // Day key: "YYYY-MM-DD" — small integer-ish key, easy to sort/render.
    const dayKey = (ms) => {
      const d = new Date(ms);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };
    // ISO-ish week key "YYYY-Www" using Monday as week start. Computed by
    // shifting each date back to its Monday and using that day's date as the
    // week label (avoids cross-year ISO-week edge-case complexity for our
    // purposes — we only need stable bucketing within ~1y).
    const weekKey = (ms) => {
      const d = new Date(ms);
      d.setHours(0, 0, 0, 0);
      const dow = (d.getDay() + 6) % 7; // Mon=0..Sun=6
      d.setDate(d.getDate() - dow);
      return dayKey(d.getTime());
    };
    const byDay = new Map();
    const byWeek = new Map();
    const ensureDay = (k) => {
      if (!byDay.has(k)) byDay.set(k, { day: k, cost: 0, sessions: 0, compacts: 0 });
      return byDay.get(k);
    };
    const ensureWeek = (k) => {
      if (!byWeek.has(k)) byWeek.set(k, { week: k, cost: 0, sessions: 0, compacts: 0 });
      return byWeek.get(k);
    };
    const sessionRows = db.prepare(`
      SELECT started_at AS t, total_cost_usd AS cost
      FROM sessions WHERE started_at >= ? ${projectClause}
    `).all(cutoff, ...projectArgs);
    for (const r of sessionRows) {
      const d = ensureDay(dayKey(r.t));
      d.sessions += 1;
      if (Number.isFinite(r.cost)) d.cost += r.cost;
      const w = ensureWeek(weekKey(r.t));
      w.sessions += 1;
      if (Number.isFinite(r.cost)) w.cost += r.cost;
    }
    const compactRows = db.prepare(`
      SELECT t, cost FROM compacts WHERE t >= ? ${projectClause}
    `).all(cutoff, ...projectArgs);
    for (const r of compactRows) {
      const d = ensureDay(dayKey(r.t));
      d.compacts += 1;
      const w = ensureWeek(weekKey(r.t));
      w.compacts += 1;
      // compact cost is already counted in session totals — don't double-add
    }
    // Fill day calendar gaps so the sparkline is honest about idle days.
    // Each entry also carries its share of the window's total spend.
    const totalCostInWindow = sessionRows.reduce(
      (s, r) => s + (Number.isFinite(r.cost) ? r.cost : 0), 0);
    const dailySeries = [];
    const now = new Date();
    for (let i = sinceDays - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const k = dayKey(d.getTime());
      const entry = byDay.get(k) || { day: k, cost: 0, sessions: 0, compacts: 0 };
      entry.pct = totalCostInWindow > 0 ? entry.cost / totalCostInWindow : 0;
      dailySeries.push(entry);
    }
    // Fill week gaps for the same window. Iterate forward from the Monday on
    // or before the cutoff so the bucket alignment is stable across runs.
    const weeklySeries = [];
    const cutoffMonday = (() => {
      const d = new Date(cutoff);
      d.setHours(0, 0, 0, 0);
      const dow = (d.getDay() + 6) % 7;
      d.setDate(d.getDate() - dow);
      return d;
    })();
    for (let cursor = new Date(cutoffMonday); cursor.getTime() <= now.getTime(); cursor.setDate(cursor.getDate() + 7)) {
      const k = weekKey(cursor.getTime());
      const entry = byWeek.get(k) || { week: k, cost: 0, sessions: 0, compacts: 0 };
      entry.pct = totalCostInWindow > 0 ? entry.cost / totalCostInWindow : 0;
      weeklySeries.push(entry);
    }
    // Week-over-week delta on cost (current vs prior). Prior of the very
    // first bucket is undefined → null, rendered as "—".
    for (let i = 0; i < weeklySeries.length; i++) {
      const prev = i > 0 ? weeklySeries[i - 1].cost : null;
      const cur = weeklySeries[i].cost;
      weeklySeries[i].wow = (prev === null || prev <= 0)
        ? null
        : (cur - prev) / prev;
    }

    // Per-project enrichment: sessions, cost, compacts, red-zone count, archive stats.
    // Joins through sid (not project name) because compacts/zone_transitions
    // historically stored the encoded directory slug while sessions store the
    // basename — direct project=project comparisons never matched.
    const perProject = project ? null : db.prepare(`
      SELECT s.project AS project,
             COUNT(DISTINCT s.sid) AS sessions,
             SUM(s.total_cost_usd) AS cost,
             AVG(s.peak_tokens)    AS avg_peak,
             (SELECT COUNT(*) FROM compacts c
                WHERE c.sid IN (SELECT sid FROM sessions WHERE project = s.project)
                  AND c.t >= ?) AS compacts,
             (SELECT COUNT(*) FROM zone_transitions z
                WHERE z.sid IN (SELECT sid FROM sessions WHERE project = s.project)
                  AND z.t >= ? AND z.to_zone = 'red') AS reds,
             (SELECT COUNT(*) FROM zone_transitions z
                WHERE z.sid IN (SELECT sid FROM sessions WHERE project = s.project)
                  AND z.t >= ?) AS crossings,
             (SELECT COUNT(*) FROM tool_archives ta
                WHERE ta.sid IN (SELECT sid FROM sessions WHERE project = s.project)
                  AND ta.t >= ?) AS archives,
             (SELECT SUM(recalled) FROM tool_archives ta
                WHERE ta.sid IN (SELECT sid FROM sessions WHERE project = s.project)
                  AND ta.t >= ?) AS archives_recalled
      FROM sessions s
      WHERE s.started_at >= ? AND s.project IS NOT NULL
      GROUP BY s.project ORDER BY cost DESC NULLS LAST, sessions DESC LIMIT 10
    `).all(cutoff, cutoff, cutoff, cutoff, cutoff, cutoff);

    // Recent compacts — same shape as listRecentCompacts but capped + project-scoped.
    const recentCompacts = db.prepare(`
      SELECT sid, project, t, tokens, cost, had_shift, trigger
      FROM compacts WHERE t >= ? ${projectClause}
      ORDER BY t DESC LIMIT 8
    `).all(cutoff, ...projectArgs);

    return {
      sessions, compacts, compactPercentiles, zones, archives,
      agents, agentTypes,
      topProjects: perProject, perProject, dailySeries, weeklySeries, recentCompacts,
      sinceDays, project,
    };
  } catch { return null; }
}

function listRecentCompacts(db, { limit = 20, project = null } = {}) {
  if (!db) return [];
  try {
    const projectClause = project ? 'WHERE project = ?' : '';
    const args = project ? [project, limit] : [limit];
    return db.prepare(`
      SELECT sid, project, t, tokens, cost, cost_at_compact, had_shift, trigger
      FROM compacts ${projectClause}
      ORDER BY t DESC LIMIT ?
    `).all(...args);
  } catch { return []; }
}

module.exports = { aggregateStats, listRecentCompacts };
