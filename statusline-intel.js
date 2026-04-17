#!/usr/bin/env node
/**
 * Claude Code statusLine — Session Intelligence view (v2)
 *
 * Reads stdin JSON (provided by Claude Code):
 *   { session_id, transcript_path, cwd, model: { display_name }, ... }
 *
 * Prints a configurable single status line. Fields, colors, token source,
 * and zone thresholds are all configurable via:
 *
 *   ~/.claude/statusline-intel.json   — persistent config (takes precedence over defaults)
 *   env vars                          — override config for this session
 *
 * See README.md for the full field catalog.
 *
 * Silent fallback: if anything goes wrong, prints a minimal "claude" so the
 * status line never shows broken.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// ─── Config ──────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  fields: ['emoji', 'model', 'project', 'tokens', 'tools', 'task'],
  tokenSource: 'auto',              // 'auto' | 'transcript' | 'estimate'
  zones: { yellow: 200000, orange: 300000, red: 400000 },
  maxTaskLength: 60,
  separator: ' · ',
  colors: true,
  serviceHealth: [],                // [{ name, url, ttlSec?, timeoutMs? }]
};

function loadConfig() {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const configPath = path.join(home, '.claude', 'statusline-intel.json');

  let cfg = { ...DEFAULT_CONFIG };
  try {
    if (fs.existsSync(configPath)) {
      const user = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      cfg = { ...cfg, ...user, zones: { ...cfg.zones, ...(user.zones || {}) } };
    }
  } catch { /* invalid JSON — ignore, use defaults */ }

  // Env overrides — useful for one-off testing / mode switching.
  if (process.env.CLAUDE_STATUSLINE_FIELDS) {
    cfg.fields = process.env.CLAUDE_STATUSLINE_FIELDS
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (process.env.CLAUDE_STATUSLINE_TOKEN_SOURCE) {
    cfg.tokenSource = process.env.CLAUDE_STATUSLINE_TOKEN_SOURCE;
  }
  if (process.env.CLAUDE_STATUSLINE_SEP_INLINE) {
    cfg.separator = process.env.CLAUDE_STATUSLINE_SEP_INLINE;
  }
  if (process.env.NO_COLOR === '1' || process.env.CLAUDE_STATUSLINE_NO_COLOR === '1') {
    cfg.colors = false;
  }
  if (process.env.CLAUDE_STATUSLINE_COMPACT === '1') {
    cfg.fields = cfg.fields.filter((f) => f !== 'task');
  }

  return cfg;
}

// ─── Colors ──────────────────────────────────────────────────────────────────

function makeColors(enabled) {
  const code = (c) => (enabled ? c : '');
  return {
    reset:  code('\x1b[0m'),
    dim:    code('\x1b[2m'),
    bold:   code('\x1b[1m'),
    green:  code('\x1b[32m'),
    yellow: code('\x1b[33m'),
    orange: code('\x1b[38;5;208m'),
    red:    code('\x1b[31m'),
    blue:   code('\x1b[34m'),
    gray:   code('\x1b[90m'),
    cyan:   code('\x1b[36m'),
    magenta: code('\x1b[35m'),
  };
}

// ─── stdin ───────────────────────────────────────────────────────────────────

function readStdinSync() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function safeParse(raw) {
  try { return raw.trim() ? JSON.parse(raw) : {}; } catch { return {}; }
}

// ─── Token sources ───────────────────────────────────────────────────────────

/**
 * Parse the tail of a Claude Code transcript jsonl and return the most recent
 * assistant message's usage block. Usage is the authoritative context size.
 */
