/**
 * Typed constraint registry: standing constraints pulled from
 * session-context.md (Key Decisions, On Compact) and CLAUDE.md
 * `# Compact instructions`, classified into five types, carried outside the
 * compaction summary and re-injected afterwards. Pure helpers plus an atomic
 * per-session state file.
 */

const fs = require('fs');
const path = require('path');
const { getStateDir } = require('./utils');
const { sectionByTitle } = require('./session-context');

const CONSTRAINT_TYPES = Object.freeze(['Action', 'Information', 'Process', 'Preference', 'Output']);
const MAX_ITEMS = 25;
const MAX_ITEM_CHARS = 200;
const MAX_BLOCK_CHARS = 3000;
const BLOCK_HEADING = '## CONSTRAINT REGISTRY (must survive compaction)';
const MIN_WORD_CHARS = 4;
const WORD_OVERLAP_RATIO = 0.6;

const ACTION_RE = /^(never|always|must|do not|don't|avoid|only|no )\b|\b(never|always|must not|must)\b/i;
const OUTPUT_NOUN_RE = /\b(output|format|respond|reply|answer|print|render|report)\b/i;
const OUTPUT_PREP_RE = /\b(as|in|with|using)\b/i;
const PROCESS_RE = /\b(before|after|then|first|whenever|every time|workflow|step)\b/i;
const PREFERENCE_RE = /\b(prefer|favou?r)\b|\buse\b.*\b(over|instead of|not)\b/i;

function classifyConstraint(text) {
  const t = String(text || '');
  if (ACTION_RE.test(t)) return 'Action';
  if (OUTPUT_NOUN_RE.test(t) && OUTPUT_PREP_RE.test(t)) return 'Output';
  if (PROCESS_RE.test(t)) return 'Process';
  if (PREFERENCE_RE.test(t)) return 'Preference';
  return 'Information';
}

const LIST_MARKER_RE = /^\s*(?:[-*]|\d+[.)])\s+(.+?)\s*$/;
const KEY_LINE_RE = /^([A-Za-z][A-Za-z _-]{0,30}):\s+(.+?)\s*$/;
const DROP_KEY_RE = /^(safe to )?drop$/i;

