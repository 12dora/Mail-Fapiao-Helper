import { activeMain, announce, escapeHtml, prefersReducedMotion, text } from './dom.js';
import { fmtInt, pill, reasonLabel } from './formatters.js';
import { sanitizeText, supportRef } from './redaction.js';
import { ICON } from './shell-ui.js';
import { getState } from './state.js';

export const KNOWN_PENDING_ACTIONS = new Set(['refresh_link', 'retry', 'ignore', 'manual_archive']);
export function actionText(action) {
    // COPY-16: use the same verb set as the rest of the app (获取 / 识别).
    if (action === 'refresh_link') return ['打开原始邮件', '在邮件中刷新授权后重新获取'];
    if (action === 'retry') return ['重新尝试', '适合临时网络失败'];
    if (action === 'ignore') return ['确认忽略', '从待确认队列中移除'];
    if (action === 'manual_archive') return ['选择文件归档', '把下载好的文件复制到归档目录'];
    return ['等待新版本', '当前版本暂未支持这种处理方式'];
}

/* Internal product notes leaked into user-facing descriptions. Until the
   backend supplies `userMessage`, drop any sentence that reads like a
   developer instruction rather than user guidance. */
export const INTERNAL_NOTE_RE = /(GUI\s*应|界面应|默认保持|保留\s*reason|reason\s*字段|TODO|后续版本再)/i;
export function cleanDescription(value) {
    return String(value || '')
        .split(/(?<=[。；;])/)
        .filter((sentence) => sentence.trim() && !INTERNAL_NOTE_RE.test(sentence))
        .join('')
        .trim();
}

export function rowCategory(row) {
    return String(row?.category || reasonLabel(row?.reason) || '需要确认');
}
export function rowUserMessage(row, group) {
    if (row?.userMessage) return String(row.userMessage);
    const desc = cleanDescription(group?.userMessage || group?.description);
    return desc || '这封邮件没有自动取得发票文件。';
}
export function rowNextStep(row, group) {
    if (row?.nextStep) return String(row.nextStep);
    const [, note] = actionText(group?.action);
    return note;
}

export function applyPendingSummary(pending, opts = {}) {
    getState().pending = pending;
    const total = Number(pending.total || 0);
    text('[data-pending="total"]', fmtInt(total));
    const groups = pending.groups || [];
    // Zero queue: hide every affordance that only makes sense with records.
    document.querySelectorAll('[data-pending-nonempty]').forEach((el) => { el.hidden = total === 0; });
    document.querySelectorAll('[data-pending-empty]').forEach((el) => { el.hidden = total !== 0; });
    document.querySelectorAll('[data-pending-stats]').forEach((mount) => {
        if (groups.length === 0) {
            mount.innerHTML = `
                    <div class="stat">
                        <div class="stat__label">暂无待确认</div>
                        <div class="stat__value">0</div>
                        <div class="stat__delta is-flat">无需处理</div>
                    </div>
                `;
            return;
        }
        mount.innerHTML = groups.map((group) => {
            const [action] = actionText(group.action);
            return `
                    <div class="stat">
                        <div class="stat__label">${escapeHtml(group.title || '待确认')}</div>
                        <div class="stat__value">${fmtInt(group.count)}</div>
                        <div class="stat__delta">${escapeHtml(action)}</div>
                    </div>
                `;
        }).join('');
    });
    // FB-04: a targeted row removal owns the DOM; do not blow the list away.
    if (!opts.preservePendingDom) renderPendingGroups();
}

export function pendingRowMarkup(row, group) {
    const [primary] = actionText(group.action);
    const isKnownAction = KNOWN_PENDING_ACTIONS.has(group.action);
    const disabledAttr = isKnownAction ? '' : ' disabled title="当前版本暂未支持这种处理方式"';
    const ref = supportRef(row.hash);
    return `
            <div class="card card--tight pending-item" data-pending-row="${escapeHtml(row.hash || '')}" data-pending-action="${escapeHtml(group.action || '')}">
                <div class="row gap-8 mb-12">
                    ${pill(rowCategory(row), group.action === 'refresh_link' ? 'warn' : '')}
                    <span class="pill">${escapeHtml(rowNextStep(row, group))}</span>
                </div>
                <div class="strong pending-item__subject">${escapeHtml(row.subject || '无主题')}</div>
                <div class="mono small muted">${escapeHtml((row.date || '').slice(0, 10))} · ${escapeHtml(row.from || '')}</div>
                <div class="small muted mt-12">${escapeHtml(rowUserMessage(row, group))}</div>
                <div class="row gap-8 mt-12">
                    <button class="btn btn--sm btn--primary" type="button" data-action="pending-primary" data-hash="${escapeHtml(row.hash || '')}" data-action-kind="${escapeHtml(group.action)}"${disabledAttr}>${escapeHtml(primary)}</button>
                    <button class="btn btn--sm btn--ghost" type="button" data-action="copy-diagnostics" data-hash="${escapeHtml(row.hash || '')}">复制诊断信息</button>
                </div>
                <details class="toast__detail mt-12">
                    <summary>诊断信息（已脱敏）</summary>
                    <pre>支持编号：${escapeHtml(ref)}
原因：${escapeHtml(sanitizeText(row.reason || '未记录'))}</pre>
                </details>
            </div>
        `;
}

