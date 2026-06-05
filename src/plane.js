// Обёртка над Plane REST API (docs.plane.so).
// Все настройки читаются из .env: PLANE_URL, PLANE_API_KEY,
// PLANE_WORKSPACE_SLUG, PLANE_PROJECT_ID.
// При любой ошибке логируем и возвращаем null — вызывающий код решает, что делать.

import dotenv from 'dotenv';
dotenv.config();

const {
    PLANE_URL,
    PLANE_API_KEY,
    PLANE_WORKSPACE_SLUG,
    PLANE_PROJECT_ID,
} = process.env;

function _projectPath() {
    if (!PLANE_URL || !PLANE_WORKSPACE_SLUG || !PLANE_PROJECT_ID) {
        console.warn('[plane] не заданы PLANE_URL / WORKSPACE_SLUG / PROJECT_ID — функция вернёт null');
        return null;
    }
    return `${PLANE_URL.replace(/\/$/, '')}/api/v1/workspaces/${PLANE_WORKSPACE_SLUG}/projects/${PLANE_PROJECT_ID}`;
}

async function _request(method, url, body = null) {
    try {
        const response = await fetch(url, {
            method,
            headers: {
                'X-API-Key': PLANE_API_KEY,
                'Content-Type': 'application/json',
            },
            body: body ? JSON.stringify(body) : undefined,
        });

        if (!response.ok) {
            const text = await response.text();
            console.error(`[plane] ${method} ${url} → HTTP ${response.status}: ${text.slice(0, 300)}`);
            return null;
        }
        // DELETE может вернуть 204 No Content
        if (response.status === 204) return true;
        return await response.json();
    } catch (err) {
        console.error(`[plane] ${method} ${url} →`, err.message);
        return null;
    }
}

/**
 * Создать issue в Plane.
 * @returns объект созданной задачи или null при ошибке.
 */
export async function createIssue(title, description, priority = 'none', assigneeId = null) {
    const base = _projectPath();
    if (!base) return null;
    const payload = {
        name: title,
        description_html: description ? `<p>${description}</p>` : undefined,
        priority, // 'urgent' | 'high' | 'medium' | 'low' | 'none'
        assignees: assigneeId ? [assigneeId] : [],
    };
    return _request('POST', `${base}/issues/`, payload);
}

/**
 * Получить список issue с опциональной фильтрацией.
 * filters: { state?, priority?, assignee? } — будут переданы как query-параметры.
 */
export async function getIssues(filters = {}) {
    const base = _projectPath();
    if (!base) return null;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined && value !== null) params.set(key, value);
    }
    const qs = params.toString();
    const url = `${base}/issues/${qs ? '?' + qs : ''}`;
    const data = await _request('GET', url);
    if (!data) return null;
    return Array.isArray(data) ? data : (data.results || []);
}

/**
 * Обновить поля задачи (статус, приоритет, исполнитель и т.д.).
 * fields: произвольный набор полей Plane Issue (state, priority, assignees, target_date, ...).
 */
export async function updateIssue(issueId, fields) {
    const base = _projectPath();
    if (!base) return null;
    return _request('PATCH', `${base}/issues/${issueId}/`, fields);
}

/**
 * Найти ID пользователя по имени / отображаемому имени.
 * Сравнение нечувствительно к регистру; ищем по display_name, first_name + last_name, email.
 */
export async function resolveAssignee(name) {
    if (!name) return null;
    const url = `${PLANE_URL.replace(/\/$/, '')}/api/v1/workspaces/${PLANE_WORKSPACE_SLUG}/members/`;
    const data = await _request('GET', url);
    if (!data) return null;

    const members = Array.isArray(data) ? data : (data.results || []);
    const needle = name.trim().toLowerCase();

    const found = members.find((m) => {
        const user = m.member || m; // Plane возвращает либо вложенный member, либо плоский объект
        const candidates = [
            user.display_name,
            user.first_name && user.last_name ? `${user.first_name} ${user.last_name}` : null,
            user.first_name,
            user.email,
        ].filter(Boolean).map((s) => s.toLowerCase());
        return candidates.some((c) => c.includes(needle) || needle.includes(c));
    });

    if (!found) {
        console.warn(`[plane] resolveAssignee: пользователь «${name}» не найден среди ${members.length} участников`);
        return null;
    }
    const user = found.member || found;
    return user.id;
}