function readTranscriptUsage(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

  try {
    const stat = fs.statSync(transcriptPath);
    const SCAN_BYTES = Math.min(stat.size, 512 * 1024); // 512 KB tail
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(SCAN_BYTES);
      fs.readSync(fd, buf, 0, SCAN_BYTES, stat.size - SCAN_BYTES);
      const text = buf.toString('utf8');
      const lines = text.split('\n').filter(Boolean);

      // Walk backwards for most recent assistant message with usage
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const d = JSON.parse(lines[i]);
          const msg = d && d.message;
          if (msg && typeof msg === 'object' && msg.usage) {
            return msg.usage;
          }
        } catch { /* partial line on boundary */ }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* silent */ }
  return null;
}

/**
 * Total context size in tokens from a usage block.
 * cache_read is counted because it's in the context window, just billed cheaper.
 */
function totalTokensFromUsage(u) {
  if (!u) return 0;
  return (
    (u.input_tokens || 0) +
    (u.cache_creation_input_tokens || 0) +
    (u.cache_read_input_tokens || 0)
  );
}

function readIntFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch { return 0; }
}

function loadEstimate(sessionId) {
  const tmp = os.tmpdir();
  const ids = [sessionId, 'default'].filter(Boolean);
  for (const id of ids) {
    const sid = String(id).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!sid) continue;
    const budget = path.join(tmp, `claude-token-budget-${sid}`);
    const count  = path.join(tmp, `claude-tool-count-${sid}`);
    if (fs.existsSync(budget) || fs.existsSync(count)) {
      return { tokens: readIntFile(budget), tools: readIntFile(count), id: sid };
    }
  }
  return { tokens: 0, tools: 0, id: sessionId || 'default' };
}

// ─── Git ─────────────────────────────────────────────────────────────────────

function gitBranch(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { encoding: 'utf8', timeout: 1000 }).trim();
  } catch { return ''; }
}

function gitDirtyCount(cwd) {
  try {
    const out = execFileSync('git', ['-C', cwd, 'status', '--porcelain'],
      { encoding: 'utf8', timeout: 1500 });
    return out.split('\n').filter(Boolean).length;
  } catch { return 0; }
}

/**
 * Git short diff stat: returns { added, deleted } across all tracked + untracked
 * working-tree changes. Uses --numstat across both tracked diff and untracked files.
 */
function gitDiffStat(cwd) {
  try {
    const tracked = execFileSync('git', ['-C', cwd, 'diff', '--numstat', 'HEAD'],
      { encoding: 'utf8', timeout: 2000 });
    let added = 0, deleted = 0;
    for (const line of tracked.split('\n')) {
      if (!line.trim()) continue;
      const [a, d] = line.split('\t');
      if (a !== '-') added += parseInt(a, 10) || 0;
      if (d !== '-') deleted += parseInt(d, 10) || 0;
    }
    return { added, deleted };
  } catch { return { added: 0, deleted: 0 }; }
}

/**
 * Parse a GH-style issue number from a branch name or the current-task text.
 * Supports: fix/164, fix-164, feat/164-foo, "#164 foo", "issue #164".
 */
function extractIssueNumber(branch, task) {
  const candidates = [branch || '', task || ''];
  for (const s of candidates) {
    const m = s.match(/#?(\d{2,6})\b/);
    if (m) return `#${m[1]}`;
  }
  return '';
}

// ─── Project memory ──────────────────────────────────────────────────────────

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
      if (cwd.startsWith(decoded)) return path.join(projectsDir, d.name);
    }
  } catch { /* ignore */ }
  return null;
}

