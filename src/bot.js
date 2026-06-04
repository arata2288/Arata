// Точка входа: Telegram-бот, который понимает русский, ставит задачи в Plane,
// мониторит сервисы и отвечает на команды через Claude.

import http from 'node:http';
import { Telegraf, Markup } from 'telegraf';
import dotenv from 'dotenv';

import { analyzeTask } from './claude.js';
import { createIssue, getIssues, resolveAssignee } from './plane.js';
import {
    db,
    ensureSchema,
    setAlertChatId,
    saveMessage,
    loadHistory,
    clearHistory,
    stats as dbStats,
} from './db.js';
import { runManualCheck, startScheduler } from './healthcheck.js';

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
    console.error('TELEGRAM_BOT_TOKEN не задан в .env');
    process.exit(1);
}

const bot = new Telegraf(token);
ensureSchema();

const HISTORY_LIMIT = 10;
const START_TIME = Date.now();

// Подтверждение создания задачи (userId → план)
const pendingTasks = new Map();

// =================== Клавиатура меню ===================
const MENU_KEYBOARD = Markup.keyboard([
    ['📊 Статистика', '✅ Статус'],
    ['📋 Задачи', '🔇 Забыть историю'],
    ['ℹ️ Помощь'],
]).resize();

// =================== Утилиты ===================
function formatUptime(ms) {
    const sec = Math.floor(ms / 1000);
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return [d && `${d}д`, h && `${h}ч`, m && `${m}м`, `${s}с`].filter(Boolean).join(' ');
}

// =================== Команды (отдельные функции, чтобы кнопки могли их звать) ===================

async function cmdHelp(ctx) {
    await ctx.reply(
        [
            'Что я умею:',
            '',
            '💬 Просто пишите мне обычным текстом — пойму через Claude.',
            '«поставь задачу <описание>» → создам задачу в Plane.',
            '«покажи задачи» → список открытых.',
            '',
            '📋 Команды:',
            '/menu — показать клавиатуру с кнопками.',
            '/status — быстрый health-check сервисов.',
            '/services — детальный список мониторимых сервисов.',
            '/stats — статистика бота (uptime, сообщения, чаты).',
            '/forget — очистить историю этого чата.',
            '/set_alert — присылать алерты от мониторинга в этот чат.',
            '/help — это сообщение.',
        ].join('\n'),
        MENU_KEYBOARD,
    );
}

async function cmdMenu(ctx) {
    await ctx.reply('Главное меню — нажимайте кнопки внизу:', MENU_KEYBOARD);
}

async function cmdStatus(ctx) {
    await ctx.reply('🔄 Проверяю сервисы...');
    const results = await runManualCheck();
    const lines = results.map((s) => {
        const ok = s.status === 'ok';
        const icon = ok ? '✅' : (s.status === 'down' ? '🔴' : '⚠️');
        const detail = ok ? 'OK' : (s.error || `HTTP ${s.httpCode}`);
        return `${icon} ${s.name}: ${detail} (${s.responseTime ?? '—'} мс)`;
    });
    await ctx.reply(['Статус сервисов:', ...lines].join('\n'));
}

async function cmdServices(ctx) {
    await ctx.reply('🔄 Опрашиваю мониторимые сервисы...');
    const results = await runManualCheck();
    const lines = results.map((s) => {
        const ok = s.status === 'ok';
        const icon = ok ? '✅' : (s.status === 'down' ? '🔴' : '⚠️');
        const code = s.httpCode ? `HTTP ${s.httpCode}` : (s.error || '—');
        return `${icon} <b>${s.name}</b>\n   ${code} · ${s.responseTime ?? '—'} мс`;
    });
    const text = [
        `📋 Под мониторингом: ${results.length} сервис(ов)`,
        '',
        ...lines,
    ].join('\n');
    await ctx.reply(text, { parse_mode: 'HTML' });
}

