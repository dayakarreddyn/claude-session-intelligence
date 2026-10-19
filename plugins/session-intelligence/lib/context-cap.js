/**
 * Shared context-window resolver. Lifted from the statusline so hooks and the
 * statusline measure fill against the same real model window.
 */

const fs = require('fs');
const path = require('path');
const { getHomeDir } = require('./utils');

const DEFAULT_CAP = 200000;
const WINDOW_1M = 1000000;
const AUTOCOMPACT_BUFFER = 33000;
const BUCKET_STEP = 5;
const FAMILY_ALIASES = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'];

const MARKER_1M = /\[1m\]|-1m\b|\b1m\b|1000k|1000000/i;
const FAMILY_1M = /fable|mythos|opus[\s-]?(4[\s.-]?[7-9]|[5-9])|sonnet[\s-]?[5-9]|haiku[\s-]?5[\s.-]?5/i;

function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function isNative1M(model) {
  const id = String(model || '');
  return MARKER_1M.test(id) || FAMILY_1M.test(id);
}

function resolveContextCap({ model, env = {}, contextWindowSize, configCap } = {}) {
  const fromConfig = positiveInt(configCap);
  if (fromConfig) return { cap: fromConfig, source: 'config' };
  const fromStatusline = positiveInt(contextWindowSize);
  if (fromStatusline) return { cap: fromStatusline, source: 'statusline' };

  const native = isNative1M(model);
  if (native && env.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1') {
    return { cap: DEFAULT_CAP, source: 'env-disable-1m' };
  }
  const maxTokens = positiveInt(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS);
  if (maxTokens && (!native || env.DISABLE_COMPACT === '1')) {
    return { cap: maxTokens, source: 'env-max-context' };
  }
  if (native) return { cap: WINDOW_1M, source: 'model' };
  return { cap: DEFAULT_CAP, source: 'fallback' };
}

function modelSettingsWindow(settings, model) {
  const table = settings && settings.modelSettings;
  if (!table || typeof table !== 'object') return null;
  const id = String(model || '').toLowerCase();
  const family = FAMILY_ALIASES.find((f) => id.includes(f));
  for (const key of [model, id, family]) {
    const entry = key && table[key];
    const value = entry && positiveInt(entry.autoCompactWindow);
    if (value) return value;
  }
  return null;
}

function resolveAutoCompactPoint({ cap, model, env = {}, settings } = {}) {
  const clamp = (n) => Math.min(n, cap);
  const defaultPoint = cap > DEFAULT_CAP ? cap - AUTOCOMPACT_BUFFER : cap;

  const envWindow = positiveInt(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  if (envWindow) return { point: clamp(envWindow), source: 'env' };
  const pct = Number(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE);
  if (Number.isFinite(pct) && pct > 0 && pct <= 100) {
    return { point: clamp(Math.round((defaultPoint * pct) / 100)), source: 'env-pct' };
  }
  const perModel = modelSettingsWindow(settings, model);
  if (perModel) return { point: clamp(perModel), source: 'model-settings' };
  const global = settings && positiveInt(settings.autoCompactWindow);
  if (global) return { point: clamp(global), source: 'settings' };
  return { point: defaultPoint, source: 'default' };
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function loadSettingsForCwd(cwd) {
  const files = [
    path.join(getHomeDir(), '.claude', 'settings.json'),
    cwd && path.join(cwd, '.claude', 'settings.json'),
    cwd && path.join(cwd, '.claude', 'settings.local.json'),
  ].filter(Boolean);
  return files.reduce((acc, file) => ({ ...acc, ...readJson(file) }), {});
}

function fillPctOf(tokens, cap) {
  if (!(cap > 0) || !(tokens > 0)) return 0;
  return Math.round((tokens / cap) * 1000) / 10;
}

function bucketPct(pct) {
  return Math.floor(pct / BUCKET_STEP) * BUCKET_STEP;
}

function windowLabel(cap) {
  return cap >= WINDOW_1M ? `${Math.round(cap / WINDOW_1M)}M` : `${Math.round(cap / 1000)}k`;
}

module.exports = {
  DEFAULT_CAP, WINDOW_1M, AUTOCOMPACT_BUFFER, BUCKET_STEP,
  resolveContextCap, resolveAutoCompactPoint, loadSettingsForCwd,
  isNative1M, fillPctOf, bucketPct, windowLabel,
};
