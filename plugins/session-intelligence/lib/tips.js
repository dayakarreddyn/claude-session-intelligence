/**
 * Zone- and compact-keyed tip rotator.
 *
 * Tips are deterministic per (sessionId, zone, day) so the same session
 * sees a consistent tip within a day but different sessions — or the same
 * session tomorrow — see a different one. That avoids banner fatigue
 * without making the output flicker between tool calls.
 *
 * Keep pools short. The callout already carries a headline + diagnosis +
 * memory-offload nudge; the tip is the "one more thing you could do"
 * cherry on top, not another paragraph.
 */

'use strict';

const TIP_POOLS = {
  yellow: [
    'write an insight to `memory/reference_<slug>.md` before it collapses in /compact.',
    'update `session-context.md` PRESERVE/DROP lines now — they steer the next compact.',
    '`/compact preserve <topic>, drop <topic>` beats a bare `/compact` for keeping signal.',
  ],
  orange: [
    'delegate the next wide grep/read to a subagent — keep the conclusion, not the output.',
    'commit in-flight work now; a clean tree survives /compact without needing to be re-described.',
    'offload non-obvious findings to `memory/` before they collapse — the pre-compact block is a safety net, not the primary capture surface.',
  ],
  red: [
    '`/compact preserve <current task>, drop <finished work>` — explicit hints beat the auto-summary at this size.',
    'use `/si expand <tool_use_id>` after compact to replay any large Read/Bash output you still need.',
    'if the current topic is done, `/clear` + a short handoff note is cheaper than another /compact.',
  ],
  compact: [
    'after compact: if a tool result gets summarised away, `/si expand <tool_use_id>` replays the archived body.',
    'after compact: `/si archive-list` shows every oversized tool response saved this session.',
    'after compact: the resume banner reads `memory/MEMORY.md` + `session-context.md` — keep those up to date and the next boot is cheap.',
  ],
};

function hashString(s) {
  // Tiny FNV-1a 32-bit — no crypto needed, just a stable shuffle.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h;
}

/**
 * Pick a tip for the given zone. Returns null when the zone has no pool,
 * so callers can skip the line rather than print an empty "Tip: ".
 *
 * @param {'yellow'|'orange'|'red'|'compact'} zone
 * @param {string} [salt] — usually sessionId. Anything stable within a
 *   session and varied across sessions works. Empty string is accepted
 *   (pool[0] is chosen — better than crashing).
 * @param {{day?: string}} [opts] — injectable "today" for tests.
 * @returns {string|null}
 */
function pickTip(zone, salt, opts = {}) {
  const pool = TIP_POOLS[zone];
  if (!Array.isArray(pool) || pool.length === 0) return null;
  const day = opts.day || new Date().toISOString().slice(0, 10);
  const key = `${salt || ''}|${zone}|${day}`;
  const idx = hashString(key) % pool.length;
  return pool[idx];
}

module.exports = { pickTip, TIP_POOLS };
