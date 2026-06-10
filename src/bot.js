// Точка входа: Telegram-бот, который понимает русский, ставит задачи в Plane,
// мониторит сервисы и отвечает на команды через Claude.

import http from 'node:http';
import { Telegraf, Markup } from 'telegraf';
import cron from 'node-cron';
import dotenv from 'dotenv';

import { analyzeTask, translate, summarize, explain } from './claude.js';
import { transcribeAudio, isVoiceEnabled } from './voice.js';
import { createIssue, getIssues, resolveAssignee } from './plane.js';
import {
    db,
    ensureSchema,
    setAlertChatId,
    getAlertChatId,
    saveMessage,
    loadHistory,
    clearHistory,
    stats as dbStats,
    addMonitoredService,
    listMonitoredServices,
    removeMonitoredService,
    isAllowedUser,
    addAllowedUser,
    removeAllowedUser,
    listAllowedUsers,
    addTodo,
    listTodos,
    listAllTodos,
    markTodoDone,
    deleteTodo,
    editTodo,
    addReminder,
    listPendingReminders,
    listUserReminders,
    markReminderSent,
    deleteReminder,
    addNote,
    listNotes,
    getNote,
    deleteNote,
    searchAcrossTables,
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

// =================== Whitelist ===================
// Если ADMIN_USER_ID задан — бот приватный. Без него — открыт всем (старое поведение).
const ADMIN_USER_ID = process.env.ADMIN_USER_ID ? Number(process.env.ADMIN_USER_ID) : null;
const WHITELIST_ENABLED = ADMIN_USER_ID !== null && !Number.isNaN(ADMIN_USER_ID);

function isAdmin(ctx) {
    return WHITELIST_ENABLED && ctx.from?.id === ADMIN_USER_ID;
}

function canTalkToBot(ctx) {
    if (!WHITELIST_ENABLED) return true;       // whitelist выключен — все пускаемся
    if (isAdmin(ctx)) return true;             // админ всегда может
    return isAllowedUser(ctx.from?.id);        // остальные — только если в БД
}

// Глобальный middleware-фильтр: блокирует всё, кроме /myid и /start, не-разрешённым.
bot.use(async (ctx, next) => {
    const text = ctx.message?.text || '';
    if (text === '/myid' || text === '/start') return next();
    if (canTalkToBot(ctx)) return next();

    try {
        if (ctx.callbackQuery) {
            await ctx.answerCbQuery('🔒 Бот приватный');
        } else if (ctx.message) {
            await ctx.reply(
                `🔒 Бот приватный.\nВаш ID: ${ctx.from?.id}\nПопросите админа выполнить: /allow ${ctx.from?.id}`,
            );
        }
    } catch { /* проигнорировать */ }
    // не вызываем next() — на этом обработка останавливается
});

if (WHITELIST_ENABLED) {
    console.log(`[whitelist] активен. Админ: ${ADMIN_USER_ID}`);
} else {
    console.warn('[whitelist] ВЫКЛЮЧЕН. Задайте ADMIN_USER_ID в env, чтобы сделать бота приватным.');
}

const HISTORY_LIMIT = 10;
const START_TIME = Date.now();
const MAX_USER_MESSAGE_LEN = 2000; // обрезаем длинные сообщения перед записью/Claude
const PENDING_TTL_MS = 30 * 60 * 1000; // 30 мин на подтверждение задачи

// Подтверждение создания задачи (userId → план с createdAt)
const pendingTasks = new Map();

// Периодическая чистка просроченных pendingTasks (раз в 5 мин).
setInterval(() => {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [userId, entry] of pendingTasks) {
        if (entry.createdAt < cutoff) pendingTasks.delete(userId);
    }
}, 5 * 60 * 1000);

// Обёртка для команд: глушит исключения внутри, отвечает пользователю про сбой.
async function safeCmd(ctx, fn) {
    try {
        await fn(ctx);
    } catch (err) {
        console.error('[cmd] internal error:', err.message);
        try {
            await ctx.reply('⚠️ Внутренняя ошибка. Попробуйте ещё раз через минуту.');
        } catch { /* если не смогли ответить — отдельный лог уже выше */ }
    }
}

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
            '/monitor — добавить/удалить свой сервис для мониторинга.',
            '/todo — личный список задач (add/list/done/edit/delete).',
            '/remind — напоминания (18:00 / через 30 мин / завтра 9:00).',
            '/note — заметки (поддерживают многострочный текст).',
            '/translate — перевод текста (русский ↔ английский или явный язык).',
            '/summarize — краткое резюме длинного текста.',
            '/explain — объяснить код, термин, регулярку, SQL простыми словами.',
            '/search <слово> — поиск по диалогам, задачам и заметкам.',
            '',
            '🎤 Голосовые: запишите голосовое — бот его расшифрует и обработает как текст.',
            '/stats — статистика бота (uptime, сообщения, чаты).',
            '/forget — очистить историю этого чата.',
            '/set_alert — присылать алерты от мониторинга в этот чат.',
            '/myid — показать ваш Telegram ID и статус доступа.',
            '/help — это сообщение.',
            '',
            'Для админа (если whitelist активен):',
            '/allow <id>, /disallow <id>, /allowed — управление доступом.',
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

