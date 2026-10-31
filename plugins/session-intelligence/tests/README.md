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

- **Statusline layout beyond the goldens** — `statusline-golden.test.js`
  renders every payload in `fixtures/statusline/payloads/` and diffs against
  `fixtures/statusline/golden/`. Renders run with the wall clock pinned to
  2026-10-21 09:01 UTC (`helpers/freeze-clock.js`, preloaded via `node -r`),
  so the captured `resets_at` epochs stay in the future and `r:<dur>` cells
  never rot. Regenerate after an intentional layout change with
  `UPDATE_GOLDEN=1 node --test tests/statusline-golden.test.js`.
- **Hook entry points** (`hooks/si-*.js`) — those are CLI scripts. Tests
  would need to fork + pipe, which adds runtime + flakiness. Their
  business logic is already covered via the modules they import.

## Node version matrix

The events store falls back from `better-sqlite3` to `node:sqlite` when the
native binary does not match the running Node ABI. The fallback path only runs
under Node 22.13+, so run both before shipping anything that touches
`lib/sqlite-driver.js` or `lib/events.js`:

```bash
npm test            # Node 20 (better-sqlite3 path; node:sqlite tests skip)
npm run test:node22 # Node 22 via mise (automatic node:sqlite fallback)
npm run test:matrix # both
```
