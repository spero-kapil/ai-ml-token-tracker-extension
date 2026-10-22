// Runs on chatgpt.com. When the user is on the usage overview page it reads the
// usage figures, account name and plan that the page already displays to the
// signed-in user and hands them to the background worker. It makes no network
// requests of its own.
(function () {
  'use strict';

  const { parseUsageLimits, parseProfileText, detectPlan, looksSignedOut } = globalThis.UsageParser;
  const SETTLE_MS = 1200;
  const GIVE_UP_MS = 15000;
  const EXTRACT_DEADLINE_MS = 10000;
  const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

  let debounceTimer = null;
  let giveUpTimer = null;
  let observer = null;
  let lastSentKey = null;

  const isUsagePage = () => location.pathname.startsWith('/settings/usage');
  const isAuthPage = () => /\/auth\/|\/login/.test(location.pathname);
  const pageText = () => (document.querySelector('main') || document.body)?.innerText || '';

  // Same entry shape as src/lib/logger.js; the worker stores it.
  function logError(scope, error, details) {
    console.error(`[AI Usage Tracker] [${scope}]`, error, ...(details === undefined ? [] : [details]));
    const entry = {
      at: new Date().toISOString(),
      level: 'error',
      scope,
      code: error?.code || null,
      message: error?.message || String(error),
      stack: error?.stack || null,
      details: details ?? null
    };
    chrome.runtime.sendMessage({ type: 'LOG_ERROR', entry }).catch(() => {});
  }

  const PROFILE_BUTTON_SELECTOR = '[data-testid="accounts-profile-button"]';
  const PROFILE_MISSING_LOG_MS = 15000;

  // One line per element's own text. Unlike innerText this also works while
  // the sidebar is collapsed and the name/plan labels are hidden.
  function elementLines(root) {
    const byParent = new Map();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent || parent.closest('script, style, svg')) continue;
      byParent.set(parent, (byParent.get(parent) || '') + node.nodeValue);
    }
    return [...byParent.values()].map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  }

  // The sidebar profile button ("<name>\n<plan>"). The settings pages,
  // including the usage page, have no chat sidebar, so it is read on any page.
  function readProfile() {
    const button = document.querySelector(PROFILE_BUTTON_SELECTOR);
    const text = button ? elementLines(button) : '';
    return { found: Boolean(button), text, ...parseProfileText(text) };
  }

  // On the usage page: the profile button if present, with the plan wording or
  // an email on the page as fallbacks.
  function readAccount() {
    const profile = readProfile();
    const name = apiProfile.name || profile.name || EMAIL_RE.exec(document.body?.innerText || '')?.[0] || null;
    return { account: name ? { name } : null, plan: apiProfile.plan || profile.plan || detectPlan(pageText()) };
  }

  // Plan type and account name from the page's own API responses (usage API,
  // session), reported by page-hook.js. Preferred over the sidebar text.
  const HOOK_SOURCE = 'ai-usage-tracker';
  const apiProfile = { plan: null, name: null };
  function onHookMessage(event) {
    if (event.source !== window || event.origin !== location.origin) return;
    const msg = event.data;
    if (msg?.source !== HOOK_SOURCE || msg.type !== 'PROFILE') return;
    if (typeof msg.plan === 'string') apiProfile.plan = msg.plan;
    if (typeof msg.name === 'string') apiProfile.name = msg.name;
    sendProfile();
  }
  window.addEventListener('message', onHookMessage);

  let lastProfileKey = null;
  let profileWatchStart = Date.now();
  let profileMissingLogged = false;
  function sendProfile() {
    if (isAuthPage()) return;
    const sidebar = readProfile();
    const { found, text } = sidebar;
    const name = apiProfile.name || sidebar.name;
    const plan = apiProfile.plan || sidebar.plan;
    if (!name && !plan) {
      // Logged once per page so a changed selector or layout shows up in the error log.
      const hasSidebar = !location.pathname.startsWith('/settings');
      if (hasSidebar && !lastProfileKey && !profileMissingLogged && Date.now() - profileWatchStart > PROFILE_MISSING_LOG_MS) {
        profileMissingLogged = true;
        const reason = found ? 'Profile button has no name or plan text.' : `Profile button ${PROFILE_BUTTON_SELECTOR} not found.`;
        logError('content:profile', Object.assign(new Error(reason), { code: 'NO_DATA' }), {
          url: location.href,
          buttonText: text.slice(0, 200)
        });
      }
      return;
    }
    const profile = { account: name ? { name } : null, plan };
    const key = JSON.stringify(profile);
    if (key === lastProfileKey) return;
    lastProfileKey = key;
    chrome.runtime.sendMessage({ type: 'PROFILE_SNAPSHOT', profile }).catch((error) => {
      console.warn('[AI Usage Tracker] could not send profile snapshot', error);
      lastProfileKey = null;
    });
  }

  // Limits are required unless `allowEmpty`: some plans may show no limits at
  // all, but that is only trusted once the page has had time to render.
  function extract({ allowEmpty = false } = {}) {
    try {
      const text = pageText();
      const limits = parseUsageLimits(text);
      if (limits.length || (allowEmpty && !looksSignedOut(text) && !isAuthPage())) {
        return { ok: true, data: { limits, ...readAccount(), pageUrl: location.href } };
      }
      if (looksSignedOut(text) || isAuthPage()) {
        return { ok: false, error: { code: 'AUTH', message: 'You appear to be signed out of ChatGPT.' } };
      }
      return { ok: false, error: { code: 'NO_DATA', message: 'No usage information was found on the usage page.' } };
    } catch (error) {
      logError('content:extract', error, { url: location.href });
      return { ok: false, error: { code: 'NO_DATA', message: `Could not read the usage page: ${error.message}` } };
    }
  }

  function send(result) {
    const { pageUrl, ...data } = result.ok ? result.data : {};
    const key = JSON.stringify(result.ok ? data : result.error);
    if (key === lastSentKey) return;
    lastSentKey = key;
    chrome.runtime.sendMessage({ type: 'USAGE_SNAPSHOT', result }).catch((error) => {
      // Worker may be restarting; the next mutation or alarm will retry.
      console.warn('[AI Usage Tracker] could not send usage snapshot', error);
      lastSentKey = null;
    });
  }

  function scheduleExtract() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const result = extract();
      if (result.ok) {
        clearTimeout(giveUpTimer);
        send(result);
      }
    }, SETTLE_MS);
  }

  function startWatching() {
    if (observer) return;
    lastSentKey = null;
    observer = new MutationObserver(scheduleExtract);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    scheduleExtract();
    // If the page never renders usage figures, report what it does show once.
    giveUpTimer = setTimeout(() => send(extract({ allowEmpty: true })), GIVE_UP_MS);
  }

  function stopWatching() {
    observer?.disconnect();
    observer = null;
    clearTimeout(debounceTimer);
    clearTimeout(giveUpTimer);
  }

  // ChatGPT is a single-page app, so watch for client-side route changes.
  let lastPath = null;
  function onRouteChange() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    if (isUsagePage()) startWatching();
    else stopWatching();
  }
  // A copy left over from before the extension was reloaded or updated can no
  // longer reach the worker; stop it so the newly injected copy takes over.
  const stop = () => {
    clearInterval(tick);
    stopWatching();
    window.removeEventListener('popstate', onRouteChange);
    window.removeEventListener('message', onHookMessage);
  };
  const tick = setInterval(() => {
    if (!chrome.runtime?.id) return stop();
    onRouteChange();
    sendProfile();
  }, 1000);
  globalThis.__aiUsageTrackerStop?.();
  globalThis.__aiUsageTrackerStop = stop;
  window.addEventListener('popstate', onRouteChange);
  onRouteChange();
  sendProfile();
  window.postMessage({ source: HOOK_SOURCE, type: 'PROFILE_REQUEST' }, location.origin);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'EXTRACT_USAGE') return false;
    if (isAuthPage()) {
      sendResponse({ ok: false, error: { code: 'AUTH', message: 'You appear to be signed out of ChatGPT.' } });
      return false;
    }
    if (!isUsagePage()) {
      sendResponse({ ok: false, error: { code: 'NO_DATA', message: 'Tab is not on the usage page.' } });
      return false;
    }
    // Give a freshly loaded page a moment to render before answering.
    const started = Date.now();
    (function attempt() {
      const timedOut = Date.now() - started > EXTRACT_DEADLINE_MS;
      const result = extract({ allowEmpty: timedOut });
      if (result.ok || timedOut) sendResponse(result);
      else setTimeout(attempt, 750);
    })();
    return true;
  });
})();
