import pino from 'pino';

// Структурированный JSON-логгер.
// На Railway пишет в stdout сырые JSON-строки — дашборд их нормально показывает.
// Локально можно прогонять через `npx pino-pretty` для красивого вывода.
export const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    base: { service: 'scrum-plane-bot' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
        // Подстраховка от случайного логирования секретов.
        paths: [
            'TELEGRAM_BOT_TOKEN',
            'ANTHROPIC_API_KEY',
            'GROQ_API_KEY',
            'ELEVENLABS_API_KEY',
            'WEBHOOK_SECRET',
            'PLANE_API_KEY',
            '*.token',
            '*.api_key',
            '*.apiKey',
        ],
        censor: '[REDACTED]',
    },
});
