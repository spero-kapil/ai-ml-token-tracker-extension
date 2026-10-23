# AI token usage tracker extension

A Chromium (Manifest V3) extension that shows your **remaining ChatGPT usage allowance** and the **next reset time** in the toolbar popup. It works for any subscription plan and any usage period (hourly, daily, weekly, monthly, yearly), whichever ones your plan has.

## Install (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Log in at <https://chatgpt.com>, then open the popup and press **Refresh**.

## Provider cards

The popup shows one card per provider, listed in `src/popup/providers.js`. All cards are collapsed when the popup opens, showing:

- the name and icon at top left
- the enable/disable toggle at top right
- a usage bar at bottom left
- a connection dot at bottom right: green for connected, red for disconnected

Clicking a card (or pressing Enter/Space on it) expands or collapses its details. The toggle sits outside the clickable area, so using it never expands the card.

| Provider | Status |
| --- | --- |
| **ChatGPT** | Integrated. The details show the account name, the subscription plan (Free, Go, Plus, Pro, Team, Business, Enterprise, Edu) and the connection. Below that is one block per usage limit the plan has, each with its period, remaining figure, bar and next reset, then Refresh and Open usage page buttons. Turning the toggle off stops refreshing and clears the badge. |
| **Claude Code, Cursor, Devin** | UI only. Each shows *Not connected* and *No usage data*, with a disabled toggle and a placeholder in its details. No data is fetched. |

Each provider names its own details `<template>` in `popup.html` (`details` in `providers.js`). That lets each provider get its own account, usage and reset layout once it is integrated.

### Plans and usage periods

ChatGPT plans have different limits over different periods, so nothing is hard-coded to one plan or one period:

- Every limit on the usage page is read, whatever its period: `5 hour`, `daily`, `weekly`, `monthly`, `yearly`/`annual`, `billing period`.
- The **main allowance** is the limit with the longest period. It comes first in the details, and the collapsed card (e.g. `72% left · weekly`) and toolbar badge use it. Shorter limits are listed under it in a compact form.
- The plan is read from the sidebar profile button (`<name>` / `<plan>`), or from wording such as `Your plan: Pro` on the page.
- If the page shows no limits for a plan, the card says so instead of reporting an error.

## How it gets the data

The extension does **not** bypass authentication or call undocumented private APIs. It uses two data sources:

| Source | When it is used | How |
| --- | --- | --- |
| **Usage page (default)** | Always available | `src/content/content.js` runs on `chatgpt.com` and, on `/settings/usage`, reads the usage limits, account name and plan the page already shows to you in your signed-in session. |
| **Authorized endpoint (optional)** | Only when you set a URL in Options | `src/background.js` calls `fetch()` with `credentials: 'include'` on each refresh (`REFRESH_PERIOD_MINUTES` in `.env`). Enter a URL here only if it is officially supported or you have explicit authorization to use it. Host permission is requested at runtime for that origin only. |

Each refresh tries these in order:

1. The configured authorized endpoint, if one is set.
2. Any open `chatgpt.com/settings/usage` tab.
3. The usage page opened in an **inactive tab** and closed again afterwards. A manual **Refresh** always does this. A scheduled refresh does it only if *Options → Scheduled refresh* is turned on.

Also, whenever you visit the usage page yourself, the extension stores the figures it shows.

## Sending usage to the server

After every refresh (the alarm from `.env`, startup, and manual **Refresh**), `src/lib/server-sync.js` POSTs the latest data for each enabled provider to `<server URL>/api/<endpoint>`. The server URL is set in *Options → Tracking server* (default from `DEFAULT_SERVER_URL` in `.env`). It takes `host:port` (`http://` is assumed) or a full URL such as `https://usage.example.com`. On save, the extension asks for permission for that host, unless it is `127.0.0.1`, which is already allowed. Endpoints are listed in `SERVER_CONFIG.endpoints` (`src/lib/constants.js`). Only ChatGPT is configured:

```
POST http://127.0.0.1:3000/api/chat-gpt
Content-Type: application/json

{
  "provider": "chatgpt",
  "email_id": "test@example.com",
  "plan_type": "free",
  "data": {
    "monthly_usage": 10,
    "monthly_reset_time": "2026-01-01 00:00:00",
    "last_updated": "2025-12-31 12:30:00"
  }
}
```

`data` has one `<period>_usage` (percent used) and `<period>_reset_time` pair per limit the plan has (`5h`, `daily`, `weekly`, `monthly`, …). Times are UTC. If a refresh fails, the last good data is sent, and `last_updated` shows when it was read. Nothing is sent until the first successful read.

A failed request (server down, timeout, non-2xx) never affects the refresh or the popup. It is retried on the next refresh, kept in `chrome.storage.local` under `serverSync`, and written to the error log once per distinct error.

