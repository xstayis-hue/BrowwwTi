# Ti · брови — Telegram Mini App

Сайт-визитка + запись для бровиста (Telegram Mini App).

## Фронт (index.html)
- Секции: услуги с ценами, работы до/после, отзывы с модерацией, запись в 3 шага, контакты
- Кабинет мастера: точка «·» под контактами → ключ → заявки + модерация отзывов
- Настройка: вписать URL воркера в API_BASE, контакты в LINKS, услуги в SERVICES

## Бэк (brow-worker.js, Cloudflare Worker)
- POST /api/book — заявка → KV + уведомление мастеру в Telegram
- POST /api/review — отзыв на модерации; GET /api/reviews — только одобренные
- GET /api/admin?key= — заявки + отзывы на модерации; POST /api/moderate?key= — публикация/удаление
- GET /api/whoami — узнать CHAT_ID
- Конфиг через переменные окружения: BOT_TOKEN, CHAT_ID, ADMIN_KEY; KV-биндинг BK

## Деплой
1. Pages/хостинг: index.html
2. Cloudflare Worker: вставить brow-worker.js, добавить KV-биндинг BK, переменные BOT_TOKEN/CHAT_ID/ADMIN_KEY
3. API_BASE в index.html = URL воркера
