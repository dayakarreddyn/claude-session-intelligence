/**
 * Thinking-token accounting.
 *
 * Primary source (exact): every assistant row's
 * `message.usage.output_tokens_details.thinking_tokens`. Claude Code streams one
 * JSONL row per content block, and each row repeats the same cumulative
 * `usage` and `message.id`, so the LAST value per `message.id` wins and a turn
 * counts when that value is > 0. Exact mode is chosen when any scanned
 * assistant row carries a numeric `thinking_tokens`.
 *
 * Legacy fallback (estimate, `exact: false`): older transcripts lack that
 * field. The thinking block text is redacted (signature-only) but its cost is
 * part of `usage.output_tokens`, so we residual-estimate per row:
 *
 *   thinkingTokens(turn) ~= output_tokens
 *                           - (visible_text_chars + tool_use_json_chars) / 4
 *
 * This is a heuristic and over-counts streamed messages (one row per block).
 *
 * Implementation notes:
 *   - We tail-scan the last SCAN_BYTES of the transcript. Full scans are
 *     expensive on long sessions and the statusline renders frequently.
 *   - The first line of a mid-file read is dropped because it is almost
 *     certainly a partial jsonl record.
 *   - Only assistant rows contribute. Empty content or tool_result rows are
 *     skipped silently.
 */

const fs = require('fs');

const CHARS_PER_TOKEN = 4;
const SCAN_BYTES = 512 * 1024;
const TOOL_USE_FRAMING_CHARS = 20; // accounts for type/name/id JSON envelope

function emptyResult() {
  return { total: 0, turns: 0, recent: 0, lastTurnAgo: null, exact: false };
}

function summarizeExact(values, recentWindow) {
  let total = 0;
  let turns = 0;
  let lastThinkingIdx = -1;
  const perTurn = values.map((v, i) => {
    if (v > 0) { total += v; turns++; lastThinkingIdx = i; return v; }
    return 0;
  });
  const recent = perTurn.slice(-recentWindow).reduce((a, b) => a + b, 0);
  const lastTurnAgo = lastThinkingIdx >= 0 ? values.length - 1 - lastThinkingIdx : null;
  return { total, turns, recent, lastTurnAgo, exact: true };
}

/**
 * @param {string} transcriptPath
 * @param {{ recentWindow?: number, scanBytes?: number }} [opts]
 * @returns {{ total: number, turns: number, recent: number, lastTurnAgo: number | null, exact: boolean }}
 */
function estimateThinkingTokens(transcriptPath, opts) {
  const recentWindow = (opts && Number.isFinite(opts.recentWindow)) ? opts.recentWindow : 30;
  const scanBytes = (opts && Number.isFinite(opts.scanBytes)) ? opts.scanBytes : SCAN_BYTES;

  if (!transcriptPath) return emptyResult();
  let stat;
  try { stat = fs.statSync(transcriptPath); }
  catch { return emptyResult(); }

  let text;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const bytes = Math.min(stat.size, scanBytes);
      const buf = Buffer.alloc(bytes);
      fs.readSync(fd, buf, 0, bytes, stat.size - bytes);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return emptyResult(); }

  const allLines = text.split('\n').filter(Boolean);
  // Drop the first line when we read from a byte offset mid-line — it's almost
  // certainly a partial jsonl record that would fail to parse.
  const lines = stat.size > scanBytes ? allLines.slice(1) : allLines;

  let total = 0;
  let turns = 0;
  let assistantIdx = 0;
  let lastThinkingIdx = -1;
  const perTurn = [];
  // message.id -> last exact thinking_tokens (Map keeps first-seen order).
  const exactById = new Map();
  let hasExact = false;
  let anonSeq = 0;

  for (const ln of lines) {
    let d;
    try { d = JSON.parse(ln); } catch { continue; }
    const msg = d && d.message;
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    const details = msg.usage && msg.usage.output_tokens_details;
    const exactVal = details && details.thinking_tokens;
    if (typeof exactVal === 'number' && Number.isFinite(exactVal)) {
      hasExact = true;
      exactById.set(msg.id || `anon-${anonSeq++}`, exactVal);
    }

    let hasThinking = false;
    let visibleChars = 0;
    for (const block of msg.content) {
      if (!block || !block.type) continue;
      if (block.type === 'thinking') {
        hasThinking = true;
      } else if (block.type === 'text') {
        visibleChars += (block.text || '').length;
      } else if (block.type === 'tool_use') {
        visibleChars += JSON.stringify(block.input || {}).length
          + (block.name || '').length
          + TOOL_USE_FRAMING_CHARS;
      }
    }

    const outputTokens = Number((msg.usage && msg.usage.output_tokens) || 0);
    let turnThinking = 0;
    if (hasThinking && outputTokens > 0) {
      const visibleTokens = Math.round(visibleChars / CHARS_PER_TOKEN);
      turnThinking = Math.max(0, outputTokens - visibleTokens);
      turns++;
      lastThinkingIdx = assistantIdx;
    }
    perTurn.push(turnThinking);
    total += turnThinking;
    assistantIdx++;
  }

  if (hasExact) return summarizeExact([...exactById.values()], recentWindow);

  const recent = perTurn.slice(-recentWindow).reduce((a, b) => a + b, 0);
  const lastTurnAgo = lastThinkingIdx >= 0
    ? assistantIdx - 1 - lastThinkingIdx
    : null;

  return { total, turns, recent, lastTurnAgo, exact: false };
}

module.exports = { estimateThinkingTokens, _CHARS_PER_TOKEN: CHARS_PER_TOKEN };
