import { DEFAULT_SERVER_URL, REFRESH_PERIOD_MINUTES } from './env.js';

export { REFRESH_PERIOD_MINUTES };
export const USAGE_PAGE_URL = 'https://chatgpt.com/settings/usage?tab=overview';
export const USAGE_PAGE_MATCH = 'https://chatgpt.com/settings/usage*';
export const LOGIN_PAGE_URL = 'https://chatgpt.com/auth/login';

export const ALARM_NAME = 'usage-refresh';

// Data older than two missed refresh cycles is flagged as stale.
export const STALE_AFTER_MS = 2 * REFRESH_PERIOD_MINUTES * 60 * 1000;

export const TAB_EXTRACT_TIMEOUT_MS = 20000;
export const FETCH_TIMEOUT_MS = 15000;

// Error log: kept in storage and, when `npm run logs` is running, appended to
// logs/error.log in the project directory.
export const LOG_MAX_ENTRIES = 500;
export const LOG_SERVER_PORT = 47321;
export const LOG_SERVER_URL = `http://127.0.0.1:${LOG_SERVER_PORT}/log`;
export const LOG_FLUSH_TIMEOUT_MS = 2000;

// Tracking server that receives each provider's usage after every refresh, at
// <settings.serverUrl><apiPath><endpoint path>. A provider without an entry
// here is not sent.
export const SERVER_CONFIG = {
  defaultServerUrl: DEFAULT_SERVER_URL,
  apiPath: '/api/',
  timeoutMs: 10000,
  endpoints: {
    chatgpt: { method: 'POST', path: '/chat-gpt' }
  }
};

export const STORAGE_KEYS = {
  state: 'usageState',
  settings: 'settings',
  errorLog: 'errorLog',
  serverSync: 'serverSync'
};

export const DEFAULT_SETTINGS = {
  // Officially supported/authorized endpoint. Empty = fetch source disabled.
  endpointUrl: '',
  // Allow the scheduled refresh to open the usage page in an inactive tab.
  backgroundTabRefresh: false,
  // Tracking server as `host:port` or a full URL; http:// is assumed without a scheme.
  serverUrl: SERVER_CONFIG.defaultServerUrl,
  // Enable/disable toggles from the popup's provider cards.
  providers: {
    chatgpt: { enabled: true }
  }
};

export const ERROR_CODES = {
  AUTH: 'AUTH',
  NO_DATA: 'NO_DATA',
  NETWORK: 'NETWORK',
  NO_SOURCE: 'NO_SOURCE',
  PERMISSION: 'PERMISSION',
  SERVER: 'SERVER'
};
