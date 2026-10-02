/**
 * Ti · брови — Cloudflare Worker v2.
 *
 * НАСТРОЙКА:
 * 1) Cloudflare → Workers → brow-ti (или новый) → Edit code → вставить файл → Deploy.
 * 2) Лучше через Settings → Variables: BOT_TOKEN, CHAT_ID, ADMIN_KEY (секреты).
 *    Можно и захардкодить ниже — но переменные надёжнее.
 * 3) KV: Settings → Bindings → KV Namespace → переменная BK (namespace "brow-ti-kv").
 * 4) URL воркера → в index.html → const API_BASE.
 *
 * КАБИНЕТ: в мини-аппе точка «·» внизу страницы → ключ (ADMIN_KEY) → заявки + модерация отзывов.
 */

const CONFIG = {
  BOT_TOKEN: '',   // ← или задай переменной окружения BOT_TOKEN
  CHAT_ID: '',     // ← chat_id мастера (подсказка: /api/whoami)
  ADMIN_KEY: 'brow-2026',
};

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);

    const TOKEN = env.BOT_TOKEN || CONFIG.BOT_TOKEN;
    const CHAT_ID = env.CHAT_ID || CONFIG.CHAT_ID;
    const ADMIN_KEY = env.ADMIN_KEY || CONFIG.ADMIN_KEY;

    async function tg(text) {
      if (!TOKEN || !CHAT_ID) return false;
      try {
        const r = await fetch('https://api.telegram.org/bot' + TOKEN + '/sendMessage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' }),
        });
        return r.ok;
      } catch { return false; }
    }

    /* ---------- заявка ---------- */
    if (url.pathname === '/api/book' && request.method === 'POST') {
      const b = await request.json().catch(() => null);
      if (!b || !String(b.name || '').trim() || !String(b.phone || '').trim())
        return json({ ok: false, error: 'bad payload' }, 400);
      const row = {
        name: String(b.name).slice(0, 40),
        phone: String(b.phone).slice(0, 40),
        svc: String(b.svc || '').slice(0, 80),
        price: String(b.price || '').slice(0, 20),
        date: String(b.date || '').slice(0, 10),
        time: String(b.time || '').slice(0, 5),
        note: String(b.note || '').slice(0, 300),
        at: new Date().toISOString(),
      };
      if (env.BK) { try { await env.BK.put('book:' + Date.now(), JSON.stringify(row)); } catch {} }
      const delivered = await tg(
        '<b>✦ Новая заявка</b>\n' +
        '<b>' + row.name + '</b>\n' + row.svc + ' · ' + row.price +
        '\n📅 ' + row.date + ' в ' + row.time +
        '\n📞 ' + row.phone +
        (row.note ? '\n📝 ' + row.note : '')
      );
      return json({ ok: true, delivered });
    }

    /* ---------- отзывы ---------- */
    if (url.pathname === '/api/review' && request.method === 'POST') {
      const r = await request.json().catch(() => null);
      if (!r || !String(r.text || '').trim()) return json({ ok: false, error: 'bad payload' }, 400);
      const id = 'rev:' + Date.now();
      const row = {
        name: String(r.name || 'Клиент').slice(0, 40),
        text: String(r.text).slice(0, 400),
        rating: Math.max(1, Math.min(5, Number(r.rating) || 5)),
        ok: false, // на модерации
        at: new Date().toISOString(),
      };
      if (env.BK) { try { await env.BK.put(id, JSON.stringify(row)); } catch {} }
      await tg('<b>✦ Новый отзыв на модерации</b>\n' + row.name + ' (' + row.rating + '★):\n' + row.text);
      return json({ ok: true, moderated: true });
    }

    // публичный список: только одобренные (у старых записей поля ok нет — считаем одобренными)
    if (url.pathname === '/api/reviews' && request.method === 'GET') {
      if (!env.BK) return json({ ok: true, reviews: [] });
      const list = await env.BK.list({ prefix: 'rev:' });
      const reviews = [];
      for (const k of list.keys) {
        try {
          const r = JSON.parse(await env.BK.get(k.name));
          if (r.ok !== false) reviews.push(r);
        } catch {}
      }
      reviews.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
      return json({ ok: true, reviews });
    }

    /* ---------- кабинет (ключ) ---------- */
    if (url.pathname === '/api/admin' && request.method === 'GET') {
      if (url.searchParams.get('key') !== ADMIN_KEY) return json({ ok: false, error: 'bad key' }, 401);
      if (!env.BK) return json({ ok: true, bookings: [], pending: [], kv: false });
      const bookList = await env.BK.list({ prefix: 'book:' });
      const bookings = [];
      for (const k of bookList.keys) { try { bookings.push(JSON.parse(await env.BK.get(k.name))); } catch {} }
      bookings.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
      const revList = await env.BK.list({ prefix: 'rev:' });
      const pending = [];
      for (const k of revList.keys) {
        try {
          const r = JSON.parse(await env.BK.get(k.name));
          if (r.ok === false) pending.push({ k: k.name, ...r });
        } catch {}
      }
      return json({ ok: true, bookings, pending });
    }

    if (url.pathname === '/api/moderate' && request.method === 'POST') {
      if (url.searchParams.get('key') !== ADMIN_KEY) return json({ ok: false, error: 'bad key' }, 401);
      const b = await request.json().catch(() => null);
      if (!b || !b.id || !env.BK) return json({ ok: false }, 400);
      const row = JSON.parse(await env.BK.get(b.id) || 'null');
      if (!row) return json({ ok: false, error: 'not found' }, 404);
      row.ok = !!b.approve;
      await env.BK.put(b.id, JSON.stringify(row));
      return json({ ok: true });
    }

    /* ---------- chat_id подсказка ---------- */
    if (url.pathname === '/api/whoami' && request.method === 'GET') {
      if (!TOKEN) return json({ ok: false, error: 'token не задан' });
      const r = await fetch('https://api.telegram.org/bot' + TOKEN + '/getUpdates');
      const j = await r.json().catch(() => null);
      const chats = {};
      ((j && j.result) || []).forEach(u => {
        const f = u.message && u.message.from;
        if (f) chats[f.id] = f.first_name || f.username || '';
      });
      return json({ ok: true, chats });
    }

    return json({ ok: false, error: 'not found' }, 404);
  },
};
