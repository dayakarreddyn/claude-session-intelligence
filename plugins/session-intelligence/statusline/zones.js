'use strict';

// Context-bar zone thresholds: fractions of the resolved window (or absolute,
// per statusline.zoneMode) via the shared getZoneThresholds, then (fraction mode
// only) replaced by the adaptive learner's zones whenever it reports a fit. This is the exact
// behaviour main() had inline before the split.

const { loadSharedConfig } = require('./lib-loader');

function resolveZones(cfg, { cap, cwd, history, adaptiveZones } = {}) {
  let zones = cfg.zones;
  let source = cfg.zoneMode === 'absolute' ? 'absolute' : 'fraction';
  try {
    const shared = loadSharedConfig();
    if (shared && typeof shared.getZoneThresholds === 'function') {
      const base = shared.getZoneThresholds({ statusline: cfg }, { cap });
      zones = { yellow: base.yellow, orange: base.orange, red: base.red };
    }
  } catch { /* keep static zones on error */ }
  // Absolute mode: the user's thresholds are authoritative; the learner never replaces them.
  if (source === 'absolute') return { ...zones, source };
  try {
    if (typeof adaptiveZones === 'function') {
      const adaptive = adaptiveZones(history, zones, { cwd, cap });
      if (adaptive && adaptive.adaptive) {
        zones = { yellow: adaptive.yellow, orange: adaptive.orange, red: adaptive.red };
        source = 'adaptive';
      }
    }
  } catch { /* best effort — keep static zones on error */ }
  return { ...zones, source };
}

module.exports = { resolveZones };
