import { bridgeUnavailable } from './bridge-base.js';
import { activeMain, announce, escapeHtml, text } from './dom.js';
import { fmtDateTime, fmtInt, pill, shortSender, sortRows, sourceLabel, statusPill } from './formatters.js';
import { getState } from './state.js';
import { showToast } from './toast.js';

/* Backend status enum (src/electron/summary.ts). 已识别 = 完整 only.
   COPY-03：partial / 待补充 统一为「信息不完整」。兼容旧摘要里的「待补充」。 */
export const STATUS = {
    COMPLETE: '完整',
    PARTIAL: '信息不完整',
    ARCHIVED: '已归档',
    FAILED: '识别失败',
};
export function libraryStatusMatches(status, want) {
    if (status === want) return true;
    // 旧摘要 / 旧 CSV 可能仍是「待补充」。
    if (want === STATUS.PARTIAL && (status === '待补充' || status === '信息不完整')) return true;
    return false;
}

/* ---------- Offset-based paging (contract 5) ---------- */
export const PAGE_SIZE = 80;

export function rowIdentity(kind, row) {
    if (kind === 'inbox') {
        return String(row.messageId || row.hash || `${row.date || ''}|${row.subject || ''}|${row.from || ''}`);
    }
    return String(row.filePath || `${row.hash || ''}|${row.filename || ''}|${row.invoiceNo || ''}`);
}

/* The paging cursor is always derived from what the SERVER reported
   (`offset + rows.length`), never from the locally de-duplicated row count.
   Using the local length skips boundary rows whenever the dataset shifts
   between two requests, and makes `loaded < total` stall forever. */
export function mergeSection(kind, payload) {
    const storeKey = kind === 'inbox' ? 'inboxRows' : 'libraryRows';
    if (!Array.isArray(payload?.rows)) return (getState()[storeKey] || []).length;
    const incoming = payload.rows;
    const offset = Number(payload.offset || 0);
    if (offset > 0) {
        const store = getState()[storeKey] || [];
        const seen = new Set(store.map((row) => rowIdentity(kind, row)));
        getState()[storeKey] = store.concat(incoming.filter((row) => !seen.has(rowIdentity(kind, row))));
        getState()[`${kind}Cursor`] = Math.max(Number(getState()[`${kind}Cursor`] || 0), offset + incoming.length);
    } else {
        getState()[storeKey] = incoming.slice();
        getState()[`${kind}Cursor`] = incoming.length;
    }
    getState()[`${kind}Total`] = Number(payload.total ?? getState()[storeKey].length);
    getState()[`${kind}Limit`] = Number(payload.limit || PAGE_SIZE) || PAGE_SIZE;
    return getState()[storeKey].length;
}

export function sectionCursor(kind) {
    const storeKey = kind === 'inbox' ? 'inboxRows' : 'libraryRows';
    const cursor = getState()[`${kind}Cursor`];
    return Number.isFinite(Number(cursor)) ? Number(cursor) : (getState()[storeKey] || []).length;
}

export async function reloadSectionFromStart(kind, limit) {
    const fn = window.mfhBridge?.getSummary;
    if (typeof fn !== 'function') return;
    const args = kind === 'inbox'
        ? { inboxOffset: 0, inboxLimit: limit }
        : { libraryOffset: 0, libraryLimit: limit };
    const summary = await fn(args);
    const section = kind === 'inbox' ? summary?.inbox : summary?.library;
    getState()[`${kind}Total`] = undefined;
    getState()[`${kind}Cursor`] = 0;
    getState()[kind === 'inbox' ? 'inboxRows' : 'libraryRows'] = [];
    mergeSection(kind, section && { ...section, offset: 0 });
    if (kind === 'inbox') renderInboxRows();
    else { renderLibraryRows(); updateSellerOptions(getState().libraryRows || []); }
}

