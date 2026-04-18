/**
 * Single source of truth for parsing `session-context.md`.
 *
 * Previously both `lib/handoff.js` and `hooks/si-pre-compact.js` carried
 * their own copies of `stripPlaceholderLines` + `parseSessionContext`, and
 * they drifted: handoff stripped only bare `(hint)` lines, pre-compact
 * stripped three additional placeholder shapes — so template bullets like
 * `- (list key files)` leaked into the handoff while being correctly
 * stripped from the compact hints.
 *
 * This module is deliberately dependency-free (fs/path only) so it can be
 * required by hooks, libs, and the statusline without pulling a circular
 * chain through intel-debug/config.
 */

const fs = require('fs');
const path = require('path');

// Template placeholder shapes written by the `session-context.md` seed
// template. Any line matching one of these is scaffolding, not content.
const PLACEHOLDER_BULLET_RE = /^[-*]\s*\([^)]*\)\s*$/;          // "- (list files)"
const PLACEHOLDER_PAIR_RE = /^[A-Za-z][A-Za-z0-9_-]*:\s*\([^)]*\)\s*$/; // "type: (a | b)"
const PLACEHOLDER_CAPS_RE = /^[A-Z]+:\s*\([^)]*\)\s*$/;          // "PRESERVE: (...)"
const PLACEHOLDER_BARE_RE = /^\([^)]*\)$/;                       // "(hint)"

// Sentinel written by si-bootstrap's autoFillSessionContext when it fills
// the Current Task / Key Files sections from git last-commit. Content that
// still carries the sentinel is SYNTHETIC — treating it as user-authored
// causes the post-compact banner to announce something the user never
// wrote, and the handoff to replay derived content as if it were a task.
const AUTOFILL_SENTINEL_RE = /<!--\s*si:autofill\s+sha=[0-9a-f]{4,40}\s*-->/;

function isPlaceholderLine(line) {
  const t = String(line || '').trim();
  if (!t) return false;            // blank lines preserved
  if (t.startsWith('#')) return false; // headers preserved
  if (PLACEHOLDER_BULLET_RE.test(t)) return true;
  if (PLACEHOLDER_PAIR_RE.test(t)) return true;
  if (PLACEHOLDER_CAPS_RE.test(t)) return true;
  if (PLACEHOLDER_BARE_RE.test(t)) return true;
  return false;
}

/**
 * Remove placeholder-only lines from a body of text. Preserves blank lines
 * and `#`-prefixed markdown headers since those carry structure the caller
 * may want.
 */
function stripPlaceholderLines(text) {
  return String(text || '')
    .split('\n')
    .filter((line) => !isPlaceholderLine(line))
    .join('\n')
    .trim();
}

/**
 * Parse section headers from `session-context.md`. Returns an object keyed
 * by section title (e.g. `"Current Task"`) with stripped bodies as values.
 *
 * @param {string} content raw file contents
 * @returns {Record<string, string>}
 */
function parseSessionContext(content) {
  const sections = {};
  let current = null;
  for (const line of String(content || '').split('\n')) {
    const m = line.match(/^##\s+(.+)/);
    if (m) {
      current = m[1].trim();
      sections[current] = [];
    } else if (current) {
      sections[current].push(line);
    }
  }
  for (const k of Object.keys(sections)) {
    sections[k] = stripPlaceholderLines(sections[k].join('\n'));
  }
  return sections;
}

/**
 * Read + parse `session-context.md` from a project directory.
 *
 * Returns an object with:
 *   - `sections`        full sections map
 *   - `currentTask`     body of `## Current Task`, masked to `""` when
 *                       autofill sentinel is present (unless `maskAutofill`
 *                       is set to `false`)
 *   - `keyFiles`        body of `## Key Files`, same autofill masking
 *   - `isAutofill`      true if the Current Task carries the autofill
 *                       sentinel — callers can report "stale/auto" state
 *                       instead of pretending the file is empty
 *   - `mtimeMs`         file mtime in ms for freshness checks (0 on miss)
 *
 * Never throws — missing files, parse failures, and empty contents all
 * produce the same `{ sections: {}, currentTask: '', keyFiles: '',
 * isAutofill: false, mtimeMs: 0 }` shape.
 */
function readSessionContext(projectDir, opts) {
  const empty = {
    sections: {},
    currentTask: '',
    keyFiles: '',
    isAutofill: false,
    mtimeMs: 0,
  };
  if (!projectDir) return empty;
  const maskAutofill = !opts || opts.maskAutofill !== false;

  const file = path.join(projectDir, 'session-context.md');
  let content, mtimeMs;
  try {
    const stat = fs.statSync(file);
    content = fs.readFileSync(file, 'utf8');
    mtimeMs = stat.mtimeMs;
  } catch {
    return empty;
  }

  const sections = parseSessionContext(content);
  const rawTask = sections['Current Task'] || '';
  const rawKeyFiles = sections['Key Files'] || '';
  const isAutofill = AUTOFILL_SENTINEL_RE.test(rawTask);

  return {
    sections,
    currentTask: (isAutofill && maskAutofill) ? '' : rawTask,
    keyFiles: (AUTOFILL_SENTINEL_RE.test(rawKeyFiles) && maskAutofill) ? '' : rawKeyFiles,
    isAutofill,
    mtimeMs,
  };
}

module.exports = {
  readSessionContext,
  parseSessionContext,
  stripPlaceholderLines,
  isPlaceholderLine,
  AUTOFILL_SENTINEL_RE,
  PLACEHOLDER_BULLET_RE,
  PLACEHOLDER_PAIR_RE,
  PLACEHOLDER_CAPS_RE,
  PLACEHOLDER_BARE_RE,
};
