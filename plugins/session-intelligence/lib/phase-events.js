/**
 * Phase-event detection.
 *
 * A "phase event" is a git/PR action that marks a safe compaction boundary:
 * commit, push, PR create/merge, tag cut. When we see one we record it on
 * the shape log so the /compact injection can annotate recent events
 * ("safe to snapshot at ~150k tokens where commit happened").
 *
 * Two signal sources:
 *
 *   1. **Command parse.** The canonical case — `git commit`, `git push`,
 *      `gh pr create`. Catches any invocation that goes through Bash.
 *
 *   2. **Output parse.** Wrappers (`git cz`, `gh copilot git-command`,
 *      shell aliases, IDE-driven commits surfaced via Bash) won't match
 *      the command regex but their output still looks like git output.
 *      Example patterns:
 *        - `"[main abc1234]"` — commit summary line
 *        - `"To github.com:..."` — push summary line
 *        - `"Merge pull request #"` — PR merge line
 *
 * Returns `null` when no phase event is detected.
 */

const COMMIT_CMD = /^\s*git\s+(commit|tag|merge\b(?!\s+--no-commit))/;
const PUSH_CMD = /^\s*git\s+push\b/;
const PR_CMD = /^\s*gh\s+pr\s+(create|merge|close|review\s+--approve)\b/;
const REBASE_CONT = /^\s*git\s+rebase\s+--continue\b/;

const COMMIT_OUT = /(^|\n)\[[\w/.-]+\s+(?:\(root-commit\)\s+)?[0-9a-f]{7,}\]/;
const PUSH_OUT = /(^|\n)To\s+(?:[\w.-]+@)?(?:github\.com|gitlab\.com|bitbucket\.org|ssh:\/\/|https?:\/\/)/i;
const PR_OUT = /(^|\n)https?:\/\/github\.com\/[\w./-]+\/pull\/\d+|Merge pull request #\d+/;

function detectFromCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd) return null;
  if (COMMIT_CMD.test(cmd)) return 'commit';
  if (PUSH_CMD.test(cmd)) return 'push';
  if (PR_CMD.test(cmd)) return 'pr';
  if (REBASE_CONT.test(cmd)) return 'commit';
  return null;
}

function detectFromOutput(output) {
  if (typeof output !== 'string' || !output) return null;
  // Order matters: PR merge often includes a push summary downstream, but the
  // merge is the more informative label so check PR first.
  if (PR_OUT.test(output)) return 'pr';
  if (PUSH_OUT.test(output)) return 'push';
  if (COMMIT_OUT.test(output)) return 'commit';
  return null;
}

/**
 * Detect a phase event from a PostToolUse payload.
 *
 * @param {string} toolName
 * @param {object} toolInput   — parsedInput.tool_input
 * @param {string|object} toolOutput — parsedInput.tool_output (may be a
 *   string or a content array from Claude Code's newer payload shape)
 * @returns {'commit'|'push'|'pr'|null}
 */
function detectPhaseEvent(toolName, toolInput, toolOutput) {
  if (toolName !== 'Bash' && toolName !== 'bash') return null;

  const cmd = (toolInput && toolInput.command) || '';
  const fromCmd = detectFromCommand(cmd);
  if (fromCmd) return fromCmd;

  let outputStr = '';
  if (typeof toolOutput === 'string') {
    outputStr = toolOutput;
  } else if (toolOutput && typeof toolOutput === 'object') {
    outputStr = JSON.stringify(toolOutput);
  }
  return detectFromOutput(outputStr);
}

module.exports = {
  detectPhaseEvent,
  detectFromCommand,
  detectFromOutput,
};