// =================== /todo ===================
async function cmdTodo(ctx) {
    const userId = ctx.from.id;
    const parts = ctx.message.text.trim().split(/\s+/);
    const sub = (parts[1] || '').toLowerCase();

    if (sub === 'add') {
        // Берём только первую строку, чтобы случайный многострочный ввод
        // (несколько /todo add подряд в одном сообщении) не залил мусор.
        const firstLine = ctx.message.text.split('\n')[0];
        const text = firstLine.replace(/^\/todo\s+add\s+/i, '').trim();
        if (!text) {
            await ctx.reply('Использование: /todo add <текст задачи>');
            return;
        }
        const id = addTodo(userId, text);
        await ctx.reply(`✅ Добавлено #${id}: ${text}`);
        return;
    }

    if (sub === 'edit') {
        const id = Number(parts[2]);
        if (!id) {
            await ctx.reply('Использование: /todo edit <id> <новый текст>');
            return;
        }
        // Текст после "/todo edit <id> " — только первая строка.
        const firstLine = ctx.message.text.split('\n')[0];
        const newText = firstLine
            .replace(/^\/todo\s+edit\s+\d+\s+/i, '')
            .trim();
        if (!newText) {
            await ctx.reply('Использование: /todo edit <id> <новый текст>');
            return;
        }
        const n = editTodo(userId, id, newText);
        if (n === 0) {
            await ctx.reply(`Задача #${id} не найдена.`);
            return;
        }
        await ctx.reply(`✏️ Задача #${id} обновлена: ${newText}`);
        return;
    }

    if (sub === 'list' || sub === '') {
        const todos = listTodos(userId, 'open');
        if (todos.length === 0) {
            await ctx.reply('Открытых задач нет.\nДобавить: /todo add <текст>');
            return;
        }
        const lines = todos.map((t) => `⬜ #${t.id}  ${t.text}`);
        await ctx.reply(['📋 Ваши задачи:', '', ...lines].join('\n'));
        return;
    }

    if (sub === 'all') {
        const todos = listAllTodos(userId);
        if (todos.length === 0) {
            await ctx.reply('Задач нет.');
            return;
        }
        const lines = todos.map((t) =>
            `${t.status === 'done' ? '✅' : '⬜'} #${t.id}  ${t.text}`,
        );
        await ctx.reply(['📋 Все задачи:', '', ...lines].join('\n'));
        return;
    }

    if (sub === 'done') {
        const id = Number(parts[2]);
        if (!id) {
            await ctx.reply('Использование: /todo done <id>');
            return;
        }
        const n = markTodoDone(userId, id);
        if (n === 0) {
            await ctx.reply(`Задача #${id} не найдена или уже выполнена.`);
            return;
        }
        await ctx.reply(`✅ Задача #${id} выполнена.`);
        return;
    }

    if (sub === 'delete' || sub === 'del' || sub === 'rm') {
        const id = Number(parts[2]);
        if (!id) {
            await ctx.reply('Использование: /todo delete <id>');
            return;
        }
        const n = deleteTodo(userId, id);
        if (n === 0) {
            await ctx.reply(`Задача #${id} не найдена.`);
            return;
        }
        await ctx.reply(`🗑 Задача #${id} удалена.`);
        return;
    }

    await ctx.reply([
        '📋 /todo — личный список задач',
        '',
        '/todo add <текст> — добавить',
        '/todo list — открытые (по умолчанию)',
        '/todo all — все, включая выполненные',
        '/todo done <id> — отметить выполненной',
        '/todo edit <id> <новый текст> — изменить',
        '/todo delete <id> — удалить',
        '',
        '⚠️ В /todo add отправляйте по одной задаче за сообщение.',
    ].join('\n'));
}

