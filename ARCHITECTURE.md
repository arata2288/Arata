# Архитектура — Scrum Plane Bot

Документ описывает, **из чего состоит бот** и **как компоненты взаимодействуют**.

---

## 1. Обзор

Telegram-бот на Node.js, развёрнут на Railway 24/7. Понимает русский через Claude Sonnet 4.6, ведёт диалог с памятью, создаёт задачи в Plane, мониторит произвольные HTTP-сервисы, принимает входящие webhooks. Защищён whitelist'ом.

| Параметр | Значение |
|---|---|
| Runtime | Node.js 20.x (engines pinned) |
| Тип модулей | ESM (`type: "module"`) |
| Хостинг | Railway, проект `happy-clarity`, сервис `web` |
| Публичный домен | `web-production-39115.up.railway.app` |
| БД | SQLite (`better-sqlite3`), файл `/data/bot.db` на Volume |
| AI | Claude Sonnet 4.6 через `@anthropic-ai/sdk` |
| Telegram | `telegraf` 4 (long polling) |
| Размер кода | ~870 строк в 6 файлах в `src/` |

---

## 2. Структура репозитория

```
.
├── src/
│   ├── bot.js          # Entry point: Telegraf + HTTP-сервер + регистрация команд
│   ├── claude.js       # Обёртки над Anthropic SDK: analyzeTask, analyzeError
│   ├── plane.js        # CRUD задач в Plane API (опционально)
│   ├── healthcheck.js  # Cron-мониторинг сервисов с retry и дедупом
│   ├── db.js           # SQLite: схема, helpers, ensureSchema()
│   └── setup.js        # CLI: проверка env + миграция БД (`npm run setup`)
├── package.json        # deps + engines.node=20.x
├── package-lock.json
├── railway.json        # nixpacks билд + healthcheckPath: /health
├── Procfile            # web: node src/bot.js
├── .env.example        # шаблон переменных
├── .gitignore          # .env, bot.db, node_modules
├── README.md           # человеческое описание
├── DEPLOY.md           # пошаговая инструкция по деплою на Railway
└── ARCHITECTURE.md     # этот файл
```

Не в репозитории (в `.gitignore`):
- `bot.db` — SQLite-файл (на Railway: `/data/bot.db` на Volume).
- `node_modules/`
- `.env` — секреты (на Railway задаются в Variables дашборда).

---

## 3. Модули

### 3.1 `src/bot.js` (~340 строк)

Точка входа. Делает:

1. Подключает зависимости и инициализирует Telegraf, БД, конфиг.
2. **Whitelist middleware** — если `ADMIN_USER_ID` задан, фильтрует всех неразрешённых юзеров. `/myid` и `/start` всегда доступны.
3. **Регистрирует команды** (`/help`, `/menu`, `/status`, `/services`, `/stats`, `/forget`, `/set_alert`, `/monitor`, `/myid`, `/allow`, `/disallow`, `/allowed`).
4. **Reply Keyboard** через `Markup.keyboard()` (`/menu`).
5. **Action handlers** для inline-кнопок `confirm_create` / `cancel_create`.
6. **`bot.on('text', ...)`** — основной обработчик:
   - проверяет, не нажата ли кнопка меню → если да, выполняет соответствующий `cmdXxx`;
   - иначе сохраняет user-сообщение в `dialog_history` и вызывает `claude.analyzeTask()`;
   - роутит по `action` из ответа Claude (`create_task`, `list_tasks`, `update_task`, `question`).
7. **HTTP-сервер** на `process.env.PORT`:
   - `GET /health` — для Railway healthcheck;
   - `POST /webhook/<secret>` — приём внешних webhooks с парсингом GitHub-формата.
8. **Запуск** — `startScheduler(bot)` для cron-мониторинга + `bot.launch().catch(...)`.
9. **Graceful shutdown** — `SIGINT`/`SIGTERM` → `bot.stop()` + `httpServer.close()`.