async function cmdStats(ctx) {
    const s = dbStats();
    const uptime = formatUptime(Date.now() - START_TIME);

    const lines = [
        '📊 <b>Статистика бота</b>',
        '',
        `⏱ Uptime: ${uptime}`,
        `💬 Всего сообщений: ${s.total_messages}`,
        `   • от пользователей: ${s.user_messages}`,
        `   • от ассистента: ${s.assistant_messages}`,
        `👥 Уникальных чатов: ${s.unique_chats}`,
        s.first_message_at && `🕐 Первое сообщение: ${s.first_message_at.replace('T', ' ')}`,
        s.last_message_at && `🕓 Последнее сообщение: ${s.last_message_at.replace('T', ' ')}`,
    ].filter(Boolean);

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

async function cmdForget(ctx) {
    const removed = clearHistory(ctx.chat.id);
    await ctx.reply(`🔇 История очищена. Удалено сообщений: ${removed}.\nТеперь я начинаю наш диалог «с чистого листа».`);
}

async function cmdSetAlert(ctx) {
    const chatId = ctx.chat.id;
    setAlertChatId(chatId);
    await ctx.reply(
        `✅ Готово. Алерты от мониторинга будут приходить в этот чат.\nchat_id: <code>${chatId}</code>`,
        { parse_mode: 'HTML' },
    );
}

async function cmdListTasks(ctx) {
    const issues = await getIssues();
    if (issues === null) {
        await ctx.reply('Не удалось получить задачи (Plane API не ответил или не настроен).');
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
}

// =================== Регистрация команд ===================
bot.command('help', cmdHelp);
bot.command('menu', cmdMenu);
bot.command('status', cmdStatus);
bot.command('services', cmdServices);
bot.command('stats', cmdStats);
bot.command('forget', cmdForget);
bot.command('set_alert', cmdSetAlert);

// =================== Кнопки меню (распознаём по тексту) ===================
const BUTTON_HANDLERS = {
    '📊 Статистика': cmdStats,
    '✅ Статус': cmdStatus,
    '📋 Задачи': cmdListTasks,
    '🔇 Забыть историю': cmdForget,
    'ℹ️ Помощь': cmdHelp,
};

// =================== Подтверждение создания задач ===================
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

    try {
        db.prepare(
            'INSERT INTO tasks (tg_user_id, plane_issue_key, created_at) VALUES (?, ?, ?)',
        ).run(userId, created.id || created.sequence_id || '', new Date().toISOString());
    } catch {
        /* tasks таблицы нет — не критично */
    }

    const url = `${process.env.PLANE_URL?.replace(/\/$/, '')}/${process.env.PLANE_WORKSPACE_SLUG}/projects/${process.env.PLANE_PROJECT_ID}/issues/${created.id}`;
    await ctx.editMessageText(`✅ Создано: ${created.name}\n${url}`);
});

bot.action('cancel_create', async (ctx) => {
    pendingTasks.delete(ctx.from.id);
    await ctx.answerCbQuery('Отменено');
    await ctx.editMessageText('❌ Создание задачи отменено.');
});

// =================== Основной обработчик текста ===================
bot.on('text', async (ctx) => {
    const chatId = ctx.chat.id;
    const message = ctx.message.text;

    // 1. Если нажата кнопка меню — выполняем сразу, не зовём Claude.
    const handler = BUTTON_HANDLERS[message];
    if (handler) {
        await handler(ctx);
        return;
    }

    // 2. Обычное текстовое сообщение → понимаем через Claude.
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
        await cmdListTasks(ctx);
        return;
    }

    if (result.action === 'update_task') {
        await ctx.reply(
            'Обновление задач пока поддерживается частично — укажите id задачи или название точнее.',
        );
        return;
    }

    await ctx.reply(result.reply || 'Принято.');
});

// =================== HTTP self-healthcheck ===================
const HEALTH_PORT = Number(process.env.PORT) || 3000;
http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'scrum-plane-bot' }));
    } else {
        res.writeHead(404).end();
    }
}).listen(HEALTH_PORT, () => console.log(`Health endpoint на :${HEALTH_PORT}/health`));

// =================== Старт ===================
startScheduler(bot);
bot.launch();
console.log('Бот запущен');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
