// Обращения к Claude API через официальный @anthropic-ai/sdk.
// Две функции:
//   analyzeTask(userMessage, history) — "мозг" бота, возвращает JSON для дальнейшей логики.
//   analyzeError(serviceName, httpStatus, responseTime) — объясняет ошибку сервиса и шаги по устранению.

import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

dotenv.config();

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TASK_SYSTEM_PROMPT = `Ты — менеджер задач команды. Понимаешь русский язык, помогаешь ставить задачи в Plane.

В ответ ВСЕГДА возвращай только валидный JSON без поясняющего текста, без markdown-блоков, без \`\`\`:
{
  "action": "create_task" | "list_tasks" | "update_task" | "question",
  "title":     "string или null",
  "description": "string или null",
  "assignee":  "имя исполнителя или null",
  "priority":  "urgent" | "high" | "medium" | "low" | "none",
  "dueDate":   "YYYY-MM-DD или null",
  "reply":     "короткий ответ пользователю по-русски"
}

Правила:
- "поставь задачу ...", "создай таск ..." → action="create_task", заполни title/description/assignee/priority/dueDate.
- "покажи задачи", "что у меня в работе" → action="list_tasks".
- "закрой задачу X", "поменяй приоритет" → action="update_task".
- Если сообщение — вопрос или непонятно → action="question", в reply дай ответ, остальные поля null.
- Если приоритет не указан явно — ставь "medium".
- Дату интерпретируй относительно сегодняшнего дня ("до пятницы", "завтра" и т.п.).`;


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
            max_tokens: 1024,
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
        console.error('[claude] analyzeTask error:', err.message, '| cause:', err.cause?.code, err.cause?.message, '| status:', err.status);
        return null;
    }
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
        console.error('[claude] analyzeError error:', err.message, '| cause:', err.cause?.code, err.cause?.message, '| status:', err.status);
        return null;
    }
}
