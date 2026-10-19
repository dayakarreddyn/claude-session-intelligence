/**
 * Session Intelligence — pure prune decisions.
 *
 * No I/O. Decides whether a tool result is large enough to replace with a
 * head/tail excerpt (full body is archived separately), rewrites noisy Bash
 * commands into filtered forms, and hashes tool inputs for re-run detection.
 */

'use strict';

const crypto = require('crypto');

const INPUT_HASH_LENGTH = 16;
const HEADER_SETTLE_PASSES = 3; // header embeds its own length; a few passes converge
const EXIT_MARKER_PATTERN = '\\[exit=';
const FILTER_PIPE_RE = /\|\s*(grep|head|tail|wc|jq)\b/;

// `pattern` rules get an exit-status-preserving wrapper; `suffix` rules are
// appended verbatim. `exit` only ever runs inside a ( ) subshell so the
// persistent shell is never terminated.
const DEFAULT_INPUT_RULES = Object.freeze([
  Object.freeze({
    name: 'test-runner',
    match: '^\\s*(npm|pnpm|yarn)\\s+(run\\s+)?test\\b|^\\s*(pytest|go\\s+test|cargo\\s+test)\\b|^\\s*node\\s+--test\\b',
    pattern: '(FAIL|ERROR|error:|not ok|# fail|# pass|passed|failed|^ok\\b)',
  }),
  Object.freeze({
    name: 'log-cat',
    match: '^\\s*cat\\s+\\S+\\.log\\b',
    suffix: ' | tail -n 200',
  }),
]);

/** @typedef {{ pruned: true, output: string, archiveId: string, originalChars: number, excerptChars: number } | { pruned: false, reason: 'disabled'|'not-string'|'tool-excluded'|'below-floor'|'no-id' }} PruneDecision */

const fmt = (n) => n.toLocaleString('en-US');

function buildExcerpt(body, { headChars, tailChars, archiveId, toolName, originalChars }) {
  const head = body.slice(0, headChars);
  const tailStart = Math.max(head.length, body.length - Math.max(0, tailChars));
  const tail = body.slice(tailStart); // clamped so head and tail never overlap
  const omitted = Math.max(0, body.length - head.length - tail.length);
  const rest = `\n${head}\n…[${fmt(omitted)} chars omitted]…\n${tail}`;
  const header = (excerptChars) =>
    `[SI pruned: ${toolName} result ${fmt(originalChars)} chars → ${fmt(excerptChars)}-char excerpt. ` +
    `Full body archived; run \`/si expand ${archiveId}\` to replay it verbatim.]`;
  // The header states the excerpt's own length, so settle on a fixed point.
  let len = header(0).length + rest.length;
  for (let i = 0; i < HEADER_SETTLE_PASSES; i += 1) len = header(len).length + rest.length;
  return header(len) + rest;
}

/**
 * Pull the prunable text out of a tool response and return a `rebuild` that
 * puts an excerpt back in the tool's own output shape (Claude Code ignores an
 * `updatedToolOutput` that does not match the built-in tool's output schema).
 * Supported: plain string, Bash `{ stdout, stderr, ... }`, Read
 * `{ type: 'text', file: { content, ... } }`. Anything else (MCP content
 * arrays, Agent results, unknown objects, null) returns null.
 */
function extractPrunableText({ toolName, toolResponse } = {}) {
  void toolName;
  const r = toolResponse;
  if (typeof r === 'string') return { text: r, rebuild: (excerpt) => excerpt };
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  if (typeof r.stdout === 'string') {
    return { text: r.stdout, rebuild: (excerpt) => ({ ...r, stdout: excerpt }) };
  }
  if (r.type === 'text' && r.file && typeof r.file.content === 'string') {
    return { text: r.file.content, rebuild: (excerpt) => ({ ...r, file: { ...r.file, content: excerpt } }) };
  }
  return null;
}

function decidePrune({ toolName, toolUseId, body, cfg }) {
  if (!cfg || !cfg.enabled) return { pruned: false, reason: 'disabled' };
  if (typeof body !== 'string') return { pruned: false, reason: 'not-string' };
  if (!Array.isArray(cfg.tools) || !cfg.tools.includes(toolName)) return { pruned: false, reason: 'tool-excluded' };
  if (body.length < cfg.outputFloorChars) return { pruned: false, reason: 'below-floor' };
  if (!toolUseId) return { pruned: false, reason: 'no-id' };
  const output = buildExcerpt(body, {
    headChars: cfg.headChars,
    tailChars: cfg.tailChars,
    archiveId: toolUseId,
    toolName,
    originalChars: body.length,
  });
  return { pruned: true, output, archiveId: toolUseId, originalChars: body.length, excerptChars: output.length };
}

function applyRule(command, rule) {
  if (rule.pattern) {
    // Newline before the status capture: a trailing token in the command
    // (comment, `&`) cannot swallow or break `rc=$?`.
    const pattern = String(rule.pattern).replace(/'/g, "'\\''");
    return `( set -o pipefail; ( ${command}\n rc=$?; echo "[exit=$rc]"; exit $rc ) 2>&1 | ` +
      `grep -E -A 5 '${pattern}|${EXIT_MARKER_PATTERN}' | head -100 )`;
  }
  return `${command}${rule.suffix || ''}`;
}

function rewriteCommand(command, rules = DEFAULT_INPUT_RULES) {
  const unchanged = { command, rule: null };
  if (typeof command !== 'string') return unchanged;
  if (command.includes('>') || command.includes('\n') || command.includes('#')) return unchanged;
  if (FILTER_PIPE_RE.test(command) || command.trimEnd().endsWith('&')) return unchanged;
  for (const rule of rules || []) {
    let re;
    try { re = new RegExp(rule.match); } catch { continue; }
    if (re.test(command)) return { command: applyRule(command, rule), rule: rule.name };
  }
  return unchanged;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonicalize(value[k])]));
  }
  return value;
}

function inputHash(toolName, toolInput) {
  const canonical = JSON.stringify(canonicalize(toolInput === undefined ? null : toolInput));
  return crypto.createHash('sha1').update(`${toolName}\n${canonical}`).digest('hex').slice(0, INPUT_HASH_LENGTH);
}

module.exports = { extractPrunableText, decidePrune, buildExcerpt, rewriteCommand, inputHash, DEFAULT_INPUT_RULES };