To add a provider, add its `{ method, path }` to `SERVER_CONFIG.endpoints` and a payload builder to `PAYLOAD_BUILDERS` in `server-sync.js`.

## Storage and schedule

- State is stored in `chrome.storage.local` under `usageState`, settings under `settings` and the error log under `errorLog`.
- A `chrome.alarms` alarm fires every **`REFRESH_PERIOD_MINUTES`** (default 15). Chrome may delay it if the browser is asleep or closed.
- The toolbar badge shows the remaining percentage of the main allowance. It is green above 30%, orange at 30% or below, red at 10% or below, and grey when stale.

## Error handling

| Case | Behaviour |
| --- | --- |
| Signed out / HTTP 401–403 | `AUTH` error with a "Log in to ChatGPT" action that opens <https://chatgpt.com/auth/login>. A manual **Refresh** that finds you signed out opens the login page directly; scheduled refreshes never open tabs for this. |
| Page shows no usage limits | `NO_DATA` error with an "Open the usage page" action, or a "no usage limits for your plan" note if the page loaded fully and the plan simply has none |
| Offline, timeout, HTTP 5xx | `NETWORK` error |
| No usage tab and no endpoint (scheduled refresh) | `NO_SOURCE` error |
| Endpoint permission missing | `PERMISSION` error with an "Open options" action |
| ChatGPT toggle off | No refreshes and no badge; the card shows *Disabled* |
| Data older than two refresh intervals, or the main allowance's reset time already passed | Shown as **Stale**; the last known values are kept |

If a refresh fails, the popup keeps the last good values and labels them as stale.

## Error log

Every error (failed sources, sign-outs, parse failures, uncaught exceptions in the worker, popup, options page and content script) is logged:

1. **Console.** The console of the context it happened in (service worker, popup, options or the chatgpt.com tab), prefixed `[AI Usage Tracker]`.
2. **Extension storage.** The last 500 entries. *Options → Error log* shows the count and can download or clear them.
3. **`logs/error.log` in the project directory.** A browser extension can't write files to arbitrary folders, so a small local receiver does it. Run it from the project folder:

   ```bash
   npm run logs      # listens on 127.0.0.1:47321, appends to logs/error.log
   ```

   Entries logged while it isn't running are kept and written when it next receives one (or when the service worker restarts). The receiver only listens on `127.0.0.1`, and the extension only sends error entries to it.

Each entry is one line, `<ISO time> [ERROR] [<scope>] <CODE>: <message>`, followed by indented `details:` and stack lines.

## Development

```bash
cp .env.example .env  # then set DEFAULT_SERVER_URL and REFRESH_PERIOD_MINUTES
npm run env           # write src/lib/env.js from .env (reload the unpacked extension after)
npm test              # parser, normalizer, usage helpers and log format tests (Node 20+)
npm run logs          # write extension errors to logs/error.log
npm run icons         # regenerate icons/ (Python 3, no dependencies)
npm run package       # zip for the Chrome Web Store (create dist/ first)
```

`DEFAULT_SERVER_URL` and `REFRESH_PERIOD_MINUTES` live in `.env`. Chrome cannot read that file directly, so `npm run env` copies them into `src/lib/env.js`. Test and package run that step first.

### If ChatGPT changes the usage page

`src/content/usage-parser.js` reads the page's **visible text**, not CSS selectors, so changes to markup or class names don't break it. It looks for short heading lines that name a period ("5 hour usage limit", "Weekly usage limit", "This month", "Annual allowance"). Under each heading it reads one of these:

- `NN% remaining`, `NN% left` or `NN% used`
- `X of Y`

It also reads a `Resets …` line. New period words go in `PERIOD_PATTERNS`, and new plan names go in `PLANS` (in both `usage-parser.js` and `src/lib/usage.js`). If OpenAI changes the wording, add a sample of the new text to `tests/usage-parser.test.js` and adjust the regular expressions.

## Project layout

```
manifest.json
icons/                     generated toolbar icons
scripts/make_icons.py      icon generator
scripts/log-server.js      local receiver that writes logs/error.log
src/background.js          service worker: alarms, sources, storage, badge
src/content/usage-parser.js text parser (shared with tests)
src/content/content.js     reads the usage page in the user's session
.env / .env.example        DEFAULT_SERVER_URL and REFRESH_PERIOD_MINUTES (`npm run env` writes src/lib/env.js)
src/lib/                   constants, storage, endpoint normalizer, usage/plan helpers, error logger, server sync
src/popup/                 popup UI (provider cards; registry in providers.js)
src/options/               options page
tests/                     node:test unit tests
logs/error.log             error log (created by `npm run logs`)
```
