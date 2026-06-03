// Запуск: `node src/setup.js` или `npm run setup`.
// 1. Проверяет, что все переменные .env заполнены.
// 2. Открывает SQLite, создаёт таблицы tasks и dialog_history (если их нет).
// 3. По каждому пункту печатает ✅ или ❌ с подсказкой, что исправить.

import dotenv from 'dotenv';
import { db } from './db.js';

dotenv.config();

const REQUIRED_VARS = [
    'TELEGRAM_BOT_TOKEN',
    'ALERT_CHAT_ID',
    'PLANE_URL',
    'PLANE_API_KEY',
    'PLANE_WORKSPACE_SLUG',
    'PLANE_PROJECT_ID',
    'ANTHROPIC_API_KEY',
];

let hasErrors = false;

function check(label, ok, hint = '') {
    const icon = ok ? '✅' : '❌';
    console.log(`${icon} ${label}${ok || !hint ? '' : ` — ${hint}`}`);
    if (!ok) hasErrors = true;
}

console.log('=== Проверка переменных окружения ===');
for (const name of REQUIRED_VARS) {
    check(name, Boolean(process.env[name]), 'не заполнено в .env');
}

console.log('\n=== Подключение к SQLite ===');
try {
    db.prepare('SELECT 1').get();
    check('Подключение к bot.db', true);
} catch (err) {
    check('Подключение к bot.db', false, err.message);
}

console.log('\n=== Создание таблиц ===');
try {
    db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            tg_user_id      INTEGER NOT NULL,
            plane_issue_key TEXT    NOT NULL,
            created_at      TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS dialog_history (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            tg_user_id   INTEGER NOT NULL,
            role         TEXT    NOT NULL,
            content      TEXT    NOT NULL,
            created_at   TEXT    NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(tg_user_id);
        CREATE INDEX IF NOT EXISTS idx_dialog_user ON dialog_history(tg_user_id);
    `);
    check('Таблицы tasks, dialog_history', true);
} catch (err) {
    check('Таблицы tasks, dialog_history', false, err.message);
}

console.log('\n=== Итог ===');
if (hasErrors) {
    console.log('❌ Есть незаполненные пункты. Откройте .env и заполните недостающее, затем повторите.');
    process.exit(1);
} else {
    console.log('✅ Всё готово. Можно запускать: npm start');
}
