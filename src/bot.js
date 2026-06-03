// Точка входа: Telegram-бот, который понимает русский, ставит задачи в Plane
// и отвечает на /status (текущее состояние сервисов) и /help.

import http from 'node:http';
import { Telegraf, Markup } from 'telegraf';
import dotenv from 'dotenv';

import { analyzeTask } from './claude.js';
import { createIssue, getIssues, resolveAssignee } from './plane.js';
import { db, ensureSchema, setAlertChatId, getAlertChatId, saveMessage, loadHistory } from './db.js';
import { runManualCheck, startScheduler } from './healthcheck.js';

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
    console.error('TELEGRAM_BOT_TOKEN не задан в .env');
    process.exit(1);
}

const bot = new Telegraf(token);

// Создаём таблицы (идемпотентно) — на случай, если setup.js не запускали.
ensureSchema();

// История диалога — в SQLite (таблица dialog_history). Переживает рестарты и редеплои.
const HISTORY_LIMIT = 10;

// ------- Подтверждение создания задачи (userId → план) -------
const pendingTasks = new Map();

// ------- Помощь и статус -------
bot.command('help', async (ctx) => {
    await ctx.reply(
        [
            'Что я умею:',
            '• «поставь задачу <описание>» — создам задачу в Plane (спрошу подтверждение).',
            '• «покажи задачи» — список текущих задач.',
            '• «закрой задачу X» / «измени приоритет» — обновлю задачу.',
            '• /status — состояние всех сервисов (Plane / Claude / Telegram / bot server).',
            '• /set_alert — в этом чате будут приходить алерты от мониторинга.',
            '• /help — это сообщение.',
        ].join('\n'),
    );
});

bot.command('set_alert', async (ctx) => {
    const chatId = ctx.chat.id;
    setAlertChatId(chatId);
    await ctx.reply(
        `✅ Готово. Алерты от мониторинга будут приходить в этот чат.\nchat_id: <code>${chatId}</code>`,
        { parse_mode: 'HTML' },
    );
});

bot.command('status', async (ctx) => {
    await ctx.reply('🔄 Проверяю сервисы...');
    const results = await runManualCheck();
    const lines = results.map((s) => {
        const ok = s.status === 'ok';
        const icon = ok ? '✅' : (s.status === 'down' ? '🔴' : '⚠️');
        const detail = ok ? 'OK' : (s.error || `HTTP ${s.httpCode}`);
        return `${icon} ${s.name}: ${detail} (${s.responseTime ?? '—'} мс)`;
    });
    await ctx.reply(['Статус сервисов:', ...lines].join('\n'));
});

// ------- Подтверждение создания: кнопки -------
bot.action('confirm_create', async (ctx) => {
    const userId = ctx.from.id;
    const plan = pendingTasks.get(userId);
    if (!plan) {
        await ctx.answerCbQuery('Задача неактуальна');
        return;
    }
    pendingTasks.delete(userId);
    await ctx.answerCbQuery('Создаю...');

    const assigneeId = plan.assignee ? await resolveAssignee(plan.assignee) : null;
    const created = await createIssue(plan.title, plan.description, plan.priority, assigneeId);

    if (!created) {
        await ctx.editMessageText('❌ Plane API не ответил — задача не создана. Проверьте логи и .env.');
        return;
    }

    // Связка пользователь ↔ задача (если таблица tasks уже существует — см. setup.js).
    try {
        db.prepare(
            'INSERT INTO tasks (tg_user_id, plane_issue_key, created_at) VALUES (?, ?, ?)',
        ).run(userId, created.id || created.sequence_id || '', new Date().toISOString());
    } catch {
        // Таблицы ещё нет — не критично, инициализируется через `npm run setup`.
    }

    const url = `${process.env.PLANE_URL?.replace(/\/$/, '')}/${process.env.PLANE_WORKSPACE_SLUG}/projects/${process.env.PLANE_PROJECT_ID}/issues/${created.id}`;
    await ctx.editMessageText(`✅ Создано: ${created.name}\n${url}`);
});

bot.action('cancel_create', async (ctx) => {
    pendingTasks.delete(ctx.from.id);
    await ctx.answerCbQuery('Отменено');
    await ctx.editMessageText('❌ Создание задачи отменено.');
});

// ------- Основной обработчик: понимаем намерение через Claude -------
bot.on('text', async (ctx) => {
    const chatId = ctx.chat.id;
    const message = ctx.message.text;
    saveMessage(chatId, 'user', message);

    const result = await analyzeTask(message, loadHistory(chatId, HISTORY_LIMIT));
    if (!result) {
        await ctx.reply('Claude API не ответил. Проверьте ANTHROPIC_API_KEY и логи.');
        return;
    }
    saveMessage(chatId, 'assistant', result.reply || '');

    if (result.action === 'create_task') {
        pendingTasks.set(ctx.from.id, {
            title: result.title,
            description: result.description,
            assignee: result.assignee,
            priority: result.priority || 'medium',
            dueDate: result.dueDate,
        });
        const preview = [
            'Создать задачу?',
            `📋 ${result.title}`,
            result.description ? `📝 ${result.description}` : null,
            result.assignee ? `👤 ${result.assignee}` : null,
            result.priority ? `⚡ Приоритет: ${result.priority}` : null,
            result.dueDate ? `📅 До: ${result.dueDate}` : null,
        ].filter(Boolean).join('\n');
        const keyboard = Markup.inlineKeyboard([
            [
                Markup.button.callback('✅ Создать', 'confirm_create'),
                Markup.button.callback('❌ Отмена', 'cancel_create'),
            ],
        ]);
        await ctx.reply(preview, keyboard);
        return;
    }

    if (result.action === 'list_tasks') {
        const issues = await getIssues();
        if (issues === null) {
            await ctx.reply('Не удалось получить задачи (Plane API не ответил).');
            return;
        }
        if (issues.length === 0) {
            await ctx.reply('Задач нет.');
            return;
        }
        const list = issues.slice(0, 10).map((i) =>
            `• ${i.name || i.sequence_id} — ${i.priority || 'none'}`,
        ).join('\n');
        await ctx.reply(`Текущие задачи (топ 10):\n${list}`);
        return;
    }

    if (result.action === 'update_task') {
        await ctx.reply(
            'Обновление задач пока поддерживается частично — укажите id задачи или название точнее.',
        );
        return;
    }

    // action = "question" или неизвестное
    await ctx.reply(result.reply || 'Принято.');
});

// ------- Мини HTTP-сервер для self-healthcheck на /health -------
// Railway сам подставляет PORT через env. Локально — 3000.
const HEALTH_PORT = Number(process.env.PORT) || 3000;
http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'scrum-plane-bot' }));
    } else {
        res.writeHead(404).end();
    }
}).listen(HEALTH_PORT, () => console.log(`Health endpoint на :${HEALTH_PORT}/health`));

// ------- Старт -------
startScheduler(bot);
bot.launch();
console.log('Бот запущен');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