export async function loadMoreRows(kind, button) {
    const fn = window.mfhBridge?.getSummary;
    if (typeof fn !== 'function') { bridgeUnavailable(); return; }
    const limit = getState()[`${kind}Limit`] || PAGE_SIZE;
    const cursor = sectionCursor(kind);
    const prevTotal = Number(getState()[`${kind}Total`] ?? NaN);
    const args = kind === 'inbox'
        ? { inboxOffset: cursor, inboxLimit: limit }
        : { libraryOffset: cursor, libraryLimit: limit };
    let summary;
    try {
        summary = await fn(args);
    } catch (err) {
        showToast('加载更多失败', '请稍后重试。', 'err', { detail: err?.message });
        return;
    }
    const section = kind === 'inbox' ? summary?.inbox : summary?.library;
    const total = Number(section?.total ?? prevTotal);
    // The dataset moved under us (a run added/removed records): every
    // server-side slice shifted, so anything we keep would silently skip or
    // duplicate boundary rows. Restart from page one.
    if (Number.isFinite(prevTotal) && Number.isFinite(total) && total !== prevTotal) {
        await reloadSectionFromStart(kind, limit);
        showToast('列表已更新', `记录数量变成了 ${fmtInt(total)} 条，已重新从第一页加载。`, 'warn');
        announce('记录数量发生变化，已重新从第一页加载。');
        return;
    }
    const serverOffset = Number(section?.offset ?? cursor);
    const returned = Array.isArray(section?.rows) ? section.rows.length : 0;
    const before = (getState()[kind === 'inbox' ? 'inboxRows' : 'libraryRows'] || []).length;
    const after = mergeSection(kind, section);
    if (kind === 'inbox') renderInboxRows(); else { renderLibraryRows(); updateSellerOptions(getState().libraryRows || []); }
    if (returned === 0 || serverOffset + returned >= total) {
        // Only the server cursor may declare the end of the dataset.
        if (button) { button.disabled = true; button.textContent = '没有更多记录了'; }
        announce('没有更多记录了。');
        return;
    }
    announce(after > before
        ? `已加载 ${after - before} 条记录，共 ${after} 条。`
        : `已读取 ${returned} 条记录，其中没有新内容。`);
}

export function renderLoadMore(kind, loaded, total) {
    const scope = activeMain();
    const mount = scope.querySelector(`[data-load-more="${kind}"]`);
    if (!mount) return;
    // Remaining is measured against the server cursor, not the de-duplicated
    // local length, so dedupe can never hide reachable records.
    const cursor = sectionCursor(kind);
    const remaining = Math.max(0, Number(total || 0) - cursor);
    mount.replaceChildren();
    if (remaining > 0) {
        const button = document.createElement('button');
        button.className = 'btn btn--sm';
        button.type = 'button';
        button.dataset.action = 'load-more';
        button.dataset.loadKind = kind;
        button.textContent = `加载更多（还有 ${fmtInt(remaining)} 条）`;
        const note = document.createElement('span');
        note.className = 'small muted';
        note.textContent = `搜索、排序和筛选只作用于已加载的 ${fmtInt(loaded)} 条记录。`;
        mount.append(button, note);
    } else {
        const note = document.createElement('span');
        note.className = 'small muted';
        note.textContent = `已加载全部 ${fmtInt(loaded)} 条记录。`;
        mount.append(note);
    }
}

export function renderInboxRows() {
    const scope = activeMain();
    const tbody = scope.querySelector('[data-inbox-rows]');
    if (!tbody) return;
    const loadedRows = getState().inboxRows || [];
    const rows = selectVisibleInboxRows();
    tbody.innerHTML = rows.map((row) => `
            <tr>
                <td class="mono">${fmtDateTime(row.date)}</td>
                <td>${escapeHtml(shortSender(row.from))}<br><span class="small muted">${escapeHtml(row.from || '')}</span></td>
                <td>${escapeHtml(row.subject || '无主题')}<span class="cell-sub">${escapeHtml(row.mailbox || '邮箱')} · ${row.hasAttachment ? '有附件' : '无附件'} · 链接 ${fmtInt(row.bodyLinkCount)}</span></td>
                <td class="mono col-num col-secondary">${row.hasAttachment ? '有' : '-'}</td>
                <td class="mono col-num col-secondary">${fmtInt(row.bodyLinkCount)}</td>
                <td class="col-secondary"><span class="pill">${escapeHtml(row.mailbox || '邮箱')}</span></td>
                <td>${pill('已缓存', 'ok')}</td>
            </tr>
        `).join('') || `<tr><td colspan="7" class="muted">没有找到匹配邮件。你可以换个关键词或取消筛选。</td></tr>`;
    const total = Number(getState().inboxTotal ?? loadedRows.length);
    text('[data-inbox-page]', `显示 ${fmtInt(rows.length)} · 已加载 ${fmtInt(loadedRows.length)} · 共 ${fmtInt(total)} 行`);
    renderLoadMore('inbox', loadedRows.length, total);
}

