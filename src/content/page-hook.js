// Runs in the page's own JavaScript world on chatgpt.com, before the app loads.
// It watches the responses of requests the page itself makes (the usage API,
// the session and profile) and passes on only the plan type and account name
// to content.js. It makes no requests of its own and passes on nothing else.
(function () {
  'use strict';

  const SOURCE = 'ai-usage-tracker';
  const WATCHED_PATH_RE = /^\/(?:api\/auth\/session|backend-api\/(?:me|[\w/-]*usage[\w/-]*))$/;
  const latest = { plan: null, name: null };

  const str = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

  function pickProfile(body) {
    if (!body || typeof body !== 'object') return null;
    const plan =
      str(body.plan_type) || str(body.planType) || str(body.account?.plan_type) || str(body.account?.planType);
    const user = body.user && typeof body.user === 'object' ? body.user : body;
    const name = str(user.name) || str(user.email);
    return plan || name ? { plan, name } : null;
  }

  function post() {
    window.postMessage({ source: SOURCE, type: 'PROFILE', ...latest }, location.origin);
  }

  function inspect(url, response) {
    let path;
    try {
      path = new URL(url, location.href).pathname;
    } catch {
      return;
    }
    if (!WATCHED_PATH_RE.test(path) || !response.ok) return;
    if (!(response.headers.get('content-type') || '').includes('application/json')) return;
    response
      .clone()
      .json()
      .then((body) => {
        const found = pickProfile(body);
        if (!found) return;
        latest.plan = found.plan || latest.plan;
        latest.name = found.name || latest.name;
        post();
      })
      .catch(() => {});
  }

  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    const promise = originalFetch.apply(this, arguments);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    if (url) {
      promise.then((response) => inspect(url, response)).catch(() => {});
    }
    return promise;
  };

  // content.js loads later (document_idle) and asks for anything seen so far.
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== SOURCE || event.data.type !== 'PROFILE_REQUEST') return;
    if (latest.plan || latest.name) post();
  });
})();
