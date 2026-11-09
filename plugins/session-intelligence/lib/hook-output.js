'use strict';

/**
 * Hook-output assembly. Claude Code replaces hook stdout above 10,000 chars
 * with a 2,000-char preview plus a file path, so anything that must survive
 * (the constraint registry) has to fit under the cap or be lost entirely.
 */

const HOOK_OUTPUT_CAP_CHARS = 10000;
const TRUNCATION_MARKER = '\n…[truncated]\n';

/** @typedef {{ name: string, text: string, required?: boolean }} OutputBlock */

const lengthOf = (blocks) => blocks.reduce((n, b) => n + b.text.length, 0);

/**
 * Join blocks in order, dropping optional blocks from the end until the
 * result fits `maxChars`. Required blocks that alone exceed the cap are
 * truncated (overCap: true). Empty blocks are ignored.
 * @param {OutputBlock[]} blocks
 * @returns {{ text: string, dropped: string[], chars: number, overCap: boolean }}
 */
function assembleUnderCap(blocks, { maxChars = HOOK_OUTPUT_CAP_CHARS } = {}) {
  const live = (blocks || [])
    .filter((b) => b && typeof b.text === 'string' && b.text.length > 0);
  const kept = [...live];
  const dropped = [];
  for (let i = kept.length - 1; i >= 0 && lengthOf(kept) >= maxChars; i--) {
    if (kept[i].required) continue;
    dropped.push(kept[i].name);
    kept.splice(i, 1);
  }
  let text = kept.map((b) => b.text).join('');
  let overCap = false;
  if (text.length >= maxChars) {
    overCap = true;
    text = text.slice(0, Math.max(0, maxChars - 16)) + TRUNCATION_MARKER;
  }
  return { text, dropped, chars: text.length, overCap };
}

/**
 * Join SessionStart context parts under the hook-output cap. The first part
 * (the compact handoff, which holds the standing constraints) is required;
 * later parts are optional and drop from the end first. Empty/non-string
 * parts are ignored.
 * @param {string[]} parts
 * @returns {string}
 */
function renderBootstrapContext(parts, { maxChars = HOOK_OUTPUT_CAP_CHARS } = {}) {
  const live = (Array.isArray(parts) ? parts : []).filter((s) => typeof s === 'string' && s.length > 0);
  return assembleUnderCap(
    live.map((text, i) => ({ name: `part${i}`, text: i ? `\n\n${text}` : text, required: i === 0 })),
    { maxChars },
  ).text;
}

module.exports = { HOOK_OUTPUT_CAP_CHARS, assembleUnderCap, renderBootstrapContext };