function extractCompactInstructions(claudeMdText) {
  const out = [];
  let inside = false;
  for (const line of String(claudeMdText || '').split('\n')) {
    if (/^#{1,6}\s/.test(line)) {
      inside = /^#{1,6}\s*compact instructions/i.test(line);
      continue;
    }
    if (!inside) continue;
    const m = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * Constraint lines of one session-context section body: bullets, numbered
 * items, `Key: value` lines (value kept) and plain prose. Drop lines and
 * headings are skipped.
 */
function linesOfSection(body) {
  const out = [];
  for (const raw of String(body || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const listed = line.match(LIST_MARKER_RE);
    const content = listed ? listed[1] : line;
    const key = content.match(KEY_LINE_RE);
    if (key && DROP_KEY_RE.test(key[1].trim())) continue;
    out.push(key && !listed ? key[2] : content);
  }
  return out;
}

function clip(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length <= MAX_ITEM_CHARS ? t : `${t.slice(0, MAX_ITEM_CHARS - 1)}…`;
}

function buildRegistry({ sections, claudeMdText } = {}) {
  const s = sections || {};
  const candidates = [
    // Priority order: the most authoritative rules survive the caps.
    ...extractCompactInstructions(claudeMdText).map((text) => ({ text, source: 'compact-instructions' })),
    ...linesOfSection(sectionByTitle(s, 'On Compact')).map((text) => ({ text, source: 'on-compact' })),
    ...linesOfSection(sectionByTitle(s, 'Key Decisions')).map((text) => ({ text, source: 'key-decisions' })),
  ];
  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    const text = clip(c.text);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    unique.push({ type: classifyConstraint(text), text, source: c.source });
  }
  const items = unique.slice(0, MAX_ITEMS);
  return {
    items,
    truncated: unique.length > MAX_ITEMS,
    sources: [...new Set(items.map((i) => i.source))],
  };
}

const BLOCK_HEAD = `\n${BLOCK_HEADING}\n`;

function lineOf(item) {
  return `- [${item.type}] ${item.text}\n`;
}

/**
 * Keep the longest priority-ordered prefix of whole items whose rendered
 * block fits `maxChars`. The result is the exact retention baseline for what
 * the render emits; `truncated` is set when anything was dropped.
 */
function fitRegistryToCap(registry, maxChars = MAX_BLOCK_CHARS) {
  const items = (registry && registry.items) || [];
  const kept = [];
  let used = BLOCK_HEAD.length;
  for (const item of items) {
    used += lineOf(item).length;
    if (used > maxChars) break;
    kept.push(item);
  }
  return {
    items: kept,
    truncated: Boolean(registry && registry.truncated) || kept.length < items.length,
    sources: [...new Set(kept.map((i) => i.source))],
  };
}

function renderRegistryBlock(registry) {
  const { items } = fitRegistryToCap(registry); // no-op on an already fitted registry
  if (items.length === 0) return '';
  return BLOCK_HEAD + items.map(lineOf).join('');
}

function isSafeSessionId(sessionId) {
  return typeof sessionId === 'string' && /^[A-Za-z0-9_-]+$/.test(sessionId);
}

function registryStatePath(sessionId) {
  if (!isSafeSessionId(sessionId)) return null;
  return path.join(getStateDir(), `claude-constraints-${sessionId}.json`);
}

function writeRegistryState(sessionId, data) {
  const file = registryStatePath(sessionId);
  if (!file) return false;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return false;
  }
}

function readRegistryState(sessionId) {
  const file = registryStatePath(sessionId);
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null; // absent or corrupt
  }
}

function normalize(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Generic words that appear in nearly any summary and prove nothing.
// "never"/"always" are deliberately absent: they are load-bearing in rules.
const STOP_WORDS = new Set([
  'with', 'that', 'this', 'from', 'into', 'have', 'will', 'when', 'then', 'than',
  'they', 'them', 'there', 'their', 'what', 'which', 'were', 'been', 'also', 'only',
  'some', 'such', 'each', 'over', 'after', 'before', 'about', 'because', 'would',
  'could', 'should', 'must',
]);

/** Lower-case word tokens with a light plural strip ("tests" ~ "test"). */
function wordsOf(norm) {
  return norm.split(/[^a-z0-9]+/).filter(Boolean)
    .map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w));
}

function isRetained(itemText, normSummary, summaryTokens) {
  const norm = normalize(itemText);
  if (!norm) return false;
  if (normSummary.includes(norm)) return true;
  const words = [...new Set(wordsOf(norm).filter((w) => w.length >= MIN_WORD_CHARS && !STOP_WORDS.has(w)))];
  if (words.length === 0) return false;
  const hits = words.filter((w) => summaryTokens.has(w)).length;
  return hits / words.length >= WORD_OVERLAP_RATIO;
}

function retentionOf(items, summary) {
  const list = Array.isArray(items) ? items : [];
  const normSummary = normalize(summary);
  const summaryTokens = new Set(wordsOf(normSummary));
  const missing = list.filter((i) => !isRetained(i.text, normSummary, summaryTokens)).map((i) => i.text);
  const total = list.length;
  const retained = total - missing.length;
  return { total, retained, ratio: total ? Math.round((retained / total) * 100) / 100 : 0, missing };
}

module.exports = {
  CONSTRAINT_TYPES,
  MAX_ITEMS,
  MAX_ITEM_CHARS,
  MAX_BLOCK_CHARS,
  classifyConstraint,
  extractCompactInstructions,
  buildRegistry,
  renderRegistryBlock,
  fitRegistryToCap,
  registryStatePath,
  writeRegistryState,
  readRegistryState,
  retentionOf,
};