// =================== /remind: парсер времени ===================
// Возвращает {date, text} либо null.
// Понимает: "HH:MM текст", "завтра HH:MM текст",
//            "через N мин|минут|минуту|минуты текст",
//            "через N час|часа|часов|часу текст",
//            "через N день|дня|дней|дн текст".
function parseRemind(input) {
    const text = input.trim();
    if (!text) return null;
    const now = new Date();
    let m;
    let timePart = null;
    let date = null;

    // \b плохо работает с кириллицей в JS-regex, поэтому используем (?=\s|$).

    // через N минут
    m = text.match(/^через\s+(\d+)\s*(минут[ауы]?|мин)(?=\s|$)/i);
    if (m) {
        timePart = m[0];
        date = new Date(now.getTime() + Number(m[1]) * 60_000);
    }
    // через N часов
    if (!date) {
        m = text.match(/^через\s+(\d+)\s*(час(?:ов|а|у)?)(?=\s|$)/i);
        if (m) {
            timePart = m[0];
            date = new Date(now.getTime() + Number(m[1]) * 3_600_000);
        }
    }
    // через N дней
    if (!date) {
        m = text.match(/^через\s+(\d+)\s*(день|дня|дней|дн)(?=\s|$)/i);
        if (m) {
            timePart = m[0];
            date = new Date(now.getTime() + Number(m[1]) * 86_400_000);
        }
    }
    // завтра HH:MM
    if (!date) {
        m = text.match(/^завтра\s+(\d{1,2}):(\d{2})(?=\s|$)/i);
        if (m) {
            timePart = m[0];
            date = new Date();
            date.setDate(date.getDate() + 1);
            date.setHours(Number(m[1]), Number(m[2]), 0, 0);
        }
    }
    // HH:MM (сегодня или завтра, если прошло)
    if (!date) {
        m = text.match(/^(\d{1,2}):(\d{2})(?=\s|$)/);
        if (m) {
            timePart = m[0];
            date = new Date();
            date.setHours(Number(m[1]), Number(m[2]), 0, 0);
            if (date <= now) date.setDate(date.getDate() + 1);
        }
    }

    if (!date) return null;
    const body = text.slice(timePart.length).trim();
    if (!body) return null;
    return { date, text: body };
}

async function cmdRemind(ctx) {
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;
    const fullText = ctx.message.text.replace(/^\/remind/i, '').trim();
    const parts = fullText.split(/\s+/);
    const sub = (parts[0] || '').toLowerCase();

    if (sub === 'list') {
        const items = listUserReminders(userId);
        if (items.length === 0) {
            await ctx.reply('Активных напоминаний нет.');
            return;
        }
        const lines = items.map((r) =>
            `#${r.id}  ${new Date(r.remind_at).toLocaleString('ru-RU')}\n   ${r.text}`,
        );
        await ctx.reply(['⏰ Ваши напоминания:', '', ...lines].join('\n'));
        return;
    }

    if (sub === 'delete' || sub === 'del' || sub === 'rm') {
        const id = Number(parts[1]);
        if (!id) {
            await ctx.reply('Использование: /remind delete <id>');
            return;
        }
        const n = deleteReminder(userId, id);
        if (n === 0) {
            await ctx.reply(`Напоминание #${id} не найдено.`);
            return;
        }
        await ctx.reply(`🗑 Напоминание #${id} удалено.`);
        return;
    }

    // Без аргументов — помощь
    if (!fullText) {
        await ctx.reply([
            '⏰ /remind — напоминания',
            '',
            'Примеры:',
            '/remind 18:00 совещание',
            '/remind через 30 мин позвонить врачу',
            '/remind через 2 часа перерыв',
            '/remind завтра 9:00 митинг',
            '',
            '/remind list — активные',
            '/remind delete <id> — удалить',
        ].join('\n'));
        return;
    }

    // Парсинг времени
    const parsed = parseRemind(fullText);
    if (!parsed) {
        await ctx.reply(
            'Не понял время. Попробуйте формат:\n' +
            '/remind 18:00 текст\n' +
            '/remind через 30 мин текст\n' +
            '/remind через 2 часа текст\n' +
            '/remind завтра 9:00 текст',
        );
        return;
    }

    const id = addReminder(userId, chatId, parsed.text, parsed.date);
    await ctx.reply(
        `⏰ Напомню ${parsed.date.toLocaleString('ru-RU')}\n#${id}: ${parsed.text}`,
    );
}

// =================== /translate, /summarize, /explain — обёртки над Claude ===================

