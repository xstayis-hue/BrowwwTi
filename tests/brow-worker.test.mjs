import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import worker from '../brow-worker.js';

const originalFetch = globalThis.fetch;
const origin = 'https://xstayis-hue.github.io';
const adminKey = 'test-key-for-worker-test-only-at-least-32-chars';

class MemoryKV {
  records = new Map();

  async put(key, value) {
    this.records.set(key, value);
  }

  async get(key) {
    return this.records.get(key) ?? null;
  }

  async delete(key) {
    this.records.delete(key);
  }

  async list({ prefix, limit = 1000, cursor }) {
    const names = [...this.records.keys()].filter((name) => name.startsWith(prefix)).sort();
    const offset = Number(cursor || 0);
    const keys = names.slice(offset, offset + limit).map((name) => ({ name }));
    const nextOffset = offset + keys.length;
    const listComplete = nextOffset >= names.length;
    return {
      keys,
      list_complete: listComplete,
      cursor: listComplete ? '' : String(nextOffset),
    };
  }
}

let env;
let telegramMessages;
let telegramResult;

function request(path, { method = 'GET', body, headers = {}, requestOrigin = origin } = {}) {
  return new Request('https://ti-worker.test' + path, {
    method,
    headers: {
      ...(requestOrigin ? { Origin: requestOrigin } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function call(path, options = {}, bindings = env) {
  return worker.fetch(request(path, options), bindings);
}

async function json(response) {
  return response.json();
}

beforeEach(() => {
  telegramMessages = [];
  telegramResult = Response.json({ ok: true });
  globalThis.fetch = async (_url, options) => {
    telegramMessages.push(JSON.parse(options.body));
    return telegramResult;
  };
  env = {
    BK: new MemoryKV(),
    ADMIN_KEY: adminKey,
    BOT_TOKEN: 'test-token',
    CHAT_ID: '12345',
    ALLOWED_ORIGINS: origin,
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('health reports setup state without exposing secrets', async () => {
  const result = await json(await call('/api/health'));
  assert.equal(result.ok, true);
  assert.equal(result.ready, true);
  assert.equal(result.notificationsConfigured, true);
  assert.equal(JSON.stringify(result).includes(env.BOT_TOKEN), false);
});

test('rejects unapproved browser origins', async () => {
  const response = await call('/api/health', { requestOrigin: 'https://not-ti.example' });
  assert.equal(response.status, 403);
  assert.equal((await json(response)).error, 'origin_not_allowed');
});

test('answers browser preflight requests without a body', async () => {
  const response = await call('/api/moderate', {
    method: 'OPTIONS',
    headers: {
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  assert.match(response.headers.get('Access-Control-Allow-Headers'), /Authorization/);
});

test('stores booking and escapes user values in Telegram message', async () => {
  const response = await call('/api/book', {
    method: 'POST',
    body: {
      name: '<b>Аня</b>',
      contact: '@anya',
      serviceId: 'brow-shape',
      date: new Date().toISOString().slice(0, 10),
      time: '10:00',
      note: '<script>alert(1)</script>',
    },
  });
  const result = await json(response);
  assert.equal(response.status, 201);
  assert.equal(result.ok, true);
  assert.equal(result.saved, true);
  assert.equal(result.notified, true);
  assert.equal((await env.BK.get(result.id)) !== null, true);
  assert.match(telegramMessages[0].text, /&lt;b&gt;Аня&lt;\/b&gt;/);
  assert.match(telegramMessages[0].text, /&lt;script&gt;/);
});

test('does not claim a booking was sent when storage is unavailable', async () => {
  const brokenEnv = { ...env, BK: { put: async () => { throw new Error('KV unavailable'); } } };
  const response = await call('/api/book', {
    method: 'POST',
    body: {
      name: 'Аня',
      contact: '@anya',
      serviceId: 'brow-shape',
      date: new Date().toISOString().slice(0, 10),
      time: '10:00',
      note: '',
    },
  }, brokenEnv);
  assert.equal(response.status, 503);
  assert.equal((await json(response)).ok, false);
  assert.equal(telegramMessages.length, 0);
});

test('returns saved state if Telegram notification fails', async () => {
  telegramResult = Response.json({ ok: false });
  const response = await call('/api/book', {
    method: 'POST',
    body: {
      name: 'Аня',
      contact: '@anya',
      serviceId: 'brow-shape',
      date: new Date().toISOString().slice(0, 10),
      time: '10:00',
      note: '',
    },
  });
  const result = await json(response);
  assert.equal(response.status, 201);
  assert.equal(result.saved, true);
  assert.equal(result.notified, false);
});

test('validates booking data and request size', async () => {
  for (const serviceId of ['not-a-service', 'constructor']) {
    const invalid = await call('/api/book', {
      method: 'POST',
      body: {
        name: 'Аня',
        contact: '@anya',
        serviceId,
        date: new Date().toISOString().slice(0, 10),
        time: '10:00',
      },
    });
    assert.equal(invalid.status, 400);
    assert.equal((await json(invalid)).error, 'invalid_booking');
  }

  const tooLarge = await worker.fetch(new Request('https://ti-worker.test/api/book', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Length': '20000', 'Content-Type': 'application/json' },
    body: '{}',
  }), env);
  assert.equal(tooLarge.status, 413);
});

test('reviews stay private until the admin approves them', async () => {
  const submitted = await call('/api/review', {
    method: 'POST',
    body: { name: 'Маша', text: 'Очень бережно и красиво.', rating: 5 },
  });
  const review = await json(submitted);
  assert.equal(submitted.status, 201);
  assert.equal(review.notified, true);
  assert.deepEqual((await json(await call('/api/reviews'))).reviews, []);

  const unauthorized = await call('/api/admin');
  assert.equal(unauthorized.status, 401);
  const authHeaders = { Authorization: 'Bearer ' + adminKey };
  const admin = await call('/api/admin', { headers: authHeaders });
  const adminData = await json(admin);
  assert.equal(adminData.pending.length, 1);

  const moderated = await call('/api/moderate', {
    method: 'POST',
    headers: authHeaders,
    body: { id: review.id, action: 'approve' },
  });
  assert.equal(moderated.status, 200);
  const publicReviews = await json(await call('/api/reviews'));
  assert.equal(publicReviews.reviews.length, 1);
  assert.equal(publicReviews.reviews[0].name, 'Маша');
});

test('rejecting a review removes it from the pending list', async () => {
  const submitted = await call('/api/review', {
    method: 'POST',
    body: { name: 'Лена', text: 'Спасибо!', rating: 4 },
  });
  const review = await json(submitted);
  const result = await call('/api/moderate', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + adminKey },
    body: { id: review.id, action: 'reject' },
  });
  assert.equal(result.status, 200);
  const admin = await call('/api/admin', { headers: { Authorization: 'Bearer ' + adminKey } });
  assert.equal((await json(admin)).pending.length, 0);
});
