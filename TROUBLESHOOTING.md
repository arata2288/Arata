# 🚨 Troubleshooting — что делать, когда бот тупит

Файл-шпаргалка для случаев, когда бот не отвечает / работает странно / упал деплой.

---

## Быстрая «скорая помощь» — 3 шага за 2 минуты

### 1. Бот вообще жив?
В Telegram → **@Help_scrum_bot** → `/help`.
- ✅ Ответил → бот живой, проблема локальная (Claude / Variables / etc.)
- ❌ Молчит → шаг 2.

### 2. Открыть Railway
**https://railway.com/dashboard** → проект **happy-clarity** → сервис **web** → вкладка **Deployments**.
- Зелёный **Active** на верхнем? → есть деплой, проблема в логике.
- Красный **Failed** или нет деплоев → шаг 3.

### 3. Перезапустить
Активный деплой → **⋮** (три точки справа) → **Restart**. 30 секунд → контейнер поднимется заново. Это решает **70% временных проблем**.

---

## Подробно по симптомам

### Бот молчит совсем

| Гипотеза | Где проверить |
|---|---|
| Контейнер упал | Railway Deployments — статус деплоя |
| Telegram-сбой | https://downdetector.com/status/telegram/ |
| Конфликт long-polling (два инстанса с одним токеном) | View Logs → ищи `409 Conflict` |
| Railway-сбой | https://status.railway.app |

**Фикс:** Restart деплоя. Если Failed — посмотреть Deploy Logs.

### «Claude API не ответил» в Telegram

| Гипотеза | Где проверить |
|---|---|
| Кончились кредиты Anthropic | https://console.anthropic.com → Dashboard → Credit balance |
| Сбой у Anthropic | https://status.anthropic.com |
| Стерт `ANTHROPIC_API_KEY` | Railway → Variables |
| Опечатка в `ANTHROPIC_MODEL` | Должно быть `claude-sonnet-4-6` |

**Фикс:** проверить баланс, обновить ключ если устарел, подождать если сбой.

### «🔒 Бот приватный» при попытке писать боту

- Случайно стёрся `ADMIN_USER_ID` в Railway → впишите обратно ваш ID.
- Узнать ID: `/myid` всегда работает, даже если whitelist активен.

### Бот странно отвечает / тупит

- Перезапустите контейнер.
- Временно поменяйте модель: `ANTHROPIC_MODEL=claude-opus-4-8` (умнее, дороже) или `claude-sonnet-4-6` обратно.
- Чистая история: `/forget` → диалог с нуля.

### Деплой упал (Build / Deploy Failed)

Шаги:
1. Кликнуть на провалившийся деплой → **View logs**.
2. Открыть **Build Logs** (если упал билд) или **Deploy Logs** (если упал старт).
3. Прокрутить вниз → найти строки с `Error` / `failed`.
4. Если непонятно — скопировать последние 20 строк, послать Claude / коллеге / в issue.

### Healthcheck failure

Бот стартует, но Railway healthcheck не проходит. Обычно:
- Не задана какая-то критичная env-переменная → бот падает при импорте.
- Деплой Logs покажут конкретную ошибку (например, «TELEGRAM_BOT_TOKEN не задан»).

**Фикс:** проверить Variables, дозаполнить.

### Webhooks не приходят

| Гипотеза | Где проверить |
|---|---|
| Стёрт `WEBHOOK_SECRET` | Railway → Variables |
| Не совпадает секрет в URL внешнего сервиса | GitHub → Settings → Webhooks → проверить URL |
| Не задан чат для алертов | `/set_alert` в Telegram |

**Тест:** запустить с локального терминала:
```
curl -X POST https://<домен>/webhook/<секрет> -H "Content-Type: application/json" -d '{"test":1}'
```
Если ответил `{"ok":true}` и в Telegram пришло — webhook сам работает, дело в настройке внешнего сервиса.

### Алерты приходят, когда не надо

- Команда `/status` → проверить, что мониторимые сервисы реально живы.
- Если ложно срабатывает на пользовательский сервис → `/monitor remove <имя>`.

### Бот не понимает команду

- Проверить, что Deployments → Active имеет нужный коммит (с командой).
- Возможно деплой ещё не докатился — подождать минуту.
- Если код запушен правильно, но команда не работает — посмотреть Deploy Logs на предмет ошибок старта.

---

## Конкретные команды

### Перезапустить контейнер
Railway → Deployments → активный → **⋮** → **Restart**.

### Откатиться к предыдущей версии
Railway → Deployments → найти предыдущий **зелёный** деплой → **⋮** → **Redeploy**.

### Посмотреть логи
Railway → Active deploy → **View logs** → **Deploy Logs**. Фильтры:
- `error` — все ошибки
- `claude` — проблемы с AI
- `webhook` — проблемы с входящими webhooks
- `healthcheck` — мониторинг

### Проверить env-переменные
Railway → сервис → **Variables** → должны быть как минимум:
- `TELEGRAM_BOT_TOKEN`
- `ANTHROPIC_API_KEY`
- `ANTHROPIC_MODEL`
- `DB_PATH=/data/bot.db`
- `ADMIN_USER_ID` (если включён whitelist)
- `WEBHOOK_SECRET` (если используются webhooks)

### Запустить setup
Railway → **Console** → внутри контейнера:
```
node src/setup.js
```
— проверит env и БД, покажет ✅/❌ по каждому пункту.

---

## Статусы внешних сервисов

| Сервис | URL |
|---|---|
| Anthropic (Claude API) | https://status.anthropic.com |
| Telegram | https://downdetector.com/status/telegram/ |
| Railway | https://status.railway.app |
| GitHub (если используется webhook) | https://www.githubstatus.com |

Если у кого-то сбой — это не у вас, надо ждать.

---

## Запасные варианты

- **Claude напрямую:** https://claude.ai — там бесплатный план, та же модель.
- **GitHub Issues:** github.com/anthropics/anthropic-sdk-typescript/issues — баги SDK.
- **Telegraf GitHub:** github.com/telegraf/telegraf/issues — баги Telegram-обёртки.

---

## Профилактика

- Перед `git push` — `node --check src/*.js` локально.
- После пуша — глянуть Railway: Deployments стал зелёным?
- Раз в неделю — проверить баланс Anthropic.
- Все секреты — в надёжном хранилище (1Password / заметка) на случай случайного удаления.
- Не пушить «на удачу» на main — лучше сначала локальный `npm start`.

---

## Контакты для эскалации

- **Railway support:** https://railway.com/help (есть live chat)
- **Anthropic support:** support.anthropic.com
- **Telegram bot dev community:** https://t.me/devbots
