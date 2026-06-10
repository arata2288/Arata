// Транскрипция голосовых сообщений через Groq Whisper.
// Бесплатный tier с большим лимитом, очень быстрый (~1-2 сек на минуту аудио).

import dotenv from 'dotenv';

dotenv.config();

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MODEL = 'whisper-large-v3-turbo';
const DEFAULT_LANGUAGE = 'ru';

/** Включена ли транскрипция (есть ли ключ). */
export function isVoiceEnabled() {
    return Boolean(GROQ_API_KEY);
}

/**
 * Скачивает аудио по URL и шлёт в Groq на транскрипцию.
 * @param {string} fileUrl — публичная ссылка на аудиофайл (Telegram отдаёт такую через getFileLink).
 * @param {string} [language='ru'] — двухбуквенный код языка для подсказки модели.
 * @returns {Promise<string>} распознанный текст.
 * @throws если ключ не задан, скачивание упало или Groq вернул не-2xx.
 */
export async function transcribeAudio(fileUrl, language = DEFAULT_LANGUAGE) {
    if (!GROQ_API_KEY) {
        throw new Error('GROQ_API_KEY не задан в env');
    }

    // 1. Скачиваем файл с Telegram-серверов.
    const audioRes = await fetch(fileUrl);
    if (!audioRes.ok) {
        throw new Error(`Не смог скачать аудио с Telegram: HTTP ${audioRes.status}`);
    }
    const audioBlob = await audioRes.blob();

    // 2. Отправляем в Groq как multipart/form-data.
    const form = new FormData();
    form.append('file', audioBlob, 'voice.ogg');
    form.append('model', MODEL);
    form.append('language', language);
    form.append('response_format', 'json');

    const groqRes = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
        body: form,
    });

    if (!groqRes.ok) {
        const text = await groqRes.text();
        throw new Error(`Groq ${groqRes.status}: ${text.slice(0, 200)}`);
    }

    const data = await groqRes.json();
    return (data.text || '').trim();
}
