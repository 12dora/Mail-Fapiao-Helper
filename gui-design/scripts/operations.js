import { loadBridgeConfig, loadBridgeSummary } from './bridge.js';
import { bridgeUnavailable } from './bridge-base.js';
import { applyFieldErrors, refreshArchiveJournalStatus, showConfigError } from './config-view.js';
import { activeMain, announce, checkedBySelector, isChecked } from './dom.js';
import { copyText, exportPendingTechTable, exportVisibleLog, exportVisibleTable } from './exports.js';
import { applyNormalizedFilter } from './filters.js';
import { fmtInt } from './formatters.js';
import { applyOpState, beginLocalMutexLock, endLocalMutexLock, ocrJobRunning } from './op-state.js';
import { handlePendingAction } from './pending-actions.js';
import { rowCategory, rowNextStep } from './pending-view.js';
import { applyFileProgress, applyOcrProgress, resetFileProgress, resetOcrProgress, setOcrControlState } from './progress.js';
import { loadMoreRows, renderInboxRows, renderLibraryRows } from './records.js';
import { eventDetail, eventMessage, sanitizeText, supportRef } from './redaction.js';
import { showPage } from './router.js';
import { getState } from './state.js';
import { applySummary, setCurrentBatch } from './summary.js';
import { showToast } from './toast.js';
import { clearSecret, reloadMailboxes, repairConfig, saveConfigChecked, testConnection } from './config-actions.js';

export async function quarantineArchiveJournal() {
    const panel = document.querySelector('[data-archive-journal-panel]');
    const statusEl = panel?.querySelector('[data-archive-journal-status]');
    const fn = window.mfhBridge?.archiveJournalQuarantine;
    if (typeof fn !== 'function') {
        bridgeUnavailable();
        return;
    }
    const confirmed = window.confirm([
        '确认隔离未解决的归档恢复记录？',
        '',
        '隔离后可继续写入；记录会保留在数据目录的隔离副本中，请勿删除直至确认发票清单无误。',
    ].join('\n'));
    if (!confirmed) return;
    try {
        const result = await fn({ confirm: true });
        const ok = result && result.ok === true;
        if (statusEl) {
            statusEl.textContent = String(
                (result && result.message)
                || (ok ? '已隔离。' : '隔离未完成。')
            );
        }
        showToast(
            ok ? '归档恢复记录已隔离' : '隔离未完成',
            eventMessage(result) || (ok ? '记录已移到数据目录内的隔离副本，证据未删除。' : '请查看状态说明后重试。'),
            ok ? 'ok' : 'err',
            { detail: ok ? '' : eventDetail(result) },
        );
    } catch (err) {
        if (statusEl) statusEl.textContent = '隔离失败，请确认磁盘可写后重试。';
        showToast('隔离失败', '请确认磁盘可写后重试。', 'err', { detail: err?.message });
    }
    await refreshArchiveJournalStatus();
}

export function wireSearch() {
    document.querySelector('[data-global-search]')?.addEventListener('keydown', async (event) => {
        if (event.key !== 'Enter') return;
        const q = String(event.currentTarget.value || '').trim();
        if (!q) return;
        // Honor current page: searching from inbox should filter inbox, not jump to library.
        const currentPage = document.body.dataset.page;
        const targetPage = currentPage === 'inbox' ? 'inbox' : 'library';
        await showPage(targetPage);
        const selector = targetPage === 'inbox' ? '[data-search="inbox"]' : '[data-search="library"]';
        const input = document.querySelector(`main.main:not([style*="display: none"]) ${selector}`);
        if (input) {
            input.value = q;
            if (targetPage === 'inbox') renderInboxRows();
            else renderLibraryRows();
            announce(`已在${targetPage === 'inbox' ? '邮件记录' : '发票库'}的已加载记录中搜索「${q}」`);
        }
    });
    document.addEventListener('keydown', (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
            const input = document.querySelector('[data-global-search]');
            if (!input) return;
            event.preventDefault();
            input.focus();
            input.select?.();
        }
    });
    const params = new URLSearchParams(window.location.search);
    const q = params.get('q');
    if (q) {
        const input = document.querySelector('[data-search="library"], [data-search="inbox"]');
        if (input) {
            input.value = q;
            window.setTimeout(() => {
                renderLibraryRows();
                renderInboxRows();
            }, 0);
        }
    }
}

