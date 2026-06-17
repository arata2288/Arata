// Мониторинг сервисов: cron каждые 5 минут, алерт в Telegram при сбое.
// Также экспортирует runManualCheck() для команды /status в боте.

import cron from 'node-cron';
import dotenv from 'dotenv';

import { analyzeError } from './claude.js';
import { getAlertChatId, listMonitoredServices, getServiceStatus, setServiceStatus } from './db.js';
import { logger } from './logger.js';

dotenv.config();

const TIMEOUT_MS = 10_000;

/**
 * Список сервисов для проверки. Сервис включается в список только если
 * заданы нужные переменные окружения — иначе пропускаем, чтобы не падать
 * на пустых URL.
 */
function _services() {
    // Bot Server self-check намеренно убран:
    // — это циклическая проверка (если бот мёртв, он и алерт не пошлёт);
    // — Railway сам пингует /health через healthcheckPath и автоперезапустит при падении.

    // 1. Системные зависимости (всегда чекаются).
    const builtin = [
        process.env.PLANE_URL && process.env.PLANE_API_KEY && {
            name: 'Plane API',
            url: `${process.env.PLANE_URL.replace(/\/$/, '')}/api/v1/`,
            headers: { 'X-API-Key': process.env.PLANE_API_KEY },
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
    ].filter(Boolean);

    // 2. Пользовательские сервисы из SQLite (добавляются через /monitor add).
    let custom = [];
    try {
        custom = listMonitoredServices().map((s) => ({
            name: s.name, url: s.url, headers: {},
        }));
    } catch (err) {
        logger.error({ err: err.message }, '[healthcheck] failed to read custom services');
    }

    return [...builtin, ...custom];
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
 * Защита от шума:
 *   1. Если первая попытка упала — ждём 3 сек и пробуем ещё раз (фильтр транзитных блипов).
 *   2. Алерт уходит только если статус ИЗМЕНИЛСЯ относительно прошлого опроса.
 * Последний статус хранится в SQLite (service_status), переживает рестарт.
 */
export async function checkAll(botInstance = null) {
    const services = _services();
    const results = [];

    for (const svc of services) {
        let result = await checkService(svc.name, svc.url, svc.headers);

        // Retry: транзитный блип за 3 сек обычно проходит.
        if (result.status !== 'ok') {
            await new Promise((r) => setTimeout(r, 3000));
            result = await checkService(svc.name, svc.url, svc.headers);
        }
        results.push(result);

        const currentStatus = result.status === 'ok' ? 'ok' : 'fail';
        const previousStatus = getServiceStatus(svc.name);
        setServiceStatus(svc.name, currentStatus);

        const alertChatId = getAlertChatId() || process.env.ALERT_CHAT_ID;
        if (!botInstance || !alertChatId) continue;

        // Алерт о падении — только при смене ok → fail (или при первом наблюдении как fail).
        if (currentStatus === 'fail' && previousStatus !== 'fail') {
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
                logger.error({ err: err.message }, '[healthcheck] failed to send alert');
            }
        }

        // Алерт о восстановлении — при fail → ok.
        if (currentStatus === 'ok' && previousStatus === 'fail') {
            try {
                await botInstance.telegram.sendMessage(
                    alertChatId,
                    `✅ ${result.name}: восстановился (${result.responseTime} мс).`,
                );
            } catch (err) {
                logger.error({ err: err.message }, '[healthcheck] failed to send recovery alert');
            }
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
        checkAll(botInstance).catch((err) => logger.error({ err: err.message }, '[healthcheck cron] error'));
    });
    logger.info('[healthcheck] scheduler started (every 5 min)');
}
