// Запуск: `node src/setup.js` или `npm run setup`.
// 1. Проверяет обязательные переменные .env (без них бот не стартует).
// 2. Предупреждает о опциональных, которые не заданы (Plane скипнется, и т.д.).
// 3. Открывает SQLite и создаёт все таблицы через ensureSchema().
// 4. По каждому пункту печатает ✅ / ⚠️ / ❌ с подсказкой, что делать.

import dotenv from 'dotenv';

import { db, ensureSchema } from './db.js';

dotenv.config();

// Без этих переменных бот не запустится.
const REQUIRED_VARS = [
    'TELEGRAM_BOT_TOKEN',
    'ANTHROPIC_API_KEY',
];

// Эти не обязательны: либо есть дефолты, либо просто фича отключится.
const OPTIONAL_VARS = [
    'ANTHROPIC_MODEL',
    'DB_PATH',
    'PLANE_URL', 'PLANE_API_KEY', 'PLANE_WORKSPACE_SLUG', 'PLANE_PROJECT_ID',
];

let hasErrors = false;

function check(label, ok, hint = '') {
    const icon = ok ? '✅' : '❌';
    console.log(`${icon} ${label}${ok || !hint ? '' : ` — ${hint}`}`);
    if (!ok) hasErrors = true;
}

console.log('=== Обязательные переменные ===');
for (const name of REQUIRED_VARS) {
    check(name, Boolean(process.env[name]), 'не заполнено в .env');
}

console.log('\n=== Опциональные (без них фичи просто отключатся) ===');
for (const name of OPTIONAL_VARS) {
    if (process.env[name]) {
        console.log(`✅ ${name}`);
    } else {
        console.log(`⚠️  ${name} — не задано (это ок, фича скипнется)`);
    }
}

console.log('\n=== SQLite ===');
try {
    db.prepare('SELECT 1').get();
    check('Подключение к bot.db', true);
} catch (err) {
    check('Подключение к bot.db', false, err.message);
}

try {
    ensureSchema();
    check('Таблицы tasks, dialog_history, alert_chat', true);
} catch (err) {
    check('Создание таблиц', false, err.message);
}

console.log('\n=== Итог ===');
if (hasErrors) {
    console.log('❌ Есть критичные проблемы — бот не запустится. Поправьте .env и повторите.');
    process.exit(1);
} else {
    console.log('✅ Всё готово. Можно запускать: npm start');
}
