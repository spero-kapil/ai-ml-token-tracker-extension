// Helpers for stored usage data:
// { limits: [limit], account: { name }, plan: { id, name }, source, pageUrl?, fetchedAt }
// where each limit is
// { period, periodLabel, periodMs, label, remainingPercent, usedPercent,
//   remaining, limit, resetAt, resetText }.

const HOUR = 36e5;
const DAY = 24 * HOUR;

export const PERIODS = {
  hourly: { periodLabel: 'Hourly', periodMs: HOUR },
  daily: { periodLabel: 'Daily', periodMs: DAY },
  weekly: { periodLabel: 'Weekly', periodMs: 7 * DAY },
  monthly: { periodLabel: 'Monthly', periodMs: 30 * DAY },
  billing: { periodLabel: 'Billing period', periodMs: 30 * DAY },
  yearly: { periodLabel: 'Yearly', periodMs: 365 * DAY }
};

const PERIOD_ALIASES = {
  hour: 'hourly',
  day: 'daily',
  week: 'weekly',
  month: 'monthly',
  billing_period: 'billing',
  billing_cycle: 'billing',
  year: 'yearly',
  annual: 'yearly',
  annually: 'yearly'
};

// Accepts 'weekly', 'week', 'monthly', '5h', '5_hour', '3d', … Unknown ids
// are kept with their own name and sort as the shortest period.
export function describePeriod(raw) {
  const key = String(raw || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const id = PERIOD_ALIASES[key] || key;
  if (PERIODS[id]) return { period: id, ...PERIODS[id] };

  const m = /^(\d+)_?(h|hr|hrs|hours?|d|days?)$/.exec(id);
  if (m) {
    const n = Number(m[1]);
    const isHours = m[2].startsWith('h');
    return {
      period: `${n}${isHours ? 'h' : 'd'}`,
      periodLabel: `${n}-${isHours ? 'hour' : 'day'}`,
      periodMs: n * (isHours ? HOUR : DAY)
    };
  }
  const label = String(raw || 'Usage').trim();
  return { period: id || 'unknown', periodLabel: label.charAt(0).toUpperCase() + label.slice(1), periodMs: 0 };
}

export const PLANS = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu'
};

// 'plus', 'ChatGPT Plus', 'chatgptplusplan' → { id: 'plus', name: 'Plus' }.
// Unknown plan names (e.g. from an endpoint) are shown as given.
export function normalizePlan(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw.id || raw.name ? normalizePlan(raw.name || raw.id) : null;
  const text = String(raw).trim();
  const key = text.toLowerCase().replace(/^chatgpt\s*/, '').replace(/\s*plan$/, '').trim();
  if (PLANS[key]) return { id: key, name: PLANS[key] };
  return text ? { id: key.replace(/\s+/g, '_'), name: text } : null;
}

// Limits from stored data. Data saved before multi-period support only had
// `weekly`.
export function limitsOf(data) {
  if (Array.isArray(data?.limits)) return data.limits;
  if (data?.weekly) return [{ ...describePeriod('weekly'), ...data.weekly }];
  return [];
}

// The limit shown in the collapsed card and the toolbar badge: the longest
// period that has a remaining figure, since that is the plan's main allowance.
export function primaryLimit(limits) {
  const usable = limits.filter((l) => typeof l.remainingPercent === 'number');
  if (!usable.length) return limits[0] || null;
  return usable.reduce((best, l) => ((l.periodMs || 0) > (best.periodMs || 0) ? l : best));
}

// Primary limit first, the rest in their original order.
export function orderedLimits(limits) {
  const primary = primaryLimit(limits);
  return primary ? [primary, ...limits.filter((l) => l !== primary)] : [];
}

// Data saved before plan support stored the account as a plain string.
export function accountName(data) {
  const account = data?.account;
  return (typeof account === 'string' ? account : account?.name) || null;
}
