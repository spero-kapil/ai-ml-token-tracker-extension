// Sends each provider's latest usage to the tracking server (SERVER_CONFIG and
// the `serverUrl` setting):
//   POST http://<serverUrl>/api/<path>  { provider, account_name, plan_type, data }
//
// Adding a provider means adding its endpoint to SERVER_CONFIG.endpoints and a
// payload builder to PAYLOAD_BUILDERS. A builder takes the provider's stored
// state and returns the request body, or null when there is nothing to send.
//
// The last outcome per provider is kept in chrome.storage.local under
// `serverSync`: { [provider]: { lastAttemptAt, lastSuccessAt, error } }.
import { ERROR_CODES, SERVER_CONFIG, STORAGE_KEYS } from './constants.js';
import { logError } from './logger.js';
import { accountName, limitsOf, normalizePlan } from './usage.js';

export class ServerSyncError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// 1767225600000 → '2026-01-01 00:00:00' (UTC).
export function formatServerTime(timestamp) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString().slice(0, 19).replace('T', ' ');
}

const round = (value) => (typeof value === 'number' ? Math.round(value * 100) / 100 : null);

// One `<period>_usage` (percent used) and `<period>_reset_time` pair per limit,
// e.g. monthly_usage, weekly_reset_time, 5h_usage.
export function buildChatGptPayload(state) {
  const data = state?.data;
  if (!data) return null;

  const usage = {};
  for (const limit of limitsOf(data)) {
    const base = limit.period || 'unknown';
    let key = base;
    for (let n = 2; `${key}_usage` in usage; n++) key = `${base}_${n}`;
    usage[`${key}_usage`] = round(limit.usedPercent);
    usage[`${key}_reset_time`] = formatServerTime(limit.resetAt);
  }
  usage.last_updated = formatServerTime(data.fetchedAt);

  return {
    provider: 'chatgpt',
    account_name: accountName(data) || state.profile?.account?.name || null,
    plan_type: normalizePlan(data.plan)?.id || state.profile?.plan?.id || null,
    data: usage
  };
}

export const PAYLOAD_BUILDERS = {
  chatgpt: buildChatGptPayload
};

// '127.0.0.1:3000' → URL('http://127.0.0.1:3000/'). Also accepts a full
// http(s) URL, optionally with a path prefix. Returns null if invalid.
export function parseServerUrl(serverUrl) {
  const raw = String(serverUrl ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;
    url.search = '';
    url.hash = '';
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url;
  } catch {
    return null;
  }
}

// ('127.0.0.1:3000', '/chat-gpt') → 'http://127.0.0.1:3000/api/chat-gpt'.
export function endpointUrl(serverUrl, path) {
  const server = parseServerUrl(serverUrl);
  if (!server) throw new ServerSyncError(ERROR_CODES.SERVER, `The server URL "${serverUrl}" is invalid.`);
  const base = new URL(SERVER_CONFIG.apiPath.replace(/^\/+/, ''), server);
  return new URL(String(path).replace(/^\/+/, ''), base).href;
}

async function ensurePermission(url) {
  const { origin } = new URL(url);
  if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) {
    throw new ServerSyncError(ERROR_CODES.PERMISSION, `Host permission for ${origin} has not been granted. Re-save the server URL in Options.`);
  }
}

async function send(url, method, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERVER_CONFIG.timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    const reason = error.name === 'AbortError' ? 'timed out' : 'could not be reached';
    throw new ServerSyncError(ERROR_CODES.NETWORK, `Server ${url} ${reason}.`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new ServerSyncError(
      ERROR_CODES.SERVER,
      `Server ${url} responded with HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}.`,
      response.status
    );
  }
}

async function readSyncState() {
  return (await chrome.storage.local.get(STORAGE_KEYS.serverSync))[STORAGE_KEYS.serverSync] || {};
}

async function recordOutcome(provider, outcome) {
  const all = await readSyncState();
  const next = { ...all, [provider]: { ...all[provider], ...outcome } };
  await chrome.storage.local.set({ [STORAGE_KEYS.serverSync]: next });
  return all[provider];
}

// Never rejects: a failed push is recorded and logged, and the next refresh
// tries again. A failure is logged only when it differs from the previous one,
// so a server that stays down doesn't fill the error log.
export async function pushUsage(provider, state, { serverUrl = SERVER_CONFIG.defaultServerUrl, ...details } = {}) {
  const endpoint = SERVER_CONFIG.endpoints[provider];
  const build = PAYLOAD_BUILDERS[provider];
  if (!endpoint || !build) return { ok: false, skipped: 'not configured' };

  try {
    const body = build(state);
    if (!body) return { ok: false, skipped: 'no data' };
    const at = Date.now();
    let url = null;
    try {
      url = endpointUrl(serverUrl, endpoint.path);
      await ensurePermission(url);
      await send(url, endpoint.method, body);
    } catch (error) {
      const previous = await recordOutcome(provider, {
        lastAttemptAt: at,
        error: { code: error.code || ERROR_CODES.NETWORK, message: error.message, at }
      });
      if (previous?.error?.message !== error.message) {
        logError(`background:server:${provider}`, error, { ...details, url, status: error.status ?? null });
      }
      return { ok: false, error };
    }
    await recordOutcome(provider, { lastAttemptAt: at, lastSuccessAt: at, error: null });
    return { ok: true };
  } catch (error) {
    logError(`background:server:${provider}`, error, details);
    return { ok: false, error };
  }
}