// Async-button guard: prevents double-clicks and shows a "正在…" label while awaiting.
export const BUSY_ACTIONS = new Set([
    'test-connection',
    'reload-mailboxes',
    'developer-reset',
    'clear-secret',
    'rename-organize',
    'run-pipeline',
    'rerun-pipeline',
    'pending-primary',
    'discard-config',
    'ocr-toggle',
    'load-more',
    'repair-config',
]);
export const BUSY_LABELS = {
    'test-connection': '正在连接邮箱…',
    'reload-mailboxes': '正在读取…',
    'developer-reset': '正在删除…',
    'clear-secret': '正在清除…',
    'rename-organize': '正在改名…',
    'run-pipeline': '正在获取…',
    'rerun-pipeline': '正在重新获取…',
    'pending-primary': '处理中…',
    'discard-config': '正在读取…',
    'load-more': '正在加载…',
    'repair-config': '正在重建…',
};

export async function withBusyButton(button, runner) {
    if (button.dataset.busy === 'true') return undefined;
    const original = button.innerHTML;
    const wasDisabled = button.disabled;
    const isOcrToggle = button.dataset.action === 'ocr-toggle';
    button.dataset.busy = 'true';
    button.disabled = true;
    const label = BUSY_LABELS[button.dataset.action];
    if (label) button.textContent = label;
    try {
        return await runner();
    } finally {
        button.dataset.busy = '';
        // For ocr-toggle, setOcrControlState / stopOcr own the label and disabled state
        // for the full lifecycle of the OCR run, so don't restore here.
        if (!isOcrToggle) {
            button.disabled = wasDisabled;
            button.innerHTML = original;
        }
    }
}

export const MUTEX_ACTIONS = new Set(['run-pipeline', 'rerun-pipeline', 'ocr-toggle', 'rename-organize']);

export async function handleAction(action) {
    const name = action.dataset.action;
    // FE-08: lock every mutex start entry before any await/IPC.
    const needsMutex = MUTEX_ACTIONS.has(name)
        && !(name === 'ocr-toggle' && (action.dataset.ocrMode === 'stop' || action.dataset.ocrMode === 'stopping'));
    if (needsMutex) beginLocalMutexLock(name);
    try {
        if (BUSY_ACTIONS.has(name)) {
            // For pending-primary, also lock peer buttons so users can't fire on multiple rows.
            const peers = name === 'pending-primary'
                ? Array.from(document.querySelectorAll('[data-action="pending-primary"]')).filter((el) => el !== action)
                : [];
            const peerStates = peers.map((el) => ({ el, wasDisabled: el.disabled }));
            for (const { el } of peerStates) el.disabled = true;
            try {
                return await withBusyButton(action, () => handleActionImpl(action, name));
            } finally {
                for (const { el, wasDisabled } of peerStates) el.disabled = wasDisabled;
            }
        }
        return await handleActionImpl(action, name);
    } finally {
        if (needsMutex) endLocalMutexLock();
    }
}

