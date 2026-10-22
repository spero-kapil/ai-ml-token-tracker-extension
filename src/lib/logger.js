// Error log shared by every extension context.
//
// logError() always writes to the console. Entries are stored by the service
// worker in chrome.storage.local (the last LOG_MAX_ENTRIES), and pushed to the
// local log receiver (`npm run logs`), which appends them to logs/error.log in
// the project directory. Entries written while the receiver is not running are
// kept and sent on the next flush.
//
// Pages (popup, options) and the content script can't safely share the
// storage read-modify-write, so they forward entries to the worker instead.
import { LOG_FLUSH_TIMEOUT_MS, LOG_MAX_ENTRIES, LOG_SERVER_URL, STORAGE_KEYS } from './constants.js';

const IS_WORKER = typeof ServiceWorkerGlobalScope !== 'undefined' && globalThis instanceof ServiceWorkerGlobalScope;

export function createLogEntry(scope, error, details) {
  const isError = error instanceof Error;
  return {
    at: new Date().toISOString(),
    level: 'error',
    scope,
    code: error?.code || null,
    message: isError ? error.message : typeof error === 'string' ? error : error?.message || String(error),
    stack: isError ? error.stack || null : null,
    details: details ?? null
  };
}

export function logError(scope, error, details) {
  const entry = createLogEntry(scope, error, details);
  console.error(`[AI Usage Tracker] [${scope}]`, error, ...(details === undefined ? [] : [details]));
  if (IS_WORKER) return persistLogEntry(entry);
  return chrome.runtime.sendMessage({ type: 'LOG_ERROR', entry }).catch(() => {
    // Worker unreachable; the console line above is all we can do.
  });
}

// Report uncaught errors and unhandled rejections in this context.
export function installGlobalErrorHandlers(scope) {
  globalThis.addEventListener('error', (event) => {
    logError(scope, event.error || event.message, { source: event.filename, line: event.lineno });
  });
  globalThis.addEventListener('unhandledrejection', (event) => {
    logError(scope, event.reason ?? 'Unhandled promise rejection');
  });
}

// ---------------------------------------------------------------------------
// Storage (service worker only)

// Stored as { entries: [...], unsynced: n } where the last `unsynced`
// entries have not reached logs/error.log yet.
async function readLog() {
  const stored = (await chrome.storage.local.get(STORAGE_KEYS.errorLog))[STORAGE_KEYS.errorLog];
  return { entries: stored?.entries || [], unsynced: stored?.unsynced || 0 };
}

const writeLog = (log) => chrome.storage.local.set({ [STORAGE_KEYS.errorLog]: log });

// Writes are serialized so concurrent errors don't overwrite each other.
let queue = Promise.resolve();
const enqueue = (task) => {
  queue = queue.then(task).catch((error) => console.warn('[AI Usage Tracker] [logger] error log write failed', error));
  return queue;
};

export function persistLogEntry(entry) {
  return enqueue(async () => {
    const log = await readLog();
    const entries = [...log.entries, entry].slice(-LOG_MAX_ENTRIES);
    await writeLog({ entries, unsynced: Math.min(log.unsynced + 1, entries.length) });
    await flushToFile();
  });
}

export function flushLog() {
  return enqueue(flushToFile);
}

export function clearLog() {
  return enqueue(() => writeLog({ entries: [], unsynced: 0 }));
}

export async function getLogEntries() {
  return (await readLog()).entries;
}

async function flushToFile() {
  const log = await readLog();
  if (!log.unsynced) return;
  const pending = log.entries.slice(-log.unsynced);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOG_FLUSH_TIMEOUT_MS);
  try {
    const response = await fetch(LOG_SERVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: pending }),
      signal: controller.signal
    });
    if (!response.ok) return;
  } catch {
    // Receiver not running: keep the entries for the next flush. Not logged,
    // since logging it would recurse.
    return;
  } finally {
    clearTimeout(timer);
  }

  // Runs inside the write queue, so nothing was added since readLog().
  await writeLog({ entries: log.entries, unsynced: 0 });
}
