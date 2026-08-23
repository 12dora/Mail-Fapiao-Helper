import { bridgeUnavailable } from './bridge-base.js';
import { removePendingRowInPlace, showPendingTerminalState } from './pending-view.js';
import { eventDetail, eventMessage } from './redaction.js';
import { applySummary } from './summary.js';
import { showToast } from './toast.js';

/* Queue is empty after this operation: the summary must own the DOM so the
   real empty state renders (a preserved DOM would keep the stale group). */
export function pendingQueueEmptyAfter(result) {
    const total = result?.summary?.pending?.total;
    return Number.isFinite(Number(total)) && Number(total) === 0;
}

function showPendingResult(result, title, message, kind, detail) {
    showToast(title, eventMessage(result) || message, kind, { detail });
}

export async function retryPending(hash, runBridgeAction) {
    // CORE-09 / COPY-01：成功文案由主进程按真实结果给出；部分成功走 warn。
    await runBridgeAction('runPipeline', { onlyMail: hash }, '已重新处理', '这封邮件已重新处理。');
}

export async function refreshPendingLink(hash) {
    const fn = window.mfhBridge?.pendingRefreshLink;
    if (!fn) { bridgeUnavailable(); return; }
    const result = await fn({ hash });
    // COPY-05：按 opened / code 映射标题，绝不把「打开文件夹」说成「已打开原始邮件」。
    const opened = result?.opened || (result?.code === 'pending_mail_opened' || result?.code === 'pending_mail_revealed'
        ? 'mail'
        : result?.code === 'pending_mail_folder_opened'
            ? 'folder'
            : result?.ok ? 'folder' : 'none');
    let title;
    let kindToast;
    if (opened === 'mail' && result?.ok) {
        title = result.code === 'pending_mail_revealed' ? '已定位原始邮件' : '已打开原始邮件';
        kindToast = 'ok';
    } else if (opened === 'folder' && result?.ok) {
        title = '已打开已保存邮件文件夹';
        kindToast = 'warn';
    } else {
        title = '没有找到这封邮件';
        kindToast = 'err';
    }
    showPendingResult(
        result,
        title,
        kindToast === 'ok'
            ? '请到开票平台重新下载发票，然后回到这里选择文件归档。'
            : '本机缓存里找不到这封邮件，可以先刷新列表。',
        kindToast,
        kindToast === 'ok' ? '' : eventDetail(result),
    );
}

export async function ignorePending(hash) {
    const confirmed = window.confirm('确认把这封邮件从待确认队列中移除吗？原始邮件仍会保留在邮件缓存里。');
    if (!confirmed) return;
    const fn = window.mfhBridge?.pendingIgnore;
    if (!fn) { bridgeUnavailable(); return; }
    const result = await fn({ hash });
    // Update the affected row in place, then refresh counters without
    // rebuilding the whole list (keeps focus and expansion state).
    // When it was the last queued item, let the summary re-render and
    // show the real empty state instead.
    const emptied = pendingQueueEmptyAfter(result);
    const removed = result?.ok && !emptied ? removePendingRowInPlace(hash, '已从待确认队列中移除') : false;
    if (result?.summary) applySummary(result.summary, { preservePendingDom: removed });
    if (result?.ok && emptied) showPendingTerminalState('已从待确认队列中移除');
    showPendingResult(
        result,
        result?.ok ? '已忽略' : '忽略失败',
        result?.ok ? '这封邮件已从待确认队列移除，原始邮件仍保留在缓存里。' : '没能更新待确认队列，请重试。',
        result?.ok ? 'ok' : 'err',
        result?.ok ? '' : eventDetail(result),
    );
}

export async function manualArchivePending(hash) {
    const fn = window.mfhBridge?.pendingManualArchive;
    if (!fn) { bridgeUnavailable(); return; }
    const result = await fn({ hash });
    if (result?.canceled) {
        if (result?.summary) applySummary(result.summary);
        showToast('已取消归档', '没有选择文件，待确认队列保持不变。', 'warn');
        return;
    }
    const emptied = pendingQueueEmptyAfter(result);
    const pendingRemoved = Number(result?.pendingRemoved || 0);
    // COPY-04：只有 pending 行确实移除后才隐藏卡片。
    const removed = result?.ok && pendingRemoved > 0 && !emptied
        ? removePendingRowInPlace(hash, '已归档并移出待确认队列')
        : false;
    if (result?.summary) applySummary(result.summary, { preservePendingDom: removed });
    if (result?.ok && pendingRemoved > 0 && emptied) {
        showPendingTerminalState('已归档并移出待确认队列');
    }
    // COPY-18：全部已存在不是「归档失败」。
    const isDup = result?.code === 'manual_archive_all_duplicates';
    let title;
    let kindToast;
    if (result?.ok && pendingRemoved > 0) {
        title = '已归档';
        kindToast = 'ok';
    } else if (result?.ok && pendingRemoved === 0) {
        title = '文件已保存';
        kindToast = 'warn';
    } else if (isDup) {
        title = '没有新增文件';
        kindToast = 'warn';
    } else {
        title = '归档失败';
        kindToast = 'err';
    }
    showPendingResult(
        result,
        title,
        result?.ok && pendingRemoved > 0
            ? '文件已保存，并已从「待确认」移除。'
            : result?.ok
                ? '文件已保存，并会在下次识别时处理；但这封邮件仍在「待确认」中。请刷新列表后重试移除。'
                : isDup
                    ? '选择的文件都已经归档过了，没有新增内容。'
                    : '文件没有归档成功，待确认记录保持不变。',
        kindToast,
        kindToast === 'err' ? eventDetail(result) : '',
    );
}

const PENDING_ACTION_HANDLERS = {
    retry: retryPending,
    refresh_link: refreshPendingLink,
    ignore: ignorePending,
    manual_archive: manualArchivePending,
};

export async function handlePendingAction(action, runBridgeAction) {
    const kind = action.dataset.actionKind;
    const hash = action.dataset.hash || '';
    const handler = PENDING_ACTION_HANDLERS[kind || 'manual_archive'];
    if (handler) {
        await handler(hash, runBridgeAction);
        return;
    }
    // Unknown future action: refuse to fall back to manual archive (which would
    // surprise users by opening a file picker for an unrelated row).
    showToast('暂不支持该操作', '请升级到新版本后再处理这类邮件。', 'warn');
}
