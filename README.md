# Scrum Plane Bot

Telegram-бот, который понимает русский язык, ставит задачи в **Plane** через
**Claude AI** и присматривает за сервисами (healthcheck каждые 5 минут).

## Стек
Node.js 18+, ESM, Telegraf 4, better-sqlite3, node-cron, dotenv.

## Установка
```bash
npm install
cp .env.example .env
# заполнить токены и URL в .env
npm run setup    # создаст таблицы в bot.db и проверит подключения
npm start        # запустит бота
```

## Структура
| Файл | Назначение |
|---|---|
| `src/bot.js` | Точка входа: Telegram-бот, обработчики, команды |
| `src/claude.js` | Обращения к Claude API (analyzeTask, analyzeError) |
| `src/plane.js` | CRUD задач в Plane |
| `src/healthcheck.js` | Мониторинг сервисов, алерты в Telegram |
| `src/db.js` | Подключение к SQLite (файл `bot.db`) |
| `src/setup.js` | Проверка `.env` и создание таблиц БД |

## Что делает бот
- Ставит задачи в Plane по сообщениям на русском («поставь задачу Игорю — поправить логи до пятницы»).
- Подтверждает создание задачи кнопкой перед отправкой.
- Команда `/status` — текущее состояние всех сервисов.
- Команда `/help` — что умеет бот.
- Сам мониторит Plane / Claude / Telegram / собственный health-endpoint каждые 5 мин, шлёт алерт при сбое.

## База данных
SQLite, один файл `bot.db` рядом с проектом. Две таблицы:
- `tasks` — связка Telegram-юзер ↔ ID задачи в Plane.
- `dialog_history` — последние сообщения для контекста Claude.

В оригинальном гайде использовался PostgreSQL — мы взяли SQLite для простоты,
переход на PostgreSQL делается заменой драйвера в `src/db.js`.
