import { isChecked, setChecked } from './dom.js';
import { getState } from './state.js';
import { showToast } from './toast.js';

/* Subject/body are the only two keyword match scopes; turning both off would
   silently match nothing (and the backend quietly re-enables subject). */
export function enforceMatchScope(changed) {
    const subject = document.querySelector('[data-fetch-check="matchSubject"]');
    const body = document.querySelector('[data-fetch-check="matchBody"]');
    if (!subject || !body) return;
    if (isChecked(subject) || isChecked(body)) return;
    setChecked(changed, true);
    showToast('至少需要一个匹配范围', '“匹配主题”和“匹配正文”不能同时关闭，否则不会命中任何邮件。已为你恢复。', 'warn');
}

/* Reflects the backend-normalised filter (contract: normalizedFilter) back
   into the controls so the UI never claims a setting the run did not use. */
export function applyNormalizedFilter(normalized) {
    if (!normalized || typeof normalized !== 'object') return;
    if (typeof normalized.matchSubject === 'boolean') {
        document.querySelectorAll('[data-fetch-check="matchSubject"]').forEach((el) => setChecked(el, normalized.matchSubject));
    }
    if (typeof normalized.matchBody === 'boolean') {
        document.querySelectorAll('[data-fetch-check="matchBody"]').forEach((el) => setChecked(el, normalized.matchBody));
    }
    getState().normalizedFilter = normalized;
    const note = document.querySelector('[data-normalized-filter]');
    if (note) {
        const parts = [];
        if (normalized.matchSubject) parts.push('主题');
        if (normalized.matchBody) parts.push('正文');
        const keywords = Array.isArray(normalized.keywords) ? normalized.keywords.join('、') : '';
        note.textContent = `本次实际使用：匹配${parts.join(' + ') || '（无）'}${keywords ? ` · 关键词 ${keywords}` : ''}`;
    }
}

