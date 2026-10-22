// Text-based parser for the usage overview page. It works on the page's visible
// text rather than CSS selectors so that cosmetic markup changes don't break it.
// Loaded as a classic content script (exposes globalThis.UsageParser) and
// imported by the Node tests.
//
// Usage periods depend on the subscription plan, so every limit the page shows
// is read (N-hour, daily, weekly, monthly, yearly, billing period), each as
// { period, periodLabel, periodMs, label, remainingPercent, usedPercent,
//   remaining, limit, resetAt, resetText }.
(function (root) {
  'use strict';

  const PERCENT_RE = /(\d{1,3}(?:\.\d+)?)\s*%\s*(remaining|left|used)?/i;
  const FRACTION_RE = /(\d[\d,]*)\s*(?:\/|of)\s*(\d[\d,]*)\b[^\d]*?(remaining|left|used)?\s*$/i;
  const RESET_RE = /\bresets?\b\s*(?:on|at)?\s*:?\s*(.*)$/i;
  const STARTS_WITH_RESET_RE = /^(?:resets?|renews?)\b/i;
  const MAX_SECTION_LINES = 8;
  const MAX_HEADER_LENGTH = 80;
  // "3 days" alone is more likely a reset countdown than a heading.
  const LIMIT_WORD_RE = /\b(limit|usage|window|cap|quota|allowance|messages|requests)\b/i;

  const HOUR = 36e5;
  const DAY = 24 * HOUR;

  // Checked in order; the first match names the section's usage period.
  const PERIOD_PATTERNS = [
    { re: /\b(\d+)\s*-?\s*(?:hours?|hrs?|h)\b/i, numeric: true, make: (n) => ({ period: `${n}h`, periodLabel: `${n}-hour`, periodMs: n * HOUR }) },
    { re: /\bhourly\b/i, make: () => ({ period: '1h', periodLabel: 'Hourly', periodMs: HOUR }) },
    { re: /\b(\d+)\s*-?\s*days?\b/i, numeric: true, make: (n) => ({ period: `${n}d`, periodLabel: `${n}-day`, periodMs: n * DAY }) },
    { re: /\b(daily|today|per day)\b/i, make: () => ({ period: 'daily', periodLabel: 'Daily', periodMs: DAY }) },
    { re: /\b(weekly|week)\b/i, make: () => ({ period: 'weekly', periodLabel: 'Weekly', periodMs: 7 * DAY }) },
    { re: /\b(monthly|month)\b/i, make: () => ({ period: 'monthly', periodLabel: 'Monthly', periodMs: 30 * DAY }) },
    { re: /\b(billing (?:period|cycle))\b/i, make: () => ({ period: 'billing', periodLabel: 'Billing period', periodMs: 30 * DAY }) },
    { re: /\b(yearly|annual(?:ly)?|year)\b/i, make: () => ({ period: 'yearly', periodLabel: 'Yearly', periodMs: 365 * DAY }) }
  ];

  const PLANS = {
    free: 'Free',
    go: 'Go',
    plus: 'Plus',
    pro: 'Pro',
    team: 'Team',
    business: 'Business',
    enterprise: 'Enterprise',
    edu: 'Edu'
  };
  const PLAN_NAMES = Object.keys(PLANS).join('|');
  const PLAN_LINE_RE = new RegExp(`^(?:chatgpt\\s+)?(${PLAN_NAMES})(?:\\s+plan)?$`, 'i');
  // Not "ChatGPT Plus" on its own: upgrade prompts use that wording too.
  const PLAN_TEXT_RES = [
    new RegExp(`\\b(?:your|current)\\s+plan\\s*:?\\s*(?:chatgpt\\s+)?(${PLAN_NAMES})\\b`, 'i'),
    new RegExp(`\\b(${PLAN_NAMES})\\s+plan\\b`, 'i')
  ];

  const UNIT_MS = {
    w: 7 * 864e5, week: 7 * 864e5,
    d: 864e5, day: 864e5,
    h: 36e5, hr: 36e5, hour: 36e5,
    m: 6e4, min: 6e4, minute: 6e4
  };
  const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

  function toLines(text) {
    return String(text || '')
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }

  function parseClock(text) {
    const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
    if (!m) return null;
    let hours = Number(m[1]);
    const minutes = Number(m[2] || 0);
    const meridiem = (m[3] || '').toLowerCase();
    if (meridiem === 'pm' && hours < 12) hours += 12;
    if (meridiem === 'am' && hours === 12) hours = 0;
    return { hours, minutes };
  }

  function atClock(baseMs, text) {
    const date = new Date(baseMs);
    const clock = parseClock(text);
    if (clock) date.setHours(clock.hours, clock.minutes, 0, 0);
    else date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  // Turns reset wording ("in 2d 4h", "tomorrow at 9:00 AM", "Monday 9 AM",
  // "Oct 27 at 9:00 AM", "2:30 PM", ISO strings) into an epoch timestamp, or null.
  function parseResetTime(rawText, now) {
    const text = String(rawText || '').replace(/[.]$/, '').trim();
    if (!text) return null;
    const lower = text.toLowerCase();

    if (/^in\b/.test(lower)) {
      let total = 0;
      const re = /(\d+(?:\.\d+)?)\s*(weeks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m)\b/g;
      let m;
      while ((m = re.exec(lower))) {
        const unit = m[2].replace(/s$/, '');
        total += Number(m[1]) * (UNIT_MS[unit] || 0);
      }
      return total > 0 ? now + total : null;
    }

    if (/^today\b/.test(lower)) return atClock(now, lower);
    if (/^tomorrow\b/.test(lower)) return atClock(now + 864e5, lower);

    // A bare clock time ("2:30 PM") is the next occurrence of that time.
    if (/^\d{1,2}(:\d{2})?\s*(am|pm)$/.test(lower)) {
      const ts = atClock(now, lower);
      return ts <= now ? atClock(now + 864e5, lower) : ts;
    }

    const weekday = WEEKDAYS.findIndex((day) => lower.startsWith(day) || lower.startsWith(day.slice(0, 3) + ' '));
    if (weekday !== -1 && !/\d{1,2}\s*[,/]|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/.test(lower)) {
      const today = new Date(now).getDay();
      let delta = (weekday - today + 7) % 7;
      let ts = atClock(now + delta * 864e5, lower);
      if (ts <= now) ts += 7 * 864e5;
      return ts;
    }

    const cleaned = text.replace(/\bat\b/gi, ' ').replace(/\s+/g, ' ').trim();
    const hasYear = /\b\d{4}\b/.test(cleaned);
    const year = new Date(now).getFullYear();
    let ts = Date.parse(hasYear ? cleaned : `${cleaned} ${year}`);
    if (Number.isNaN(ts) && !hasYear) {
      // "Oct 27 9:00 AM 2026" may not parse; move the year next to the date.
      const withYear = cleaned.replace(/^([A-Za-z]+\.? \d{1,2})(,)?/, `$1, ${year}`);
      ts = Date.parse(withYear);
    }
    if (Number.isNaN(ts)) return null;
    // A date without a year that lies in the past belongs to next year.
    if (!hasYear && ts < now - 864e5) {
      const d = new Date(ts);
      d.setFullYear(d.getFullYear() + 1);
      ts = d.getTime();
    }
    return ts;
  }

  function detectPeriod(line) {
    for (const { re, numeric, make } of PERIOD_PATTERNS) {
      const m = re.exec(line);
      if (!m) continue;
      if (numeric && !LIMIT_WORD_RE.test(line)) continue;
      return make(Number(m[1]));
    }
    return null;
  }

  // A section heading names a period ("Weekly usage limit", "5 hour limit",
  // "This month") and carries no figures or reset wording itself.
  function headerPeriod(line) {
    if (line.length > MAX_HEADER_LENGTH || /%/.test(line) || STARTS_WITH_RESET_RE.test(line)) return null;
    if (/^in\b/i.test(line) || FRACTION_RE.test(line)) return null;
    return detectPeriod(line);
  }

  function parseSection(lines, now) {
    const joined = lines.join(' ').toLowerCase();
    const impliesUsed = /\bused\b/.test(joined) && !/\b(remaining|left)\b/.test(joined);
    const result = { remainingPercent: null, usedPercent: null, remaining: null, limit: null, resetAt: null, resetText: null };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (result.remainingPercent === null) {
        const pm = PERCENT_RE.exec(line);
        if (pm) {
          const value = Number(pm[1]);
          const qualifier = (pm[2] || '').toLowerCase();
          const isUsed = qualifier === 'used' || (!qualifier && impliesUsed);
          result.remainingPercent = Math.max(0, Math.min(100, isUsed ? 100 - value : value));
          result.usedPercent = 100 - result.remainingPercent;
        }
      }

      if (result.remaining === null) {
        const fm = FRACTION_RE.exec(line);
        if (fm && !/%/.test(line)) {
          const a = Number(fm[1].replace(/,/g, ''));
          const limit = Number(fm[2].replace(/,/g, ''));
          const isUsed = (fm[3] || '').toLowerCase() === 'used' || (!fm[3] && impliesUsed);
          if (limit > 0) {
            result.limit = limit;
            result.remaining = isUsed ? limit - a : a;
            if (result.remainingPercent === null) {
              result.remainingPercent = (result.remaining / limit) * 100;
              result.usedPercent = 100 - result.remainingPercent;
            }
          }
        }
      }

      if (result.resetText === null) {
        const rm = RESET_RE.exec(line);
        if (rm) {
          let resetText = rm[1].trim();
          if (!resetText && lines[i + 1]) resetText = lines[i + 1];
          if (resetText) {
            result.resetText = resetText;
            result.resetAt = parseResetTime(resetText, now);
          }
        }
      }
    }

    return result.remainingPercent === null && result.remaining === null ? null : result;
  }

  // Every usage limit on the page, in page order, one per period.
  function parseUsageLimits(text, now) {
    const timestamp = typeof now === 'number' ? now : Date.now();
    const lines = toLines(text);
    const limits = [];
    const seen = new Set();

    for (let i = 0; i < lines.length; i++) {
      const period = headerPeriod(lines[i]);
      if (!period || seen.has(period.period)) continue;
      const section = [lines[i]];
      for (let j = i + 1; j < lines.length && section.length < MAX_SECTION_LINES; j++) {
        if (headerPeriod(lines[j])) break;
        section.push(lines[j]);
      }
      const parsed = parseSection(section, timestamp);
      if (!parsed) continue;
      seen.add(period.period);
      limits.push({ label: lines[i], ...period, ...parsed });
    }
    return limits;
  }

  function normalizePlan(raw) {
    const id = String(raw || '').trim().toLowerCase();
    return PLANS[id] ? { id, name: PLANS[id] } : null;
  }

  // Plan wording somewhere in the page text ("Your plan: Plus", "Pro plan").
  function detectPlan(text) {
    for (const re of PLAN_TEXT_RES) {
      const m = re.exec(String(text || ''));
      if (m) return normalizePlan(m[1]);
    }
    return null;
  }

  // The sidebar profile button reads "<name>\n<plan>", possibly after avatar
  // initials ("AL"), which are only used when no longer name is present.
  function parseProfileText(text) {
    let name = null;
    let initials = null;
    let plan = null;
    for (const line of toLines(text)) {
      const m = PLAN_LINE_RE.exec(line);
      if (m) plan = plan || normalizePlan(m[1]);
      else if (line.length <= 2) initials = initials || line;
      else if (!name && line.length <= 80) name = line;
    }
    return { name: name || initials, plan };
  }

  function looksSignedOut(text) {
    const lower = String(text || '').toLowerCase();
    return /\blog in\b|\bsign up\b/.test(lower) && !/\busage\b/.test(lower);
  }

  const api = { parseUsageLimits, parseResetTime, detectPeriod, detectPlan, parseProfileText, looksSignedOut };
  root.UsageParser = api;
})(globalThis);
