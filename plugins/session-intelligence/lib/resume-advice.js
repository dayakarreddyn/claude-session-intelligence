/**
 * Cold-resume advice from the SessionStart payload.
 *
 * On `resume`/`fork` Claude Code reports how long the session sat idle and
 * whether the prompt cache has likely expired. A `/compact` on a cold resume
 * re-writes the whole prefix at the cache-write rate, while `/clear` costs
 * nothing. The line is factual; no TTL timer is kept here.
 */

const RESUME_SOURCES = new Set(['resume', 'fork']);
const SECONDS_PER_MINUTE = 60;

function minutesSince(seconds) {
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds / SECONDS_PER_MINUTE) : null;
}

/** @param {object} input SessionStart hook payload. @returns {string} advice line or ''. */
function buildResumeCacheContext(input) {
  if (!input || !RESUME_SOURCES.has(input.source) || input.prompt_cache_likely_expired !== true) return '';
  const minutes = minutesSince(input.seconds_since_last_response);
  const usd = Number(input.estimated_cache_write_usd);
  const since = minutes === null ? 'A while' : `${minutes} min`;
  const rebuild = Number.isFinite(usd) && usd > 0 ? ` (estimated rebuild $${usd.toFixed(2)})` : '';
  return `Resume notice: ${since} since the last response; the prompt cache has likely expired${rebuild}. If the previous topic is finished, \`/clear\` costs nothing; \`/compact\` on a cold resume re-reads the whole prefix at the cache-write rate.`;
}

module.exports = { buildResumeCacheContext };
