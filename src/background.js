import {
  ALARM_NAME,
  ERROR_CODES,
  FETCH_TIMEOUT_MS,
  LOGIN_PAGE_URL,
  REFRESH_PERIOD_MINUTES,
  STORAGE_KEYS,
  TAB_EXTRACT_TIMEOUT_MS,
  USAGE_PAGE_MATCH,
  USAGE_PAGE_URL
} from './lib/constants.js';
import { clearLog, flushLog, installGlobalErrorHandlers, logError, persistLogEntry } from './lib/logger.js';
import { normalizeEndpointPayload } from './lib/normalize.js';
import { pushUsage } from './lib/server-sync.js';
import { getSettings, getState, isProviderEnabled, isStale, patchState } from './lib/storage.js';
import { limitsOf, normalizePlan, primaryLimit } from './lib/usage.js';

const PROVIDER_ID = 'chatgpt';

class UsageError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

installGlobalErrorHandlers('background');
// Send entries logged while the log receiver was not running.
flushLog();

// ---------------------------------------------------------------------------
// Scheduling

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing || existing.periodInMinutes !== REFRESH_PERIOD_MINUTES) {
    await chrome.alarms.create(ALARM_NAME, { delayInMinutes: 1, periodInMinutes: REFRESH_PERIOD_MINUTES });
  }
}

const reportFailure = (scope) => (error) => logError(scope, error);

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm().catch(reportFailure('background:alarm'));
  injectIntoOpenTabs()
    .catch(reportFailure('background:inject'))
    .finally(() => refresh({ trigger: 'install' }));
});

// Chrome only injects content scripts into pages loaded after install, so tabs
// that were already open would otherwise keep a disconnected copy. The
// page-world hook is skipped: it must run before the page loads to be useful.
async function injectIntoOpenTabs() {
  const { js: files } = chrome.runtime.getManifest().content_scripts.find((entry) => entry.world !== 'MAIN');
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  await Promise.all(
    tabs
      .filter((tab) => !tab.discarded && tab.status !== 'unloaded')
      .map((tab) =>
        chrome.scripting
          .executeScript({ target: { tabId: tab.id }, files })
          .catch((error) => logError('background:inject', error, { url: tab.url }))
      )
  );
}

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm().catch(reportFailure('background:alarm'));
  refresh({ trigger: 'startup' });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) refresh({ trigger: 'alarm' });
});

// Alarms persist, but re-check whenever the worker wakes up.
ensureAlarm().catch(reportFailure('background:alarm'));

// React to the ChatGPT card's enable/disable toggle.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[STORAGE_KEYS.settings]) return;
  const before = changes[STORAGE_KEYS.settings].oldValue?.providers?.[PROVIDER_ID]?.enabled;
  const after = changes[STORAGE_KEYS.settings].newValue?.providers?.[PROVIDER_ID]?.enabled;
  if (before === after) return;
  if (after) refresh({ trigger: 'enable' });
  else getState().then(updateBadge).catch(reportFailure('background:badge'));
});

// ---------------------------------------------------------------------------
// Messages from the content script, popup and options page

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const reply = (promise, scope) =>
    promise.then(sendResponse, (error) => {
      logError(scope, error);
      sendResponse({ ok: false, error: { message: error.message } });
    });

  switch (message?.type) {
    case 'USAGE_SNAPSHOT':
      reply(handleSnapshot(message.result).then(() => ({ ok: true })), 'background:snapshot');
      return true;
    case 'PROFILE_SNAPSHOT':
      reply(handleProfile(message.profile).then(() => ({ ok: true })), 'background:profile');
      return true;
    case 'REFRESH':
      reply(refresh({ trigger: 'manual' }), 'background:refresh');
      return true;
    case 'OPEN_USAGE_PAGE':
      reply(chrome.tabs.create({ url: USAGE_PAGE_URL, active: true }).then(() => ({ ok: true })), 'background:open-usage');
      return true;
    case 'OPEN_LOGIN_PAGE':
      reply(openLoginPage().then(() => ({ ok: true })), 'background:open-login');
      return true;
    case 'LOG_ERROR':
      reply(persistLogEntry({ ...message.entry, scope: message.entry?.scope || 'unknown' }).then(() => ({ ok: true })), 'background:log');
      return true;
    case 'CLEAR_LOG':
      reply(clearLog().then(() => ({ ok: true })), 'background:log');
      return true;
    default:
      return false;
  }
});

async function handleSnapshot(result) {
  if (!result || !isProviderEnabled(await getSettings(), PROVIDER_ID)) return;
  if (result.ok) {
    await saveSuccess({ ...result.data, source: 'page' });
  } else {
    const error = new UsageError(result.error?.code || ERROR_CODES.NO_DATA, result.error?.message);
    logError('content:usage-page', error);
    // During a refresh the refresh itself reports the outcome.
    if (!inFlight) await saveError(error);
  }
}

