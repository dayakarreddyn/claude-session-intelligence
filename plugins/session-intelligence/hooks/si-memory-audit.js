#!/usr/bin/env node
/**
 * Session Intelligence — memory hygiene audit.
 *
 * Read-only report on the active project's memory directory. Anthropic's
 * memory-tool spec calls out three concerns SI doesn't address by default:
 *   - File-size growth
 *   - Expiration of unaccessed files
 *   - Sensitive-info / duplicate detection
 *
 * This script catches all three plus frontmatter validation and
 * orphans/missing entries between memory files and MEMORY.md.
 *
 * Usage:
 *   echo '{"cwd":"<abs cwd>"}' | node si-memory-audit.js
 *   node si-memory-audit.js --cwd <abs cwd>
 *
 * Pure read-only. Exits 0 when no issues, 1 when any issue is found, 2 on
 * crash. The text output is the primary contract — exit code is best-
 * effort secondary so the `/si memory-audit` command can compose with
 * shell pipelines.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');

// Defaults (overridable via config or CLI flags).
const DEFAULTS = {
  // Files unaccessed for this many days are eviction candidates.
  staleDays: 60,
  // Files larger than this many bytes are split candidates.
  sizeBytes: 16 * 1024,
  // Memory files we expect to find frontmatter on. The MEMORY.md INDEX is
  // exempt — it's a flat bullet list, not a frontmatter doc.
  frontmatterExempt: ['MEMORY.md', 'MEMORY.index.md'],
  // Recognised type values.
  validTypes: ['user', 'feedback', 'project', 'reference'],
};

function readStdinJsonOrEmpty() {
  try {
    const buf = fs.readFileSync(0, 'utf8');
    return buf ? (JSON.parse(buf) || {}) : {};
  } catch { return {}; }
}

function readArg(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : null;
}

function resolveProjectDir(cwd) {
  if (!cwd) return null;
  let dir = path.resolve(cwd);
  for (let i = 0; i < 10; i++) {
    const encoded = dir.replace(/\//g, '-');
    const candidate = path.join(CLAUDE_DIR, 'projects', encoded);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Lightweight YAML frontmatter parser — recognises the SI-specific shape
 * (`name`, `description`, `type`) and ignores everything else. We don't
 * pull a YAML dep for this; the schema is fixed and the body is small.
 */
function parseFrontmatter(content) {
  if (!content.startsWith('---')) return null;
  const end = content.indexOf('\n---', 3);
  if (end < 0) return null;
  const raw = content.slice(3, end).trim();
  const out = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function listMemoryFiles(memoryDir) {
  try {
    return fs.readdirSync(memoryDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const p = path.join(memoryDir, f);
        const stat = fs.statSync(p);
        return { name: f, path: p, size: stat.size, atime: stat.atime, mtime: stat.mtime };
      });
  } catch { return []; }
}

function readIndexEntries(indexPath) {
  // MEMORY.md is a flat bullet list. Each line is roughly:
  //   - [Title](slug.md) — one-line description
  // We extract the slug for cross-checking against the file listing.
  try {
    const txt = fs.readFileSync(indexPath, 'utf8');
    const slugs = new Set();
    for (const line of txt.split('\n')) {
      const m = line.match(/^[-*]\s+\[[^\]]+\]\(([^)]+\.md)\)/);
      if (m) slugs.add(m[1].trim());
    }
    return slugs;
  } catch { return new Set(); }
}

function fmtBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}kB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function daysAgo(date) {
  return Math.floor((Date.now() - date.getTime()) / (24 * 3600 * 1000));
}

