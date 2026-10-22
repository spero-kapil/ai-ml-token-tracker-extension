import { ERROR_CODES, STORAGE_KEYS } from '../lib/constants.js';
import { installGlobalErrorHandlers, logError } from '../lib/logger.js';
import { getSettings, getState, isProviderEnabled, isStale, setProviderEnabled } from '../lib/storage.js';
import { accountName, limitsOf, orderedLimits, primaryLimit } from '../lib/usage.js';
import { PROVIDERS } from './providers.js';

installGlobalErrorHandlers('popup');

const $ = (id) => document.getElementById(id);
const cards = new Map();

const ERROR_ACTIONS = {
  [ERROR_CODES.AUTH]: { label: 'Log in to ChatGPT', run: () => openLoginPage() },
  [ERROR_CODES.NO_SOURCE]: { label: 'Open the usage page', run: () => openUsagePage() },
  [ERROR_CODES.NO_DATA]: { label: 'Open the usage page', run: () => openUsagePage() },
  [ERROR_CODES.PERMISSION]: { label: 'Open options', run: () => chrome.runtime.openOptionsPage() }
};

const absoluteFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
});

function formatDuration(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 1) return 'less than a minute';
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatAgo(ts, now) {
  const diff = now - ts;
  if (diff < 60000) return 'just now';
  return `${formatDuration(diff)} ago`;
}

function fillClass(pct) {
  if (pct !== null && pct <= 10) return 'meter-fill danger';
  if (pct !== null && pct <= 30) return 'meter-fill warn';
  return 'meter-fill';
}

function openPage(type) {
  chrome.runtime
    .sendMessage({ type })
    .catch((error) => logError('popup:open-page', error, { type }))
    .finally(() => window.close());
}

const openUsagePage = () => openPage('OPEN_USAGE_PAGE');
const openLoginPage = () => openPage('OPEN_LOGIN_PAGE');

// ---------------------------------------------------------------------------
// Card shell (shared by every provider)

function setExpanded(card, expanded) {
  card.querySelector('.summary').setAttribute('aria-expanded', String(expanded));
  card.querySelector('.details').hidden = !expanded;
}

// Collapsed-view bar and connection indicator.
function renderSummary(card, { percent, valueText, connection }) {
  const fill = card.querySelector('.mini-usage .meter-fill');
  fill.style.width = `${percent ?? 0}%`;
  fill.className = fillClass(percent);
  card.querySelector('.mini-usage').classList.toggle('empty-usage', percent === null);
  card.querySelector('.mini-value').textContent = valueText;

  const conn = card.querySelector('.conn');
  conn.className = `conn ${connection.variant}`.trim();
  card.querySelector('.conn-text').textContent = connection.text;
}

function buildCard(provider) {
  const card = $('card-template').content.firstElementChild.cloneNode(true);
  const summary = card.querySelector('.summary');
  const details = card.querySelector('.details');
  const toggle = card.querySelector('.switch input');

  card.dataset.provider = provider.id;
  card.querySelector('.p-icon').innerHTML = provider.icon;
  card.querySelector('.p-icon').style.setProperty('--brand', provider.color);
  card.querySelector('.p-name').textContent = provider.name;
  details.id = `details-${provider.id}`;
  details.append($(provider.details).content.cloneNode(true));
  summary.setAttribute('aria-controls', details.id);
  summary.setAttribute('aria-label', `${provider.name} details`);
  toggle.setAttribute('aria-label', `Enable ${provider.name}`);

  // Collapsed by default; clicking the summary toggles the details only.
  setExpanded(card, false);
  summary.addEventListener('click', () => setExpanded(card, details.hidden));
  summary.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    setExpanded(card, details.hidden);
  });

  if (provider.integrated) {
    toggle.addEventListener('change', () =>
      setProviderEnabled(provider.id, toggle.checked).catch((error) => logError('popup:toggle', error, { provider: provider.id }))
    );
  } else {
    // UI only: no integration yet, so nothing about the provider is known.
    card.classList.add('unavailable');
    toggle.disabled = true;
    toggle.checked = false;
    card.querySelector('.switch').title = 'Integration coming soon';
    card.querySelector('.placeholder-text').textContent =
      `${provider.name} integration is not available yet. Account, usage and reset details will appear here once it is supported.`;
    renderSummary(card, {
      percent: null,
      valueText: 'No usage data',
      connection: { text: 'Not connected', variant: 'disconnected' }
    });
  }

  $('providers').append(card);
  cards.set(provider.id, card);
}