export function renderLibraryRows() {
    const scope = activeMain();
    const tbody = scope.querySelector('[data-library-rows]');
    if (!tbody) return;
    const loadedRows = getState().libraryRows || [];
    const seller = scope.querySelector('[data-library-seller]')?.value || '';
    const rows = selectVisibleLibraryRows();
    tbody.innerHTML = rows.map((row) => `
            <tr>
                <td class="mono">${escapeHtml((row.date || '').slice(0, 10))}</td>
                <td>${escapeHtml(row.seller || '未识别销售方')}<span class="cell-sub">${escapeHtml(sourceLabel(row.source))} · ${escapeHtml(row.filename || '未记录文件名')}</span></td>
                <td class="mono">${escapeHtml(row.invoiceNo || '-')}</td>
                <td class="mono col-num">${escapeHtml(row.amount || '-')}</td>
                <td class="col-secondary"><span class="pill">${escapeHtml(sourceLabel(row.source))}</span></td>
                <td class="mono small col-secondary">${escapeHtml(row.filename || '')}</td>
                <td>${statusPill(row.status)}</td>
                <td><button class="btn btn--sm" type="button" data-action="open-row-file" data-file-path="${escapeHtml(row.filePath || '')}"${row.filePath ? '' : ' disabled title="该记录没有对应文件路径"'}>打开</button></td>
            </tr>
        `).join('') || `<tr><td colspan="8" class="muted">没有找到匹配结果。你可以换个关键词或取消筛选。</td></tr>`;
    const total = Number(getState().libraryTotal ?? loadedRows.length);
    text('[data-library-page]', `显示 ${fmtInt(rows.length)} · 已加载 ${fmtInt(loadedRows.length)} · 共 ${fmtInt(total)} 条`);
    text('[data-library-sellers]', seller ? `销售方：${seller}（仅在已加载记录中筛选）` : '销售方：全部（仅在已加载记录中筛选）');
    renderLoadMore('library', loadedRows.length, total);
}

export function updateSellerOptions(rows) {
    const select = activeMain().querySelector('[data-library-seller]');
    if (!select) return;
    const sellers = Array.from(new Set(rows.map((row) => row.seller).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const current = select.value;
    select.innerHTML = '<option value="">全部销售方</option>' + sellers.map((seller) => `<option value="${escapeHtml(seller)}">${escapeHtml(seller)}</option>`).join('');
    if (sellers.includes(current)) select.value = current;
}

export function selectVisibleInboxRows() {
    const scope = activeMain();
    const query = String(scope.querySelector('[data-search="inbox"]')?.value || '').trim().toLowerCase();
    const attachmentOnly = scope.querySelector('[data-filter="inbox-attachment"]')?.classList.contains('is-active');
    const linksOnly = scope.querySelector('[data-filter="inbox-links"]')?.classList.contains('is-active');
    const loadedRows = getState().inboxRows || [];
    return sortRows(loadedRows.filter((row) => {
        const haystack = `${row.messageId || ''} ${row.from || ''} ${row.subject || ''} ${row.mailbox || ''}`.toLowerCase();
        if (query && !haystack.includes(query)) return false;
        if (attachmentOnly && !row.hasAttachment) return false;
        if (linksOnly && Number(row.bodyLinkCount || 0) <= 0) return false;
        return true;
    }), 'sortInbox');
}

export function selectVisibleLibraryRows() {
    const scope = activeMain();
    const query = String(scope.querySelector('[data-search="library"]')?.value || '').trim().toLowerCase();
    const activeTab = scope.querySelector('[data-library-tab].is-active')?.dataset.libraryTab || 'all';
    const seller = scope.querySelector('[data-library-seller]')?.value || '';
    const loadedRows = getState().libraryRows || [];
    return sortRows(loadedRows.filter((row) => {
        const haystack = `${row.seller || ''} ${row.invoiceNo || ''} ${row.amount || ''} ${row.filename || ''} ${row.error || ''}`.toLowerCase();
        if (query && !haystack.includes(query)) return false;
        if (seller && row.seller !== seller) return false;
        const status = String(row.status || '');
        const docType = String(row.documentType || '');
        if (activeTab === 'recognized' && status !== STATUS.COMPLETE) return false;
        if (activeTab === 'partial' && !libraryStatusMatches(status, STATUS.PARTIAL)) return false;
        if (activeTab === 'failed' && status !== STATUS.FAILED) return false;
        if (activeTab === 'supporting' && docType !== 'supporting') return false;
        if (activeTab === 'itinerary' && docType !== 'itinerary') return false;
        return true;
    }), 'sortLibrary');
}


