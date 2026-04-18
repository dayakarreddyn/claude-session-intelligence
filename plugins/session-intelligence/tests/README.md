# Session-Intelligence — tests

Lightweight test suite for the hot-path modules. Uses Node's built-in
`node:test` runner (Node 18+) — no external dependencies, no package.json.

## Run

```bash
# From the plugin root (plugins/session-intelligence/)
node --test tests/
```

That runs every `*.test.js` file in this directory. Expect all tests to
pass; if any fail, the return code is non-zero and the specific assertion
is printed.

### Run a single file

```bash
node --test tests/session-context.test.js
```

## What's covered

| File | Target | Fixes it guards |
|------|--------|-----------------|
| `session-context.test.js` | `lib/session-context.js` | C1 autofill mask, H1 placeholder strip alignment |
| `handoff.test.js` | `lib/handoff.js` | C1/H3 strong-signal gate, M1 truncation sentinel, M4 atomic consume, stale handoff cleanup |
| `context-shape.test.js` | `lib/context-shape.js` | M2 shift-window guard for small sessions |

## What's intentionally NOT covered

- **Statusline rendering** — integration/visual; covered ad-hoc by running
  `plugins/session-intelligence/statusline/statusline-intel.js` against a
  fixture stdin JSON.
- **Hook entry points** (`hooks/si-*.js`) — those are CLI scripts. Tests
  would need to fork + pipe, which adds runtime + flakiness. Their
  business logic is already covered via the modules they import.
- **Token budget zone resolution** — lives inside `si-token-budget.js` as
  a local helper. Worth extracting to `lib/zones.js` next time it changes,
  at which point it earns a test file.
