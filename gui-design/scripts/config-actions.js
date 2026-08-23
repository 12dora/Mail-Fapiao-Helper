import { bridgeUnavailable } from './bridge-base.js';
import { loadBridgeConfig } from './bridge.js';
import { applyFieldErrors, applyMailStatus, clearConfigError, clearMailVerification, markMailVerified, refreshMailStatusFromForm, setMailboxOptions, showConfigError } from './config-view.js';
import { announce } from './dom.js';
import { eventDetail, eventMessage, sanitizeText } from './redaction.js';
import { showPage } from './router.js';
import { getState } from './state.js';
import { showToast } from './toast.js';


export async function clearSecret(action) {
    const key = String(action.dataset.secretKey || '');
    const label = action.dataset.secretLabel || key || '该字段';
    if (!key) return;
    const confirmed = window.confirm(`确认清除${label}吗？后续运行需要重新填写。`);
    if (!confirmed) return;
    if (!window.mfhBridge?.saveConfig) { bridgeUnavailable(); return; }
    const parts = key.split('.').filter(Boolean);
    if (parts.length === 0) return;
    const patch = {};
    let cur = patch;
    for (let i = 0; i < parts.length - 1; i++) {
        cur[parts[i]] = {};
        cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = '';
    try {
        const saved = await saveConfigChecked(patch);
        if (!saved.ok) return;
        if (key === 'imap.pass' || key.startsWith('imap.')) clearMailVerification();
        await loadBridgeConfig();
        const input = document.querySelector(`[data-config="${key}"]`);
        if (input) input.value = '';
        showToast('已清除', `${label}已从本机配置中移除。`, 'warn');
    } catch (err) {
        showToast('清除失败', '没能清除这项凭据，请重试。', 'err', { detail: err?.message });
    }
}

/* APP-08: the only way out of a corrupted config file. Plain saves keep
   returning `configError`, so the repair must explicitly ask the main
   process to quarantine the broken file and rebuild from this payload. */
export async function repairConfig() {
    if (!window.mfhBridge?.saveConfig) { bridgeUnavailable(); return; }
    if (typeof window.collectConfigPayload !== 'function') {
        // The form lives on the config page; go there first so the rebuild
        // uses real values instead of an empty object.
        await showPage('config');
    }
    if (typeof window.collectConfigPayload !== 'function') {
        showToast('无法重建配置', '请先打开「邮箱与保存」页，再点击「备份并重建配置」。', 'err');
        return;
    }
    const confirmed = window.confirm([
        '备份并重建配置',
        '',
        '将会：',
        '· 把当前损坏的配置文件另存为备份文件',
        '· 用本页现在填写的内容重新生成一份配置',
        '',
        '不会删除邮件缓存、已归档发票或识别结果。',
        '',
        '确认继续吗？',
    ].join('\n'));
    if (!confirmed) return;
    const payload = { ...window.collectConfigPayload(), repairCorrupt: true };
    let result;
    try {
        result = await window.mfhBridge.saveConfig(payload);
    } catch (err) {
        showToast('重建失败', '配置文件没有被修改，请重试。', 'err', { detail: err?.message });
        return;
    }
    if (result && result.ok === false) {
        if (result.configError) showConfigError(result.configError);
        else applyFieldErrors(result.fieldErrors);
        showToast('重建失败', eventMessage(result) || '配置文件还是无法写入，请检查磁盘权限。', 'err', { detail: eventDetail(result) });
        return;
    }
    clearConfigError();
    applyFieldErrors([]);
    await loadBridgeConfig();
    // COPY-02：以 backupCreated 为准，不承诺未成功的备份。
    const backupCreated = result?.backupCreated === true
        || result?.configError?.backupCreated === true
        || Boolean(result?.backupPath || result?.repairedFrom || result?.configError?.backupPath);
    const backupPath = result?.backupPath || result?.repairedFrom || result?.configError?.backupPath || '';
    if (backupCreated && backupPath) {
        showToast(
            '配置已重建',
            `设置已重建，旧设置已另存为备份：${sanitizeText(backupPath)}`,
            'ok',
            { duration: 8000 },
        );
    } else if (backupCreated) {
        showToast('配置已重建', '设置已重建，旧设置已另存为备份。', 'ok', { duration: 8000 });
    } else {
        showToast(
            '配置已重建',
            '设置已重建，但旧设置未能备份。请立即核对邮箱账号、保存位置和识别设置。',
            'warn',
            { duration: 10000 },
        );
    }
    announce('配置已重建，可以继续使用。');
}

/* Shared entry point used by the config page's autosave and by
   testConnection: a failed save must never be treated as success. */
export async function saveConfigChecked(payload) {
    const fn = window.mfhBridge?.saveConfig;
    if (typeof fn !== 'function') return { ok: true, skipped: true };
    const result = await fn(payload);
    // Older builds resolve with undefined on success.
    if (result && result.ok === false) {
        if (result.configError) showConfigError(result.configError);
        else if (!applyFieldErrors(result.fieldErrors)) {
            showToast('保存失败', eventMessage(result) || '这次修改没有保存到本机。', 'err', { detail: eventDetail(result) });
        }
        return { ok: false, result };
    }
    applyFieldErrors([]);
    clearConfigError();
    return { ok: true, result };
}

export async function testConnection() {
    const fn = window.mfhBridge?.testMailConnection;
    if (!fn) { bridgeUnavailable(); return; }
    const payload = typeof window.collectConfigPayload === 'function' ? window.collectConfigPayload() : undefined;
    if (payload && window.mfhBridge?.saveConfig) {
        const saved = await saveConfigChecked(payload);
        if (!saved.ok) {
            // Saving failed, so the backend would test the *old* values.
            showToast('还不能测试连接', '请先修好上面标红的设置，保存成功后再测试。', 'err');
            return;
        }
    }
    const result = await fn(payload);
    const toastKind = result?.ok ? (result.kind === 'warn' ? 'warn' : 'ok') : 'err';
    const toastTitle = result?.ok
        ? (result.kind === 'warn' ? '连接成功，但需要调整' : '邮箱连接正常')
        : '邮箱连接失败';
    showToast(toastTitle, eventMessage(result) || (result?.ok ? '已成功连接邮箱。' : '无法连接邮箱，请检查账号、授权码和主机地址。'), toastKind, {
        detail: result?.ok ? '' : eventDetail(result),
    });
    if (result?.ok) {
        // UI-01: only a real successful connection may mark credentials verified,
        // and only for the exact settings that were tested.
        await reloadMailboxes({ silent: true });
        await loadBridgeConfig();
        /* UI-01: mark verified against the config that was just RELOADED, not
           against the test payload. `collectConfigPayload()` omits `imap.pass`
           when the user did not retype it, so a payload-derived fingerprint
           recorded hasPass=0 while the reloaded config reports the stored
           password as hasPass=1 — the fingerprints never matched and
           applyMailStatus cleared verification immediately, so a successful
           test could never surface 「已连接」. Computing both sides from the
           same inputs makes them equal by construction. */
        const verifiedCfg = getState().configPayload?.config || payload || {};
        const verifiedSecrets = getState().configPayload?.secrets || {};
        markMailVerified(verifiedCfg, verifiedSecrets);
        applyMailStatus(verifiedCfg, verifiedSecrets);
    } else {
        clearMailVerification();
        refreshMailStatusFromForm();
    }
}

export async function reloadMailboxes(opts = {}) {
    const fn = window.mfhBridge?.listMailboxes;
    const statusEl = document.querySelector('[data-mailbox-status]');
    if (!fn) { if (!opts.silent) bridgeUnavailable(); return; }
    const payload = typeof window.collectConfigPayload === 'function' ? window.collectConfigPayload() : undefined;
    if (statusEl) statusEl.textContent = '正在读取…';
    const result = await fn(payload);
    if (result?.ok && Array.isArray(result.mailboxes)) {
        setMailboxOptions(result.mailboxes);
        if (statusEl) statusEl.textContent = `已读取 ${result.mailboxes.length} 个文件夹`;
        if (!opts.silent) showToast('已读取邮箱文件夹', `共 ${result.mailboxes.length} 个，可在列表中多选`);
    } else {
        if (statusEl) statusEl.textContent = eventMessage(result) || '读取失败';
        if (!opts.silent) showToast('读取失败', eventMessage(result) || '请先填写邮箱主机、账号和授权码。', 'err', { detail: eventDetail(result) });
    }
}

