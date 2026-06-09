// Обращения к Claude API через официальный @anthropic-ai/sdk.
// Две функции:
//   analyzeTask(userMessage, history) — "мозг" бота, возвращает JSON для дальнейшей логики.
//   analyzeError(serviceName, httpStatus, responseTime) — объясняет ошибку сервиса и шаги по устранению.

import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

dotenv.config();

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TASK_SYSTEM_PROMPT = `Ты — универсальный AI-помощник на русском языке, работаешь в Telegram-боте.

Умеешь две вещи:
1. ОБЫЧНЫЙ РАЗГОВОР: отвечать на вопросы, объяснять, переводить, считать, советовать, помогать с кодом, рассуждать. По умолчанию веди себя как нормальный полезный AI, не пытайся "впихнуть" вопрос в формат задачи.
2. УПРАВЛЕНИЕ ЗАДАЧАМИ в Plane — но ТОЛЬКО при явных триггерах ниже.

В ответ ВСЕГДА возвращай ТОЛЬКО валидный JSON, без markdown-блоков, без \`\`\`:
{
  "action": "create_task" | "list_tasks" | "update_task" | "question",
  "title":     "string или null",
  "description": "string или null",
  "assignee":  "имя исполнителя или null",
  "priority":  "urgent" | "high" | "medium" | "low" | "none",
  "dueDate":   "YYYY-MM-DD или null",
  "reply":     "полный полезный ответ пользователю по-русски"
}

Когда какое action:
- ЯВНАЯ просьба создать задачу («поставь задачу ...», «создай таск ...», «нужно сделать ...» с явным контекстом таска) → action="create_task", заполни title/description/assignee/priority/dueDate.
- «покажи задачи», «что у меня в работе», «список задач» → action="list_tasks".
- «закрой задачу X», «обнови приоритет», «измени дедлайн» → action="update_task".
- ВСЁ ОСТАЛЬНОЕ (вопросы, объяснения, советы, перевод, расчёты, код, философия, болтовня) → action="question", в reply дай НОРМАЛЬНЫЙ развёрнутый ответ, остальные поля null.

Важно:
- НЕ ПЫТАЙСЯ оформлять вопрос как задачу. «Что такое REST API» — это вопрос, action="question", reply — объяснение. Не таск!
- В reply пиши развёрнуто и полезно, как нормальный AI-ассистент. Не одно-два слова.
- НЕ используй markdown (**, ##, \`\`\` и т.д.) — Telegram плохо рендерит. Простой текст, можно с эмодзи.
- Если приоритет задачи не указан — medium.
- Дату интерпретируй относительно сегодняшнего дня.`;


const ERROR_SYSTEM_PROMPT =
    'Ты — опытный SRE/DevOps. Отвечай кратко и по-русски. ' +
    'По коду ответа и времени отклика сделай предположение, что не так, и дай 2-4 конкретных шага диагностики. ' +
    'Не предлагай опасных действий без подтверждения.';


/**
 * Понять, что хочет пользователь, и вернуть структурированное намерение.
 * @param {string} userMessage — текущее сообщение пользователя.
 * @param {Array<{role: 'user'|'assistant', content: string}>} history — последние 10 сообщений.
 * @returns {Promise<object|null>} распарсенный JSON ответа или null при сбое.
 */
export async function analyzeTask(userMessage, history = []) {
    const messages = [
        ...history.slice(-10),
        { role: 'user', content: userMessage },
    ];

    try {
        const response = await client.messages.create({
            model: MODEL,
            max_tokens: 2048,
            system: TASK_SYSTEM_PROMPT,
            messages,
        });

        const text = response.content?.[0]?.text?.trim();
        if (!text) return null;

        try {
            return JSON.parse(text);
        } catch (err) {
            console.error('[claude] Ответ не валидный JSON:', text.slice(0, 300));
            return {
                action: 'question',
                title: null, description: null, assignee: null,
                priority: 'medium', dueDate: null,
                reply: 'Не смог распарсить ответ. Попробуйте переформулировать запрос.',
            };
        }
    } catch (err) {
        console.error(
            '[claude] analyzeTask error:',
            JSON.stringify({
                name: err.name,
                message: err.message,
                status: err.status,
                cause_code: err.cause?.code,
                cause_name: err.cause?.name,
            }),
        );
        return null;
    }
}


/**
 * Универсальная обёртка для простых текстовых запросов к Claude — для /translate, /summarize, /explain.
 * Возвращает чистый текст без JSON-обёртки.
 */
async function _simpleCall(systemPrompt, userMessage, maxTokens = 1024) {
    try {
        const response = await client.messages.create({
            model: MODEL,
            max_tokens: maxTokens,
            system: systemPrompt,
            messages: [{ role: 'user', content: userMessage }],
        });
        return response.content?.[0]?.text?.trim() || null;
    } catch (err) {
        console.error(
            '[claude] simple call error:',
            JSON.stringify({ name: err.name, message: err.message, status: err.status }),
        );
        return null;
    }
}

export async function translate(text, targetLang = null) {
    const system = targetLang
        ? `Переведи следующий текст на язык: ${targetLang}. Только перевод, без пояснений, без кавычек.`
        : 'Определи язык текста и переведи на ПРОТИВОПОЛОЖНЫЙ (русский ↔ английский, или с другого языка на русский). '
            + 'Только перевод, без пояснений, без кавычек.';
    return _simpleCall(system, text, 1024);
}

export async function summarize(text) {
    const system = 'Сделай краткое резюме текста на русском в 3-7 пунктов, каждый с символа «• ». '
        + 'Только самую суть. Без воды, без вводных фраз, без markdown.';
    return _simpleCall(system, text, 1024);
}

export async function explain(text) {
    const system = 'Объясни на русском простыми словами что это (код, термин, концепция, regex, SQL, аббревиатура). '
        + '3-7 предложений. Если это код — что он делает. Без markdown, без тройных кавычек.';
    return _simpleCall(system, text, 1024);
}

/**
 * Объяснить сбой сервиса и предложить шаги диагностики.
 * @returns {Promise<string|null>} текст на русском или null при сбое.
 */
export async function analyzeError(serviceName, httpStatus, responseTime) {
    const prompt =
        `Сервис: ${serviceName}\n` +
        `HTTP-статус: ${httpStatus || 'нет ответа'}\n` +
        `Время отклика, мс: ${responseTime ?? 'нет данных'}\n\n` +
        'Что вероятно случилось? Какие 2–4 шага проверки стоит сделать первыми?';

    try {
        const response = await client.messages.create({
            model: MODEL,
            max_tokens: 512,
            system: ERROR_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: prompt }],
        });
        return response.content?.[0]?.text?.trim() || null;
    } catch (err) {
        console.error(
            '[claude] analyzeError error:',
            JSON.stringify({
                name: err.name,
                message: err.message,
                status: err.status,
                cause_code: err.cause?.code,
                cause_name: err.cause?.name,
            }),
        );
        return null;
    }
}
