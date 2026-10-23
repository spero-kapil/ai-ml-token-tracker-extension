// Normalizes a JSON response from a user-configured, authorized usage endpoint
// into the same shape produced by the page parser:
// { limits: [{ period, periodLabel, periodMs, label, remainingPercent,
//              usedPercent, remaining, limit, resetAt, resetText }],
//   plan: { id, name } | null, account: { name } | null }
//
// Accepted layouts (also nested under `data`):
//   { limits: [{ period: 'monthly', remaining_percent: 40, … }, …] }
//   { weekly: {…}, monthly: {…}, five_hour: {…}, … }
//   { period: 'weekly', remaining_percent: 72, … }   (a single limit)
import { describePeriod, normalizePlan } from './usage.js';

const pick = (obj, keys) => {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
};

const toNumber = (value) => {
  const n = typeof value === 'string' ? Number(value.replace(/[%,\s]/g, '')) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Keys of per-period sections, e.g. `weekly`, `weekly_limit`, `monthlyUsage`.
const SECTION_RE = /^(hourly|daily|weekly|monthly|yearly|annual|billing(?:_?period)?|\d+_?(?:h|hours?|d|days?)|five_hour)(?:_?(?:limit|usage))?$/i;
const PERIOD_FROM_KEY = { five_hour: '5h', billingperiod: 'billing', billing_period: 'billing' };

export function toTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') {
    // Treat values below 1e12 as Unix seconds.
    return value < 1e12 ? value * 1000 : value;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return toTimestamp(numeric);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeLimit(section, periodRaw) {
  if (!isObject(section)) return null;

  let remainingPercent = toNumber(pick(section, ['remaining_percent', 'remainingPercent', 'percent_remaining']));
  let usedPercent = toNumber(pick(section, ['used_percent', 'usedPercent', 'percent_used']));
  const remaining = toNumber(pick(section, ['remaining', 'remaining_count', 'remainingCount']));
  const used = toNumber(pick(section, ['used', 'used_count', 'usedCount']));
  const limit = toNumber(pick(section, ['limit', 'total', 'quota', 'allowance']));

  if (remainingPercent === undefined && usedPercent !== undefined) remainingPercent = 100 - usedPercent;
  if (remainingPercent === undefined && limit) {
    if (remaining !== undefined) remainingPercent = (remaining / limit) * 100;
    else if (used !== undefined) remainingPercent = ((limit - used) / limit) * 100;
  }
  if (remainingPercent !== undefined) {
    remainingPercent = Math.max(0, Math.min(100, remainingPercent));
    usedPercent = 100 - remainingPercent;
  }

  const resetRaw = pick(section, ['reset_at', 'resets_at', 'resetAt', 'resetsAt', 'reset_time', 'next_reset']);
  const period = describePeriod(pick(section, ['period', 'window', 'interval']) ?? periodRaw);

  const result = {
    ...period,
    label: pick(section, ['label']) || `${period.periodLabel} usage limit`,
    remainingPercent: remainingPercent ?? null,
    usedPercent: usedPercent ?? null,
    remaining: remaining ?? (limit !== undefined && used !== undefined ? limit - used : null),
    limit: limit ?? null,
    resetAt: toTimestamp(resetRaw),
    resetText: typeof resetRaw === 'string' ? resetRaw : null
  };

  return result.remainingPercent === null && result.remaining === null ? null : result;
}

function collectLimits(root) {
  if (Array.isArray(root.limits)) return root.limits.map((section) => normalizeLimit(section));

  const limits = [];
  for (const [key, value] of Object.entries(root)) {
    if (!SECTION_RE.test(key) || !isObject(value)) continue;
    const base = key.toLowerCase().replace(/_?(limit|usage)$/, '');
    limits.push(normalizeLimit(value, PERIOD_FROM_KEY[base] || base));
  }
  if (limits.some(Boolean)) return limits;

  // A single limit at the top level; weekly unless it names its period.
  return [normalizeLimit(root, 'weekly')];
}

export function normalizeEndpointPayload(payload) {
  if (!isObject(payload)) return null;

  const root = isObject(payload.data) ? { ...payload, ...payload.data } : payload;
  const limits = collectLimits(root).filter(Boolean);
  if (!limits.length) return null;

  const accountRaw = pick(root, ['account', 'user']);
  const accountName = isObject(accountRaw)
    ? pick(accountRaw, ['name', 'display_name', 'email'])
    : accountRaw ?? pick(root, ['email_id', 'account_name', 'name', 'email']);

  return {
    limits,
    plan: normalizePlan(pick(root, ['plan', 'plan_type', 'planType', 'subscription', 'subscription_type', 'tier'])),
    account: accountName ? { name: String(accountName) } : null
  };
}
