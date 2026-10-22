import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountName, describePeriod, limitsOf, orderedLimits, primaryLimit } from '../src/lib/usage.js';
import { formatLogEntry } from '../src/lib/log-format.js';

test('describes named and numeric periods', () => {
  assert.equal(describePeriod('week').period, 'weekly');
  assert.equal(describePeriod('Annual').periodLabel, 'Yearly');
  assert.deepEqual(describePeriod('5_hours'), { period: '5h', periodLabel: '5-hour', periodMs: 5 * 36e5 });
  assert.equal(describePeriod('3d').periodLabel, '3-day');
});

test('primary limit is the longest period with a figure', () => {
  const fiveHour = { period: '5h', periodMs: 5 * 36e5, remainingPercent: 10 };
  const weekly = { period: 'weekly', periodMs: 7 * 864e5, remainingPercent: 60 };
  const monthly = { period: 'monthly', periodMs: 30 * 864e5, remainingPercent: null };
  assert.equal(primaryLimit([fiveHour, weekly, monthly]), weekly);
  assert.deepEqual(orderedLimits([fiveHour, weekly]), [weekly, fiveHour]);
  assert.equal(primaryLimit([]), null);
});

test('reads data stored before multi-period support', () => {
  const legacy = { weekly: { remainingPercent: 50 }, account: 'Ada' };
  assert.equal(limitsOf(legacy)[0].period, 'weekly');
  assert.equal(limitsOf(legacy)[0].remainingPercent, 50);
  assert.equal(accountName(legacy), 'Ada');
  assert.equal(accountName({ account: { name: 'Grace' } }), 'Grace');
});

test('log entries format as one line plus details and stack', () => {
  const text = formatLogEntry({
    at: '2026-10-20T10:00:00.000Z',
    level: 'error',
    scope: 'background:refresh',
    code: 'AUTH',
    message: 'Signed out',
    details: { trigger: 'manual' },
    stack: 'Error: Signed out\n    at run (background.js:1:1)'
  });
  assert.equal(
    text,
    '2026-10-20T10:00:00.000Z [ERROR] [background:refresh] AUTH: Signed out\n' +
      '    details: {"trigger":"manual"}\n' +
      '    at run (background.js:1:1)'
  );
});
