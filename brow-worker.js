const SERVICES = Object.freeze({
  'brow-shape': { name: 'Коррекция бровей', price: 1200, duration: 40 },
  'brow-color': { name: 'Окрашивание + коррекция', price: 1800, duration: 75 },
  'brow-lamination': { name: 'Ламинирование бровей', price: 2800, duration: 90 },
  'lash-lamination': { name: 'Ламинирование ресниц', price: 2500, duration: 90 },
  'brow-lash-combo': { name: 'Комплекс: брови + ресницы', price: 4500, duration: 150 },
});
const TIMES = new Set(['10:00', '11:30', '13:00', '14:30', '16:00', '17:30']);
const MAX_BODY_BYTES = 16 * 1024;
const RECORD_TTL_SECONDS = 60 * 60 * 24 * 180;

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || 'https://xstayis-hue.github.io')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function response(request, env, payload, status = 200) {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Vary': 'Origin',
  });
  const origin = request.headers.get('Origin');
  if (origin && allowedOrigins(env).includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Max-Age', '86400');
  }
  return new Response(status === 204 ? null : JSON.stringify(payload), { status, headers });
}

function validOrigin(request, env) {
  const origin = request.headers.get('Origin');
  return !origin || allowedOrigins(env).includes(origin);
}

function text(value, maxLength) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, maxLength);
}

async function readJson(request) {
  const declaredSize = Number(request.headers.get('Content-Length') || 0);
  if (declaredSize > MAX_BODY_BYTES) return { error: 'request_too_large' };
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) return { error: 'request_too_large' };
  try {
    const value = JSON.parse(body);
    return value && typeof value === 'object' && !Array.isArray(value) ? { value } : { error: 'invalid_json' };
  } catch {
    return { error: 'invalid_json' };
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00.000Z');
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return false;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const days = (parsed.getTime() - today.getTime()) / 86400000;
  return days >= 0 && days <= 60;
}

async function sendTelegram(env, message) {
  if (!env.BOT_TOKEN || !env.CHAT_ID) return false;
  try {
    const result = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.CHAT_ID,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(8000),
    });
    const payload = await result.json();
    return result.ok && payload.ok === true;
  } catch {
    return false;
  }
}

async function readPrefix(kv, prefix) {
  const records = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const key of page.keys) {
      const raw = await kv.get(key.name);
      if (raw === null) continue;
      records.push({ id: key.name, ...JSON.parse(raw) });
    }
    cursor = page.list_complete ? undefined : page.cursor;
    if (!page.list_complete && !cursor) throw new Error('KV pagination cursor is missing');
  } while (cursor);
  return records;
}

function authorized(request, env) {
  const expected = env.ADMIN_KEY;
  if (typeof expected !== 'string' || expected.length < 32) return 'not_configured';
  const provided = request.headers.get('Authorization') || '';
  const match = /^Bearer (.+)$/.exec(provided);
  if (!match) return 'invalid';
  const encoder = new TextEncoder();
  const left = encoder.encode(match[1]);
  const right = encoder.encode(expected);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left[index] || 0) ^ (right[index] || 0);
  }
  return difference === 0 ? 'valid' : 'invalid';
}

