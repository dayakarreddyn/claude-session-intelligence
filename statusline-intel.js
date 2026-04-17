#!/usr/bin/env node
/**
 * Claude Code statusLine — Session Intelligence view
 *
 * Reads stdin JSON (provided by Claude Code):
 *   { session_id, cwd, model: { display_name }, ... }
 *
 * Prints a single line to stdout: model · project · token-zone · tool-count · current-task
 *
 * Colors (ANSI) reflect the token zone:
 *   green   <200k
 *   yellow  200-300k
 *   orange  300-400k
 *   red     >=400k
 *
 * Silent fallback: if anything goes wrong, prints a minimal model/project line
 * so the status line never appears broken to the user.
 *
 * Config env vars:
 *   CLAUDE_STATUSLINE_NO_COLOR=1  — strip ANSI
 *   CLAUDE_STATUSLINE_COMPACT=1   — omit the task description tail
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const NO_COLOR = process.env.NO_COLOR === '1' || process.env.CLAUDE_STATUSLINE_NO_COLOR === '1';
const COMPACT = process.env.CLAUDE_STATUSLINE_COMPACT === '1';

const C = {
  reset:  NO_COLOR ? '' : '\x1b[0m',
  dim:    NO_COLOR ? '' : '\x1b[2m',
  bold:   NO_COLOR ? '' : '\x1b[1m',
  green:  NO_COLOR ? '' : '\x1b[32m',
  yellow: NO_COLOR ? '' : '\x1b[33m',
  orange: NO_COLOR ? '' : '\x1b[38;5;208m',
  red:    NO_COLOR ? '' : '\x1b[31m',
  blue:   NO_COLOR ? '' : '\x1b[34m',
  gray:   NO_COLOR ? '' : '\x1b[90m',
  cyan:   NO_COLOR ? '' : '\x1b[36m',
};

function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function safeParse(raw) {
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function readIntFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function zoneFor(tokens) {
  if (tokens >= 400_000) return { name: 'red',    color: C.red,    icon: '▰▰▰▰' };
  if (tokens >= 300_000) return { name: 'orange', color: C.orange, icon: '▰▰▰▱' };
  if (tokens >= 200_000) return { name: 'yellow', color: C.yellow, icon: '▰▰▱▱' };
  return                   { name: 'green',  color: C.green,  icon: '▰▱▱▱' };
}

function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/**
 * Find the active session's budget/count files. Prefers the current session id;
 * falls back to "default" if no per-session file exists yet (first tick).
 */
function loadSession(sessionId) {
  const tmp = os.tmpdir();
  const candidates = [sessionId, 'default'].filter(Boolean);

  for (const id of candidates) {
    const sanitized = String(id).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!sanitized) continue;
    const budgetFile = path.join(tmp, `claude-token-budget-${sanitized}`);
    const countFile  = path.join(tmp, `claude-tool-count-${sanitized}`);
    if (fs.existsSync(budgetFile) || fs.existsSync(countFile)) {
      return {
        id: sanitized,
        tokens: readIntFile(budgetFile),
        tools:  readIntFile(countFile),
      };
    }
  }
  return { id: (sessionId || 'default'), tokens: 0, tools: 0 };
}

/**
 * Resolve the per-project memory directory for the given cwd, mirroring the
 * pre-compact hook's logic.
 */
function resolveProjectDir(cwd) {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const projectsDir = path.join(home, '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return null;

  const encoded = cwd.replace(/\//g, '-');
  const direct = path.join(projectsDir, encoded);
  if (fs.existsSync(path.join(direct, 'session-context.md'))) return direct;
  if (fs.existsSync(direct)) return direct;

  try {
    const children = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const d of children) {
      if (!d.isDirectory()) continue;
      const decoded = '/' + d.name.replace(/^-/, '').replace(/-/g, '/');
      if (cwd.startsWith(decoded)) {
        return path.join(projectsDir, d.name);
      }
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Extract the "Current Task" summary from session-context.md.
 * Returns a short single-line description or 'idle'.
 */
function loadCurrentTask(projectDir) {
  if (!projectDir) return '';
  const file = path.join(projectDir, 'session-context.md');
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }

  const match = content.match(/##\s+Current Task\s*([\s\S]*?)(?=\n##\s|$)/);
  if (!match) return '';

  const body = match[1].trim();
  // Find a "type:" or first meaningful line.
  const typeMatch = body.match(/^type:\s*([^\n—-]+)(?:[—-]\s*(.+))?/m);
  if (typeMatch) {
    const type = typeMatch[1].trim();
    const desc = (typeMatch[2] || '').trim();
    if (type && desc) return `${type} — ${truncate(desc, 50)}`;
    if (type) return type;
  }
  // Fallback: first non-empty line
  const firstLine = body.split('\n').find((l) => l.trim().length > 0) || '';
  return truncate(firstLine.replace(/^[-*#\s]+/, ''), 60);
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function projectLabel(cwd) {
  if (!cwd) return '';
  const name = path.basename(cwd);
  return name || cwd;
}

function main() {
  const input = safeParse(readStdinSync());
  const sessionId = input.session_id || input.sessionId || process.env.CLAUDE_SESSION_ID || 'default';
  const cwd = input.cwd || input.workspace?.current_dir || process.cwd();
  const model = input.model?.display_name || input.model?.id || 'claude';

  const session = loadSession(sessionId);
  const zone = zoneFor(session.tokens);
  const projectDir = resolveProjectDir(cwd);
  const task = loadCurrentTask(projectDir);

  const parts = [];
  parts.push(`${C.bold}${model}${C.reset}`);
  parts.push(`${C.cyan}${projectLabel(cwd)}${C.reset}`);

  // Token zone with colored bar + label
  const tokenText = session.tokens > 0
    ? `${zone.icon} ${fmtTokens(session.tokens)} tok`
    : `${zone.icon} idle`;
  parts.push(`${zone.color}${tokenText}${C.reset}`);

  // Tool count
  if (session.tools > 0) {
    const label = session.tools === 1 ? 'tool' : 'tools';
    parts.push(`${C.dim}${session.tools} ${label}${C.reset}`);
  }

  // Task
  if (!COMPACT && task) {
    parts.push(`${C.dim}${task}${C.reset}`);
  }

  // Join with a bullet so it reads cleanly at small widths.
  const line = parts.join(` ${C.gray}·${C.reset} `);
  process.stdout.write(line);
}

try {
  main();
} catch {
  // Never crash the status bar.
  process.stdout.write('claude');
}