async function handleProfile(profile) {
  if (!profile || !isProviderEnabled(await getSettings(), PROVIDER_ID)) return;
  const previous = (await getState()).profile;
  await patchState({
    profile: {
      account: profile.account || previous?.account || null,
      plan: normalizePlan(profile.plan) || previous?.plan || null,
      at: Date.now()
    }
  });
}

// Focus an open login tab, or open the login page.
async function openLoginPage() {
  const [existing] = await chrome.tabs.query({ url: 'https://chatgpt.com/auth/*' });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: LOGIN_PAGE_URL, active: true });
  }
}

// ---------------------------------------------------------------------------
// Refresh pipeline

let inFlight = null;

function refresh(options) {
  if (!inFlight) {
    inFlight = runRefresh(options)
      .catch(async (error) => {
        logError('background:refresh', error, { trigger: options.trigger, unexpected: true });
        return saveError(new UsageError(ERROR_CODES.NETWORK, `Refresh failed: ${error.message}`));
      })
      .finally(() => {
        inFlight = null;
      });
    // Not awaited, so a slow or unreachable server never delays the refresh result.
    inFlight.then((state) => pushToServer(state, options.trigger)).catch(reportFailure('background:server'));
  }
  return inFlight;
}

// Sends the latest data after every refresh, including the scheduled one. If
// the refresh failed, the last good data is sent with its `last_updated` time.
async function pushToServer(state, trigger) {
  const settings = await getSettings();
  if (!state?.data || !isProviderEnabled(settings, PROVIDER_ID)) return;
  await pushUsage(PROVIDER_ID, state, { serverUrl: settings.serverUrl, trigger });
}

async function runRefresh({ trigger }) {
  const settings = await getSettings();
  if (!isProviderEnabled(settings, PROVIDER_ID)) {
    const state = await patchState({ refreshing: false });
    await updateBadge(state);
    return state;
  }

  await patchState({ refreshing: true, lastAttemptAt: Date.now() });
  const errors = [];
  const fail = (source, error) => {
    errors.push(error);
    logError(`background:source:${source}`, error, { trigger });
  };

  // 1. Officially supported / authorized endpoint, if the user configured one.
  if (settings.endpointUrl) {
    try {
      const data = await fetchFromEndpoint(settings.endpointUrl);
      return await saveSuccess({ ...data, source: 'endpoint' });
    } catch (error) {
      fail('endpoint', error);
    }
  }

  // 2. A usage page the user already has open in their signed-in session.
  try {
    const data = await readFromOpenTabs();
    if (data) return await saveSuccess({ ...data, source: 'page' });
  } catch (error) {
    fail('open-tab', error);
  }

  // 3. Open the usage page in an inactive tab: always for a manual refresh,
  //    and for scheduled refreshes only if the user opted in.
  if (trigger === 'manual' || settings.backgroundTabRefresh) {
    try {
      const data = await readFromTemporaryTab();
      return await saveSuccess({ ...data, source: 'page' });
    } catch (error) {
      fail('temporary-tab', error);
    }
  }

  let error = pickMostRelevantError(errors);
  if (!error) {
    error = new UsageError(ERROR_CODES.NO_SOURCE, 'No usage source available. Open the ChatGPT usage page or press Refresh.');
    logError('background:refresh', error, { trigger });
  }

  // Signed out: send the user to the login page, but only when they asked
  // for the refresh, never from a scheduled one.
  if (error.code === ERROR_CODES.AUTH && trigger === 'manual') {
    await openLoginPage().catch(reportFailure('background:open-login'));
  }
  return saveError(error);
}

function pickMostRelevantError(errors) {
  const priority = [ERROR_CODES.AUTH, ERROR_CODES.PERMISSION, ERROR_CODES.NETWORK, ERROR_CODES.NO_DATA];
  for (const code of priority) {
    const match = errors.find((e) => e.code === code);
    if (match) return match;
  }
  return errors[0] ? new UsageError(ERROR_CODES.NETWORK, errors[0].message) : null;
}

async function saveSuccess(data) {
  const previous = await getState();
  const state = await patchState({
    data: {
      limits: data.limits || [],
      // Account name and plan aren't always visible; keep the last ones seen.
      account: data.account || previous.profile?.account || previous.data?.account || null,
      plan: normalizePlan(data.plan) || previous.profile?.plan || previous.data?.plan || null,
      source: data.source,
      pageUrl: data.pageUrl,
      fetchedAt: Date.now()
    },
    error: null,
    refreshing: false
  });
  await updateBadge(state);
  return state;
}

