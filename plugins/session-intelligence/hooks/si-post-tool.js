#!/usr/bin/env node
/**
 * PostToolUse dispatcher — runs token-budget, tool-archive, prune-output,
 * agent-tracker, and suggest-compact sequentially in a single hook entry so Claude Code only emits one
 * "Async hook PostToolUse completed" notice per tool call instead of three.
 *
 * Each child reads the same stdin payload and writes user-visible feedback to
 * stderr. Only si-prune-output emits stdout JSON (updatedToolOutput), which is
 * captured and forwarded; other children's stdout is ignored. Failures in any
 * child are swallowed: a broken sub-hook must never block tool execution.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CHILDREN = [
  'si-token-budget.js',
  'si-tool-archive.js',
  'si-prune-output.js',
  'si-agent-tracker.js',
  'si-suggest-compact.js',
];

const PRUNE_CHILD = 'si-prune-output.js';
const NUDGE_CHILD = 'si-suggest-compact.js';
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const MAX_CONTEXT_CHARS = 9000;

function main() {
  let stdin = '';
  try { stdin = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }

  // PostToolUse exit 2 is the magic code that tells Claude Code to surface
  // a child hook's stderr to the assistant as feedback (vs. silent log).
  // si-suggest-compact relies on it for zone-crossover nudges. The dispatcher
  // must propagate the highest meaningful exit code from any child, otherwise
  // exit 0 here masks the child's exit 2 and the nudge never surfaces.
  let dispatchExit = 0;
  let pruneJson = null;
  let callout = '';

  for (const name of CHILDREN) {
    const script = path.join(__dirname, name);
    if (!fs.existsSync(script)) continue;
    const isPrune = name === PRUNE_CHILD;
    const isNudge = name === NUDGE_CHILD;
    try {
      const r = spawnSync(process.execPath, [script], {
        input: stdin,
        // prune stdout is the JSON channel; the nudge's stderr is held back so
        // it can be merged into that JSON. Everything else keeps today's wiring.
        stdio: ['pipe', isPrune ? 'pipe' : 'ignore', isNudge ? 'pipe' : 'inherit'],
        encoding: 'utf8',
        timeout: 10_000,
      });
      if (isPrune && r && r.status === 0) pruneJson = parsePruneOutput(r.stdout);
      if (isNudge && r) callout = typeof r.stderr === 'string' ? r.stderr : '';
      if (r && r.status === 2) dispatchExit = 2;
    } catch {
      // Best-effort — never fail the dispatcher.
    }
  }

  if (pruneJson && dispatchExit === 2) {
    // exit 2 would discard the JSON, so fold the callout into it and exit 0.
    const merged = {
      hookSpecificOutput: {
        ...pruneJson,
        additionalContext: callout.replace(ANSI_RE, '').trim().slice(0, MAX_CONTEXT_CHARS),
      },
    };
    process.stdout.write(JSON.stringify(merged));
    process.exit(0);
  }
  if (callout) process.stderr.write(callout);
  if (pruneJson) process.stdout.write(JSON.stringify({ hookSpecificOutput: pruneJson }));
  process.exit(dispatchExit);
}

function parsePruneOutput(stdout) {
  if (!stdout || !stdout.trim()) return null;
  try {
    const parsed = JSON.parse(stdout);
    const h = parsed && parsed.hookSpecificOutput;
    return h && typeof h.updatedToolOutput === 'string' ? h : null;
  } catch { return null; }
}

try { main(); } catch { process.exit(0); }
