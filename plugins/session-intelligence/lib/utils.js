/**
 * Minimal utility functions for session-intelligence hooks.
 * Zero external dependencies — works standalone or alongside ECC.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function getHomeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function getClaudeDir() {
  return path.join(getHomeDir(), '.claude');
}

function getSessionsDir() {
  return path.join(getClaudeDir(), 'session-data');
}

function getTempDir() {
  return os.tmpdir();
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function writeFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
}

function appendFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, content, 'utf8');
}

/** Log to stderr (visible to user in Claude Code terminal). */
function log(message) {
  console.error(message);
}

function getDateTimeString() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function getTimeString() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/**
 * Find files matching a glob-like pattern in a directory.
 * Simple implementation — supports only trailing wildcards (e.g., '*-session.tmp').
 */
function findFiles(dir, pattern) {
  if (!fs.existsSync(dir)) return [];
  const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && regex.test(e.name))
      .map(e => {
        const fullPath = path.join(dir, e.name);
        const stats = fs.statSync(fullPath);
        return { path: fullPath, mtime: stats.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

/**
 * Read hook stdin as JSON. Returns `{}` on empty, missing, or invalid input
 * so callers can safely `const { cwd } = readStdinJson()`.
 */
function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/**
 * Resolve the Claude Code project dir (`~/.claude/projects/<encoded>`) for a
 * given working directory. Walks ancestor paths so running Claude from a
 * subdirectory of a tracked project still finds the right slot. Avoids the
 * lossy hyphen-decode heuristic that conflated `/alice-smith/x` with
 * `/alice/smith/x`. Returns null when no ancestor has a project dir.
 */
function resolveProjectDir(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  const projectsDir = path.join(getClaudeDir(), 'projects');
  if (!fs.existsSync(projectsDir)) return null;

  let dir = path.resolve(cwd);
  for (let depth = 0; depth < 64; depth++) {
    const encoded = dir.replace(/\//g, '-');
    const candidate = path.join(projectsDir, encoded);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Read token count from the latest assistant-message usage block in a Claude
 * transcript JSONL file. Scans only the tail (512 KB) so multi-MB transcripts
 * stay cheap. Returns 0 when the file is missing, empty, or has no usage yet.
 * Shared across statusline / suggest-compact / task-change-detector so they
 * all see the same number.
 */
function readTranscriptTokens(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return 0;
  try {
    const stat = fs.statSync(transcriptPath);
    const scanBytes = Math.min(stat.size, 512 * 1024);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(scanBytes);
      fs.readSync(fd, buf, 0, scanBytes, stat.size - scanBytes);
      const lines = buf.toString('utf8').split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const d = JSON.parse(lines[i]);
          const u = d && d.message && d.message.usage;
          if (u) {
            return (u.input_tokens || 0)
                 + (u.cache_creation_input_tokens || 0)
                 + (u.cache_read_input_tokens || 0);
          }
        } catch { /* partial line at tail boundary — fine */ }
      }
    } finally { fs.closeSync(fd); }
  } catch { /* silent — callers fall back to other sources */ }
  return 0;
}

module.exports = {
  getHomeDir,
  getClaudeDir,
  getSessionsDir,
  getTempDir,
  ensureDir,
  readFile,
  writeFile,
  appendFile,
  log,
  getDateTimeString,
  getTimeString,
  findFiles,
  readStdinJson,
  resolveProjectDir,
  readTranscriptTokens,
};