async function cmdTranslate(ctx) {
    const fullText = ctx.message.text.replace(/^\/translate/i, '').trim();
    if (!fullText) {
        await ctx.reply(
            '🌐 /translate — перевод текста\n\n'
            + '/translate <текст> — авто (русский ↔ английский)\n'
            + '/translate en <текст> — на английский\n'
            + '/translate kk <текст> — на казахский\n'
            + '/translate de <текст> — на немецкий\n'
            + '...любой код или название языка',
        );
        return;
    }

    // Если первый токен — короткий буквенный код (2-5 латинских букв), считаем его lang code.
    const m = fullText.match(/^([a-z]{2,5})\s+([\s\S]+)$/i);
    let targetLang = null;
    let textToTranslate = fullText;
    if (m) {
        targetLang = m[1].toLowerCase();
        textToTranslate = m[2];
    }

    await ctx.sendChatAction('typing').catch(() => {});
    const result = await translate(textToTranslate, targetLang);
    if (!result) {
        await ctx.reply('Не получилось перевести (Claude API не ответил).');
        return;
    }
    await ctx.reply(`🌐 ${result}`);
}

async function cmdSummarize(ctx) {
    const text = ctx.message.text.replace(/^\/summarize/i, '').trim();
    if (!text) {
        await ctx.reply(
            '📝 /summarize <текст> — краткое резюме\n\n'
            + 'Вставьте после команды длинный текст (статью, документ, переписку) — '
            + 'бот вернёт 3-7 пунктов с самой сутью.',
        );
        return;
    }
    await ctx.sendChatAction('typing').catch(() => {});
    const result = await summarize(text);
    if (!result) {
        await ctx.reply('Не получилось сделать резюме (Claude API не ответил).');
        return;
    }
    await ctx.reply(`📝 Резюме:\n\n${result}`);
}

async function cmdExplain(ctx) {
    const text = ctx.message.text.replace(/^\/explain/i, '').trim();
    if (!text) {
        await ctx.reply(
            '💡 /explain <что-то> — объяснить простыми словами\n\n'
            + 'Можно: код, термин, regex, SQL-запрос, аббревиатура, концепция.\n\n'
            + 'Примеры:\n'
            + '/explain SELECT * FROM users WHERE id = 1\n'
            + '/explain что такое closure\n'
            + '/explain ^\\d{3}-\\d{2}-\\d{4}$',
        );
        return;
    }
    await ctx.sendChatAction('typing').catch(() => {});
    const result = await explain(text);
    if (!result) {
        await ctx.reply('Не получилось объяснить (Claude API не ответил).');
        return;
    }
    await ctx.reply(`💡 ${result}`);
}

// =================== /note — личные заметки ===================

async function cmdNote(ctx) {
    const userId = ctx.from.id;
    const parts = ctx.message.text.trim().split(/\s+/);
    const sub = (parts[1] || '').toLowerCase();

    if (sub === 'add') {
        // Для заметок поддерживаем многострочный текст — не режем по \n.
        const fullText = ctx.message.text.replace(/^\/note\s+add\s+/i, '').trim();
        if (!fullText) {
            await ctx.reply('Использование: /note add <текст заметки>');
            return;
        }
        const id = addNote(userId, fullText);
        await ctx.reply(`✅ Заметка #${id} сохранена.`);
        return;
    }

    if (sub === 'list' || sub === '') {
        const notes = listNotes(userId);
        if (notes.length === 0) {
            await ctx.reply('Заметок нет.\nДобавить: /note add <текст>');
            return;
        }
        const lines = notes.map((n) => {
            const date = new Date(n.created_at).toLocaleDateString('ru-RU');
            const preview = n.text.length > 100
                ? n.text.slice(0, 100).replace(/\n/g, ' ') + '…'
                : n.text.replace(/\n/g, ' ');
            return `📌 #${n.id}  ${date}\n${preview}`;
        });
        await ctx.reply(['📚 Ваши заметки:', '', ...lines].join('\n\n'));
        return;
    }

    if (sub === 'show') {
        const id = Number(parts[2]);
        if (!id) {
            await ctx.reply('Использование: /note show <id>');
            return;
        }
        const note = getNote(userId, id);
        if (!note) {
            await ctx.reply(`Заметка #${id} не найдена.`);
            return;
        }
        const date = new Date(note.created_at).toLocaleString('ru-RU');
        await ctx.reply(`📌 #${id}  ${date}\n\n${note.text}`);
        return;
    }

    if (sub === 'delete' || sub === 'del' || sub === 'rm') {
        const id = Number(parts[2]);
        if (!id) {
            await ctx.reply('Использование: /note delete <id>');
            return;
        }
        const n = deleteNote(userId, id);
        if (n === 0) {
            await ctx.reply(`Заметка #${id} не найдена.`);
            return;
        }
        await ctx.reply(`🗑 Заметка #${id} удалена.`);
        return;
    }

    await ctx.reply([
        '📚 /note — личные заметки',
        '',
        '/note add <текст> — добавить (поддерживается многострочный текст)',
        '/note list — все заметки с превью',
        '/note show <id> — показать заметку целиком',
        '/note delete <id> — удалить',
    ].join('\n'));
}

