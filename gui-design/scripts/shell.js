/* 发票助手桌面端壳层。
   为 Electron 预留 window.mfhBridge，当前静态预览会使用本地演示数据。 */

import { loadAppInfo, renderAppInfo } from './about.js';
import { loadBridgeSummary, whenConfigReady } from './bridge.js';
import { wire } from './bootstrap.js';
import { applyConfig, applyFieldErrors, applyLiveState, applyMailStatus, clearConfigError, clearMailVerification, markMailVerified, refreshMailStatusFromForm, showConfigError } from './config-view.js';
import { announce, isChecked, setChecked } from './dom.js';
import { copyText } from './exports.js';
import { applyNormalizedFilter } from './filters.js';
import { beginLocalMutexLock, endLocalMutexLock, applyOpState } from './op-state.js';
import { repairConfig, saveConfigChecked } from './config-actions.js';
import { applyFileProgress, applyOcrProgress } from './progress.js';
import { sanitizeText } from './redaction.js';
import { ICON, getTheme, setMotion, setTheme, upgradeStaticMarkup } from './shell-ui.js';
import { exposeCompatibilityApi } from './state.js';
import { applySummary, setCurrentBatch } from './summary.js';
import { dismissPageToasts, setToastClipboardCallback, showToast } from './toast.js';

setToastClipboardCallback(copyText);

// Expose for inline buttons
exposeCompatibilityApi({
    setTheme,
    toggleTheme: () => setTheme(getTheme() === 'light' ? 'dark' : 'light'),
    setMotion,
    showToast,
    reloadSummary: loadBridgeSummary,
    applySummary,
    applyConfig,
    bridge: window.mfhBridge || null,
    applyOcrProgress,
    applyFileProgress,
    applyNormalizedFilter,
    setCurrentBatch,
    saveConfigChecked,
    applyFieldErrors,
    showConfigError,
    clearConfigError,
    repairConfig,
    beginLocalMutexLock,
    endLocalMutexLock,
    clearMailVerification,
    refreshMailStatusFromForm,
    markMailVerified,
    applyMailStatus,
    applyOpState,
    applyLiveState,
    loadAppInfo,
    renderAppInfo,
    dismissPageToasts,
    isChecked,
    setChecked,
    announce,
    sanitizeText,
    upgradeStaticMarkup,
    whenConfigReady,
    ICON,
});

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
} else {
    wire();
}
