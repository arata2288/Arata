// Мониторинг сервисов: cron каждые 5 минут, алерт в Telegram при сбое.
// Также экспортирует runManualCheck() для команды /status в боте.

import cron from 'node-cron';
import dotenv from 'dotenv';

import { analyzeError } from './claude.js';
import { getAlertChatId } from './db.js';

dotenv.config();

const TIMEOUT_MS = 10_000;

/**
 * Список сервисов для проверки. Сервис включается в список только если
 * заданы нужные переменные окружения — иначе пропускаем, чтобы не падать
 * на пустых URL.
 */
function _services() {
    return [
        process.env.PLANE_URL && {
            name: 'Plane API',
            url: `${process.env.PLANE_URL.replace(/\/$/, '')}/api/v1/`,
            headers: { 'X-API-Key': process.env.PLANE_API_KEY || '' },
        },
        process.env.ANTHROPIC_API_KEY && {
            name: 'Claude API',
            url: 'https://api.anthropic.com/v1/models',
            headers: {
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
            },
        },
        process.env.TELEGRAM_BOT_TOKEN && {
            name: 'Telegram',
            url: `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`,
            headers: {},
        },
        {
            name: 'Bot Server',
            url: process.env.BOT_SERVER_URL || 'http://localhost:3000/health',
            headers: {},
        },
    ].filter(Boolean);
}

/**
 * Проверка одного эндпоинта. Возвращает структурированный результат
 * (никогда не бросает — все ошибки внутри).
 */
export async function checkService(name, url, headers = {}) {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const response = await fetch(url, { headers, signal: controller.signal });
        const responseTime = Date.now() - start;
        return {
            name,
            status: response.ok ? 'ok' : 'error',
            httpCode: response.status,
            responseTime,
            error: response.ok ? null : `HTTP ${response.status}`,
        };
    } catch (err) {
        return {
            name,
            status: 'down',
            httpCode: null,
            responseTime: Date.now() - start,
            error: err.name === 'AbortError' ? 'timeout (10s)' : err.message,
        };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Проверяет все сервисы из _services().
 * Если передан botInstance — шлёт алерт в ALERT_CHAT_ID при каждом сбое
 * (с AI-объяснением от Claude).
 */
export async function checkAll(botInstance = null) {
    const services = _services();
    const results = [];

    for (const svc of services) {
        const result = await checkService(svc.name, svc.url, svc.headers);
        results.push(result);

        if (result.status === 'ok') continue;
        // Куда слать: сначала из БД (выбрано через /set_alert), иначе fallback на .env.
        const alertChatId = getAlertChatId() || process.env.ALERT_CHAT_ID;
        if (!botInstance || !alertChatId) continue;

        // Сервис не отвечает — формируем алерт.
        const aiHint = await analyzeError(result.name, result.httpCode, result.responseTime);
        const text = [
            `🔴 ${result.name}`,
            `📍 ${result.httpCode || result.error || 'нет ответа'}`,
            `⏱ ${result.responseTime} мс`,
            `🕐 ${new Date().toLocaleString('ru-RU')}`,
            aiHint ? `\n${aiHint}` : null,
        ].filter(Boolean).join('\n');

        try {
            await botInstance.telegram.sendMessage(alertChatId, text);
        } catch (err) {
            console.error('[healthcheck] не удалось отправить алерт:', err.message);
        }
    }
    return results;
}

/** Ручная проверка для команды /status в боте — без алертов. */
export async function runManualCheck() {
    return checkAll(null);
}

/** Запустить cron, который каждые 5 минут вызывает checkAll(bot). */
export function startScheduler(botInstance) {
    cron.schedule('*/5 * * * *', () => {
        checkAll(botInstance).catch((err) => console.error('[healthcheck cron]', err));
    });
    console.log('[healthcheck] планировщик запущен (каждые 5 минут)');
}
