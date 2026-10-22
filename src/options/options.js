import { SERVER_CONFIG, STORAGE_KEYS } from '../lib/constants.js';
import { formatLogEntry } from '../lib/log-format.js';
import { getLogEntries, installGlobalErrorHandlers, logError } from '../lib/logger.js';
import { parseServerUrl } from '../lib/server-sync.js';
import { getSettings, saveSettings } from '../lib/storage.js';

installGlobalErrorHandlers('options');

const endpointInput = document.getElementById('endpoint');
const serverInput = document.getElementById('server-url');
const backgroundTab = document.getElementById('background-tab');
const status = document.getElementById('status');
const logCount = document.getElementById('log-count');

function showStatus(text, ok) {
  status.textContent = text;
  status.className = ok ? 'ok' : 'err';
}

async function load() {
  const settings = await getSettings();
  endpointInput.value = settings.endpointUrl;
  serverInput.value = settings.serverUrl;
  backgroundTab.checked = settings.backgroundTabRefresh;
}

async function showLogCount() {
  const entries = await getLogEntries();
  logCount.textContent = entries.length
    ? `${entries.length} logged error${entries.length === 1 ? '' : 's'}, latest at ${new Date(entries.at(-1).at).toLocaleString()}.`
    : 'No errors logged.';
}

document.getElementById('save').addEventListener('click', async () => {
  const raw = endpointInput.value.trim();
  const serverUrl = serverInput.value.trim() || SERVER_CONFIG.defaultServerUrl;
  let endpointUrl = '';
  const origins = [];

  try {
    if (raw) {
      let url;
      try {
        url = new URL(raw);
      } catch {
        return showStatus('Enter a valid URL.', false);
      }
      if (url.protocol !== 'https:') return showStatus('The endpoint must use HTTPS.', false);
      endpointUrl = url.href;
      origins.push(`${url.origin}/*`);
    }

    const server = parseServerUrl(serverUrl);
    if (!server) return showStatus('Enter a valid server URL, e.g. 127.0.0.1:3000.', false);
    origins.push(`${server.origin}/*`);

    // Must be requested from this click handler (a user gesture), in one call.
    const granted = await chrome.permissions.request({ origins });
    if (!granted) return showStatus(`Permission for ${origins.map((o) => o.slice(0, -2)).join(' and ')} was not granted.`, false);

    await saveSettings({ endpointUrl, serverUrl, backgroundTabRefresh: backgroundTab.checked });
    serverInput.value = serverUrl;
    showStatus('Saved.', true);
    chrome.runtime.sendMessage({ type: 'REFRESH' }).catch((error) => logError('options:refresh', error));
  } catch (error) {
    logError('options:save', error);
    showStatus(`Could not save: ${error.message}`, false);
  }
});

document.getElementById('download-log').addEventListener('click', async () => {
  const entries = await getLogEntries();
  const text = entries.length ? entries.map(formatLogEntry).join('\n') + '\n' : 'No errors logged.\n';
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: 'ai-usage-tracker-error.log' });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

document.getElementById('clear-log').addEventListener('click', async () => {
  // Cleared by the worker, which owns writes to the log.
  await chrome.runtime.sendMessage({ type: 'CLEAR_LOG' }).catch((error) => logError('options:clear-log', error));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEYS.errorLog]) showLogCount();
});

load().catch((error) => logError('options:load', error));
showLogCount();
