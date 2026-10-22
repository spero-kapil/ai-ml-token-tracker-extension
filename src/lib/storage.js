import { DEFAULT_SETTINGS, STALE_AFTER_MS, STORAGE_KEYS } from './constants.js';
import { limitsOf, primaryLimit } from './usage.js';

export const EMPTY_STATE = Object.freeze({
  data: null,          // { limits, account, plan, source, pageUrl?, fetchedAt } (see usage.js)
  profile: null,       // { account, plan, at } from the sidebar on any chatgpt.com page
  error: null,         // { code, message, at }
  lastAttemptAt: null,
  refreshing: false
});

export async function getState() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.state);
  return { ...EMPTY_STATE, ...(stored[STORAGE_KEYS.state] || {}) };
}

export async function patchState(patch) {
  const next = { ...(await getState()), ...patch };
  await chrome.storage.local.set({ [STORAGE_KEYS.state]: next });
  return next;
}

function mergeSettings(stored = {}) {
  const providers = { ...DEFAULT_SETTINGS.providers };
  for (const [id, value] of Object.entries(stored.providers || {})) {
    providers[id] = { ...providers[id], ...value };
  }
  return { ...DEFAULT_SETTINGS, ...stored, providers };
}

export async function getSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return mergeSettings(stored[STORAGE_KEYS.settings]);
}

export async function saveSettings(settings) {
  const current = await getSettings();
  const next = mergeSettings({ ...current, ...settings, providers: { ...current.providers, ...settings.providers } });
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
  return next;
}

export const isProviderEnabled = (settings, id) => Boolean(settings.providers?.[id]?.enabled);

export function setProviderEnabled(id, enabled) {
  return saveSettings({ providers: { [id]: { enabled } } });
}

export function isStale(state, now = Date.now()) {
  if (!state?.data?.fetchedAt) return false;
  if (now - state.data.fetchedAt > STALE_AFTER_MS) return true;
  // A reset of the main allowance that has already passed means it is outdated.
  const resetAt = primaryLimit(limitsOf(state.data))?.resetAt;
  return typeof resetAt === 'number' && resetAt < now && state.data.fetchedAt < resetAt;
}