const ACTION_HANDLERS = {
    'reload-summary': async () => {
        // FE-04：摘要读取失败时不追加成功提示。
        const ok = await loadBridgeSummary();
        if (ok) showToast('已刷新', '本地列表已重新读取。');
    },
    'preview-fetch': async () => { showFetchPreview(); },
    'export-log': async () => { exportVisibleLog(); },
    'export-table': async (action) => { exportVisibleTable(action); },
    'load-more': async (action) => { await loadMoreRows(action.dataset.loadKind || 'inbox', action); },
    'copy-diagnostics': async (action) => { await copyPendingDiagnostics(action.dataset.hash || ''); },
    'export-pending-tech': async () => { exportPendingTechTable(); },
    // ELEC-06：目录打开只传符号 location，绝不把 get-config 的路径展示串交给 open-path。
    'open-invoices-folder': async () => { await openConfiguredPath('invoices'); },
    'open-pending-folder': async () => { await openConfiguredPath('pending'); },
    'open-samples-folder': async () => { await openConfiguredPath('samples'); },
    'open-row-file': async (action) => { await openRowFile(action); },
    'ocr-toggle': async (action) => { await handleOcrToggle(action); },
    'rename-organize': async () => {
        const fn = window.mfhBridge?.organize;
        if (!fn) { bridgeUnavailable(); return; }
        const result = await fn({ applyRename: true });
        if (result?.summary) applySummary(result.summary);
        const empty = typeof result?.message === 'string' && result.message.includes('目前没有可整理');
        const kind = result?.ok ? (empty ? 'warn' : 'ok') : 'err';
        const title = result?.ok ? (empty ? '没有可整理的识别结果' : '改名完成') : '运行失败';
        const okFallback = '已按当前规则改名并整理输出。';
        showToast(title, eventMessage(result) || (result?.ok ? okFallback : '请查看最近运行记录。'), kind, {
            detail: result?.ok ? '' : eventDetail(result),
        });
    },
    'run-pipeline': async () => { await runBridgeAction('runPipeline', { avoidConflictBeforeOcr: downloadRenameEnabled(), force: false }, '获取完成', '已从本地邮件中获取发票文件。'); },
    'rerun-pipeline': async () => {
        const confirmed = window.confirm('重新获取发票文件会忽略已处理标记，重新跑一遍所有邮件。确认继续吗？');
        if (!confirmed) return;
        await runBridgeAction('runPipeline', { avoidConflictBeforeOcr: downloadRenameEnabled(), force: true }, '重新获取完成', '已重新获取本地邮件中的发票文件。');
    },
    'test-connection': async () => { await testConnection(); },
    'reload-mailboxes': async () => { await reloadMailboxes(); },
    'discard-config': async () => {
        const hasPending = window.MFH_CONFIG_HAS_PENDING_SAVE?.() === true;
        if (hasPending && !window.confirm('当前还有未保存的改动，重新读取后会被丢弃。确认继续吗？')) {
            return;
        }
        // FE-02: cancel supersedes queued writes and waits for in-flight ones.
        if (typeof window.MFH_CONFIG_CANCEL_PENDING_SAVE === 'function') {
            try { await window.MFH_CONFIG_CANCEL_PENDING_SAVE(); } catch { /* already surfaced */ }
        }
        // FE-04：配置读取失败时不追加成功提示。
        const ok = await loadBridgeConfig();
        // Clear any lingering invalid markers since values just came from disk.
        document.querySelectorAll('[data-config].is-invalid').forEach((el) => el.classList.remove('is-invalid'));
        if (ok) showToast('已重新读取配置', '已从本机恢复最新配置。');
        else showToast('读取失败', '无法从本机恢复配置，请检查配置文件后重试。', 'err');
    },
    'repair-config': async () => { await repairConfig(); },
    'developer-reset': async () => { await developerReset(); },
    'pending-primary': async (action) => { await handlePendingAction(action, runBridgeAction); },
    'clear-secret': async (action) => { await clearSecret(action); },
    'archive-journal-refresh': async () => { await refreshArchiveJournalStatus(); },
    'archive-journal-quarantine': async () => { await quarantineArchiveJournal(); },
};

export async function handleActionImpl(action, name) {
    const handler = ACTION_HANDLERS[name];
    if (handler) await handler(action);
}