// =================== /search — поиск по диалогам, задачам, заметкам ===================

function truncate(text, max = 80) {
    const oneLine = text.replace(/\n/g, ' ');
    return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
}

async function cmdSearch(ctx) {
    const query = ctx.message.text.replace(/^\/search/i, '').trim();
    if (!query) {
        await ctx.reply(
            '🔍 /search <слово или фраза> — искать по диалогам, задачам и заметкам.\n\n'
            + 'Примеры:\n'
            + '/search молоко\n'
            + '/search Биржан\n'
            + '/search HR-портал',
        );
        return;
    }
    if (query.length < 2) {
        await ctx.reply('Слишком короткий запрос — минимум 2 символа.');
        return;
    }

    const userId = ctx.from.id;
    const { dialogs, todos, notes } = searchAcrossTables(userId, query);
    const total = dialogs.length + todos.length + notes.length;

    if (total === 0) {
        await ctx.reply(`🔍 По «${query}» ничего не найдено.`);
        return;
    }

    const lines = [`🔍 Найдено ${total} совпадений по «${query}»`];

    if (todos.length) {
        lines.push('', `📋 Задачи (${todos.length}):`);
        for (const t of todos.slice(0, 5)) {
            const icon = t.status === 'done' ? '✅' : '⬜';
            lines.push(`${icon} #${t.id}  ${truncate(t.text)}`);
        }
        if (todos.length > 5) lines.push(`   …и ещё ${todos.length - 5}`);
    }

    if (notes.length) {
        lines.push('', `📚 Заметки (${notes.length}):`);
        for (const n of notes.slice(0, 5)) {
            const date = new Date(n.created_at).toLocaleDateString('ru-RU');
            lines.push(`📌 #${n.id}  ${date}  ${truncate(n.text)}`);
        }
        if (notes.length > 5) lines.push(`   …и ещё ${notes.length - 5}`);
    }

    if (dialogs.length) {
        lines.push('', `💬 История диалогов (${dialogs.length}):`);
        for (const d of dialogs.slice(0, 5)) {
            const date = new Date(d.created_at).toLocaleDateString('ru-RU');
            const roleIcon = d.role === 'user' ? '👤' : '🤖';
            lines.push(`${roleIcon} ${date}  ${truncate(d.content)}`);
        }
        if (dialogs.length > 5) lines.push(`   …и ещё ${dialogs.length - 5}`);
    }

    if (todos.length > 5 || notes.length > 5 || dialogs.length > 5) {
        lines.push('', '💡 Уточните запрос, чтобы увидеть больше результатов.');
    }

    await ctx.reply(lines.join('\n'));
}

