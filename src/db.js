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

        CREATE INDEX IF NOT EXISTS idx_tasks_user  ON tasks(tg_user_id);
        CREATE INDEX IF NOT EXISTS idx_dialog_user ON dialog_history(tg_user_id);
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
