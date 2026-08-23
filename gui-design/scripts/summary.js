import { escapeHtml, text } from './dom.js';
import { fmtDateTime, fmtDuration, fmtInt, historyTime, pill, shortSender } from './formatters.js';
import { applyOpState, ocrJobRunning } from './op-state.js';
import { applyPendingSummary } from './pending-view.js';
import { setOcrControlState } from './progress.js';
import { mergeSection, renderInboxRows, renderLibraryRows, updateSellerOptions } from './records.js';
import { getState } from './state.js';

export function applySummary(summary, opts = {}) {
    getState().summary = summary;
    const inbox = summary.inbox || {};
    const library = summary.library || {};
    const pending = summary.pending || {};
    text('[data-nav-badge="inbox"]', fmtInt(inbox.total));
    text('[data-nav-badge="library"]', fmtInt(library.recognized));
    text('[data-nav-badge="pending"]', fmtInt(pending.total));
    text('[data-summary="config-path"]', summary.configExists ? '本机配置已加载' : '尚未保存本机配置');

    applyDashboardSummary(summary);
    applyInboxSummary(inbox);
    applyLibrarySummary(library);
    applyPendingSummary(pending, opts);
    applyHistory(summary.history || []);
    // The "本次抓取" table is owned by the last run, never by the full INDEX.
    renderCurrentBatch();
    // A plain summary refresh must not reset the controls of a job that is
    // still running (FB-01 / APP-05).
    setOcrControlState(ocrJobRunning() ? 'running' : 'idle');
    applyOpState(getState().opState || null);
}

export function applyDashboardSummary(summary) {
    const inbox = summary.inbox || {};
    const library = summary.library || {};
    const pending = summary.pending || {};
    text('[data-dash="cached-mails"]', fmtInt(inbox.total));
    text('[data-dash="cached-range"]', inbox.earliestMonth && inbox.latestMonth ? `${inbox.earliestMonth} 至 ${inbox.latestMonth}` : '暂无本地缓存');
    text('[data-dash="recognized"]', fmtInt(library.recognized));
    // COPY-03：首页「识别失败」只绑真正的 failed，不含信息不完整。
    text('[data-dash="failed"]', fmtInt(library.failed));
    text('[data-dash="ignored"]', fmtInt(library.ignored));
    const ocrGroups = library.ocr?.byDocumentType || [];
    const groupCount = (key) => ocrGroups.find((group) => group.key === key)?.count || 0;
    text('[data-dash="invoice-like"]', fmtInt(Math.max(0, groupCount('invoice') || library.invoiceLike || 0)));
    text('[data-dash="itinerary"]', fmtInt(groupCount('itinerary') || library.itinerary || 0));
    text('[data-dash="supporting"]', fmtInt(groupCount('supporting') || library.supporting || 0));
    text('[data-dash="pending-total"]', `${fmtInt(pending.total)} 封`);
}

export function applyHistory(history) {
    const mount = document.querySelector('[data-run-history]');
    if (!mount) return;
    mount.innerHTML = history.slice(0, 6).map((item) => {
        const kind = item.status === 'success' ? 'ok' : item.status === 'partial' ? 'warn' : 'err';
        const label = item.status === 'success' ? '成功' : item.status === 'partial' ? '部分成功' : '失败';
        return `
                <div class="history-item history-item--${kind}">
                    <div class="row row--between mb-12">
                        <span class="mono small strong">${escapeHtml(historyTime(item.time))}</span>
                        ${pill(label, kind)}
                    </div>
                    <div class="small muted">${escapeHtml(item.title || '本地操作')}</div>
                    <div class="mono small muted mt-12">${escapeHtml(item.message || '已记录')} ${item.durationMs ? `· ${escapeHtml(fmtDuration(item.durationMs))}` : ''}</div>
                </div>
            `;
    }).join('') || `
                <div class="empty empty--compact">
                    <div class="empty__title">还没有运行记录</div>
                    <div class="empty__sub">点击「获取邮件」或「开始识别」后，这里会显示真实结果。</div>
                </div>
            `;
    const total = document.querySelector('[data-history-total]');
    if (total) total.textContent = `${fmtInt(history.length)} 条记录`;
}

