/**
 * BrowwwTi backend — Cloudflare Worker.
 *
 * НАСТРОЙКА (5 минут):
 * 1) Cloudflare → Workers & Pages → Create Worker → имя brow-ti → Deploy → Edit code
 *    → вставь этот файл целиком → Deploy.
 * 2) Заполни BOT_TOKEN (токен бота подруги от @BotFather) и CHAT_ID (см. /api/whoami ниже).
 * 3) KV: Workers → brow-ti → Settings → Bindings → KV Namespace → имя переменной BK
 *    (создай namespace "brow-ti-kv"). Без KV работает только отправка в Telegram.
 * 4) URL воркера (https://brow-ti.xxx.workers.dev) вставить в index.html → const API_BASE.
 *
 * Как узнать CHAT_ID: подруга пишет что-нибудь своему боту → открой
 * https://<worker-url>/api/whoami → увидишь id в списке.
 */

const BOT_TOKEN = '';        // ← токен бота мастера
const CHAT_ID = '';          // ← chat_id мастера
const ADMIN_KEY = 'brow-2026'; // ключ кабинета (сменить на свой)

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
};
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);

    async function tg(text) {
      if (!BOT_TOKEN || !CHAT_ID) return false;
      try {
        const r = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' })
        });
        return r.ok;
      } catch (e) { return false; }
    }

    /* заявка */
    if (url.pathname === '/api/book' && request.method === 'POST') {
      const b = await request.json().catch(() => null);
      if (!b || !b.name || !b.phone) return json({ ok: false, error: 'bad payload' }, 400);
      const row = Object.assign({}, b, { at: new Date().toISOString() });
      if (env.BK) { try { await env.BK.put('book:' + Date.now(), JSON.stringify(row)); } catch (e) {} }
      const delivered = await tg(
        '<b>Новая заявка</b>\n' + (b.name || '') +
        '\n' + (b.svc || '') + ' · ' + (b.price || '') +
        '\n📅 ' + (b.date || '') + ' в ' + (b.time || '') +
        '\n📞 ' + (b.phone || '') +
        (b.note ? '\n📝 ' + b.note : '')
      );
      return json({ ok: true, delivered: delivered });
    }

    /* кабинет: список заявок (нужен KV + ключ) */
    if (url.pathname === '/api/list' && request.method === 'GET') {
      if (url.searchParams.get('key') !== ADMIN_KEY) return json({ ok: false, error: 'bad key' }, 401);
      if (!env.BK) return json({ ok: true, items: [], kv: false });
      const list = await env.BK.list({ prefix: 'book:' });
      const items = [];
      for (const k of list.keys) { try { items.push(JSON.parse(await env.BK.get(k.name))); } catch (e) {} }
      items.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
      return json({ ok: true, items: items });
    }

    /* отзыв */
    if (url.pathname === '/api/review' && request.method === 'POST') {
      const r = await request.json().catch(() => null);
      if (!r || !r.text) return json({ ok: false, error: 'bad payload' }, 400);
      const row = {
        name: String(r.name || 'Клиент').slice(0, 40),
        text: String(r.text).slice(0, 400),
        rating: Math.max(1, Math.min(5, Number(r.rating) || 5)),
        at: new Date().toISOString()
      };
      if (env.BK) { try { await env.BK.put('rev:' + Date.now(), JSON.stringify(row)); } catch (e) {} }
      return json({ ok: true });
    }

    /* список отзывов (публичный) */
    if (url.pathname === '/api/reviews' && request.method === 'GET') {
      if (!env.BK) return json({ ok: true, reviews: [] });
      const list = await env.BK.list({ prefix: 'rev:' });
      const reviews = [];
      for (const k of list.keys) { try { reviews.push(JSON.parse(await env.BK.get(k.name))); } catch (e) {} }
      return json({ ok: true, reviews: reviews });
    }

    /* узнать CHAT_ID: мастер пишет боту → открыть этот адрес */
    if (url.pathname === '/api/whoami' && request.method === 'GET') {
      if (!BOT_TOKEN) return json({ ok: false, error: 'token не задан' });
      const r = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/getUpdates');
      const j = await r.json().catch(() => null);
      const chats = {};
      (j && j.result || []).forEach(u => {
        const f = u.message && u.message.from;
        if (f) chats[f.id] = f.first_name || f.username || '';
      });
      return json({ ok: true, chats: chats });
    }

    return json({ ok: false, error: 'not found' }, 404);
  }
};
