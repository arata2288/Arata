import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// DB_PATH из env — для Railway, где БД лежит на смонтированном Volume.
// По умолчанию — bot.db рядом с проектом (локальный режим).
const DB_PATH = process.env.DB_PATH || join(__dirname, '..', 'bot.db');

// Гарантируем, что родительская директория существует (свежий Volume может быть пустым).
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

/**
 * Идемпотентное создание всех таблиц.
 * Вызывается из bot.js на старте и из setup.js — безопасно гонять много раз.
 */
export function ensureSchema() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            tg_user_id      INTEGER NOT NULL,
            plane_issue_key TEXT    NOT NULL,
            created_at      TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS dialog_history (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            tg_user_id INTEGER NOT NULL,
            role       TEXT    NOT NULL,
            content    TEXT    NOT NULL,
            created_at TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS alert_chat (
            id         INTEGER PRIMARY KEY,
            chat_id    TEXT    NOT NULL,
            updated_at TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS monitored_services (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            name     TEXT    UNIQUE NOT NULL,
            url      TEXT    NOT NULL,
            added_at TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS allowed_users (
            tg_user_id INTEGER PRIMARY KEY,
            username   TEXT,
            added_at   TEXT NOT NULL,
            added_by   INTEGER
        );

        CREATE TABLE IF NOT EXISTS todos (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            tg_user_id   INTEGER NOT NULL,
            text         TEXT    NOT NULL,
            status       TEXT    NOT NULL DEFAULT 'open',
            created_at   TEXT    NOT NULL,
            completed_at TEXT
        );

        CREATE TABLE IF NOT EXISTS reminders (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            tg_user_id INTEGER NOT NULL,
            chat_id    INTEGER NOT NULL,
            text       TEXT    NOT NULL,
            remind_at  TEXT    NOT NULL,
            created_at TEXT    NOT NULL,
            sent       INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS notes (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            tg_user_id INTEGER NOT NULL,
            text       TEXT    NOT NULL,
            created_at TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS rate_limit (
            tg_user_id INTEGER NOT NULL,
            request_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS service_status (
            name        TEXT PRIMARY KEY,
            last_status TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pending_tasks (
            token       TEXT PRIMARY KEY,
            tg_user_id  INTEGER NOT NULL,
            chat_id     INTEGER NOT NULL,
            plan_json   TEXT    NOT NULL,
            created_at  INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_tasks_user      ON tasks(tg_user_id);
        CREATE INDEX IF NOT EXISTS idx_dialog_user     ON dialog_history(tg_user_id);
        CREATE INDEX IF NOT EXISTS idx_todos_user      ON todos(tg_user_id, status);
        CREATE INDEX IF NOT EXISTS idx_reminders_due   ON reminders(sent, remind_at);
        CREATE INDEX IF NOT EXISTS idx_notes_user      ON notes(tg_user_id);
        CREATE INDEX IF NOT EXISTS idx_rl_user_time    ON rate_limit(tg_user_id, request_at);
        CREATE INDEX IF NOT EXISTS idx_pending_user    ON pending_tasks(tg_user_id);
    `);
}

/** Получить сохранённый chat_id для алертов (или null, если не задан). */
export function getAlertChatId() {
    try {
        const row = db.prepare('SELECT chat_id FROM alert_chat WHERE id = 1').get();
        return row?.chat_id || null;
    } catch {
        return null;
    }
}

/** Сохранить (или перезаписать) chat_id для алертов. */
export function setAlertChatId(chatId) {
    db.prepare(
        `INSERT INTO alert_chat (id, chat_id, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
             chat_id    = excluded.chat_id,
             updated_at = excluded.updated_at`,
    ).run(String(chatId), new Date().toISOString());
}

/** Сохранить одно сообщение диалога (role: 'user' | 'assistant'). */
export function saveMessage(chatId, role, content) {
    db.prepare(
        `INSERT INTO dialog_history (tg_user_id, role, content, created_at)
         VALUES (?, ?, ?, ?)`,
    ).run(chatId, role, content, new Date().toISOString());
}

/** Загрузить последние N сообщений чата (старые → новые, как ждёт Claude). */
export function loadHistory(chatId, limit = 10) {
    const rows = db.prepare(
        `SELECT role, content FROM dialog_history
         WHERE tg_user_id = ?
         ORDER BY id DESC
         LIMIT ?`,
    ).all(chatId, limit);
    return rows.reverse();
}

/** Удалить всю историю одного чата (команда /forget). Возвращает число удалённых строк. */
export function clearHistory(chatId) {
    const result = db.prepare(
        'DELETE FROM dialog_history WHERE tg_user_id = ?',
    ).run(chatId);
    return result.changes;
}

/** Добавить (или обновить) пользовательский сервис в мониторинг. */
export function addMonitoredService(name, url) {
    db.prepare(
        `INSERT INTO monitored_services (name, url, added_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET url = excluded.url, added_at = excluded.added_at`,
    ).run(name, url, new Date().toISOString());
}

/** Список всех пользовательских сервисов на мониторинге. */
export function listMonitoredServices() {
    return db.prepare(
        'SELECT name, url, added_at FROM monitored_services ORDER BY id',
    ).all();
}

/** Удалить сервис по имени. Возвращает число удалённых строк. */
export function removeMonitoredService(name) {
    return db.prepare('DELETE FROM monitored_services WHERE name = ?').run(name).changes;
}

/** Whitelist: проверить, разрешён ли пользователь. */
export function isAllowedUser(userId) {
    if (!userId) return false;
    const row = db.prepare('SELECT 1 FROM allowed_users WHERE tg_user_id = ?').get(userId);
    return !!row;
}

/** Добавить пользователя в whitelist (UPSERT). */
export function addAllowedUser(userId, username, addedBy) {
    db.prepare(
        `INSERT INTO allowed_users (tg_user_id, username, added_at, added_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(tg_user_id) DO UPDATE SET
             username = excluded.username,
             added_at = excluded.added_at`,
    ).run(userId, username || null, new Date().toISOString(), addedBy || null);
}

/** Удалить пользователя из whitelist. Возвращает число удалённых строк. */
export function removeAllowedUser(userId) {
    return db.prepare('DELETE FROM allowed_users WHERE tg_user_id = ?').run(userId).changes;
}

/** Список разрешённых пользователей. */
export function listAllowedUsers() {
    return db.prepare(
        'SELECT tg_user_id, username, added_at FROM allowed_users ORDER BY tg_user_id',
    ).all();
}

// ============================== TODOs ==============================

export function addTodo(userId, text) {
    const result = db.prepare(
        `INSERT INTO todos (tg_user_id, text, status, created_at)
         VALUES (?, ?, 'open', ?)`,
    ).run(userId, text, new Date().toISOString());
    return result.lastInsertRowid;
}

export function listTodos(userId, status = 'open') {
    return db.prepare(
        `SELECT id, text, status, created_at, completed_at
         FROM todos
         WHERE tg_user_id = ? AND status = ?
         ORDER BY id ASC`,
    ).all(userId, status);
}

export function listAllTodos(userId) {
    return db.prepare(
        `SELECT id, text, status, created_at, completed_at
         FROM todos
         WHERE tg_user_id = ?
         ORDER BY status ASC, id ASC`,
    ).all(userId);
}

export function markTodoDone(userId, id) {
    return db.prepare(
        `UPDATE todos SET status = 'done', completed_at = ?
         WHERE id = ? AND tg_user_id = ? AND status = 'open'`,
    ).run(new Date().toISOString(), id, userId).changes;
}

export function deleteTodo(userId, id) {
    return db.prepare(
        'DELETE FROM todos WHERE id = ? AND tg_user_id = ?',
    ).run(id, userId).changes;
}

export function editTodo(userId, id, newText) {
    return db.prepare(
        'UPDATE todos SET text = ? WHERE id = ? AND tg_user_id = ?',
    ).run(newText, id, userId).changes;
}

// ============================== Reminders ==============================

export function addReminder(userId, chatId, text, remindAt) {
    const result = db.prepare(
        `INSERT INTO reminders (tg_user_id, chat_id, text, remind_at, created_at, sent)
         VALUES (?, ?, ?, ?, ?, 0)`,
    ).run(userId, chatId, text, remindAt.toISOString(), new Date().toISOString());
    return result.lastInsertRowid;
}

/** Все ещё не отправленные с remind_at <= сейчас. Используется cron'ом. */
export function listPendingReminders() {
    const nowIso = new Date().toISOString();
    return db.prepare(
        `SELECT id, tg_user_id, chat_id, text, remind_at
         FROM reminders
         WHERE sent = 0 AND remind_at <= ?
         ORDER BY remind_at ASC`,
    ).all(nowIso);
}

/** Список активных (ещё не отправленных) напоминаний юзера. */
export function listUserReminders(userId) {
    return db.prepare(
        `SELECT id, text, remind_at
         FROM reminders
         WHERE tg_user_id = ? AND sent = 0
         ORDER BY remind_at ASC`,
    ).all(userId);
}

export function markReminderSent(id) {
    return db.prepare('UPDATE reminders SET sent = 1 WHERE id = ?').run(id).changes;
}

export function deleteReminder(userId, id) {
    return db.prepare(
        'DELETE FROM reminders WHERE id = ? AND tg_user_id = ?',
    ).run(id, userId).changes;
}

// ============================== Notes ==============================

export function addNote(userId, text) {
    const result = db.prepare(
        'INSERT INTO notes (tg_user_id, text, created_at) VALUES (?, ?, ?)',
    ).run(userId, text, new Date().toISOString());
    return result.lastInsertRowid;
}

export function listNotes(userId) {
    return db.prepare(
        'SELECT id, text, created_at FROM notes WHERE tg_user_id = ? ORDER BY id DESC',
    ).all(userId);
}

export function getNote(userId, id) {
    return db.prepare(
        'SELECT id, text, created_at FROM notes WHERE id = ? AND tg_user_id = ?',
    ).get(id, userId);
}

export function deleteNote(userId, id) {
    return db.prepare(
        'DELETE FROM notes WHERE id = ? AND tg_user_id = ?',
    ).run(id, userId).changes;
}

// ============================== Search ==============================

/**
 * Поиск по диалогам, задачам и заметкам пользователя.
 * Возвращает {dialogs: [...], todos: [...], notes: [...]}.
 * Регистронезависимо, включая кириллицу (через JS toLowerCase).
 */
export function searchAcrossTables(userId, query) {
    const q = query.toLowerCase();

    const dialogs = db.prepare(
        `SELECT id, role, content, created_at
         FROM dialog_history
         WHERE tg_user_id = ?
         ORDER BY id DESC
         LIMIT 1000`,
    ).all(userId).filter((d) => d.content.toLowerCase().includes(q));

    const todos = db.prepare(
        `SELECT id, text, status, created_at
         FROM todos
         WHERE tg_user_id = ?
         ORDER BY id ASC`,
    ).all(userId).filter((t) => t.text.toLowerCase().includes(q));

    const notes = db.prepare(
        `SELECT id, text, created_at
         FROM notes
         WHERE tg_user_id = ?
         ORDER BY id DESC`,
    ).all(userId).filter((n) => n.text.toLowerCase().includes(q));

    return { dialogs, todos, notes };
}

/** Сводная статистика по dialog_history — для команды /stats. */
export function stats() {
    return db.prepare(`
        SELECT
            COUNT(*)                                                          AS total_messages,
            COUNT(DISTINCT tg_user_id)                                        AS unique_chats,
            (SELECT COUNT(*) FROM dialog_history WHERE role = 'user')         AS user_messages,
            (SELECT COUNT(*) FROM dialog_history WHERE role = 'assistant')    AS assistant_messages,
            (SELECT created_at FROM dialog_history ORDER BY id ASC  LIMIT 1)  AS first_message_at,
            (SELECT created_at FROM dialog_history ORDER BY id DESC LIMIT 1)  AS last_message_at
        FROM dialog_history
    `).get();
}

// ============================== Rate limit ==============================

/**
 * Чекнуть и записать запрос. Возвращает {allowed, count, max}.
 * Если allowed=false — лимит превышен, запись НЕ создаём.
 */
export function checkAndRecordRateLimit(userId, maxPerHour = 30) {
    const now = Date.now();
    const hourAgo = now - 3_600_000;
    db.prepare('DELETE FROM rate_limit WHERE request_at < ?').run(hourAgo);
    const { c } = db.prepare(
        'SELECT COUNT(*) AS c FROM rate_limit WHERE tg_user_id = ? AND request_at > ?',
    ).get(userId, hourAgo);
    if (c >= maxPerHour) return { allowed: false, count: c, max: maxPerHour };
    db.prepare('INSERT INTO rate_limit (tg_user_id, request_at) VALUES (?, ?)').run(userId, now);
    return { allowed: true, count: c + 1, max: maxPerHour };
}

// ============================== Service status ==============================

export function getServiceStatus(name) {
    const row = db.prepare('SELECT last_status FROM service_status WHERE name = ?').get(name);
    return row ? row.last_status : null;
}

export function setServiceStatus(name, status) {
    db.prepare(`
        INSERT INTO service_status (name, last_status, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
            last_status = excluded.last_status,
            updated_at  = excluded.updated_at
    `).run(name, status, new Date().toISOString());
}

// ============================== Pending tasks (persisted) ==============================

export function savePendingTask(token, userId, chatId, plan) {
    db.prepare(`
        INSERT INTO pending_tasks (token, tg_user_id, chat_id, plan_json, created_at)
        VALUES (?, ?, ?, ?, ?)
    `).run(token, userId, chatId, JSON.stringify(plan), Date.now());
}

export function getPendingTask(token) {
    const row = db.prepare('SELECT * FROM pending_tasks WHERE token = ?').get(token);
    if (!row) return null;
    return {
        token: row.token,
        userId: row.tg_user_id,
        chatId: row.chat_id,
        plan: JSON.parse(row.plan_json),
        createdAt: row.created_at,
    };
}

export function deletePendingTask(token) {
    return db.prepare('DELETE FROM pending_tasks WHERE token = ?').run(token).changes;
}

export function cleanupExpiredPendingTasks(ttlMs = 30 * 60_000) {
    const cutoff = Date.now() - ttlMs;
    return db.prepare('DELETE FROM pending_tasks WHERE created_at < ?').run(cutoff).changes;
}

export function hasActivePendingTask(userId, ttlMs = 30 * 60_000) {
    const cutoff = Date.now() - ttlMs;
    const row = db.prepare(
        `SELECT token FROM pending_tasks
         WHERE tg_user_id = ? AND created_at > ?
         LIMIT 1`,
    ).get(userId, cutoff);
    return row ? row.token : null;
}

// ============================== dialog_history cleanup ==============================

/**
 * Оставить не больше keepLastPerUser сообщений на пользователя — старые удалить.
 * Возвращает число удалённых строк.
 */
export function cleanupDialogHistory(keepLastPerUser = 50) {
    return db.prepare(`
        DELETE FROM dialog_history
        WHERE id NOT IN (
            SELECT id FROM dialog_history d1
            WHERE (
                SELECT COUNT(*) FROM dialog_history d2
                WHERE d2.tg_user_id = d1.tg_user_id AND d2.id >= d1.id
            ) <= ?
        )
    `).run(keepLastPerUser).changes;
}