async function saveError(error) {
  const state = await patchState({
    error: { code: error.code || ERROR_CODES.NETWORK, message: error.message || 'Unknown error', at: Date.now() },
    refreshing: false
  });
  await updateBadge(state);
  return state;
}

// ---------------------------------------------------------------------------
// Source: authorized endpoint (background fetch)

async function fetchFromEndpoint(endpointUrl) {
  let url;
  try {
    url = new URL(endpointUrl);
  } catch {
    throw new UsageError(ERROR_CODES.NO_DATA, 'The configured endpoint URL is invalid.');
  }

  const origin = `${url.origin}/*`;
  if (!(await chrome.permissions.contains({ origins: [origin] }))) {
    throw new UsageError(ERROR_CODES.PERMISSION, `Host permission for ${url.origin} has not been granted. Re-save it in Options.`);
  }
  if (!navigator.onLine) throw new UsageError(ERROR_CODES.NETWORK, 'You are offline.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
  } catch (error) {
    const reason = error.name === 'AbortError' ? 'Request timed out.' : 'Network request failed.';
    throw new UsageError(ERROR_CODES.NETWORK, reason);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new UsageError(ERROR_CODES.AUTH, 'Not signed in or not authorized. Log in to ChatGPT and try again.');
  }
  if (!response.ok) {
    throw new UsageError(ERROR_CODES.NETWORK, `Usage endpoint responded with HTTP ${response.status}.`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new UsageError(ERROR_CODES.NO_DATA, 'Usage endpoint did not return JSON.');
  }
  const data = normalizeEndpointPayload(payload);
  if (!data) throw new UsageError(ERROR_CODES.NO_DATA, 'Usage endpoint response contained no usage data.');
  return data;
}

// ---------------------------------------------------------------------------
// Source: the usage page rendered in the user's own session

async function requestExtract(tabId) {
  // The content script may not be ready right after a load, so retry briefly.
  const deadline = Date.now() + TAB_EXTRACT_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_USAGE' });
      if (result?.ok) return result.data;
      throw new UsageError(result?.error?.code || ERROR_CODES.NO_DATA, result?.error?.message || 'No usage data.');
    } catch (error) {
      if (error instanceof UsageError) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new UsageError(ERROR_CODES.NO_DATA, lastError?.message || 'The usage page did not respond in time.');
}

async function readFromOpenTabs() {
  const tabs = await chrome.tabs.query({ url: USAGE_PAGE_MATCH });
  let lastError = null;
  for (const tab of tabs) {
    if (tab.discarded || tab.status === 'unloaded') continue;
    try {
      return await requestExtract(tab.id);
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return null;
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new UsageError(ERROR_CODES.NETWORK, 'The usage page took too long to load.'));
    }, TAB_EXTRACT_TIMEOUT_MS);
    function listener(id, info, tab) {
      if (id !== tabId || info.status !== 'complete') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(tab);
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function isLoginUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.hostname !== 'chatgpt.com' || /^\/(auth|login)\b/.test(url.pathname);
  } catch {
    return true;
  }
}

async function readFromTemporaryTab() {
  const tab = await chrome.tabs.create({ url: USAGE_PAGE_URL, active: false });
  try {
    const loaded = await waitForTabComplete(tab.id);
    if (!loaded.url?.startsWith('https://chatgpt.com/settings/usage')) {
      // A redirect to the login page (or away from chatgpt.com) means signed out;
      // any other redirect means this account has no usage page.
      if (isLoginUrl(loaded.url)) {
        throw new UsageError(ERROR_CODES.AUTH, 'You appear to be signed out of ChatGPT. Log in and try again.');
      }
      throw new UsageError(ERROR_CODES.NO_DATA, `The usage page redirected to ${loaded.url}; it may not be available for this plan.`);
    }
    return await requestExtract(tab.id);
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Toolbar badge

async function updateBadge(state) {
  const remaining = primaryLimit(limitsOf(state.data))?.remainingPercent;
  const stale = isStale(state);
  let text = '';
  let color = '#10a37f';

  if (!isProviderEnabled(await getSettings(), PROVIDER_ID)) {
    // Tracking is off: no badge.
  } else if (typeof remaining === 'number') {
    text = `${Math.round(remaining)}%`;
    if (remaining <= 10) color = '#d93025';
    else if (remaining <= 30) color = '#e37400';
  } else if (state.error) {
    text = '!';
    color = '#d93025';
  }
  if (stale || (state.error && state.data)) color = '#80868b';

  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}

// Keep the badge colour honest when the worker wakes (e.g. data became stale).
getState().then(updateBadge).catch(reportFailure('background:badge'));
