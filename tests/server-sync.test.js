import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildChatGptPayload, endpointUrl, formatServerTime, parseServerUrl, pushUsage } from '../src/lib/server-sync.js';

const STATE = {
  data: {
    limits: [
      { period: '5h', periodMs: 5 * 36e5, usedPercent: 40, remainingPercent: 60, resetAt: Date.UTC(2025, 11, 31, 18) },
      { period: 'monthly', periodMs: 30 * 864e5, usedPercent: 10, remainingPercent: 90, resetAt: Date.UTC(2026, 0, 1) }
    ],
    account: { name: 'test@example.com' },
    plan: { id: 'free', name: 'Free' },
    fetchedAt: Date.UTC(2025, 11, 31, 12, 30)
  },
  profile: null
};

let storage;
let requests;
let logged;
let respond;
let granted;

beforeEach(() => {
  storage = {};
  requests = [];
  logged = [];
  granted = ['http://127.0.0.1:3000/*'];
  respond = () => new Response(null, { status: 201 });
  globalThis.chrome = {
    permissions: { contains: async ({ origins }) => origins.every((o) => granted.includes(o)) },
    storage: {
      local: {
        get: async (key) => ({ [key]: storage[key] }),
        set: async (items) => Object.assign(storage, items)
      }
    },
    runtime: { sendMessage: async (message) => logged.push(message.entry) }
  };
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return respond();
  };
});

test('formats times as UTC "YYYY-MM-DD HH:mm:ss"', () => {
  assert.equal(formatServerTime(Date.UTC(2026, 0, 1)), '2026-01-01 00:00:00');
  assert.equal(formatServerTime(null), null);
});

test('parses host:port and full server URLs', () => {
  assert.equal(parseServerUrl('127.0.0.1:3000').href, 'http://127.0.0.1:3000/');
  assert.equal(parseServerUrl(' https://usage.example.com ').href, 'https://usage.example.com/');
  assert.equal(parseServerUrl('http://10.0.0.5:8080/tracker?x=1').href, 'http://10.0.0.5:8080/tracker/');
  assert.equal(parseServerUrl(''), null);
  assert.equal(parseServerUrl('ftp://example.com'), null);
  assert.equal(parseServerUrl('http://'), null);
});

test('joins the server URL, API path and endpoint path', () => {
  assert.equal(endpointUrl('127.0.0.1:3000', '/chat-gpt'), 'http://127.0.0.1:3000/api/chat-gpt');
  assert.equal(endpointUrl('http://10.0.0.5:8080/tracker', 'chat-gpt'), 'http://10.0.0.5:8080/tracker/api/chat-gpt');
  assert.throws(() => endpointUrl('', '/chat-gpt'), { code: 'SERVER' });
});

test('builds the ChatGPT payload from stored state', () => {
  assert.deepEqual(buildChatGptPayload(STATE), {
    provider: 'chatgpt',
    account_name: 'test@example.com',
    plan_type: 'free',
    data: {
      '5h_usage': 40,
      '5h_reset_time': '2025-12-31 18:00:00',
      monthly_usage: 10,
      monthly_reset_time: '2026-01-01 00:00:00',
      last_updated: '2025-12-31 12:30:00'
    }
  });
});

test('payload falls back to the sidebar profile and keeps duplicate periods apart', () => {
  const payload = buildChatGptPayload({
    data: { limits: [{ period: 'weekly', usedPercent: 1 / 3 }, { period: 'weekly', usedPercent: null }], fetchedAt: null },
    profile: { account: { name: 'Ada' }, plan: { id: 'plus', name: 'Plus' } }
  });
  assert.equal(payload.account_name, 'Ada');
  assert.equal(payload.plan_type, 'plus');
  assert.equal(payload.data.weekly_usage, 0.33);
  assert.equal(payload.data.weekly_2_usage, null);
  assert.equal(buildChatGptPayload({ data: null }), null);
});

test('posts the payload as JSON and records success', async () => {
  const result = await pushUsage('chatgpt', STATE);
  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://127.0.0.1:3000/api/chat-gpt');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers['Content-Type'], 'application/json');
  assert.equal(JSON.parse(requests[0].init.body).plan_type, 'free');
  assert.equal(storage.serverSync.chatgpt.error, null);
  assert.equal(typeof storage.serverSync.chatgpt.lastSuccessAt, 'number');
});

test('a failing server is recorded, logged once per distinct error, and never throws', async () => {
  respond = () => new Response('boom', { status: 500 });
  const first = await pushUsage('chatgpt', STATE);
  await pushUsage('chatgpt', STATE);
  assert.equal(first.ok, false);
  assert.equal(first.error.code, 'SERVER');
  assert.equal(storage.serverSync.chatgpt.error.code, 'SERVER');
  assert.equal(logged.length, 1);

  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  const offline = await pushUsage('chatgpt', STATE);
  assert.equal(offline.error.code, 'NETWORK');
  assert.equal(logged.length, 2);
});

test('posts to the configured server URL', async () => {
  granted.push('http://10.0.0.5:8080/*');
  assert.equal((await pushUsage('chatgpt', STATE, { serverUrl: '10.0.0.5:8080' })).ok, true);
  assert.equal(requests[0].url, 'http://10.0.0.5:8080/api/chat-gpt');
});

test('does not send without host permission or with an invalid server URL', async () => {
  const denied = await pushUsage('chatgpt', STATE, { serverUrl: 'usage.example.com' });
  assert.equal(denied.error.code, 'PERMISSION');
  const invalid = await pushUsage('chatgpt', STATE, { serverUrl: 'ftp://x' });
  assert.equal(invalid.error.code, 'SERVER');
  assert.equal(requests.length, 0);
  assert.equal(storage.serverSync.chatgpt.error.code, 'SERVER');
  assert.equal(logged.length, 2);
});

test('skips providers without an endpoint and states without data', async () => {
  assert.equal((await pushUsage('cursor', STATE)).skipped, 'not configured');
  assert.equal((await pushUsage('chatgpt', { data: null })).skipped, 'no data');
  assert.equal(requests.length, 0);
});
