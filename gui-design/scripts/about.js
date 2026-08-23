import { getState } from './state.js';

/* ---------- About / version metadata (COPY-07B) ---------- */
export let appInfoLoaded = false;

export async function loadAppInfo(opts = {}) {
    if (appInfoLoaded && !opts.force) { renderAppInfo(); return; }
    let info = null;
    try {
        const fn = window.mfhBridge?.getAppInfo;
        if (typeof fn === 'function') info = await fn();
    } catch {
        info = null;
    }
    getState().appInfo = info || null;
    appInfoLoaded = true;
    renderAppInfo();
}

/**
 * 把已取到的应用信息写进当前 DOM。SPA 新插入的 About 页不会重新执行
 * `loadAppInfo()`，若不在 commit 后重渲染，版本/渠道会一直停在 HTML 里的
 * 「读取中…」占位符——那样 COPY-07B 在用户唯一的进入路径上等于没修。
 */
export function renderAppInfo() {
    const info = getState().appInfo;
    const version = info?.version ? `v${info.version}` : '版本未知';
    const channel = info?.channel || (window.mfhBridge ? '桌面版' : '静态预览');
    document.querySelectorAll('[data-app-version]').forEach((el) => { el.textContent = version; });
    document.querySelectorAll('[data-about-version]').forEach((el) => { el.textContent = version; });
    document.querySelectorAll('[data-about-channel]').forEach((el) => { el.textContent = channel; });
    applyOcrStatusCards();
}

/* “已配置” must reflect real config, never a hardcoded pill. */
export function applyOcrStatusCards() {
    const cfg = getState().configPayload?.config || {};
    const secrets = getState().configPayload?.secrets || {};
    const ocr = cfg.ocr || {};
    const engineEnabled = ocr.enabled !== false;
    const engineEl = document.querySelector('[data-about-engine]');
    if (engineEl) {
        engineEl.className = `pill ${engineEnabled ? 'pill--ok' : ''}`;
        engineEl.textContent = engineEnabled ? '已启用' : '未启用（只保存原件）';
    }
    const hasId = Boolean(secrets.tencentSecretId ?? ocr.credentials?.tencentSecretId ?? ocr.credentials?.secretId);
    const hasKey = Boolean(secrets.tencentSecretKey ?? ocr.credentials?.tencentSecretKey ?? ocr.credentials?.secretKey);
    const cloudEl = document.querySelector('[data-about-cloud]');
    if (cloudEl) {
        // COPY-09: derive from engine + mode + credentials; never claim upload
        // solely because keys exist, and always mention 行程单 when upload may happen.
        const configured = hasId && hasKey;
        const mode = ocr.ocrMode || 'auto';
        if (!engineEnabled) {
            cloudEl.className = 'pill';
            cloudEl.textContent = '识别已关闭（不会上传文件）';
        } else if (mode === 'disabled') {
            cloudEl.className = 'pill';
            cloudEl.textContent = configured
                ? '已填写密钥（当前模式不上传）'
                : '未填写密钥（不会上传文件）';
        } else if (!configured) {
            cloudEl.className = 'pill';
            cloudEl.textContent = '未填写密钥（不会上传文件）';
        } else if (mode === 'required') {
            cloudEl.className = 'pill pill--warn';
            cloudEl.textContent = '会上传发票和行程单文件';
        } else {
            cloudEl.className = 'pill pill--warn';
            cloudEl.textContent = '必要时会上传发票和行程单文件';
        }
    }
    const modeEl = document.querySelector('[data-about-ocr-mode]');
    if (modeEl) {
        const mode = ocr.ocrMode || 'auto';
        modeEl.textContent = mode === 'disabled' ? '仅本地规则，不使用云端识别'
            : mode === 'required' ? '每个文件都使用云端识别'
            : '规则优先，必要时使用云端识别';
    }
}

