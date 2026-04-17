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
};
