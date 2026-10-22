import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEndpointPayload, toTimestamp } from '../src/lib/normalize.js';

test('nested weekly percent with ISO reset', () => {
  const { limits } = normalizeEndpointPayload({ weekly: { remaining_percent: 72, reset_at: '2026-10-27T09:00:00Z' } });
  assert.equal(limits.length, 1);
  assert.equal(limits[0].period, 'weekly');
  assert.equal(limits[0].remainingPercent, 72);
  assert.equal(limits[0].resetAt, Date.parse('2026-10-27T09:00:00Z'));
});

test('used/limit counts with unix-seconds reset', () => {
  const [limit] = normalizeEndpointPayload({ data: { used: 30, limit: 120, resets_at: 1793091600 } }).limits;
  assert.equal(limit.remaining, 90);
  assert.equal(limit.remainingPercent, 75);
  assert.equal(limit.resetAt, 1793091600 * 1000);
});

test('used percent is inverted and clamped', () => {
  assert.equal(normalizeEndpointPayload({ used_percent: 120 }).limits[0].remainingPercent, 0);
});

test('limits array with plan and account', () => {
  const result = normalizeEndpointPayload({
    plan: 'ChatGPT Pro',
    account: { name: 'Ada' },
    limits: [
      { period: 'monthly', remaining_percent: 40 },
      { period: '5h', used: 2, limit: 10 }
    ]
  });
  assert.deepEqual(result.plan, { id: 'pro', name: 'Pro' });
  assert.deepEqual(result.account, { name: 'Ada' });
  assert.deepEqual(result.limits.map((l) => [l.period, l.periodLabel, l.remainingPercent]), [
    ['monthly', 'Monthly', 40],
    ['5h', '5-hour', 80]
  ]);
});

test('per-period sections by key', () => {
  const { limits } = normalizeEndpointPayload({ monthlyLimit: { remaining_percent: 10 }, yearly: { remaining: 5, limit: 10 } });
  assert.deepEqual(limits.map((l) => l.period), ['monthly', 'yearly']);
});

test('unknown plan names are kept as given', () => {
  assert.deepEqual(normalizeEndpointPayload({ plan_type: 'Pro Lite', weekly: { remaining_percent: 1 } }).plan, {
    id: 'pro_lite',
    name: 'Pro Lite'
  });
});

test('unusable payloads return null', () => {
  assert.equal(normalizeEndpointPayload(null), null);
  assert.equal(normalizeEndpointPayload({ foo: 1 }), null);
  assert.equal(toTimestamp('not a date'), null);
});
