'use strict';

// Preloaded with `node -r` into every statusline render the tests spawn, so
// each render sees the same wall clock. Golden payloads carry real `resets_at`
// epochs from the day they were captured; without a pinned "now" the
// `r:<dur>` cells vanish as soon as those instants pass and the goldens rot.
// Test-only: production never sets SI_TEST_FROZEN_NOW_MS.

const frozen = Number(process.env.SI_TEST_FROZEN_NOW_MS);
if (Number.isFinite(frozen) && frozen > 0) {
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [frozen])); }
    static now() { return frozen; }
  }
  globalThis.Date = FrozenDate;
}
