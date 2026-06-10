// Синтез голоса через ElevenLabs (TTS).
// Бесплатный tier: 10 000 символов/месяц.
// На голос Sarah (EXAVITQu4vr4xnSDxMaL) с моделью multilingual v2 → русский нормально звучит.

import dotenv from 'dotenv';

dotenv.config();

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
// Sarah — mature, reassuring, confident. Premade-голос, доступен free-tier.
const DEFAULT_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';
const MODEL_ID = 'eleven_multilingual_v2';

// Ограничение длины текста, который озвучиваем — защита от случайного слива квоты
// (10k chars/мес на free-плане). 800 символов хватит на средний ответ Claude.
export const TTS_MAX_CHARS = 800;

/** Включён ли TTS (есть ли ключ). */
export function isTtsEnabled() {
    return Boolean(ELEVENLABS_API_KEY);
}

/**
 * Синтез голоса из текста.
 * @param {string} text — текст для озвучивания.
 * @returns {Promise<Buffer>} mp3-аудио как Buffer.
 * @throws при отсутствии ключа или ошибке API.
 */
export async function synthesizeVoice(text) {
    if (!ELEVENLABS_API_KEY) {
        throw new Error('ELEVENLABS_API_KEY не задан');
    }
    const safeText = String(text).slice(0, TTS_MAX_CHARS);
    if (!safeText.trim()) {
        throw new Error('Пустой текст для озвучивания');
    }

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${DEFAULT_VOICE_ID}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'xi-api-key': ELEVENLABS_API_KEY,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            text: safeText,
            model_id: MODEL_ID,
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`ElevenLabs ${response.status}: ${errText.slice(0, 200)}`);
    }
    return Buffer.from(await response.arrayBuffer());
}