async function requireBody(request, env) {
  const parsed = await readJson(request);
  if (parsed.error) return { response: response(request, env, { ok: false, error: parsed.error }, parsed.error === 'request_too_large' ? 413 : 400) };
  return { body: parsed.value };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!validOrigin(request, env)) return response(request, env, { ok: false, error: 'origin_not_allowed' }, 403);
    if (request.method === 'OPTIONS') return response(request, env, null, 204);
    if (!['GET', 'POST'].includes(request.method)) {
      return response(request, env, { ok: false, error: 'method_not_allowed' }, 405);
    }

    if (url.pathname === '/api/health' && request.method === 'GET') {
      const storageConfigured = Boolean(env.BK);
      return response(request, env, {
        ok: true,
        ready: storageConfigured && typeof env.ADMIN_KEY === 'string' && env.ADMIN_KEY.length >= 32,
        storageConfigured,
        notificationsConfigured: Boolean(env.BOT_TOKEN && env.CHAT_ID),
      });
    }

    if (url.pathname === '/api/book' && request.method === 'POST') {
      if (!env.BK) return response(request, env, { ok: false, error: 'storage_not_configured' }, 503);
      const parsed = await requireBody(request, env);
      if (parsed.response) return parsed.response;
      const body = parsed.body;
      const serviceId = text(body.serviceId, 40);
      const service = Object.hasOwn(SERVICES, serviceId) ? SERVICES[serviceId] : null;
      const name = text(body.name, 40);
      const contact = text(body.contact, 80);
      const date = text(body.date, 10);
      const time = text(body.time, 5);
      const note = text(body.note, 300);
      if (!name || !contact || contact.length < 3 || !service || !validDate(date) || !TIMES.has(time)) {
        return response(request, env, { ok: false, error: 'invalid_booking' }, 400);
      }

      const booking = {
        id: `book:${Date.now()}:${crypto.randomUUID()}`,
        name,
        contact,
        serviceId,
        date,
        time,
        note,
        at: new Date().toISOString(),
        status: 'new',
      };
      try {
        await env.BK.put(booking.id, JSON.stringify(booking), { expirationTtl: RECORD_TTL_SECONDS });
      } catch {
        return response(request, env, { ok: false, error: 'storage_unavailable' }, 503);
      }
      const message = [
        '<b>Новый запрос на запись · Ti</b>',
        `<b>${escapeHtml(booking.name)}</b> · ${escapeHtml(booking.contact)}`,
        `${escapeHtml(service.name)} · ${service.price} ₽`,
        `${escapeHtml(booking.date)} в ${escapeHtml(booking.time)}`,
        booking.note ? `Пожелания: ${escapeHtml(booking.note)}` : '',
      ].filter(Boolean).join('\n');
      const notified = await sendTelegram(env, message);
      return response(request, env, { ok: true, id: booking.id, saved: true, notified }, 201);
    }

    if (url.pathname === '/api/review' && request.method === 'POST') {
      if (!env.BK) return response(request, env, { ok: false, error: 'storage_not_configured' }, 503);
      const parsed = await requireBody(request, env);
      if (parsed.response) return parsed.response;
      const body = parsed.body;
      const name = text(body.name, 40);
      const reviewText = text(body.text, 400);
      const rating = body.rating;
      if (!name || !reviewText || !Number.isInteger(rating) || rating < 1 || rating > 5) {
        return response(request, env, { ok: false, error: 'invalid_review' }, 400);
      }
      const review = {
        id: `review:${Date.now()}:${crypto.randomUUID()}`,
        name,
        text: reviewText,
        rating,
        approved: false,
        at: new Date().toISOString(),
      };
      try {
        await env.BK.put(review.id, JSON.stringify(review), { expirationTtl: RECORD_TTL_SECONDS });
      } catch {
        return response(request, env, { ok: false, error: 'storage_unavailable' }, 503);
      }
      const notified = await sendTelegram(env, [
        '<b>Новый отзыв на проверке · Ti</b>',
        `${escapeHtml(review.name)} · ${'★'.repeat(review.rating)}`,
        escapeHtml(review.text),
      ].join('\n'));
      return response(request, env, { ok: true, id: review.id, notified }, 201);
    }

    if (url.pathname === '/api/reviews' && request.method === 'GET') {
      if (!env.BK) return response(request, env, { ok: false, error: 'storage_not_configured' }, 503);
      try {
        const reviews = await readPrefix(env.BK, 'review:');
        const visible = reviews
          .filter((review) => review.approved === true)
          .sort((a, b) => String(b.at).localeCompare(String(a.at)))
          .slice(0, 100)
          .map(({ id, name, text, rating, at }) => ({ id, name, text, rating, at }));
        return response(request, env, { ok: true, reviews: visible });
      } catch {
        return response(request, env, { ok: false, error: 'storage_unavailable' }, 503);
      }
    }

    if (url.pathname === '/api/admin' && request.method === 'GET') {
      const auth = authorized(request, env);
      if (auth === 'not_configured') return response(request, env, { ok: false, error: 'admin_not_configured' }, 503);
      if (auth !== 'valid') return response(request, env, { ok: false, error: 'unauthorized' }, 401);
      if (!env.BK) return response(request, env, { ok: false, error: 'storage_not_configured' }, 503);
      try {
        const [bookings, reviews] = await Promise.all([
          readPrefix(env.BK, 'book:'),
          readPrefix(env.BK, 'review:'),
        ]);
        return response(request, env, {
          ok: true,
          bookings: bookings.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 100),
          pending: reviews.filter((review) => review.approved !== true).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 100),
        });
      } catch {
        return response(request, env, { ok: false, error: 'storage_unavailable' }, 503);
      }
    }

    if (url.pathname === '/api/moderate' && request.method === 'POST') {
      const auth = authorized(request, env);
      if (auth === 'not_configured') return response(request, env, { ok: false, error: 'admin_not_configured' }, 503);
      if (auth !== 'valid') return response(request, env, { ok: false, error: 'unauthorized' }, 401);
      if (!env.BK) return response(request, env, { ok: false, error: 'storage_not_configured' }, 503);
      const parsed = await requireBody(request, env);
      if (parsed.response) return parsed.response;
      const id = text(parsed.body.id, 120);
      const action = parsed.body.action;
      if (!id.startsWith('review:') || !['approve', 'reject'].includes(action)) {
        return response(request, env, { ok: false, error: 'invalid_moderation' }, 400);
      }
      try {
        const raw = await env.BK.get(id);
        if (raw === null) return response(request, env, { ok: false, error: 'review_not_found' }, 404);
        if (action === 'reject') {
          await env.BK.delete(id);
        } else {
          const review = JSON.parse(raw);
          review.approved = true;
          await env.BK.put(id, JSON.stringify(review), { expirationTtl: RECORD_TTL_SECONDS });
        }
        return response(request, env, { ok: true });
      } catch {
        return response(request, env, { ok: false, error: 'storage_unavailable' }, 503);
      }
    }

    return response(request, env, { ok: false, error: 'not_found' }, 404);
  },
};