function loadCurrentTask(projectDir, maxLen = 60) {
  if (!projectDir) return '';
  const file = path.join(projectDir, 'session-context.md');
  let content;
  try { content = fs.readFileSync(file, 'utf8'); } catch { return ''; }

  const match = content.match(/##\s+Current Task\s*([\s\S]*?)(?=\n##\s|$)/);
  if (!match) return '';

  const body = match[1].trim();
  const typeMatch = body.match(/^type:\s*([^\n\u2014-]+)(?:[\u2014-]\s*(.+))?/m);
  if (typeMatch) {
    const type = typeMatch[1].trim();
    const desc = (typeMatch[2] || '').trim();
    if (type && desc) return truncate(`${type} \u2014 ${desc}`, maxLen);
    if (type) return truncate(type, maxLen);
  }
  const firstLine = body.split('\n').find((l) => l.trim().length > 0) || '';
  return truncate(firstLine.replace(/^[-*#\s]+/, ''), maxLen);
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

function zoneFor(tokens, zones) {
  if (tokens >= zones.red)    return { name: 'red',    color: 'red',    icon: '▰▰▰▰' };
  if (tokens >= zones.orange) return { name: 'orange', color: 'orange', icon: '▰▰▰▱' };
  if (tokens >= zones.yellow) return { name: 'yellow', color: 'yellow', icon: '▰▰▱▱' };
  return { name: 'green', color: 'green', icon: '▰▱▱▱' };
}

function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
}

function projectLabel(cwd) {
  if (!cwd) return '';
  const name = path.basename(cwd);
  return name || cwd;
}

function fmtDuration(ms) {
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

// ─── Compaction ──────────────────────────────────────────────────────────────

function minutesSinceLastCompact() {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const log = path.join(home, '.claude', 'session-data', 'compaction-log.txt');
  try {
    const stat = fs.statSync(log);
    return Math.floor((Date.now() - stat.mtimeMs) / 60000);
  } catch { return null; }
}

// ─── Deploy breadcrumb ───────────────────────────────────────────────────────
// Single-line file: "<target> <iso-ts>". Any CI/script can write it:
//   echo "gateway $(date -u +%FT%TZ)" > ~/.claude/logs/deploy-breadcrumb
function readDeployBreadcrumb() {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const file = path.join(home, '.claude', 'logs', 'deploy-breadcrumb');
  try {
    const line = fs.readFileSync(file, 'utf8').trim();
    const [target, ts] = line.split(/\s+/);
    if (!target || !ts) return null;
    const ageMs = Date.now() - new Date(ts).getTime();
    if (!Number.isFinite(ageMs)) return null;
    return { target, ageMs };
  } catch { return null; }
}

// ─── Output style ────────────────────────────────────────────────────────────

function detectOutputStyle(input) {
  return input.output_style || input.outputStyle || process.env.CLAUDE_OUTPUT_STYLE || '';
}

// ─── Service health cache ────────────────────────────────────────────────────
// Config: serviceHealth: [{ name, url, ttlSec?, timeoutMs? }]
// Cache: /tmp/claude-health-<name>  ->  "<http_code> <epoch_ms>"

function readHealthCache(name) {
  try {
    const safe = String(name || '').replace(/[^a-zA-Z0-9_-]/g, '');
    const file = path.join(os.tmpdir(), `claude-health-${safe}`);
    const raw = fs.readFileSync(file, 'utf8').trim();
    const [status, ts] = raw.split(/\s+/);
    return { status, ts: parseInt(ts, 10) || 0 };
  } catch { return null; }
}

function probeHealthIfStale(svc) {
  const ttlSec = svc.ttlSec || 30;
  const cached = readHealthCache(svc.name);
  if (cached && (Date.now() - cached.ts) < ttlSec * 1000) return cached;
  if (!/^https?:\/\//i.test(svc.url || '')) return cached;

  const safe = String(svc.name || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const cacheFile = path.join(os.tmpdir(), `claude-health-${safe}`);
  const timeoutSec = Math.max(1, Math.floor((svc.timeoutMs || 2000) / 1000));

  // Detached, non-blocking probe — argv-style spawn, no shell interpolation.
  try {
    const { spawn } = require('child_process');
    const curl = spawn('curl', [
      '-s', '-o', '/dev/null',
      '-w', '%{http_code}',
      '--max-time', String(timeoutSec),
      svc.url,
    ], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });

    let out = '';
    curl.stdout.on('data', (c) => { out += c.toString('utf8'); });
    curl.on('close', () => {
      try {
        const code = (out.trim() || 'err').replace(/[^a-zA-Z0-9]/g, '');
        fs.writeFileSync(cacheFile, `${code} ${Date.now()}`, 'utf8');
      } catch { /* best effort */ }
    });
    curl.on('error', () => { /* curl missing — stay silent */ });
    curl.unref();
  } catch { /* best effort */ }

  return cached;
}

// ─── Intelligent emoji ───────────────────────────────────────────────────────
// Priority (first match wins):
//   🔥 red zone
//   ⚠️  orange zone
//   🚀 deploy breadcrumb < 15 min old
//   🐛 task mentions bug/fix/issue
//   🏗️ task mentions build/feat/add
//   ✏️  dirty working tree mid-task
//   🟡 yellow zone
//   ✨ clean idle — tree clean + green zone + idle task
//   🟢 fallback green
function pickEmoji(ctx, input) {
  const zone = zoneFor(ctx.tokens, ctx.cfg.zones).name;
  if (zone === 'red') return '🔥';
  if (zone === 'orange') return '⚠️';

  const deploy = readDeployBreadcrumb();
  if (deploy && deploy.ageMs < 15 * 60 * 1000) return '🚀';

  const task = (ctx.task || '').toLowerCase();
  if (/\b(bug|fix|issue|error|crash)\b/.test(task)) return '🐛';
  if (/\b(build|feat|add|implement|create)\b/.test(task)) return '🏗️';
  if (/\b(refactor|cleanup|simpl)\b/.test(task)) return '🧹';
  if (/\b(test|spec)\b/.test(task)) return '🧪';
  if (/\b(deploy|ship|release)\b/.test(task)) return '🚀';
  if (/\b(doc|readme)\b/.test(task)) return '📝';

  const dirty = gitDirtyCount(input.cwd || process.cwd());
  if (dirty > 0) return '✏️';

  if (zone === 'yellow') return '🟡';

  if (/\b(idle|done|clean|ended|ready)\b/.test(task)) return '✨';
  return '🟢';
}

// ─── Field renderers ─────────────────────────────────────────────────────────
// Each renderer returns a string (possibly with ANSI) or '' to skip.

function buildRenderers(C) {
  return {
    /** Intelligent leading emoji — picks based on zone, dirty tree, task intent, deploy. */
    emoji: (input, ctx) => pickEmoji(ctx, input),

    model: (input) => {
      const m = input.model?.display_name || input.model?.id || 'claude';
      return `${C.bold}${m}${C.reset}`;
    },

    project: (input) => `${C.cyan}${projectLabel(input.cwd)}${C.reset}`,

    branch: (input) => {
      const b = gitBranch(input.cwd);
      return b ? `${C.magenta}${b}${C.reset}` : '';
    },

    dirty: (input) => {
      const n = gitDirtyCount(input.cwd);
      if (n === 0) return '';
      return `${C.yellow}±${n}${C.reset}`;
    },

    tokens: (input, ctx) => {
      const t = ctx.tokens;
      const zone = zoneFor(t, ctx.cfg.zones);
      const color = C[zone.color] || C.reset;
      const label = t > 0 ? `${zone.icon} ${fmtTokens(t)}` : `${zone.icon} idle`;
      const sourceTag = ctx.cfg.tokenSource === 'estimate' || !ctx.usedTranscript
        ? `${C.dim}~${C.reset}` : '';
      return `${color}${sourceTag}${label}${C.reset}`;
    },

    zone: (input, ctx) => {
      const zone = zoneFor(ctx.tokens, ctx.cfg.zones);
      return `${C[zone.color] || ''}${zone.name}${C.reset}`;
    },

    tools: (_input, ctx) => {
      if (ctx.tools <= 0) return '';
      const label = ctx.tools === 1 ? 'tool' : 'tools';
      return `${C.dim}${ctx.tools} ${label}${C.reset}`;
    },

    session: (_input, ctx) => {
      if (!ctx.sessionDurationMs) return '';
      return `${C.dim}${fmtDuration(ctx.sessionDurationMs)}${C.reset}`;
    },

    task: (_input, ctx) => ctx.task ? `${C.dim}${ctx.task}${C.reset}` : '',

    cost: (_input, ctx) => {
      if (!ctx.costUsd) return '';
      return `${C.dim}$${ctx.costUsd.toFixed(2)}${C.reset}`;
    },

    /**
     * Git diff-stat: (+N,-M) across all uncommitted changes in HEAD + untracked.
     * Skipped silently when clean.
     */
    diffstat: (input, _ctx) => {
      const s = gitDiffStat(input.cwd);
      if (!s.added && !s.deleted) return '';
      return `${C.dim}(${C.green}+${s.added}${C.dim},${C.red}-${s.deleted}${C.dim})${C.reset}`;
    },

    /** GH issue number (#164) parsed from branch or current task. */
    issue: (input, ctx) => {
      const branch = gitBranch(input.cwd);
      const iss = extractIssueNumber(branch, ctx.task);
      return iss ? `${C.magenta}${iss}${C.reset}` : '';
    },

    /** Minutes since last compaction event (pre-compact hook timestamps). */
    compactAge: (_input, _ctx) => {
      const mins = minutesSinceLastCompact();
      if (mins === null) return '';
      const label = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60}m`;
      return `${C.dim}compact:${label}ago${C.reset}`;
    },

    /** Last deploy target + how fresh, read from ~/.claude/logs/deploy-breadcrumb. */
    deploy: (_input, _ctx) => {
      const b = readDeployBreadcrumb();
      if (!b) return '';
      const mins = Math.floor(b.ageMs / 60000);
      const when = mins < 1 ? 'now' : mins < 60 ? `${mins}m ago` : `${Math.floor(mins / 60)}h${mins % 60}m ago`;
      return `${C.dim}deploy:${b.target} ${when}${C.reset}`;
    },

    /** Output style indicator — explanatory, default, etc. */
    outputStyle: (input, _ctx) => {
      const s = detectOutputStyle(input);
      return s ? `${C.blue}style:${s}${C.reset}` : '';
    },

    /** Colored dot per configured service URL; polls in background, reads cache. */
    health: (_input, ctx) => {
      const services = (ctx.cfg.serviceHealth || []);
      if (!services.length) return '';
      const dots = services.map((svc) => {
        const cached = probeHealthIfStale(svc);
        if (!cached) return `${C.gray}○${C.reset}`;
        const code = cached.status;
        const ok = /^2\d\d$/.test(code);
        const redirect = /^3\d\d$/.test(code);
        const color = ok ? C.green : (redirect ? C.yellow : C.red);
        return `${color}●${C.reset}`;
      });
      return `${C.dim}[${C.reset}${dots.join('')}${C.dim}]${C.reset}`;
    },
  };
}

// ─── Cost estimation ─────────────────────────────────────────────────────────
// Prices are per million tokens. Kept loose — user can override via config.
const DEFAULT_PRICES = {
  // Claude Opus 4.x approximations (USD per 1M tokens)
  input: 15,
  cache_creation: 18.75,
  cache_read: 1.5,
  output: 75,
};

function costFromUsage(u, prices = DEFAULT_PRICES) {
  if (!u) return 0;
  const per = (n, p) => ((n || 0) / 1_000_000) * p;
  return per(u.input_tokens, prices.input)
       + per(u.cache_creation_input_tokens, prices.cache_creation)
       + per(u.cache_read_input_tokens, prices.cache_read)
       + per(u.output_tokens, prices.output);
}

// ─── Session duration ────────────────────────────────────────────────────────

function readSessionStartTime(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  try {
    // Just first few KB — first line is typically the session-start event.
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(Math.min(4096, fs.statSync(transcriptPath).size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      const firstLine = buf.toString('utf8').split('\n')[0];
      const d = JSON.parse(firstLine);
      const ts = d.timestamp || d.message?.timestamp;
      if (ts) return new Date(ts).getTime();
    } finally { fs.closeSync(fd); }
  } catch { /* ignore */ }
  return null;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  const cfg = loadConfig();
  const C = makeColors(cfg.colors);
  const input = safeParse(readStdinSync());
  const sessionId = input.session_id || input.sessionId || process.env.CLAUDE_SESSION_ID || 'default';
  const cwd = input.cwd || input.workspace?.current_dir || process.cwd();
  const transcriptPath = input.transcript_path || input.transcriptPath;

  // Token source resolution.
  let tokens = 0;
  let usedTranscript = false;
  let usage = null;
  if (cfg.tokenSource !== 'estimate') {
    usage = readTranscriptUsage(transcriptPath);
    const fromTranscript = totalTokensFromUsage(usage);
    if (fromTranscript > 0) {
      tokens = fromTranscript;
      usedTranscript = true;
    }
  }
  // Estimate tool count always; tokens fall through to estimate when transcript absent or disabled.
  const estimate = loadEstimate(sessionId);
  if (!usedTranscript && cfg.tokenSource !== 'transcript') {
    tokens = estimate.tokens;
  }

  // Session duration from transcript's first timestamp.
  let sessionDurationMs = 0;
  if (cfg.fields.includes('session')) {
    const start = readSessionStartTime(transcriptPath);
    if (start) sessionDurationMs = Date.now() - start;
  }

  // Cost from transcript usage.
  let costUsd = 0;
  if (cfg.fields.includes('cost') && usage) {
    costUsd = costFromUsage(usage, cfg.prices || DEFAULT_PRICES);
  }

  const projectDir = resolveProjectDir(cwd);
  const task = cfg.fields.includes('task')
    ? loadCurrentTask(projectDir, cfg.maxTaskLength || 60)
    : '';

  const ctx = {
    cfg,
    tokens,
    tools: estimate.tools,
    task,
    sessionDurationMs,
    costUsd,
    usedTranscript,
    usage,
  };

  const renderers = buildRenderers(C);
  const sep = `${C.gray}${cfg.separator}${C.reset}`;

  // Split fields on 'newline' pseudo-field so users can lay out multi-line
  // status bars, e.g. fields: ['emoji','model','project','newline','branch','tokens','cost'].
  const groups = [[]];
  for (const name of cfg.fields) {
    if (name === 'newline') groups.push([]);
    else groups[groups.length - 1].push(name);
  }

  const renderGroup = (group) => {
    const rendered = group
      .map((name) => {
        const fn = renderers[name];
        if (!fn) return { name, text: '' };
        try { return { name, text: fn(input, ctx) || '' }; }
        catch { return { name, text: '' }; }
      })
      .filter((r) => r.text && r.text.length > 0);

    if (rendered.length === 0) return '';

    // Leading emoji sits flush against the next field (single space, no bullet).
    let leading = '';
    let rest = rendered;
    if (rendered[0].name === 'emoji') {
      leading = rendered[0].text + ' ';
      rest = rendered.slice(1);
    }
    return leading + rest.map((r) => r.text).join(sep);
  };

  const lines = groups.map(renderGroup).filter((l) => l.length > 0);

  // If line 1 starts with the intelligent emoji (2-col wide + 1 space = 3 cells),
  // indent subsequent lines by the same width so columns align visually.
  const firstLineHasEmoji = groups.length > 0 && groups[0][0] === 'emoji';
  const indent = firstLineHasEmoji ? '   ' : '';
  const finalLines = lines.map((l, i) => (i === 0 ? l : indent + l));

  process.stdout.write(finalLines.length ? finalLines.join('\n') : 'claude');
}

try { main(); } catch { process.stdout.write('claude'); }
