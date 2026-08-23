import { setOcrControlState } from './progress.js';
import { getState } from './state.js';
import { showToast } from './toast.js';

/* ---------- Mutually exclusive operations (contract: 'op-state') ---------- */
export const MUTEX_GROUPS = [
    { kind: 'fetch',    selector: '#run-btn' },
    { kind: 'pipeline', selector: '[data-action="run-pipeline"], [data-action="rerun-pipeline"]' },
    { kind: 'ocr',      selector: '[data-action="ocr-toggle"]' },
    { kind: 'organize', selector: '[data-action="rename-organize"]' },
];
export const MUTEX_ALL_SELECTORS = MUTEX_GROUPS.map((g) => g.selector).join(', ');

export function setOpStateBanner(message) {
    let banner = document.getElementById('mfh-op-state-banner');
    if (!message) {
        if (banner) banner.remove();
        return;
    }
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'mfh-op-state-banner';
        banner.className = 'op-state-banner';
        banner.setAttribute('role', 'alert');
        // NEW-DEFECT 2: never prepend into the two-column `.app` grid — that
        // shifts sidebar/main into the wrong cells. Host on body as fixed.
        document.body.appendChild(banner);
    }
    banner.replaceChildren();
    const textEl = document.createElement('span');
    textEl.textContent = message;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn btn--sm';
    retry.textContent = '重新确认任务状态';
    retry.addEventListener('click', () => { wireOpState({ force: true }); });
    banner.append(textEl, retry);
}

export async function wireOpState(opts = {}) {
    const subscribe = window.mfhBridge?.onOpState;
    if (typeof subscribe === 'function' && !getState()._opStateSubscribed) {
        getState()._opStateSubscribed = true;
        subscribe((payload) => {
            const running = payload?.running || null;
            getState().opState = running;
            getState().opStateSync = 'ok';
            setOpStateBanner('');
            applyOpState(running);
        });
    }
    // Subscribing only sees FUTURE transitions. Ask for the current state so
    // a window opened mid-run does not render idle controls (FB-01).
    const read = window.mfhBridge?.getOpState;
    if (typeof read !== 'function') {
        // FE-13: only a wholly absent bridge (static HTML preview) may
        // degrade to idle. An installed desktop bridge without getOpState
        // is an incompatible preload — keep long-task entry points locked.
        if (!window.mfhBridge) {
            getState().opStateSync = 'ok';
            getState().opState = getState().opState || null;
            setOpStateBanner('');
            applyOpState(getState().opState);
            return;
        }
        getState().opStateSync = 'error';
        getState().opState = getState().opState || null;
        setOpStateBanner('当前版本无法确认任务状态。长任务入口已锁定，请重新打开应用或更新到最新版本。');
        applyOpState(getState().opState);
        return;
    }
    // Until the first successful read completes, treat long-running entry
    // points as locked so a mid-run window cannot double-submit (FE-13).
    if (getState().opStateSync !== 'ok' || opts.force) {
        getState().opStateSync = 'pending';
        applyOpState(getState().opState || null);
    }
    try {
        const state = await read();
        getState().opState = state?.running || null;
        getState().opStateSync = 'ok';
        setOpStateBanner('');
        applyOpState(getState().opState);
    } catch (err) {
        getState().opStateSync = 'error';
        setOpStateBanner('无法确认当前是否有任务在运行。长任务入口已暂时锁定，请重试或重启应用。');
        applyOpState(getState().opState || null);
        if (opts.force) {
            showToast('无法确认任务状态', '请重试；若持续失败，请重新打开应用。', 'err', {
                scope: 'global',
                detail: err?.message,
            });
        }
    }
}

/* FE-08: lock every mutex start entry synchronously before IPC; clear when
   the local runner finishes. Authoritative op-state still re-locks if a job
   is actually running. */
export function beginLocalMutexLock(kind) {
    getState().localMutexLock = kind || 'busy';
    applyOpState(getState().opState || null);
}
export function endLocalMutexLock() {
    getState().localMutexLock = null;
    applyOpState(getState().opState || null);
}

export function applyOpState(running) {
    const sync = getState().opStateSync || 'pending';
    const busyKind = running?.kind || '';
    const localLock = getState().localMutexLock || null;
    // Sync OCR labels first so we can keep the stop control available.
    if (busyKind === 'ocr') setOcrControlState('running');
    else if (sync === 'ok' && !busyKind && !localLock) setOcrControlState('idle');

    const lockAllStarts = sync !== 'ok' || Boolean(busyKind) || Boolean(localLock);
    for (const group of MUTEX_GROUPS) {
        document.querySelectorAll(group.selector).forEach((el) => {
            const allowOcrStop = sync === 'ok'
                && busyKind === 'ocr'
                && !localLock
                && group.kind === 'ocr'
                && (el.dataset.ocrMode === 'stop' || el.dataset.ocrMode === 'stopping');
            if (lockAllStarts && !allowOcrStop) {
                el.disabled = true;
                el.dataset.opLocked = 'true';
                el.title = busyKind || localLock
                    ? '另一个任务正在运行，完成后可再操作。'
                    : (sync === 'error'
                        ? '无法确认任务状态，请重试或重新打开应用。'
                        : '正在确认任务状态，请稍候。');
            } else if (el.dataset.opLocked === 'true' || allowOcrStop) {
                if (allowOcrStop) {
                    el.disabled = el.dataset.ocrMode === 'stopping';
                    delete el.dataset.opLocked;
                    if (el.dataset.ocrMode !== 'stopping') el.removeAttribute('title');
                } else {
                    el.disabled = false;
                    delete el.dataset.opLocked;
                    el.removeAttribute('title');
                }
            }
        });
    }
    // Let the dashboard re-apply its own date-range validity after unlocking.
    if (sync === 'ok' && !busyKind && !localLock) window.MFH_DASHBOARD_REFRESH_RUN_BTN?.();
}

export function ocrJobRunning() {
    return getState().opState?.kind === 'ocr';
}

