import { applyConfig, clearConfigError, showConfigError } from './config-view.js';
import { applyFileProgress, applyOcrProgress } from './progress.js';
import { PAGE_SIZE, sectionCursor } from './records.js';
import { getState } from './state.js';
import { applySummary } from './summary.js';
import { showToast } from './toast.js';

export async function loadBridgeSummary() {
    if (!window.mfhBridge?.getSummary) return false;
    try {
        // Keep already-loaded pages when refreshing after navigation (FE-11):
        // request enough rows to cover the current cursor instead of offset=0 default.
        const inboxCursor = sectionCursor('inbox');
        const libraryCursor = sectionCursor('library');
        const args = {};
        if (inboxCursor > 0) {
            args.inboxOffset = 0;
            args.inboxLimit = Math.max(inboxCursor, Number(getState().inboxLimit || PAGE_SIZE) || PAGE_SIZE);
        }
        if (libraryCursor > 0) {
            args.libraryOffset = 0;
            args.libraryLimit = Math.max(libraryCursor, Number(getState().libraryLimit || PAGE_SIZE) || PAGE_SIZE);
        }
        const summary = Object.keys(args).length > 0
            ? await window.mfhBridge.getSummary(args)
            : await window.mfhBridge.getSummary();
        getState().summary = summary;
        applySummary(summary);
        return true;
    } catch (err) {
        showToast('读取本地数据失败', '无法读取本机的邮件和发票记录，请确认配置文件是否完整。', 'err', { detail: err?.message });
        return false;
    }
}

export async function loadBridgeConfig() {
    if (!window.mfhBridge?.getConfig) return false;
    try {
        const payload = await window.mfhBridge.getConfig();
        getState().configPayload = payload;
        // A corrupted config must show a blocking repair entry point, never "已加载".
        if (payload?.configError) showConfigError(payload.configError);
        else clearConfigError();
        applyConfig(payload.config || {}, payload.secrets || {});
        return true;
    } catch (err) {
        showConfigError({ message: '无法读取本机配置文件。' });
        getState().configLoadError = err?.message || '';
        return false;
    } finally {
        getState().configReady = true;
        getState()._configReadyResolvers?.forEach((resolve) => resolve());
        getState()._configReadyResolvers = [];
    }
}

export function whenConfigReady() {
    if (!window.mfhBridge?.getConfig) return Promise.resolve();
    if (getState()?.configReady) return Promise.resolve();
    return new Promise((resolve) => {
        getState()._configReadyResolvers = getState()._configReadyResolvers || [];
        getState()._configReadyResolvers.push(resolve);
    });
}

export function wireOperationProgress() {
    window.mfhBridge?.onOperationProgress?.((data) => {
        if (!data || data.operation !== 'ocr') return;
        applyOcrProgress(data);
    });
    window.mfhBridge?.onFileProgress?.((data) => {
        if (!data || data.operation !== 'files') return;
        applyFileProgress(data);
    });
}