// ---------------------------------------------------------------------------
// ChatGPT (existing behaviour, rendered inside its card)

function chatgptConnection(state, enabled) {
  if (!enabled) return { text: 'Disabled', variant: '' };
  if (state.error?.code === ERROR_CODES.AUTH) return { text: 'Disconnected', variant: 'disconnected' };
  if (state.data) return { text: 'Connected', variant: 'connected' };
  if (state.refreshing) return { text: 'Connecting…', variant: '' };
  return { text: 'Disconnected', variant: 'disconnected' };
}

function freshnessText(state, stale) {
  if (state.refreshing) return 'refreshing…';
  if (state.error && !state.data) return 'error';
  if (stale || state.error) return 'stale';
  return state.data ? 'up to date' : '';
}

function renderError(card, state, stale) {
  const banner = card.querySelector('.error-banner');
  const action = card.querySelector('.error-action');
  let message = state.error?.message;
  if (!message && stale) message = 'Usage data is out of date. Press Refresh to update it.';

  banner.hidden = !message;
  if (!message) return;

  banner.classList.toggle('warn', !state.error);
  card.querySelector('.error-message').textContent =
    state.error && state.data ? `${message} Showing the last known values.` : message;

  const handler = state.error && ERROR_ACTIONS[state.error.code];
  action.hidden = !handler;
  if (handler) {
    action.textContent = handler.label;
    action.onclick = handler.run;
  }
}

function renderLimit(limit, { secondary, stale, now }) {
  const block = $('limit-template').content.firstElementChild.cloneNode(true);
  const q = (sel) => block.querySelector(sel);

  block.classList.toggle('secondary', secondary);
  block.classList.toggle('stale-data', stale);
  q('.limit-label').textContent = limit.label || `${limit.periodLabel} usage limit`;
  q('.period-chip').textContent = limit.periodLabel || 'Usage';
  q('.period-chip').title = 'Usage period';

  const pct = typeof limit.remainingPercent === 'number' ? limit.remainingPercent : null;
  q('.remaining-percent').textContent = pct === null ? '–' : `${Math.round(pct)}%`;

  const fill = q('.meter-fill');
  fill.style.width = `${pct ?? 0}%`;
  fill.className = fillClass(pct);
  q('.meter').setAttribute('aria-valuenow', String(Math.round(pct ?? 0)));
  q('.meter').setAttribute('aria-label', `${limit.periodLabel || ''} usage remaining`.trim());

  const count = q('.remaining-count');
  count.hidden = limit.remaining === null || limit.remaining === undefined || !limit.limit;
  if (!count.hidden) count.textContent = `${limit.remaining.toLocaleString()} of ${limit.limit.toLocaleString()} left`;

  if (typeof limit.resetAt === 'number') {
    q('.reset-absolute').textContent = absoluteFormat.format(limit.resetAt);
    q('.reset-relative').textContent =
      limit.resetAt > now ? `in ${formatDuration(limit.resetAt - now)}` : '(passed — refresh to update)';
  } else {
    q('.reset-absolute').textContent = limit.resetText || 'Unknown';
    q('.reset-relative').textContent = '';
  }
  return block;
}

