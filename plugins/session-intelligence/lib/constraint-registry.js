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

const BULLET_RE = /^\s*[-*]\s+(.+?)\s*$/;
const KEY_LINE_RE = /^([A-Z][A-Z _-]*):\s*(.+?)\s*$/;
const DROP_KEY_RE = /^(DROP|SAFE TO DROP)$/;

function extractCompactInstructions(claudeMdText) {
  const out = [];
  let inside = false;
  for (const line of String(claudeMdText || '').split('\n')) {
    if (/^#{1,6}\s/.test(line)) {
      inside = /^#{1,6}\s*compact instructions/i.test(line);
      continue;
    }
    if (!inside) continue;
    const m = line.match(BULLET_RE);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Bullets and `KEY: value` lines of one session-context section body. */
function linesOfSection(body) {
  const out = [];
  for (const line of String(body || '').split('\n')) {
    const bullet = line.match(BULLET_RE);
    if (bullet) { out.push(bullet[1]); continue; }
    const key = line.trim().match(KEY_LINE_RE);
    if (key && !DROP_KEY_RE.test(key[1])) out.push(key[2]);
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
    ...linesOfSection(sectionByTitle(s, 'Key Decisions')).map((text) => ({ text, source: 'key-decisions' })),
    ...linesOfSection(sectionByTitle(s, 'On Compact')).map((text) => ({ text, source: 'on-compact' })),
    ...extractCompactInstructions(claudeMdText).map((text) => ({ text, source: 'compact-instructions' })),
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

function renderRegistryBlock(registry) {
  const items = (registry && registry.items) || [];
  if (items.length === 0) return '';
  let out = `\n${BLOCK_HEADING}\n`;
  for (const item of items) {
    const line = `- [${item.type}] ${item.text}\n`;
    if (out.length + line.length > MAX_BLOCK_CHARS) break;
    out += line;
  }
  return out;
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

function isRetained(itemText, normSummary) {
  const norm = normalize(itemText);
  if (!norm) return false;
  if (normSummary.includes(norm)) return true;
  const words = [...new Set(norm.split(/[^a-z0-9]+/).filter((w) => w.length >= MIN_WORD_CHARS))];
  if (words.length === 0) return false;
  const hits = words.filter((w) => normSummary.includes(w)).length;
  return hits / words.length >= WORD_OVERLAP_RATIO;
}

function retentionOf(items, summary) {
  const list = Array.isArray(items) ? items : [];
  const normSummary = normalize(summary);
  const missing = list.filter((i) => !isRetained(i.text, normSummary)).map((i) => i.text);
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
  registryStatePath,
  writeRegistryState,
  readRegistryState,
  retentionOf,
};