export function renderPendingGroups() {
    const mount = activeMain().querySelector('[data-pending-groups]');
    if (!mount) return;
    const pending = getState().pending || {};
    const activeTab = activeMain().querySelector('[data-pending-tab].is-active')?.dataset.pendingTab || 'all';
    const allGroups = pending.groups || [];
    const groups = allGroups.filter((group) => {
        if (activeTab === 'all') return true;
        return group.action === activeTab;
    });
    const emptyMarkup = allGroups.length === 0
        ? '<div class="card"><div class="strong" tabindex="-1" data-pending-empty-focus>目前没有需要你确认的邮件</div><div class="small muted mt-12">获取发票文件后，如有无法自动处理的邮件，会显示在这里。</div></div>'
        : '<div class="card"><div class="strong" tabindex="-1" data-pending-empty-focus>当前分类暂无邮件</div><div class="small muted mt-12">切换到「全部」可以查看其它分类的邮件。</div></div>';
    mount.innerHTML = groups.map((group, index) => {
        const headId = `pending-head-${index}`;
        const bodyId = `pending-body-${index}`;
        // Every row is rendered: no group is silently truncated.
        const rows = (group.rows || []).map((row) => pendingRowMarkup(row, group)).join('');
        const groupTotal = Number(group.total ?? group.count ?? (group.rows || []).length);
        const shown = (group.rows || []).length;
        const description = cleanDescription(group.userMessage || group.description);
        return `
                <div class="group is-open" data-pending-group="${escapeHtml(group.action || '')}">
                    <h3 class="group__heading">
                        <button class="group__head" type="button" id="${headId}" aria-expanded="true" aria-controls="${bodyId}">
                            ${ICON.chev.replace('class="ic"', 'class="ic group__chev"')}
                            <span class="group__title">${escapeHtml(group.title)}</span>
                            <span class="group__count">${fmtInt(groupTotal)}</span>
                        </button>
                    </h3>
                    <div class="group__body" id="${bodyId}" role="region" aria-labelledby="${headId}">
                        <div class="group__inner">
                            <div class="group__content">
                                ${description ? `<div class="small muted mb-12">${escapeHtml(description)}</div>` : ''}
                                <div data-pending-rows>${rows || '<div class="card card--tight muted">暂无明细</div>'}</div>
                                ${groupTotal > shown ? `<div class="small muted mt-12" data-group-more>本地只取回了 ${fmtInt(shown)} / ${fmtInt(groupTotal)} 条，请点击“刷新列表”重新读取。</div>` : ''}
                            </div>
                        </div>
                    </div>
                </div>
            `;
    }).join('') || emptyMarkup;
}

/* Terminal state after the last queued item is handled: rebuild the region
   so the user sees the real empty state instead of a stale group whose body
   just says "这一组已经处理完了" (FB-04 / UI-08C). */
export function showPendingTerminalState(announcement) {
    renderPendingGroups();
    const focusTarget = activeMain().querySelector('[data-pending-empty-focus]')
        || document.querySelector('[data-pending-empty] [data-action="reload-summary"]');
    if (focusTarget) {
        if (!focusTarget.hasAttribute('tabindex') && !/^(BUTTON|A|INPUT|SELECT)$/.test(focusTarget.tagName)) {
            focusTarget.setAttribute('tabindex', '-1');
        }
        focusTarget.focus?.({ preventScroll: false });
    }
    announce(`${announcement || '已处理这封邮件'}，待确认队列已经清空。`);
}

/* FB-04: remove a single card in place, keep the rest of the DOM (and the
   expansion state) alive, and hand focus to a sensible neighbour. */
export function removePendingRowInPlace(hash, announcement) {
    const card = document.querySelector(`[data-pending-row="${CSS.escape(String(hash || ''))}"]`);
    if (!card) return false;
    const container = card.closest('[data-pending-rows]') || card.parentElement;
    const group = card.closest('.group');
    const siblings = Array.from(container?.querySelectorAll(':scope > .pending-item') || []);
    const index = siblings.indexOf(card);
    const nextCard = siblings[index + 1] || siblings[index - 1] || null;
    const focusTarget = nextCard?.querySelector('[data-action="pending-primary"]')
        || group?.querySelector('.group__head')
        || document.querySelector('[data-pending-groups]');

    const groupsMount = group?.closest('[data-pending-groups]');

    const finish = () => {
        card.remove();
        const remaining = Array.from(container?.querySelectorAll(':scope > .pending-item') || []).length;
        const countEl = group?.querySelector('.group__count');
        if (countEl) countEl.textContent = fmtInt(remaining);
        if (remaining === 0) {
            // An emptied group is stale: drop it. When it was the last one,
            // fall through to the real empty state instead of leaving a
            // hollow accordion behind.
            group?.remove();
            const groupsLeft = groupsMount?.querySelectorAll('.group').length || 0;
            if (groupsLeft === 0) {
                showPendingTerminalState(announcement);
                return;
            }
            const nextHead = groupsMount?.querySelector('.group__head');
            nextHead?.focus?.({ preventScroll: false });
            announce(`${announcement || '已处理这封邮件'}，这一组已经处理完，还有 ${groupsLeft} 组待确认。`);
            return;
        }
        if (focusTarget) {
            if (!focusTarget.hasAttribute('tabindex') && !/^(BUTTON|A|INPUT|SELECT)$/.test(focusTarget.tagName)) {
                focusTarget.setAttribute('tabindex', '-1');
            }
            focusTarget.focus?.({ preventScroll: false });
        }
        announce(`${announcement || '已处理这封邮件'}，本组还剩 ${remaining} 封。`);
    };

    if (prefersReducedMotion()) {
        finish();
    } else {
        card.style.maxHeight = `${card.offsetHeight}px`;
        requestAnimationFrame(() => card.classList.add('is-removing'));
        window.setTimeout(finish, 180);
    }
    return true;
}