Все команды обёрнуты в `safeCmd(ctx, fn)` — внутренние ошибки логируются, юзеру отвечается «⚠️ Внутренняя ошибка», процесс продолжает работать.

### 3.2 `src/claude.js` (~120 строк)

Две функции:

- **`analyzeTask(userMessage, history)`** — отправляет в Claude system-prompt (требующий вернуть JSON) + history + текущее сообщение. Парсит ответ JSON. Возвращает `{action, title, description, assignee, priority, dueDate, reply}`. Если Claude вернул невалидный JSON или произошла сетевая ошибка — возвращает `null` (или дефолтный `question`-объект).
- **`analyzeError(serviceName, httpStatus, responseTime)`** — Claude в роли SRE: получает данные о сбое, отвечает простым текстом — что вероятно случилось + 2-4 шага диагностики. Используется в healthcheck-алертах.

Клиент Anthropic создаётся при импорте: `new Anthropic({apiKey: ...})`. Модель берётся из `ANTHROPIC_MODEL` (fallback `claude-sonnet-4-5`).

### 3.3 `src/plane.js` (~120 строк)

REST-обёртка над Plane API (`docs.plane.so`):

- **`createIssue(title, description, priority, assigneeId)`** — `POST /issues/`
- **`getIssues(filters)`** — `GET /issues/` + опциональные фильтры через query string. Нормализует ответ (массив или `{results: []}`).
- **`updateIssue(issueId, fields)`** — `PATCH /issues/{id}/`
- **`resolveAssignee(name)`** — поиск user.id в `GET /workspaces/{slug}/members/` по `display_name` / `first_name+last_name` / `email` (case-insensitive).

Все функции вызывают приватный `_request(method, url, body)` с заголовком `X-API-Key`. При HTTP-ошибке или таймауте — логирует и возвращает `null`.

`_projectPath()` возвращает базовый URL или `null`, если не заданы `PLANE_URL`/`WORKSPACE_SLUG`/`PROJECT_ID`. Все функции графейсфул-скипают через `if (!base) return null`.

### 3.4 `src/healthcheck.js` (~180 строк)

Мониторинг сервисов:

- **`_services()`** — собирает список из:
  - Системных (Claude API, Telegram API, Plane API если задан).
  - Пользовательских из таблицы `monitored_services` (читается через `listMonitoredServices()`).
- **`checkService(name, url, headers)`** — `fetch` с таймаутом 10 сек. Возвращает `{name, status, httpCode, responseTime, error}`. Статусы: `ok` | `error` | `down`.
- **`checkAll(botInstance)`** — главная функция:
  1. Для каждого сервиса вызывает `checkService()`.
  2. Если первая попытка не `ok` — ждёт 3 секунды, делает retry (фильтрация транзитных блипов).
  3. Сравнивает с `_lastStatus` Map (per-process, in-memory).
  4. Алертит только при **смене состояния** (`ok→fail` или `fail→ok`).
  5. Алерт о падении формируется через `claude.analyzeError()` → шлёт в `getAlertChatId()` (или fallback на `ALERT_CHAT_ID` env).
- **`runManualCheck()`** — то же без отправки алертов (для команды `/status`).
- **`startScheduler(bot)`** — регистрирует `cron.schedule('*/5 * * * *', ...)`.

### 3.5 `src/db.js` (~170 строк)

Всё что связано с БД:

- Открывает SQLite через `better-sqlite3`, WAL-режим.
- **`ensureSchema()`** — идемпотентно создаёт все таблицы и индексы.
- **`dialog_history`**: `saveMessage(chatId, role, content)`, `loadHistory(chatId, limit)`, `clearHistory(chatId)`.
- **`alert_chat`**: `getAlertChatId()`, `setAlertChatId(chatId)` (single-row upsert через ON CONFLICT).
- **`monitored_services`**: `addMonitoredService(name, url)`, `listMonitoredServices()`, `removeMonitoredService(name)`.
- **`allowed_users`**: `isAllowedUser(userId)`, `addAllowedUser(userId, username, addedBy)`, `removeAllowedUser(userId)`, `listAllowedUsers()`.
- **`stats()`** — агрегирующий SELECT для `/stats`.