async function cmdMyId(ctx) {
    const id = ctx.from?.id;
    const username = ctx.from?.username ? `@${ctx.from.username}` : '(нет username)';
    const lines = [
        `Ваш Telegram ID: <code>${id}</code>`,
        `Username: ${username}`,
        '',
    ];
    if (!WHITELIST_ENABLED) {
        lines.push('🔓 Whitelist выключен — бот сейчас доступен всем.');
    } else if (isAdmin(ctx)) {
        lines.push('👑 Вы админ бота.');
    } else if (isAllowedUser(id)) {
        lines.push('✅ Вы в whitelist, бот вам доступен.');
    } else {
        lines.push('🔒 Вас нет в whitelist. Попросите админа: <code>/allow ' + id + '</code>');
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

async function cmdAllow(ctx) {
    if (!WHITELIST_ENABLED) {
        await ctx.reply('⚠️ Whitelist выключен (ADMIN_USER_ID не задан в env).');
        return;
    }
    if (!isAdmin(ctx)) {
        await ctx.reply('🔒 Команда доступна только админу.');
        return;
    }
    const parts = ctx.message.text.trim().split(/\s+/);
    const userId = Number(parts[1]);
    if (!userId) {
        await ctx.reply('Использование: /allow <telegram_user_id>');
        return;
    }
    addAllowedUser(userId, null, ctx.from.id);
    await ctx.reply(`✅ User ${userId} добавлен в whitelist.`);
}

async function cmdDisallow(ctx) {
    if (!WHITELIST_ENABLED) {
        await ctx.reply('⚠️ Whitelist выключен (ADMIN_USER_ID не задан в env).');
        return;
    }
    if (!isAdmin(ctx)) {
        await ctx.reply('🔒 Команда доступна только админу.');
        return;
    }
    const parts = ctx.message.text.trim().split(/\s+/);
    const userId = Number(parts[1]);
    if (!userId) {
        await ctx.reply('Использование: /disallow <telegram_user_id>');
        return;
    }
    const n = removeAllowedUser(userId);
    if (n === 0) {
        await ctx.reply(`User ${userId} не в whitelist.`);
        return;
    }
    await ctx.reply(`🗑 User ${userId} удалён из whitelist.`);
}

async function cmdAllowed(ctx) {
    if (!WHITELIST_ENABLED) {
        await ctx.reply('⚠️ Whitelist выключен (ADMIN_USER_ID не задан в env).');
        return;
    }
    if (!isAdmin(ctx)) {
        await ctx.reply('🔒 Команда доступна только админу.');
        return;
    }
    const list = listAllowedUsers();
    const lines = [`👑 Админ: ${ADMIN_USER_ID}`];
    if (list.length === 0) {
        lines.push('Whitelist пуст. Только админ имеет доступ.');
    } else {
        lines.push('Дополнительно разрешены:');
        for (const u of list) {
            lines.push(`• ${u.tg_user_id}${u.username ? ` (@${u.username})` : ''}`);
        }
    }
    await ctx.reply(lines.join('\n'));
}

async function cmdMonitor(ctx) {
    const parts = ctx.message.text.trim().split(/\s+/);
    const sub = (parts[1] || '').toLowerCase();

    if (sub === 'add') {
        const name = parts[2];
        const url = parts[3];
        if (!name || !url) {
            await ctx.reply('Использование: /monitor add <имя> <url>\nПример: /monitor add MySite https://mysite.com');
            return;
        }
        if (!/^https?:\/\//.test(url)) {
            await ctx.reply('URL должен начинаться с http:// или https://');
            return;
        }
        addMonitoredService(name, url);
        await ctx.reply(
            `✅ Добавлен сервис «${name}» → ${url}\nБуду проверять каждые 5 мин. Если упадёт — пришлю алерт с AI-разбором сюда.`,
        );
        return;
    }

    if (sub === 'list' || sub === 'ls') {
        const items = listMonitoredServices();
        if (items.length === 0) {
            await ctx.reply('Своих сервисов пока нет.\nДобавить: /monitor add <имя> <url>');
            return;
        }
        const lines = items.map((s) => `• ${s.name} — ${s.url}`);
        await ctx.reply(['Ваши сервисы на мониторинге:', ...lines].join('\n'));
        return;
    }

    if (sub === 'remove' || sub === 'rm' || sub === 'delete' || sub === 'del') {
        const name = parts[2];
        if (!name) {
            await ctx.reply('Использование: /monitor remove <имя>');
            return;
        }
        const n = removeMonitoredService(name);
        if (n === 0) {
            await ctx.reply(`Сервис «${name}» не найден. Список: /monitor list`);
            return;
        }
        await ctx.reply(`🗑 Удалён «${name}». Больше не мониторится.`);
        return;
    }

    await ctx.reply(
        [
            '/monitor — мониторинг своих сервисов:',
            '',
            '/monitor add <имя> <url> — добавить',
            '/monitor list — показать все',
            '/monitor remove <имя> — удалить',
        ].join('\n'),
    );
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

// =================== Регистрация команд (обёрнуты в safeCmd) ===================
bot.command('help',      (ctx) => safeCmd(ctx, cmdHelp));
bot.command('menu',      (ctx) => safeCmd(ctx, cmdMenu));
bot.command('status',    (ctx) => safeCmd(ctx, cmdStatus));
bot.command('services',  (ctx) => safeCmd(ctx, cmdServices));
bot.command('stats',     (ctx) => safeCmd(ctx, cmdStats));
bot.command('forget',    (ctx) => safeCmd(ctx, cmdForget));
bot.command('set_alert', (ctx) => safeCmd(ctx, cmdSetAlert));
bot.command('monitor',   (ctx) => safeCmd(ctx, cmdMonitor));
bot.command('todo',      (ctx) => safeCmd(ctx, cmdTodo));
bot.command('remind',    (ctx) => safeCmd(ctx, cmdRemind));
bot.command('note',      (ctx) => safeCmd(ctx, cmdNote));
bot.command('translate', (ctx) => safeCmd(ctx, cmdTranslate));
bot.command('summarize', (ctx) => safeCmd(ctx, cmdSummarize));
bot.command('explain',   (ctx) => safeCmd(ctx, cmdExplain));
bot.command('search',    (ctx) => safeCmd(ctx, cmdSearch));
bot.command('myid',      (ctx) => safeCmd(ctx, cmdMyId));
bot.command('allow',     (ctx) => safeCmd(ctx, cmdAllow));
bot.command('disallow',  (ctx) => safeCmd(ctx, cmdDisallow));
bot.command('allowed',   (ctx) => safeCmd(ctx, cmdAllowed));

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
    try {
        const userId = ctx.from.id;
        const plan = pendingTasks.get(userId);

        // Проверка TTL: задача могла протухнуть.
        if (!plan || Date.now() - plan.createdAt > PENDING_TTL_MS) {
            pendingTasks.delete(userId);
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
            /* таблицы tasks нет — не критично */
        }

        // Показываем ссылку только если все переменные Plane заданы.
        const baseUrl = process.env.PLANE_URL?.replace(/\/$/, '');
        const slug = process.env.PLANE_WORKSPACE_SLUG;
        const projectId = process.env.PLANE_PROJECT_ID;
        const url = baseUrl && slug && projectId
            ? `\n${baseUrl}/${slug}/projects/${projectId}/issues/${created.id}`
            : '';
        await ctx.editMessageText(`✅ Создано: ${created.name}${url}`);
    } catch (err) {
        console.error('[confirm_create] error:', err.message);
    }
});

bot.action('cancel_create', async (ctx) => {
    pendingTasks.delete(ctx.from.id);
    await ctx.answerCbQuery('Отменено');
    await ctx.editMessageText('❌ Создание задачи отменено.');
});

// =================== Универсальная обработка сообщения (текст ИЛИ транскрипт голосового) ===================
async function processUserMessage(ctx, rawMessage) {
    const chatId = ctx.chat.id;
    const message = rawMessage.slice(0, MAX_USER_MESSAGE_LEN);

    // 1. Если совпало с подписью кнопки меню — выполняем команду напрямую.
    const handler = BUTTON_HANDLERS[message];
    if (handler) {
        await handler(ctx);
        return;
    }

    // 2. Обычное сообщение → понимаем через Claude.
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
            createdAt: Date.now(),
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
}

// Обработчик текстовых сообщений — просто оборачивает processUserMessage в safeCmd.
bot.on('text', (ctx) => safeCmd(ctx, async (ctx) => {
    await processUserMessage(ctx, ctx.message.text);
}));

// Обработчик голосовых и аудио — транскрибируем через Groq и пропускаем через тот же поток.
async function handleVoice(ctx) {
    const fileId = ctx.message.voice?.file_id || ctx.message.audio?.file_id;
    if (!fileId) return;

    if (!isVoiceEnabled()) {
        await ctx.reply('🎤 Расшифровка голосовых отключена: не задан GROQ_API_KEY.');
        return;
    }

    await ctx.sendChatAction('typing').catch(() => {});
    let transcript;
    try {
        const link = await bot.telegram.getFileLink(fileId);
        transcript = await transcribeAudio(link.toString());
    } catch (err) {
        console.error('[voice]', err.message);
        await ctx.reply(`❌ Не получилось распознать голосовое: ${err.message}`);
        return;
    }

    if (!transcript) {
        await ctx.reply('🤔 Не услышал ничего — попробуйте записать ещё раз.');
        return;
    }

    // Покажем, что услышали — полезно для прозрачности.
    await ctx.reply(`🎤 Услышал: «${transcript}»`);

    // Пропускаем как обычное сообщение.
    await processUserMessage(ctx, transcript);
}

bot.on('voice', (ctx) => safeCmd(ctx, handleVoice));
bot.on('audio', (ctx) => safeCmd(ctx, handleVoice));

// =================== HTTP: /health + /webhook ===================
const HEALTH_PORT = Number(process.env.PORT) || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || null;
const MAX_WEBHOOK_BODY = 100 * 1024; // 100 KB лимит на тело — защита от мусора

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function formatGitHub(payload, event) {
    const repo = payload.repository?.full_name || payload.repository?.name || '?';
    if (event === 'push') {
        const ref = (payload.ref || '').replace('refs/heads/', '');
        const author = payload.head_commit?.author?.name || payload.pusher?.name || '?';
        const msg = payload.head_commit?.message || '(no message)';
        const url = payload.compare || '';
        return [
            `📦 <b>GitHub push</b> — ${escapeHtml(repo)}`,
            `Branch: <code>${escapeHtml(ref)}</code>`,
            `Author: ${escapeHtml(author)}`,
            `Msg: ${escapeHtml(msg.slice(0, 200))}`,
            url ? `<a href="${escapeHtml(url)}">Diff</a>` : null,
        ].filter(Boolean).join('\n');
    }
    if (event === 'pull_request') {
        const pr = payload.pull_request || {};
        return [
            `🔀 <b>GitHub PR ${escapeHtml(payload.action || '')}</b> — ${escapeHtml(repo)}`,
            `#${pr.number}: ${escapeHtml(pr.title || '')}`,
            `Author: ${escapeHtml(pr.user?.login || '?')}`,
            pr.html_url ? `<a href="${escapeHtml(pr.html_url)}">Открыть PR</a>` : null,
        ].filter(Boolean).join('\n');
    }
    if (event === 'issues') {
        const issue = payload.issue || {};
        return [
            `📝 <b>GitHub issue ${escapeHtml(payload.action || '')}</b> — ${escapeHtml(repo)}`,
            `#${issue.number}: ${escapeHtml(issue.title || '')}`,
            issue.html_url ? `<a href="${escapeHtml(issue.html_url)}">Открыть</a>` : null,
        ].filter(Boolean).join('\n');
    }
    if (event === 'ping') {
        return `🏓 <b>GitHub webhook ping</b> — ${escapeHtml(repo)}\nВсё подключено корректно.`;
    }
    // Прочие события — короткий дамп.
    return `📡 <b>GitHub ${escapeHtml(event)}</b> — ${escapeHtml(repo)}`;
}

function formatGeneric(payload) {
    const json = JSON.stringify(payload, null, 2);
    const truncated = json.length > 2000 ? json.slice(0, 2000) + '\n…(обрезано)' : json;
    return `📡 <b>Webhook</b>\n<pre>${escapeHtml(truncated)}</pre>`;
}

function formatWebhook(payload, headers) {
    if (headers['x-github-event']) {
        return formatGitHub(payload, headers['x-github-event']);
    }
    return formatGeneric(payload);
}

async function handleWebhook(req, res) {
    if (!WEBHOOK_SECRET) {
        res.writeHead(503).end('webhook disabled (set WEBHOOK_SECRET)');
        return;
    }
    const secret = req.url.slice('/webhook/'.length).split('?')[0];
    if (secret !== WEBHOOK_SECRET) {
        res.writeHead(401).end('invalid secret');
        return;
    }
    let body = '';
    let aborted = false;
    req.on('data', (chunk) => {
        body += chunk;
        if (body.length > MAX_WEBHOOK_BODY) {
            aborted = true;
            res.writeHead(413).end('body too large');
            req.destroy();
        }
    });
    req.on('end', async () => {
        if (aborted) return;
        try {
            const payload = body ? JSON.parse(body) : {};
            const text = formatWebhook(payload, req.headers);
            const chatId = getAlertChatId() || process.env.ALERT_CHAT_ID;
            if (!chatId) {
                console.warn('[webhook] не задан чат — выполните /set_alert в Telegram');
                res.writeHead(503).end('no alert chat — run /set_alert in Telegram');
                return;
            }
            await bot.telegram.sendMessage(chatId, text, {
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } catch (err) {
            console.error('[webhook] error:', err.message);
            res.writeHead(500).end(`error: ${err.message}`);
        }
    });
}

const httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'scrum-plane-bot' }));
        return;
    }
    if (req.method === 'POST' && req.url.startsWith('/webhook/')) {
        handleWebhook(req, res);
        return;
    }
    res.writeHead(404).end();
}).listen(HEALTH_PORT, () => {
    console.log(`HTTP на :${HEALTH_PORT} (endpoints: /health, /webhook/<secret>)`);
});

// =================== Cron напоминаний ===================
// Каждую минуту проверяем reminders с remind_at <= сейчас и шлём их.
cron.schedule('* * * * *', async () => {
    let due;
    try {
        due = listPendingReminders();
    } catch (err) {
        console.error('[reminder] чтение из БД упало:', err.message);
        return;
    }
    for (const r of due) {
        try {
            await bot.telegram.sendMessage(r.chat_id, `⏰ Напоминание #${r.id}:\n${r.text}`);
            markReminderSent(r.id);
        } catch (err) {
            console.error(`[reminder] не отправил #${r.id}:`, err.message);
        }
    }
});

// =================== Старт ===================
startScheduler(bot);
bot.launch().catch((err) => {
    console.error('[telegraf] launch error:', err.message);
    // HTTP-сервер всё равно живёт — Railway healthcheck не упадёт зря.
});
console.log('Бот запущен');

function gracefulShutdown(signal) {
    console.log(`[shutdown] получен сигнал ${signal}`);
    bot.stop(signal);
    httpServer.close();
}
process.once('SIGINT', () => gracefulShutdown('SIGINT'));
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