export function selectedOcrConcurrency() {
    const scope = activeMain();
    const value = Number(scope.querySelector('[data-ocr-parallel]')?.value || 1);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

export function downloadRenameEnabled() {
    const el = activeMain().querySelector('[data-download-rename-toggle]');
    return el ? isChecked(el) : true;
}

export async function handleOcrToggle(action) {
    const mode = action.dataset.ocrMode || 'start';
    if (mode === 'stop') {
        await stopOcr();
        return;
    }
    if (mode === 'rerun') {
        const confirmed = window.confirm('重新识别会删除已有识别结果，并把发票队列重置为待识别。确认继续吗？');
        if (!confirmed) {
            // withBusyButton skips the disabled restore for ocr-toggle, so reset here.
            setOcrControlState('idle');
            return;
        }
        await runOcr(true);
        return;
    }
    if (mode === 'stopping') {
        // Already requested a stop; ignore stacked clicks.
        return;
    }
    await runOcr(false);
}

export async function runOcr(force) {
    await runBridgeAction('runOcr', {
        force: Boolean(force),
        resetResults: Boolean(force),
        concurrency: selectedOcrConcurrency(),
    }, '识别完成', '已尝试识别本地文件。');
}

export async function stopOcr() {
    const fn = window.mfhBridge?.stopOcr;
    if (!fn) { bridgeUnavailable(); return; }
    document.querySelectorAll('[data-action="ocr-toggle"]').forEach((el) => {
        el.disabled = true;
        el.dataset.ocrMode = 'stopping';
        el.textContent = '正在停止…';
    });
    // Establish the fallback BEFORE awaiting so a rejected IPC cannot jam the button (FE-07).
    window.clearTimeout(getState()?._stopOcrFallback);
    const timer = window.setTimeout(async () => {
        try {
            const read = window.mfhBridge?.getOpState;
            if (typeof read === 'function') {
                const state = await read();
                getState().opState = state?.running || null;
                getState().opStateSync = 'ok';
                applyOpState(getState().opState);
                if (getState().opState?.kind === 'ocr') {
                    document.querySelectorAll('[data-action="ocr-toggle"]').forEach((el) => {
                        el.disabled = false;
                        el.dataset.ocrMode = 'stop';
                        el.textContent = '再次尝试停止';
                    });
                    return;
                }
            }
        } catch { /* fall through to idle restore */ }
        setOcrControlState(ocrJobRunning() ? 'running' : 'idle');
        applyOpState(getState().opState || null);
    }, 5000);
    if (getState()) getState()._stopOcrFallback = timer;
    try {
        const result = await fn();
        if (!result?.ok) {
            window.clearTimeout(getState()?._stopOcrFallback);
            if (getState()) getState()._stopOcrFallback = 0;
            setOcrControlState(ocrJobRunning() ? 'running' : 'idle');
            applyOpState(getState().opState || null);
        }
        showToast(
            result?.ok ? '正在停止识别' : '停止失败',
            eventMessage(result) || (result?.ok ? '已经发出停止指令，正在等待引擎退出。' : '没能停止识别，请稍后重试。'),
            result?.ok ? 'warn' : 'err',
            { detail: result?.ok ? '' : eventDetail(result), scope: result?.ok ? 'page' : 'global' },
        );
    } catch (err) {
        window.clearTimeout(getState()?._stopOcrFallback);
        if (getState()) getState()._stopOcrFallback = 0;
        try {
            const read = window.mfhBridge?.getOpState;
            if (typeof read === 'function') {
                const state = await read();
                getState().opState = state?.running || null;
                getState().opStateSync = 'ok';
            }
        } catch { /* keep previous opState */ }
        setOcrControlState(ocrJobRunning() ? 'running' : 'idle');
        applyOpState(getState().opState || null);
        showToast('停止失败', '没能停止识别，请稍后重试。', 'err', {
            scope: 'global',
            detail: err?.message,
        });
    }
}

export function persistConfigCheck(key, value) {
    const fn = window.mfhBridge?.saveConfig;
    if (!fn) return; // Static preview: no-op rather than nag with a toast.
    const parts = String(key || '').split('.').filter(Boolean);
    if (parts.length === 0) return;
    const patch = {};
    let cur = patch;
    for (let i = 0; i < parts.length - 1; i++) {
        cur[parts[i]] = {};
        cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
    Promise.resolve(fn(patch)).then((result) => {
        if (result && result.ok === false) {
            if (result.configError) showConfigError(result.configError);
            else applyFieldErrors(result.fieldErrors);
            showToast('这项设置没有保存', eventMessage(result) || '请到「邮箱与保存」页检查设置。', 'err');
        }
    }).catch((err) => {
        showToast('保存失败', '这项设置没有写入本机，请稍后重试。', 'err', { detail: err?.message });
    });
}

/**
 * 操作终态三态（簇 C / FE-01）：success | partial | failure。
 * 仅当主进程明确 started:false（或 confirmed rollback）时才说「本地数据没有变化」。
 */
export function terminalKindFromResult(result) {
    if (!result) return 'err';
    if (result.status === 'partial' || result.kind === 'warn') return 'warn';
    if (result.ok === true || result.status === 'success') return 'ok';
    return 'err';
}

export function terminalTitles(method, kind, okTitle) {
    if (kind === 'ok') return okTitle;
    if (kind === 'warn') {
        if (method === 'runOcr') return '识别部分完成';
        if (method === 'runPipeline') return '部分完成';
        return '部分完成';
    }
    if (method === 'runOcr') return '识别失败';
    if (method === 'runPipeline') return '处理未完成';
    return '运行失败';
}

export async function runBridgeAction(method, payload, okTitle, okMessage) {
    const fn = window.mfhBridge?.[method];
    if (!fn) { bridgeUnavailable(); return; }
    if (method === 'runOcr') resetOcrProgress();
    if (method === 'runPipeline') resetFileProgress();
    let result;
    try {
        result = await fn(payload);
    } catch (err) {
        // 抛错时无法确认 CLI 是否已提交：不谎称「本地数据没有变化」，除非明确 started:false。
        const failMessage = '操作没有完成。请刷新列表确认结果后重试。';
        if (method === 'runOcr') {
            applyOcrProgress({
                phase: '识别失败',
                percent: 100,
                total: 0,
                processed: 0,
                parsed: 0,
                skipped: 0,
                failed: 0,
                message: failMessage,
                kind: 'err',
                done: true,
            });
        }
        if (method === 'runPipeline') {
            applyFileProgress({
                phase: '获取失败',
                percent: 100,
                message: failMessage,
                kind: 'err',
                done: true,
            });
        }
        showToast('运行失败', failMessage, 'err', { detail: err?.message, scope: 'global' });
        return;
    }
    if (result?.summary) applySummary(result.summary);
    else if (result?.summaryUnavailable) {
        // 操作可能已提交，仅列表刷新失败。
        showToast('列表未刷新', '操作可能已完成，但本地列表暂时读不到。请点击「刷新列表」。', 'warn');
    }
    if (result?.normalizedFilter) applyNormalizedFilter(result.normalizedFilter);
    if (method === 'runPipeline') setCurrentBatch(result);
    const readable = eventMessage(result);
    const detail = eventDetail(result);
    const kind = terminalKindFromResult(result);
    const started = result?.started;
    // 仅当主进程明确报告未启动时，才说本地数据没有变化。
    const noLocalChange = started === false;
    if (method === 'runOcr' && kind === 'err' && !result?.summary) {
        applyOcrProgress({
            phase: '识别失败',
            percent: 100,
            message: readable
                || (noLocalChange ? '操作没有启动，本地数据没有变化。' : '识别失败，请查看诊断信息。'),
            kind: 'err',
            done: true,
        });
    }
    if (method === 'runPipeline' && kind === 'err' && !result?.summary) {
        applyFileProgress({
            phase: '获取失败',
            percent: 100,
            message: readable
                || (noLocalChange ? '操作没有启动，本地数据没有变化。' : '获取发票文件失败，请查看诊断信息。'),
            kind: 'err',
            done: true,
        });
    }
    const title = terminalTitles(method, kind, okTitle);
    const body = kind === 'ok'
        ? (readable || okMessage)
        : kind === 'warn'
            ? (readable || '部分项目已完成，请查看失败项后重试。')
            : (readable || (noLocalChange
                ? '操作没有启动，本地数据没有变化。'
                : '操作没有完成。展开诊断信息可以查看技术细节。'));
    // FE-01 / COPY-01：只有真正 success 才用绿色成功 toast。
    showToast(title, body, kind, {
        detail: kind === 'ok' ? (result?.warning || '') : detail,
        scope: 'global',
    });
    if (kind === 'ok' && result?.warning) {
        showToast('提醒', result.warning, 'warn');
    }
}

/**
 * Open a configured directory by symbolic location key only.
 * Main maps location → real path; renderer never sends absolute paths.
 * @param {'invoices'|'pending'|'samples'|'organized'|'dataDir'|'ledger'} location
 */
export async function openConfiguredPath(location) {
    if (!window.mfhBridge?.openPath) { bridgeUnavailable(); return; }
    const result = await window.mfhBridge.openPath({ location });
    showToast(
        result?.ok ? '已打开文件夹' : '打开失败',
        result?.ok ? '已在系统文件管理器中打开。' : '无法打开这个文件夹，请确认它仍然存在。',
        result?.ok ? 'ok' : 'err',
        { detail: result?.ok ? '' : eventDetail(result) },
    );
}

/**
 * Open a library row file. `data-file-path` holds the summary-issued handle
 * or dataDir-relative path (never a raw absolute OS path).
 * Prefer `{ handle }` for opaque `ext:…` refs; otherwise pass as `path`.
 */
export async function openRowFile(action) {
    const value = action.dataset.filePath || '';
    if (!value) {
        showToast('打开失败', '这条记录没有对应文件路径，请先归档源文件。', 'err');
        return;
    }
    if (!window.mfhBridge?.openPath) { bridgeUnavailable(); return; }
    const payload = value.startsWith('ext:')
        ? { handle: value, reveal: true }
        : { path: value, reveal: true };
    const result = await window.mfhBridge.openPath(payload);
    showToast(
        result?.ok ? '已打开文件位置' : '打开失败',
        result?.ok ? '已定位到对应文件。' : '无法定位这个文件，它可能已经被移动或删除。',
        result?.ok ? 'ok' : 'err',
        { detail: result?.ok ? '' : eventDetail(result) },
    );
}

/* Diagnostics are always redacted before they reach the clipboard. */
export async function copyPendingDiagnostics(hash) {
    const groups = getState().pending?.groups || [];
    let found = null;
    let owner = null;
    for (const group of groups) {
        const row = (group.rows || []).find((item) => String(item.hash || '') === String(hash));
        if (row) { found = row; owner = group; break; }
    }
    if (!found) { showToast('没有找到这条记录', '请先点击“刷新列表”。', 'warn'); return; }
    const lines = [
        `支持编号：${supportRef(found.hash)}`,
        `分类：${rowCategory(found)}`,
        `下一步：${rowNextStep(found, owner)}`,
        `主题：${found.subject || '无主题'}`,
        `日期：${(found.date || '').slice(0, 10)}`,
        `原因：${sanitizeText(found.reason || '未记录')}`,
    ];
    await copyText(lines.join('\n'), '诊断信息');
}

export async function developerReset() {
    const first = window.confirm([
        '清空应用管理的数据（保留邮箱与保存设置）',
        '',
        '会永久删除应用内部保存的邮件、发票和行程单、待确认记录、识别结果及处理记录。',
        '',
        '邮箱与保存设置不会删除；你另选文件夹中的文件也不会删除。',
        '',
        '删除后不能撤销。确认继续吗？',
    ].join('\n'));
    if (!first) return;
    const second = window.confirm('再次确认：已归档的发票原件会被删除。请先自行备份需要保留的文件。确定要删除吗？');
    if (!second) return;
    if (!window.mfhBridge?.developerReset) { bridgeUnavailable(); return; }
    const result = await window.mfhBridge.developerReset();
    if (result?.summary) applySummary(result.summary);
    // Reset only touches paths inside the app-managed data directory.
    const skipped = Array.isArray(result?.skippedExternal) ? result.skippedExternal : [];
    const removedCount = fmtInt(result?.removed?.length || 0);
    const sub = skipped.length > 0
        ? `已删除 ${removedCount} 个应用管理的位置。有 ${fmtInt(skipped.length)} 个位置保存在应用目录之外，没有被删除，需要你自行处理。`
        : `已删除 ${removedCount} 个应用管理的位置。邮箱与保存设置已保留。`;
    showToast('仅重置了应用管理的数据', sub, skipped.length > 0 ? 'warn' : 'ok', {
        detail: skipped.length > 0 ? `未删除的外部位置：\n${skipped.map((item) => sanitizeText(item)).join('\n')}` : '',
        sticky: skipped.length > 0,
        scope: 'global',
    });
}

export function showFetchPreview() {
    const from = document.getElementById('date-from')?.value || '开始日期';
    const to = document.getElementById('date-to')?.value || '结束日期';
    const matchSubject = checkedBySelector('[data-fetch-check="matchSubject"]');
    const matchBody = checkedBySelector('[data-fetch-check="matchBody"]');
    const dryRun = checkedBySelector('[data-fetch-check="dryRun"]');
    const cfg = getState().configPayload?.config || {};
    const keywords = Array.isArray(cfg.filter?.keywords) && cfg.filter.keywords.length > 0
        ? cfg.filter.keywords.join('、')
        : '发票';
    const mailboxes = Array.isArray(cfg.imap?.mailbox) && cfg.imap.mailbox.length > 0
        ? cfg.imap.mailbox.join('、')
        : '所有文件夹';
    const matchParts = [];
    if (matchSubject) matchParts.push('主题');
    if (matchBody) matchParts.push('正文');
    if (matchParts.length === 0) {
        showToast('还不能运行', '“匹配主题”和“匹配正文”至少要选一个，否则不会命中任何邮件。', 'warn');
        return;
    }
    const matchText = matchParts.join(' + ');
    const lines = [
        `日期：${from} 至 ${to}（按本机日历日，含起止当天全天）`,
        `关键词：${keywords}`,
        `匹配范围：${matchText}`,
        `邮箱文件夹：${mailboxes}`,
        dryRun ? '模式：只预览，不保存原件' : '模式：保存命中邮件到本机',
    ];
    showToast('操作预览', lines.join(' · '), 'ok', { duration: 6000 });
}