/* ---------- "本次抓取" is scoped to the batch the backend just returned ---------- */
export function setCurrentBatch(result) {
    const rows = result?.batch?.rows ?? result?.batchRows ?? result?.newRows ?? null;
    const total = result?.batch?.total ?? result?.batchTotal ?? (Array.isArray(rows) ? rows.length : undefined);
    getState().currentBatch = Array.isArray(rows)
        ? { rows, total: Number(total ?? rows.length), known: true }
        : { rows: [], total: Number(total ?? 0), known: total !== undefined };
    renderCurrentBatch();
}

export function renderCurrentBatch() {
    const tbody = document.querySelector('[data-current-batch-rows]');
    if (!tbody) return;
    const batch = getState().currentBatch;
    const note = document.querySelector('[data-current-batch-note]');
    if (!batch) {
        tbody.innerHTML = '<tr><td colspan="7" class="muted">本次还没有运行。点击「获取邮件」后，这里只显示这一次新保存的邮件。</td></tr>';
        if (note) note.textContent = '只显示最近一次运行新增的邮件，不是全部本地缓存。';
        return;
    }
    if (!batch.known) {
        tbody.innerHTML = '<tr><td colspan="7" class="muted">本次运行没有返回明细，请到「邮件记录」查看全部本地缓存邮件。</td></tr>';
        if (note) note.textContent = '本次运行没有返回逐封明细。';
        return;
    }
    tbody.innerHTML = batch.rows.map((row, index) => `
            <tr>
                <td class="faint">${String(index + 1).padStart(2, '0')}</td>
                <td class="mono">${fmtDateTime(row.date)}</td>
                <td>${escapeHtml(row.subject || '无主题')}</td>
                <td class="small">${escapeHtml(shortSender(row.from))}</td>
                <td class="mono col-num">${row.hasAttachment ? '有' : '-'}</td>
                <td class="mono col-num">${fmtInt(row.bodyLinkCount)}</td>
                <td>${pill('本次新增', 'ok')}</td>
            </tr>
        `).join('') || '<tr><td colspan="7" class="muted">本次运行没有新增邮件（命中的邮件此前已经保存过）。</td></tr>';
    if (note) {
        note.textContent = batch.total > batch.rows.length
            ? `本次新增 ${fmtInt(batch.total)} 封，下面列出前 ${fmtInt(batch.rows.length)} 封。完整列表见「邮件记录」。`
            : `本次新增 ${fmtInt(batch.total)} 封。`;
    }
}

export function applyInboxSummary(inbox) {
    text('[data-inbox="total"]', fmtInt(inbox.total));
    text('[data-inbox="with-attachment"]', fmtInt(inbox.withAttachment));
    text('[data-inbox="with-links"]', fmtInt(inbox.withLinks));
    text('[data-inbox="earliest"]', inbox.earliestMonth || '暂无');
    const total = Number(inbox.total || 0);
    const pct = (n) => total > 0 ? `占比 ${Math.round((Number(n || 0) / total) * 100)}%` : '占比 —';
    text('[data-inbox-delta="attachment"]', pct(inbox.withAttachment));
    text('[data-inbox-delta="links"]', pct(inbox.withLinks));
    mergeSection('inbox', inbox);
    renderInboxRows();
}

export function applyLibrarySummary(library) {
    // data-lib="pending" = 待识别；data-lib="total" = 发票库总记录 (FE-03).
    text('[data-lib="pending"]', fmtInt(library.pending));
    text('[data-lib="total"]', fmtInt(library.total || 0));
    text('[data-lib="recognized"]', fmtInt(library.recognized));
    text('[data-lib="ignored"]', fmtInt(library.ignored));
    text('[data-lib="failed"]', fmtInt(library.failed));
    text('[data-lib="invoice-like"]', fmtInt(library.invoiceLike));
    text('[data-lib="itinerary"]', fmtInt(library.itinerary));
    text('[data-lib="supporting"]', fmtInt(library.supporting));

    mergeSection('library', library);
    renderLibraryRows();
    updateSellerOptions(getState().libraryRows || []);
}


