import { activeMain } from './dom.js';
import { fmtDateTime, fmtInt } from './formatters.js';
import { actionText, rowUserMessage } from './pending-view.js';
import { selectVisibleInboxRows, selectVisibleLibraryRows } from './records.js';
import { sanitizeText, supportRef } from './redaction.js';
import { getState } from './state.js';
import { showToast } from './toast.js';

export async function copyText(value, label, opts = {}) {
    try {
        if (window.mfhBridge?.copyText) {
            await window.mfhBridge.copyText({ text: value });
        } else if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(value);
        } else {
            throw new Error('当前环境没有剪贴板权限');
        }
    } catch (err) {
        showToast('复制失败', '当前环境不允许写入剪贴板，请改用桌面版或检查权限。', 'err', { detail: err?.message });
        return false;
    }
    if (opts.silent) return true;
    const kind = opts.kind || 'ok';
    const title = opts.title || '已复制';
    const message = opts.message || (label ? `${label}已复制到剪贴板。` : '内容已复制到剪贴板。');
    showToast(title, message, kind);
    return true;
}

export function exportVisibleLog() {
    const scope = activeMain();
    const blocks = [
        { name: '获取邮件', el: scope.querySelector('#console-out') },
        { name: '获取发票文件', el: scope.querySelector('[data-file-log]') },
        { name: '识别发票文件', el: scope.querySelector('[data-ocr-log]') },
    ];
    const parts = blocks.map((block) => {
        if (!block.el) return '';
        const lines = Array.from(block.el.querySelectorAll('.console__line, .ocr-log__line'))
            // Skip placeholder lines (marked with data-placeholder) so the export only contains real run output.
            .filter((line) => !line.hasAttribute('data-placeholder'))
            .map((line) => line.textContent.trim())
            .filter(Boolean);
        if (lines.length === 0) return '';
        return `# ${block.name}\n${lines.join('\n')}`;
    }).filter(Boolean);
    // Redact before the log ever reaches the clipboard (URLs with tokens,
    // absolute local paths, full content hashes).
    const body = sanitizeText(parts.join('\n\n'));
    copyText(body ? `${body}\n\n（已移除链接参数、本机绝对路径和完整编号）` : '暂无实时日志', '运行日志');
}

export function tableSourceLabel() {
    const page = document.body.dataset.page;
    if (page === 'inbox') return '邮件记录';
    if (page === 'library') return '发票库';
    if (page === 'pending') return '待确认';
    return '当前表格';
}

/* Spreadsheet-safe CSV encoding (FE-05): quote fields and neutralize formula
   characters even when they appear after leading whitespace and/or quotes.
   Prefix the ENTIRE original value so Excel/Sheets treats it as text.
   Existing CSV quoting and embedded-quote doubling stay correct. */