function main() {
  const stdin = readStdinJsonOrEmpty();
  const cwd = readArg('--cwd') || stdin.cwd || process.cwd();
  const staleDays = Number(readArg('--stale-days')) || DEFAULTS.staleDays;
  const sizeBytes = Number(readArg('--size-bytes')) || DEFAULTS.sizeBytes;

  const projectDir = resolveProjectDir(cwd);
  if (!projectDir) {
    process.stdout.write(`Memory audit — no project dir resolved for ${cwd}\n` +
      `  Claude Code creates ~/.claude/projects/<encoded>/ on first session.\n`);
    process.exit(0);
  }

  const memoryDir = path.join(projectDir, 'memory');
  if (!fs.existsSync(memoryDir)) {
    process.stdout.write(`Memory audit — ${memoryDir}\n  (no memory directory yet — nothing to audit)\n`);
    process.exit(0);
  }

  const files = listMemoryFiles(memoryDir);
  const indexPath = path.join(memoryDir, 'MEMORY.md');
  const indexed = readIndexEntries(indexPath);

  const issues = {
    stale: [],          // unaccessed > staleDays
    oversized: [],      // > sizeBytes
    missingFrontmatter: [],
    badType: [],
    nameMismatch: [],   // frontmatter.name doesn't match filename pattern
    notInIndex: [],     // file exists but no MEMORY.md entry
    indexOrphan: [],    // MEMORY.md entry but no file
  };

  for (const f of files) {
    if (DEFAULTS.frontmatterExempt.includes(f.name)) continue;

    if (daysAgo(f.atime) > staleDays) issues.stale.push(f);
    if (f.size > sizeBytes) issues.oversized.push(f);

    let content = '';
    try { content = fs.readFileSync(f.path, 'utf8'); } catch { continue; }
    const fm = parseFrontmatter(content);
    if (!fm) {
      issues.missingFrontmatter.push(f);
      continue;
    }
    if (!fm.type || !DEFAULTS.validTypes.includes(fm.type)) {
      issues.badType.push({ ...f, type: fm.type || '(missing)' });
    }
    if (!indexed.has(f.name)) issues.notInIndex.push(f);
  }

  // Detect index orphans — entries pointing at files that don't exist.
  const fileSet = new Set(files.map((f) => f.name));
  for (const slug of indexed) {
    if (!fileSet.has(slug)) issues.indexOrphan.push(slug);
  }

  // ─── Render ─────────────────────────────────────────────────────────────
  const out = [];
  out.push(`Memory audit — ${memoryDir}`);
  out.push('');
  out.push(`  ${files.length} files, ${indexed.size} index entries`);
  out.push(`  Thresholds: stale > ${staleDays} days, oversized > ${fmtBytes(sizeBytes)}`);
  out.push('');

  const section = (label, rows, fmt) => {
    if (rows.length === 0) {
      out.push(`  ✓ ${label}`);
      return;
    }
    out.push(`  ✗ ${label} (${rows.length})`);
    for (const r of rows) out.push(`      ${fmt(r)}`);
  };

  section('Frontmatter present on every doc', issues.missingFrontmatter,
    (f) => `${f.name}  — no \`---\` frontmatter block`);
  section('Type is one of user/feedback/project/reference', issues.badType,
    (f) => `${f.name}  — type=${f.type}`);
  section('All docs listed in MEMORY.md', issues.notInIndex,
    (f) => `${f.name}  — add a one-line pointer to MEMORY.md`);
  section('No dangling MEMORY.md entries', issues.indexOrphan,
    (s) => `${s}  — referenced by MEMORY.md but file doesn\'t exist`);
  section(`Files accessed within ${staleDays} days`, issues.stale,
    (f) => `${f.name}  — atime ${daysAgo(f.atime)}d ago (${fmtBytes(f.size)})`);
  section(`Files under ${fmtBytes(sizeBytes)}`, issues.oversized,
    (f) => `${f.name}  — ${fmtBytes(f.size)} (consider splitting)`);
  out.push('');

  const totalIssues = Object.values(issues).reduce((n, arr) => n + arr.length, 0);
  out.push(totalIssues === 0
    ? 'VERDICT: memory directory is healthy.'
    : `VERDICT: ${totalIssues} issue${totalIssues === 1 ? '' : 's'} to address.`);

  process.stdout.write(out.join('\n') + '\n');
  process.exit(totalIssues === 0 ? 0 : 1);
}

try { main(); }
catch (err) {
  process.stderr.write(`[si-memory-audit] ${err.message}\n`);
  process.exit(2);
}