function renderUsage(card, state, stale, now) {
  const q = (sel) => card.querySelector(sel);
  const limits = orderedLimits(limitsOf(state.data));
  const hasData = Boolean(state.data);

  q('.usage').hidden = !limits.length;
  q('.no-limits').hidden = !hasData || limits.length > 0;
  q('.empty:not(.no-limits)').hidden = hasData || Boolean(state.error) || state.refreshing;

  const plan = state.profile?.plan?.name || state.data?.plan?.name;
  q('.no-limits-text').textContent = plan
    ? `The usage page shows no usage limits for your ${plan} plan.`
    : 'The usage page shows no usage limits for this account.';

  q('.usage').replaceChildren(...limits.map((limit, i) => renderLimit(limit, { secondary: i > 0, stale, now })));
}

function renderFooter(card, state, now) {
  let text = '';
  if (state.data?.fetchedAt) {
    const source = state.data.source === 'endpoint' ? 'authorized endpoint' : 'ChatGPT usage page';
    text = `Updated ${formatAgo(state.data.fetchedAt, now)} from ${source}`;
  } else if (state.lastAttemptAt) {
    text = `Last attempt ${formatAgo(state.lastAttemptAt, now)}`;
  }
  card.querySelector('.updated').textContent = text;
  card.querySelector('.refresh').disabled = Boolean(state.refreshing);
}

function renderChatGPT(state, settings) {
  const card = cards.get('chatgpt');
  const now = Date.now();
  const stale = isStale(state, now);
  const enabled = isProviderEnabled(settings, 'chatgpt');
  const connection = chatgptConnection(state, enabled);
  const primary = primaryLimit(limitsOf(state.data));
  const pct = enabled && typeof primary?.remainingPercent === 'number' ? primary.remainingPercent : null;

  card.classList.toggle('disabled', !enabled);
  card.querySelector('.switch input').checked = enabled;
  card.querySelector('.mini-usage').classList.toggle('stale-data', stale);
  renderSummary(card, {
    percent: pct,
    valueText: !enabled
      ? 'Tracking off'
      : pct === null
        ? 'No usage data'
        : `${Math.round(pct)}% left · ${primary.periodLabel.toLowerCase()}`,
    connection
  });

  card.querySelector('.account').textContent = accountName(state.profile) || accountName(state.data) || 'Not available';
  card.querySelector('.plan').textContent = state.profile?.plan?.name || state.data?.plan?.name || 'Not available';
  const freshness = enabled ? freshnessText(state, stale) : '';
  card.querySelector('.connection').textContent = freshness ? `${connection.text} · ${freshness}` : connection.text;

  const details = card.querySelector('.details');
  details.querySelector('.actions').hidden = !enabled;
  if (!enabled) {
    details.querySelector('.error-banner').hidden = true;
    details.querySelector('.usage').hidden = true;
    details.querySelectorAll('.empty').forEach((el) => (el.hidden = true));
    details.querySelector('.updated').textContent = 'Tracking is turned off. Use the toggle to turn it back on.';
    return;
  }

  renderError(card, state, stale);
  renderUsage(card, state, stale, now);
  renderFooter(card, state, now);
}

async function rerender() {
  try {
    const [state, settings] = await Promise.all([getState(), getSettings()]);
    renderChatGPT(state, settings);
  } catch (error) {
    logError('popup:render', error);
  }
}

// ---------------------------------------------------------------------------

PROVIDERS.forEach(buildCard);

const chatgpt = cards.get('chatgpt');
chatgpt.querySelector('.refresh').addEventListener('click', async (event) => {
  event.currentTarget.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: 'REFRESH' });
  } catch (error) {
    logError('popup:refresh', error);
  } finally {
    rerender();
  }
});
chatgpt.querySelector('.open-page').addEventListener('click', openUsagePage);
$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes[STORAGE_KEYS.state] || changes[STORAGE_KEYS.settings])) rerender();
});

rerender();
setInterval(rerender, 30000);
