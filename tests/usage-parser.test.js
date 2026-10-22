import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/content/usage-parser.js';

const { parseUsageLimits, parseResetTime, detectPlan, parseProfileText, looksSignedOut } = globalThis.UsageParser;

// Tuesday 2026-10-20 10:00 local time
const NOW = new Date(2026, 9, 20, 10, 0, 0).getTime();

const byPeriod = (limits) => Object.fromEntries(limits.map((l) => [l.period, l]));

test('reads every limit with its period and reset', () => {
  const text = `Usage
5 hour usage limit
90% remaining
Resets 2:30 PM
Weekly usage limit
72% remaining
Resets Oct 27, 2026 9:00 AM`;
  const limits = parseUsageLimits(text, NOW);
  assert.deepEqual(limits.map((l) => l.period), ['5h', 'weekly']);

  const { '5h': fiveHour, weekly } = byPeriod(limits);
  assert.equal(fiveHour.periodLabel, '5-hour');
  assert.equal(fiveHour.remainingPercent, 90);
  assert.equal(fiveHour.resetAt, new Date(2026, 9, 20, 14, 30).getTime());
  assert.equal(weekly.label, 'Weekly usage limit');
  assert.equal(weekly.remainingPercent, 72);
  assert.equal(weekly.resetAt, new Date(2026, 9, 27, 9, 0).getTime());
});

test('monthly and yearly periods', () => {
  const limits = parseUsageLimits(
    'Monthly usage limit\n40% used\nResets Nov 1 at 12:00 AM\nAnnual allowance\n800 of 1,000 remaining',
    NOW
  );
  const { monthly, yearly } = byPeriod(limits);
  assert.equal(monthly.remainingPercent, 60);
  assert.equal(monthly.resetAt, new Date(2026, 10, 1, 0, 0).getTime());
  assert.equal(yearly.periodLabel, 'Yearly');
  assert.equal(yearly.remaining, 800);
  assert.equal(yearly.limit, 1000);
  assert.equal(yearly.remainingPercent, 80);
});

test('daily limit', () => {
  const [daily] = parseUsageLimits('Daily limit\n3 / 10 used\nResets tomorrow at 9:00 AM', NOW);
  assert.equal(daily.period, 'daily');
  assert.equal(daily.remaining, 7);
  assert.equal(daily.resetAt, new Date(2026, 9, 21, 9, 0).getTime());
});

test('converts percent used to percent remaining', () => {
  const [weekly] = parseUsageLimits('Weekly limit\n35% used\nResets on Monday at 9:00 AM', NOW);
  assert.equal(weekly.remainingPercent, 65);
  assert.equal(weekly.resetAt, new Date(2026, 9, 26, 9, 0).getTime());
});

test('reads "X of Y" counts and a countdown reset', () => {
  const [weekly] = parseUsageLimits('This week\n12 of 50 messages remaining\nResets in 3 days 4 hours', NOW);
  assert.equal(weekly.period, 'weekly');
  assert.equal(weekly.remaining, 12);
  assert.equal(weekly.limit, 50);
  assert.equal(weekly.remainingPercent, 24);
  assert.equal(weekly.resetAt, NOW + 3 * 864e5 + 4 * 36e5);
});

test('reset text on its own line and date without a year', () => {
  const [weekly] = parseUsageLimits('Weekly usage limit\n40% left\nResets\nOct 27 at 9:00 AM', NOW);
  assert.equal(weekly.remainingPercent, 40);
  assert.equal(weekly.resetText, 'Oct 27 at 9:00 AM');
  assert.equal(weekly.resetAt, new Date(2026, 9, 27, 9, 0).getTime());
});

test('a bare duration line does not start a new section', () => {
  const [weekly] = parseUsageLimits('Weekly usage limit\n40% left\nResets\n3 days', NOW);
  assert.equal(weekly.remainingPercent, 40);
  assert.equal(weekly.resetText, '3 days');
});

test('past date without year rolls into next year', () => {
  assert.equal(parseResetTime('Jan 3 9:00 AM', NOW), new Date(2027, 0, 3, 9, 0).getTime());
});

test('tomorrow / relative short units / bare clock time', () => {
  assert.equal(parseResetTime('tomorrow at 9:00 AM', NOW), new Date(2026, 9, 21, 9, 0).getTime());
  assert.equal(parseResetTime('in 5h 20m', NOW), NOW + 5 * 36e5 + 20 * 6e4);
  assert.equal(parseResetTime('8:00 AM', NOW), new Date(2026, 9, 21, 8, 0).getTime());
});

test('figures under the 5-hour heading are not given to the weekly limit', () => {
  const limits = parseUsageLimits('Weekly usage limit\n5 hour usage limit\n90% remaining', NOW);
  assert.deepEqual(limits.map((l) => [l.period, l.remainingPercent]), [['5h', 90]]);
});

test('returns no limits when nothing is found and detects sign-out', () => {
  assert.deepEqual(parseUsageLimits('Settings\nGeneral\nPersonalization', NOW), []);
  assert.equal(looksSignedOut('Log in\nSign up for free'), true);
  assert.equal(looksSignedOut('Weekly usage limit 72% remaining'), false);
});

test('reads name and plan from the profile button', () => {
  assert.deepEqual(parseProfileText('Ada Lovelace\nPlus'), { name: 'Ada Lovelace', plan: { id: 'plus', name: 'Plus' } });
  assert.deepEqual(parseProfileText('Ada\nChatGPT Pro'), { name: 'Ada', plan: { id: 'pro', name: 'Pro' } });
  assert.deepEqual(parseProfileText('Ada'), { name: 'Ada', plan: null });
  assert.deepEqual(parseProfileText('AL\nAda Lovelace\nFree'), { name: 'Ada Lovelace', plan: { id: 'free', name: 'Free' } });
});

test('detects the plan in page text but ignores upgrade prompts', () => {
  assert.deepEqual(detectPlan('Your plan: ChatGPT Team'), { id: 'team', name: 'Team' });
  assert.deepEqual(detectPlan('You are on the Business plan'), { id: 'business', name: 'Business' });
  assert.equal(detectPlan('Try ChatGPT Plus today'), null);
});