export function csvSafeText(value) {
    const s = String(value ?? '');
    // Strip leading whitespace and ASCII/smart quotes only for the danger check;
    // the neutralization prefix is always applied to the full original string.
    // \u2018\u2019 = ‘’  \u201C\u201D = “”
    const stripped = s.replace(/^[\s'"`\u2018\u2019\u201C\u201D]+/, '');
    if (/^[=+\-@\t\r]/.test(stripped)) return `'${s}`;
    return s;
}
export function csvField(value) {
    return `"${csvSafeText(value).replace(/"/g, '""')}"`;
}

export function exportCoverageNote(exported, loaded, total) {
    const parts = [`已复制当前筛选结果 ${fmtInt(exported)} 条`];
    if (Number(loaded) < Number(total)) {
        parts.push(`仅含已加载的 ${fmtInt(loaded)} / ${fmtInt(total)} 条记录，未加载的内容未包含`);
    }
    return parts.join('。') + '。';
}

export function exportVisibleTable(action) {
    const scope = activeMain();
    const page = document.body.dataset.page;
    if (page === 'pending') {
        const groups = getState().pending?.groups || [];
        // COPY-13: default list is for reimbursement work, not support diagnostics.
        const lines = [['分类', '下一步', '邮件标题', '日期', '发件人', '原因说明'].map(csvField).join(',')];
        for (const group of groups) {
            const [primary] = actionText(group.action);
            for (const row of group.rows || []) {
                lines.push([
                    group.title || '',
                    primary || '',
                    row.subject || '',
                    (row.date || '').slice(0, 10),
                    row.from || '',
                    rowUserMessage(row, group),
                ].map(csvField).join(','));
            }
        }
        if (lines.length === 1) { showToast('没有可复制的内容', '当前待确认列表为空。', 'warn'); return; }
        copyText(lines.join('\n'), '待确认清单', {
            title: '已复制待确认清单',
            message: `共 ${fmtInt(lines.length - 1)} 条，可粘贴到 Excel。`,
        });
        return;
    }
    if (page === 'inbox') {
        const rows = selectVisibleInboxRows();
        const loaded = (getState().inboxRows || []).length;
        const total = Number(getState().inboxTotal ?? loaded);
        const lines = [['日期', '发件人', '邮件标题', '附件', '链接数', '邮箱'].map(csvField).join(',')];
        for (const row of rows) {
            lines.push([
                fmtDateTime(row.date),
                row.from || '',
                row.subject || '',
                row.hasAttachment ? '有' : '',
                Number(row.bodyLinkCount || 0),
                row.mailbox || '',
            ].map(csvField).join(','));
        }
        if (lines.length === 1) { showToast('没有可复制的内容', '当前筛选结果为空。', 'warn'); return; }
        copyText(lines.join('\n'), '邮件记录', {
            title: '已复制当前筛选结果',
            message: exportCoverageNote(rows.length, loaded, total),
            kind: loaded < total ? 'warn' : 'ok',
        });
        return;
    }
    if (page === 'library') {
        const rows = selectVisibleLibraryRows();
        const loaded = (getState().libraryRows || []).length;
        const total = Number(getState().libraryTotal ?? loaded);
        const lines = [['开票日期', '销售方', '发票号码', '金额', '文件名', '状态'].map(csvField).join(',')];
        for (const row of rows) {
            lines.push([
                (row.date || '').slice(0, 10),
                row.seller || '',
                row.invoiceNo || '',
                row.amount || '',
                row.filename || '',
                row.status || '',
            ].map(csvField).join(','));
        }
        if (lines.length === 1) { showToast('没有可复制的内容', '当前筛选结果为空。', 'warn'); return; }
        copyText(lines.join('\n'), '发票库', {
            title: '已复制当前筛选结果',
            message: exportCoverageNote(rows.length, loaded, total),
            kind: loaded < total ? 'warn' : 'ok',
        });
        return;
    }
    const table = action.closest('.card')?.querySelector('table') || scope.querySelector('table');
    if (!table) { showToast('没有可复制的表格', '当前页面没有表格内容。', 'warn'); return; }
    const csv = Array.from(table.querySelectorAll('tr')).map((tr) => (
        Array.from(tr.children).map((cell) => csvField(cell.textContent.trim())).join(',')
    )).join('\n');
    copyText(csv, `${tableSourceLabel()}`);
}

export function exportPendingTechTable() {
    const groups = getState().pending?.groups || [];
    const lines = [['分类', '邮件标题', '日期', '发件人', '支持编号', '诊断原因（已脱敏）'].map(csvField).join(',')];
    for (const group of groups) {
        for (const row of group.rows || []) {
            lines.push([
                group.title || '',
                row.subject || '',
                (row.date || '').slice(0, 10),
                row.from || '',
                supportRef(row.hash),
                sanitizeText(row.reason || ''),
            ].map(csvField).join(','));
        }
    }
    if (lines.length === 1) { showToast('没有可复制的内容', '当前待确认列表为空。', 'warn'); return; }
    copyText(lines.join('\n'), '待确认技术详情', {
        title: '已复制技术详情',
        message: `共 ${fmtInt(lines.length - 1)} 条诊断信息。`,
    });
}