Путь к файлу БД: `process.env.DB_PATH || ./bot.db`. На Railway — `/data/bot.db` на персистентном Volume. Перед открытием делается `mkdirSync(dirname(DB_PATH), {recursive: true})`, чтобы избежать `Cannot open database because the directory does not exist`.

### 3.6 `src/setup.js` (~75 строк)

CLI для первичной настройки (`npm run setup`):
1. Проверяет обязательные env (`TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`) — ❌ если нет.
2. Опциональные (`ANTHROPIC_MODEL`, `DB_PATH`, `PLANE_*`) — ⚠️ если нет, не блокирует.
3. Тестирует соединение с SQLite.
4. Вызывает `ensureSchema()`.
5. Выводит ✅/❌/⚠️ по каждому пункту.

---

## 4. Поток данных

### 4.1 Обычное текстовое сообщение

```
[Telegram user]
     │ "поставь задачу: подготовить отчёт"
     ▼
[Telegraf bot.on('text')]
     │
     ├─→ whitelist middleware (если активен)
     │     ├─→ NOT ALLOWED → ответ "🔒 приватный", выход
     │     └─→ OK → дальше
     │
     ├─→ trunc до 2000 символов
     │
     ├─→ db.saveMessage(chatId, 'user', message)
     │
     ├─→ claude.analyzeTask(message, db.loadHistory(chatId, 10))
     │     │
     │     ▼
     │   [Claude Sonnet 4.6 API]
     │     │
     │     └─→ JSON: {action: "create_task", title: "...", priority: "medium", ...}
     │
     ├─→ db.saveMessage(chatId, 'assistant', reply)
     │
     └─→ action === "create_task":
           ├─ pendingTasks.set(userId, {...plan, createdAt: now})
           └─ ctx.reply(preview, inlineKeyboard[✅ Создать, ❌ Отмена])

[Юзер нажал "✅ Создать"]
     │
     ▼
[bot.action('confirm_create')]
     │
     ├─→ pendingTasks.get(userId) — проверка TTL
     ├─→ plane.resolveAssignee(name) → assigneeId
     ├─→ plane.createIssue(title, description, priority, assigneeId)
     │     │
     │     └─→ POST <PLANE_URL>/api/v1/.../issues/
     │
     └─→ db.tasks INSERT + ctx.editMessageText("✅ Создано: <url>")
```

### 4.2 Фоновый healthcheck

```
[node-cron каждые 5 мин]
     │
     ▼
[healthcheck.checkAll(bot)]
     │
     ├─→ _services():
     │     ├─ системные (Claude, Telegram, Plane если задан)
     │     └─ db.listMonitoredServices() — пользовательские
     │
     └─→ для каждого:
           │
           ├─→ checkService() → {status, httpCode, responseTime}
           │
           ├─→ ЕСЛИ статус != ok:
           │     ├─ sleep(3000)
           │     └─ checkService() ЕЩЁ РАЗ (retry)
           │
           ├─→ сравнить с _lastStatus.get(name)
           │
           ├─→ ЕСЛИ status изменился ok→fail:
           │     ├─ claude.analyzeError(name, code, time) → AI-разбор
           │     └─ bot.telegram.sendMessage(alertChatId, alertText)
           │
           ├─→ ЕСЛИ status изменился fail→ok:
           │     └─ bot.telegram.sendMessage(alertChatId, "✅ восстановился")
           │
           └─→ _lastStatus.set(name, currentStatus)
```

### 4.3 Входящий webhook

