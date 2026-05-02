#!/usr/bin/env node
/**
 * PostToolUse dispatcher — runs token-budget, tool-archive, and suggest-compact
 * sequentially in a single hook entry so Claude Code only emits one
 * "Async hook PostToolUse completed" notice per tool call instead of three.
 *
 * Each child reads the same stdin payload and writes user-visible feedback to
 * stderr (none of them emit hookSpecificOutput JSON on stdout — verified before
 * collapsing). We forward stderr verbatim and ignore stdout. Failures in any
 * child are swallowed: a broken sub-hook must never block tool execution.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CHILDREN = [
  'si-token-budget.js',
  'si-tool-archive.js',
  'si-suggest-compact.js',
];

function main() {
  let stdin = '';
  try { stdin = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }

  // PostToolUse exit 2 is the magic code that tells Claude Code to surface
  // a child hook's stderr to the assistant as feedback (vs. silent log).
  // si-suggest-compact relies on it for zone-crossover nudges. The dispatcher
  // must propagate the highest meaningful exit code from any child, otherwise
  // exit 0 here masks the child's exit 2 and the nudge never surfaces.
  let dispatchExit = 0;

  for (const name of CHILDREN) {
    const script = path.join(__dirname, name);
    if (!fs.existsSync(script)) continue;
    try {
      const r = spawnSync(process.execPath, [script], {
        input: stdin,
        stdio: ['pipe', 'ignore', 'inherit'],
        timeout: 10_000,
      });
      if (r && r.status === 2) dispatchExit = 2;
    } catch {
      // Best-effort — never fail the dispatcher.
    }
  }
  process.exit(dispatchExit);
}

try { main(); } catch { process.exit(0); }
