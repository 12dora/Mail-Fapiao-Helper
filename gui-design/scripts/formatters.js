import { escapeHtml, text } from './dom.js';
import { getState } from './state.js';

export function fmtInt(value) {
    return Number(value || 0).toLocaleString('zh-CN');
}

export function fmtDateTime(value) {
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return '';
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmtDuration(ms) {
    const n = Number(ms || 0);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 1000) return `${Math.round(n)} 毫秒`;
    return `${(n / 1000).toFixed(1)} 秒`;
}

export function historyTime(value) {
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return '未知时间';
    const today = new Date();
    const sameDay = d.getFullYear() === today.getFullYear()
        && d.getMonth() === today.getMonth()
        && d.getDate() === today.getDate();
    const day = sameDay ? '今天' : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function pill(label, kind = '') {
    return `<span class="pill ${kind ? `pill--${kind}` : ''}">${escapeHtml(label)}</span>`;
}

export function sourceLabel(source) {
    if (source === 'http') return '本机识别';
    if (source === 'cli') return '单次识别';
    return source || '归档文件';
}

export function reasonLabel(value) {
    const v = String(value || '');
    if (v.includes('rule_unhandled')) return '暂未识别';
    if (v.includes('parse_failed')) return '解析失败';
    if (v.includes('supporting')) return '支撑材料';
    if (v.includes('missing_file')) return '文件缺失';
    if (v.includes('http_403') || v.includes('403')) return '链接过期';
    if (v.includes('no_pdf_links')) return '没有下载文件';
    return v ? '需要确认' : '待处理';
}

export function statusPill(label) {
    if (label === '完整') return pill('完整', 'ok');
    // COPY-03：统一「信息不完整」；兼容旧值「待补充」。
    if (label === '信息不完整' || label === '待补充') return pill('信息不完整', 'warn');
    if (label === '识别失败') return pill('识别失败', 'err');
    if (label === '已归档') return pill('已归档');
    return pill(label || '未知状态');
}

export function sortableValue(row, key) {
    const value = row?.[key];
    if (key === 'date') {
        const t = Date.parse(value || '');
        return Number.isFinite(t) ? t : 0;
    }
    if (key === 'bodyLinkCount') return Number(value || 0);
    if (key === 'hasAttachment') return value ? 1 : 0;
    if (key === 'amount') return Number(String(value || '').replace(/[^\d.-]/g, '')) || 0;
    return String(value || '').toLowerCase();
}

export function sortRows(rows, scope) {
    const page = document.body.dataset.page;
    const stateKey = scope || (page === 'library' ? 'sortLibrary' : page === 'inbox' ? 'sortInbox' : '');
    const state = stateKey ? getState()[stateKey] : null;
    const key = state?.key || '';
    if (!key) return rows;
    const dir = state?.dir === 'asc' ? 1 : -1;
    return rows.slice().sort((a, b) => {
        const av = sortableValue(a, key);
        const bv = sortableValue(b, key);
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
        return String(av).localeCompare(String(bv), 'zh-CN') * dir;
    });
}

export function shortSender(value) {
    const text = String(value || '');
    const lt = text.indexOf('<');
    if (lt > 0) return text.slice(0, lt).trim().replace(/^"|"$/g, '') || text;
    return text.split('@')[0] || text;
}