```
[GitHub / Sentry / любой внешний сервис]
     │ POST https://web-production-39115.up.railway.app/webhook/<secret>
     │ {payload}
     ▼
[bot.js http.createServer → handleWebhook()]
     │
     ├─→ проверка WEBHOOK_SECRET → 401 если не совпало
     │
     ├─→ body up to 100 KB → JSON.parse
     │
     ├─→ formatWebhook(payload, headers):
     │     ├─ headers['x-github-event'] → formatGitHub() (push/PR/issue/ping)
     │     └─ иначе → formatGeneric() (дамп JSON)
     │
     └─→ bot.telegram.sendMessage(alertChatId, text, {parse_mode: 'HTML'})
     │
     └─→ HTTP 200 {"ok": true}
```

---

## 5. Внешние сервисы

| Сервис | Зачем | Direction |
|---|---|---|
| **Telegram Bot API** | приём сообщений (long polling) + отправка ответов | bidirectional |
| **Anthropic API** | Claude для понимания сообщений и AI-разбора алертов | outgoing only |
| **Plane API** | CRUD задач (опционально) | outgoing only |
| **GitHub / другие** | через webhooks → /webhook/<secret> | incoming |
| **Railway healthcheck** | пингует /health → авто-перезапуск при падении | incoming |

---

## 6. БД схема

Все таблицы в SQLite (`/data/bot.db`).

```sql
-- История диалогов (последние 10 идут в контекст Claude)
CREATE TABLE dialog_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_user_id INTEGER NOT NULL,    -- хранится chat.id
    role       TEXT    NOT NULL,    -- 'user' | 'assistant'
    content    TEXT    NOT NULL,    -- ≤ 2000 символов
    created_at TEXT    NOT NULL
);
CREATE INDEX idx_dialog_user ON dialog_history(tg_user_id);

-- Куда слать алерты (single-row pattern: id always = 1)
CREATE TABLE alert_chat (
    id         INTEGER PRIMARY KEY,
    chat_id    TEXT    NOT NULL,
    updated_at TEXT    NOT NULL
);

-- Пользовательский список сервисов на мониторинг (/monitor add)
CREATE TABLE monitored_services (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT    UNIQUE NOT NULL,
    url      TEXT    NOT NULL,
    added_at TEXT    NOT NULL
);

-- Whitelist (активен если ADMIN_USER_ID задан в env)
CREATE TABLE allowed_users (
    tg_user_id INTEGER PRIMARY KEY,
    username   TEXT,
    added_at   TEXT NOT NULL,
    added_by   INTEGER
);

-- Связка юзер ↔ задача в Plane (заполняется в confirm_create)
CREATE TABLE tasks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_user_id      INTEGER NOT NULL,
    plane_issue_key TEXT    NOT NULL,
    created_at      TEXT    NOT NULL
);
CREATE INDEX idx_tasks_user ON tasks(tg_user_id);
```

---

## 7. Зависимости

```json
{
  "@anthropic-ai/sdk": "^0.100.1",
  "better-sqlite3":    "^11.5.0",
  "dotenv":            "^16.4.5",
  "node-cron":         "^3.0.3",
  "telegraf":          "^4.16.3"
}
```

5 прод-зависимостей, ноль dev-зависимостей. Без TypeScript, без линтера, без бандлера.

---

## 8. Конфигурация (env vars)

| Переменная | Тип | Обязательная | Назначение |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | string | да | токен от @BotFather |
| `ANTHROPIC_API_KEY` | string | да | ключ Claude |
| `ANTHROPIC_MODEL` | string | нет | дефолт `claude-sonnet-4-5`, сейчас в Railway `claude-sonnet-4-6` |
| `DB_PATH` | string | нет | путь к SQLite-файлу. На Railway: `/data/bot.db` |
| `PORT` | number | нет | задаёт Railway автоматически, fallback 3000 |
| `ADMIN_USER_ID` | number | нет | если задан → бот приватный, активирует whitelist |
| `WEBHOOK_SECRET` | string | нет | если задан → активен `POST /webhook/<secret>` |
| `ALERT_CHAT_ID` | string | нет | legacy fallback (теперь `/set_alert` хранит в SQLite) |
| `PLANE_URL` | string | нет | если все 4 PLANE_* заданы → Plane-фичи активны |
| `PLANE_API_KEY` | string | нет | ↑ |
| `PLANE_WORKSPACE_SLUG` | string | нет | ↑ |
| `PLANE_PROJECT_ID` | string | нет | ↑ |

