/**
 * Git Nexus — derive "the files this repo actually cares about" from
 * commit history.
 *
 * The shape log only knows what was touched THIS session. For a large
 * repo where planning docs / foundational modules get touched heavily
 * early on and then sit idle (but are still the spine of the work), pure
 * recency banding under-weights them. Git history doesn't — files that
 * change frequently across many commits are, by definition, the load-
 * bearing parts of the codebase.
 *
 * Usage:
 *   const { topTouchedFiles } = require('./git-nexus');
 *   const anchors = topTouchedFiles('/path/to/repo', { sinceDays: 90, limit: 20 });
 *   // anchors = [{ path: 'src/auth/session.ts', count: 47 }, ...]
 *
 * Computed fresh per session and cached under /tmp with a 24h TTL so we
 * don't shell out on every hook fire. Returns [] for non-git repos, on
 * timeout, and on any parse error — never throws.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DEFAULT_SINCE_DAYS = 90;
const DEFAULT_LIMIT = 20;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.cc', '.cpp', '.h', '.hpp',
  '.rb', '.php', '.cs', '.scala',
  '.md', // include markdown so plans/architecture docs surface
];
const GIT_TIMEOUT_MS = 5000;

function cacheFilePath(cwd) {
  const hash = crypto.createHash('sha1').update(String(cwd)).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), `claude-git-nexus-${hash}.json`);
}

function readCache(cwd, ttlMs) {
  try {
    const raw = fs.readFileSync(cacheFilePath(cwd), 'utf8');
    const entry = JSON.parse(raw);
    if (!entry || !Array.isArray(entry.files)) return null;
    const age = Date.now() - (entry.t || 0);
    if (age > ttlMs) return null;
    return entry;
  } catch { return null; }
}

function writeCache(cwd, entry) {
  try { fs.writeFileSync(cacheFilePath(cwd), JSON.stringify(entry)); }
  catch { /* best effort */ }
}

function isGitRepo(cwd) {
  try {
    execFileSync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    });
    return true;
  } catch { return false; }
}

/**
 * Shell out to `git log --name-only --pretty=format:` over the window,
 * count path frequencies, filter by extension, and sort descending.
 *
 * @param {string} cwd
 * @param {{sinceDays?: number, limit?: number, extensions?: string[], ttlMs?: number, force?: boolean}} [opts]
 * @returns {Array<{path: string, count: number}>}
 */
function topTouchedFiles(cwd, opts) {
  const sinceDays = (opts && Number.isFinite(opts.sinceDays)) ? opts.sinceDays : DEFAULT_SINCE_DAYS;
  const limit = (opts && Number.isFinite(opts.limit)) ? opts.limit : DEFAULT_LIMIT;
  const extensions = (opts && Array.isArray(opts.extensions)) ? opts.extensions : DEFAULT_EXTENSIONS;
  const ttlMs = (opts && Number.isFinite(opts.ttlMs)) ? opts.ttlMs : DEFAULT_TTL_MS;
  const force = !!(opts && opts.force);

  if (!cwd || typeof cwd !== 'string') return [];

  if (!force) {
    const cached = readCache(cwd, ttlMs);
    if (cached && cached.sinceDays === sinceDays) {
      return cached.files.slice(0, limit);
    }
  }

  if (!isGitRepo(cwd)) return [];

  let stdout;
  try {
    stdout = execFileSync('git', [
      '-C', cwd,
      'log',
      `--since=${sinceDays} days ago`,
      '--name-only',
      '--pretty=format:',
      '--no-merges',
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch { return []; }

  const counts = new Map();
  const extSet = new Set(extensions);
  for (const line of stdout.split('\n')) {
    const p = line.trim();
    if (!p) continue;
    const ext = path.extname(p).toLowerCase();
    if (extensions.length && !extSet.has(ext)) continue;
    counts.set(p, (counts.get(p) || 0) + 1);
  }

  const files = [...counts.entries()]
    .map(([p, count]) => ({ path: p, count }))
    .sort((a, b) => b.count - a.count);

  writeCache(cwd, { t: Date.now(), sinceDays, files: files.slice(0, Math.max(limit, DEFAULT_LIMIT)) });

  return files.slice(0, limit);
}

/**
 * Convert topTouchedFiles output into a preserveGlobs-shaped array.
 * Anchors become path-exact globs so analyzeShape matches against both
 * the file path itself and, by trailing-** fallback, the rootDir.
 */
function toPreserveGlobs(anchors) {
  if (!Array.isArray(anchors)) return [];
  return anchors
    .filter((a) => a && typeof a.path === 'string' && a.path)
    .map((a) => a.path);
}

/**
 * Render a brief markdown block for SessionStart injection. One line per
 * anchor with its path + commit count. Kept deliberately simple — no
 * LLM-derived "role" text, just the frequency signal.
 */
function renderNexusBlock(anchors, opts) {
  const limit = (opts && Number.isFinite(opts.limit)) ? opts.limit : 10;
  const sinceDays = (opts && Number.isFinite(opts.sinceDays)) ? opts.sinceDays : DEFAULT_SINCE_DAYS;
  const trimmed = (anchors || []).slice(0, limit);
  if (trimmed.length === 0) return '';
  const lines = [
    `Git Nexus — top ${trimmed.length} files by commit frequency (last ${sinceDays} days):`,
  ];
  for (const a of trimmed) {
    lines.push(`  - ${a.path} (${a.count} commits)`);
  }
  lines.push('');
  lines.push('These files anchor the repo\'s active work. Prefer them when inferring context; skip rediscovery.');
  return lines.join('\n');
}

module.exports = {
  topTouchedFiles,
  toPreserveGlobs,
  renderNexusBlock,
  cacheFilePath, // exported for tests / /si tail
  _defaults: {
    DEFAULT_SINCE_DAYS,
    DEFAULT_LIMIT,
    DEFAULT_TTL_MS,
    DEFAULT_EXTENSIONS,
  },
};