---

## 9. Деплой (Railway)

1. Git push в `main` → Railway видит коммит через GitHub-интеграцию.
2. Билд через **Nixpacks** (автоматически распознаёт Node по `package.json`).
3. Применяется `engines.node=20.x` (важно — на 18.20.x есть конфликт fetch+undici, ловили).
4. Запуск: `node src/bot.js` (из `Procfile`/`railway.json`).
5. Контейнер слушает на `process.env.PORT`, который Railway проксирует на публичный домен.
6. **Volume** примонтирован на `/data` → SQLite-файл переживает редеплои.
7. **Healthcheck** Railway пингует `/health` (per `railway.json`), при падении перезапускает контейнер. Политика рестарта: `ON_FAILURE`, до 10 попыток.

---

## 10. Защитные механизмы

| Слой | Защита |
|---|---|
| Whitelist | `bot.use()` middleware блокирует неразрешённых юзеров |
| Webhook secret | URL содержит секрет, без него 401 |
| Body size limit | 100 КБ на webhook payload |
| Message trunc | пользовательские сообщения обрезаются до 2000 символов |
| pendingTasks TTL | Map чистится setInterval'ом, TTL 30 мин |
| `safeCmd()` | все команды обёрнуты, исключения не убивают процесс |
| `bot.launch().catch()` | Telegram-сбой не крашит процесс |
| Healthcheck retry | первый failed-запрос ретраится через 3 сек |
| Healthcheck dedup | алерт только при смене состояния, без спама |
| Graceful shutdown | SIGINT/SIGTERM → bot.stop() + httpServer.close() |

---

## 11. Известные ограничения

- Логи через `console.log/error`, не структурированные.
- Нет тестов (ни unit, ни integration).
- Telegram long-polling — на одном токене только один процесс может polling'ить. При локальной отладке нужно либо убивать прод-инстанс, либо иметь отдельного бота для dev.
- `_lastStatus` Map хранится в памяти процесса — при рестарте healthcheck «забывает» состояние и первое наблюдение fail-сервиса засчитается как «изменение», даже если он уже был fail. Минорно.
- Без rate-limiting — авторизованный юзер может закидать бота запросами и съесть Anthropic-баланс.
- Webhook-форматтеры есть только для GitHub. Для остальных — сырой JSON.
- `tg_user_id` в БД где-то хранит `chat.id`, где-то `from.id` — нужна унификация.

---

## 12. Точки расширения

| Что добавить | Где |
|---|---|
| Новая Telegram-команда | `bot.command('xxx', (ctx) => safeCmd(ctx, cmdXxx))` + функция |
| Новая кнопка в меню | `MENU_KEYBOARD` (label) + `BUTTON_HANDLERS` (mapping) |
| Новый формат webhook | `formatWebhook()` в `bot.js`, ветка по header/URL-параметру |
| Новая таблица в БД | `ensureSchema()` в `db.js` + helpers |
| Новая стратегия мониторинга (TCP/ping/body-match) | расширить `checkService()` в `healthcheck.js` |
| Новый AI-провайдер | подменить `claude.js`, сохраняя интерфейс `analyzeTask/analyzeError` |

---

## 13. Контакты

- **Репозиторий:** github.com/arata2288/Arata
- **Railway-проект:** `happy-clarity`, регион US West
- **Anthropic Console:** console.anthropic.com (баланс, использование)
- **Владелец/админ:** @Minsol_209 (Telegram user ID 643778904)

Доступ коллеге:
1. Railway → Settings → Members → Invite.
2. GitHub → Settings → Collaborators → Add.
3. В боте: `/allow <его telegram id>`.
