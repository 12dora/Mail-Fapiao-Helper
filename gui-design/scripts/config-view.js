import { appInfoLoaded, applyOcrStatusCards, loadAppInfo, renderAppInfo } from './about.js';
import { escapeHtml, isChecked, setChecked, text } from './dom.js';
import { applyOpState } from './op-state.js';
import { sanitizeText } from './redaction.js';
import { getState } from './state.js';
import { showToast } from './toast.js';

/* Values shipped in config.example.json must never read as "configured". */
export const PLACEHOLDER_HOSTS = new Set(['imap.example.com', 'smtp.example.com', 'mail.example.com']);
export const PLACEHOLDER_USERS = new Set(['me@example.com', 'user@example.com', 'you@example.com']);
export const PLACEHOLDER_SECRETS = new Set(['***', '******', 'your-password', 'changeme', 'password']);

export function credentialStored(secrets, rawPass) {
    // The IPC boundary redacts secrets; prefer its boolean shadow.
    if (typeof secrets?.imapPass === 'boolean') return secrets.imapPass;
    const value = String(rawPass || '').trim();
    if (!value) return false;
    return !PLACEHOLDER_SECRETS.has(value);
}

/* UI-01: bind "已连接" to the exact IMAP settings that were tested. */
export function mailConfigFingerprint(cfg, secrets) {
    const imap = cfg?.imap || {};
    const host = typeof imap.host === 'string' ? imap.host.trim().toLowerCase() : '';
    const user = typeof imap.user === 'string' ? imap.user.trim().toLowerCase() : '';
    const port = imap.port == null || imap.port === '' ? '' : String(imap.port);
    const tls = imap.tls !== false;
    const hasPass = credentialStored(secrets, typeof imap.pass === 'string' ? imap.pass : '');
    return `${host}|${port}|${user}|${tls ? '1' : '0'}|${hasPass ? '1' : '0'}`;
}

export function clearMailVerification() {
    getState().credentialsVerified = false;
    getState().credentialsVerifiedFor = '';
}

export function markMailVerified(cfg, secrets) {
    getState().credentialsVerified = true;
    getState().credentialsVerifiedFor = mailConfigFingerprint(cfg, secrets);
}

export function applyMailStatus(cfg, secrets) {
    const imap = cfg?.imap || {};
    const host = typeof imap.host === 'string' ? imap.host.trim() : '';
    const user = typeof imap.user === 'string' ? imap.user.trim() : '';
    const pass = typeof imap.pass === 'string' ? imap.pass.trim() : '';
    const realHost = Boolean(host) && !PLACEHOLDER_HOSTS.has(host.toLowerCase());
    const realUser = Boolean(user) && !PLACEHOLDER_USERS.has(user.toLowerCase());
    const configured = realHost && realUser && credentialStored(secrets, pass);
    const fp = mailConfigFingerprint(cfg, secrets);
    if (getState().credentialsVerified && getState().credentialsVerifiedFor !== fp) {
        clearMailVerification();
    }
    const verified = configured && getState().credentialsVerified === true
        && getState().credentialsVerifiedFor === fp;
    // UI-03: keep the visible label short; put the address in title.
    const shortLabel = verified ? '已连接' : configured ? '已保存' : '邮箱未配置';
    const fullTitle = verified ? `已连接 · ${user}`
        : configured ? `已保存 · ${user}`
        : '邮箱未配置';
    document.querySelectorAll('[data-mail-status-label]').forEach((el) => {
        el.textContent = shortLabel;
        el.title = fullTitle;
        el.classList.add('sidebar__mail-status');
    });
    // UI-01: three explicit states — unconfigured / saved / verified.
    document.querySelectorAll('[data-mail-status-dot]').forEach((el) => {
        el.classList.remove('is-off', 'is-unconfigured', 'is-saved', 'is-verified');
        if (verified) el.classList.add('is-verified');
        else if (configured) el.classList.add('is-saved');
        else el.classList.add('is-unconfigured');
    });
    document.querySelectorAll('[data-mail-status-meta]').forEach((el) => {
        el.textContent = verified ? `邮箱已连接 · ${host}`
            : configured ? '邮箱设置已保存，建议先点“测试邮箱连接”'
            : '请先在「邮箱与保存」页填写邮箱';
    });
}

/* Recompute mail status from the live form (used when IMAP fields change). */
export function refreshMailStatusFromForm() {
    const tlsEl = document.querySelector('[data-config-check="imap.tls"]');
    const cfg = {
        imap: {
            host: document.querySelector('[data-config="imap.host"]')?.value || '',
            port: document.querySelector('[data-config="imap.port"]')?.value || '',
            user: document.querySelector('[data-config="imap.user"]')?.value || '',
            pass: document.querySelector('[data-config="imap.pass"]')?.value || '',
            tls: tlsEl ? isChecked(tlsEl) : true,
        },
    };
    const secrets = getState().configPayload?.secrets || {};
    // Typed password counts as a credential change; empty keeps the stored shadow.
    const passTyped = String(cfg.imap.pass || '').trim();
    const effectiveSecrets = passTyped
        ? { ...secrets, imapPass: true }
        : secrets;
    applyMailStatus(cfg, effectiveSecrets);
}

function setConfigValue(selector, value) {
    const el = document.querySelector(selector);
    if (el && value !== undefined && value !== null) el.value = value;
}

function applyMailConfig(cfg) {
    setConfigValue('[data-config="imap.host"]', cfg.imap?.host);
    setConfigValue('[data-config="imap.port"]', cfg.imap?.port);
    setConfigValue('[data-config="imap.user"]', cfg.imap?.user);
    const mailboxSelect = document.querySelector('[data-config="imap.mailbox"]');
    if (mailboxSelect && Array.isArray(cfg.imap?.mailbox)) {
        const selected = cfg.imap.mailbox;
        const known = new Set(Array.from(mailboxSelect.options).map((opt) => opt.value));
        const missing = selected.filter((value) => value && !known.has(value));
        if (missing.length > 0) {
            setMailboxOptions(Array.from(known).concat(missing), selected);
        } else {
            const selSet = new Set(selected);
            Array.from(mailboxSelect.options).forEach((opt) => {
                opt.selected = selSet.has(opt.value);
            });
        }
    }
    document.querySelectorAll('[data-config-check="imap.tls"]').forEach((el) => {
        setChecked(el, cfg.imap?.tls !== false);
    });
}

function applyFilterConfig(cfg) {
    setConfigValue('[data-config="filter.keywords"]', Array.isArray(cfg.filter?.keywords) ? cfg.filter.keywords.join(', ') : '');
    const matchSubject = cfg.filter?.matchSubject !== false;
    const matchBody = cfg.filter?.matchBody !== false;
    document.querySelectorAll('[data-fetch-check="matchSubject"]').forEach((el) => setChecked(el, matchSubject));
    document.querySelectorAll('[data-fetch-check="matchBody"]').forEach((el) => setChecked(el, matchBody));
}

function applyPathConfig(cfg) {
    setConfigValue('[data-config="paths.samples"]', cfg.paths?.samples);
    setConfigValue('[data-config="paths.invoices"]', cfg.paths?.invoices);
    setConfigValue('[data-config="paths.pending"]', cfg.paths?.pending);
    // COPY-15: About page keeps generic Chinese copy — never overwrite with
    // absolute/relative machine paths or put them in title tooltips.
    const setPathStatus = (selector, value) => {
        document.querySelectorAll(selector).forEach((el) => {
            if (value) {
                el.textContent = '已配置（在「邮箱与保存」中管理）';
                el.removeAttribute('title');
                el.classList.add('setting-row__value');
            }
        });
    };
    setPathStatus('[data-settings-path="samples"]', cfg.paths?.samples);
    setPathStatus('[data-settings-path="invoices"]', cfg.paths?.invoices);
    setPathStatus('[data-settings-path="pending"]', cfg.paths?.pending);
}

function applyRenameConfig(cfg) {
    setConfigValue('[data-config="output.csv"]', cfg.output?.csv);
    setConfigValue('[data-config="rename.rule"]', cfg.rename?.rule);
    setConfigValue('[data-config="rename.fallback"]', cfg.rename?.fallback);
    setConfigValue('[data-config="rename.typeDirRule"]', cfg.rename?.typeDirRule);
    window.MFH_UPDATE_RENAME_PREVIEW?.();
    document.querySelectorAll('[data-config-check="rename.avoidConflictBeforeOcr"]').forEach((el) => {
        setChecked(el, cfg.rename?.avoidConflictBeforeOcr !== false);
    });
    document.querySelectorAll('[data-config-check="rename.applyAfterOcr"]').forEach((el) => {
        setChecked(el, cfg.rename?.applyAfterOcr === true);
    });
    document.querySelectorAll('[data-config-check="rename.organizeByType"]').forEach((el) => {
        setChecked(el, cfg.rename?.organizeByType === true);
    });
}

function applyNetworkConfig(cfg) {
    setConfigValue('[data-config="network.retries"]', cfg.network?.retries);
    // COPY-14: present retry/wait times in seconds in the form; config stays ms.
    setConfigValue('[data-config="network.retryDelayMs"]', msToSecondsField(cfg.network?.retryDelayMs));
}

function setSecretPlaceholder(selector, hasValue) {
    const el = document.querySelector(selector);
    if (!el) return;
    if (hasValue && !el.value) {
        el.placeholder = '已保存（留空则不修改）';
    }
}

function applyOcrConfig(cfg, secrets) {
    setConfigValue('[data-config="ocr.provider"]', cfg.ocr?.enabled === false ? 'none' : (cfg.ocr?.provider || 'efapiao'));
    setConfigValue('[data-config="ocr.ocrMode"]', cfg.ocr?.ocrMode || 'auto');
    setConfigValue('[data-config="ocr.executionMode"]', cfg.ocr?.executionMode);
    setConfigValue('[data-config="ocr.resultsCsv"]', cfg.ocr?.resultsCsv);
    setConfigValue('[data-config="ocr.serviceHost"]', cfg.ocr?.serviceHost);
    setConfigValue('[data-config="ocr.servicePort"]', cfg.ocr?.servicePort);
    setConfigValue('[data-config="ocr.serviceWorkers"]', cfg.ocr?.serviceWorkers);
    setConfigValue('[data-config="ocr.batchSize"]', cfg.ocr?.batchSize);
    setSecretPlaceholder('[data-config="imap.pass"]', Boolean(secrets.imapPass ?? cfg.imap?.pass));
    setSecretPlaceholder('[data-config="ocr.credentials.tencentSecretId"]', Boolean(secrets.tencentSecretId ?? cfg.ocr?.credentials?.tencentSecretId ?? cfg.ocr?.credentials?.secretId));
    setSecretPlaceholder('[data-config="ocr.credentials.tencentSecretKey"]', Boolean(secrets.tencentSecretKey ?? cfg.ocr?.credentials?.tencentSecretKey ?? cfg.ocr?.credentials?.secretKey));
    setConfigValue('[data-config="ocr.credentials.tencentRegion"]', cfg.ocr?.credentials?.tencentRegion || cfg.ocr?.credentials?.region || '');
    // playwright.browserManagement is intentionally not surfaced: the setting
    // was never read by the CLI (APP-19). EXT-09：站点处理器不再依赖本机浏览器。
    setConfigValue('[data-config="playwright.timeoutMs"]', msToSecondsField(cfg.playwright?.timeoutMs));
}

export function applyConfig(cfg, secrets = {}) {
    applyMailStatus(cfg, secrets);
    // FE-02: never overwrite a dirty draft with a concurrent getConfig hydrate.
    if (window.MFH_CONFIG_IS_DIRTY?.() === true) {
        applyOcrStatusCards();
        return;
    }
    applyMailConfig(cfg);
    applyFilterConfig(cfg);
    applyPathConfig(cfg);
    applyRenameConfig(cfg);
    applyNetworkConfig(cfg);
    applyOcrConfig(cfg, secrets);
    applyOcrStatusCards();
}

/* COPY-14 helpers: form fields show seconds; on-disk config keeps milliseconds. */
export function msToSecondsField(ms) {
    if (ms === undefined || ms === null || ms === '') return '';
    const n = Number(ms);
    if (!Number.isFinite(n)) return '';
    // Prefer whole seconds; keep one decimal when the stored value is fractional seconds.
    const sec = n / 1000;
    return Number.isInteger(sec) ? String(sec) : String(Math.round(sec * 10) / 10);
}

/* ---------- Page-commit hook ----------
   One place for "re-render the current real state onto this DOM".
   A page inserted by the SPA loader starts from the static placeholders in
   its HTML, so every piece of state that does NOT arrive through the
   summary/config payloads must be replayed here. FB-01 (a running job's
   controls) and COPY-07B (About version/channel) are the same root cause,
   so they deliberately share this hook instead of separate call sites.
   Runs once from wire() and after every showPage() commit. */
export function applyLiveState(pageId) {
    applyOpState(getState().opState || null);
    renderAppInfo();
    if (!appInfoLoaded || pageId === 'settings') {
        // Also recovers when the bridge only became available after wire().
        Promise.resolve(loadAppInfo({ force: pageId === 'settings' })).catch(() => {});
    }
    if (pageId === 'settings') {
        Promise.resolve(refreshArchiveJournalStatus()).catch(() => {});
    }
}

/**
 * 设置页「归档恢复」：查询 journal 状态，并仅在可隔离时启用危险按钮。
 * 无 bridge 时降级为静态预览文案，不假装一切正常。
 */
export async function refreshArchiveJournalStatus() {
    const panel = document.querySelector('[data-archive-journal-panel]');
    if (!panel) return;
    const statusEl = panel.querySelector('[data-archive-journal-status]');
    const quarantineBtn = panel.querySelector('[data-archive-journal-quarantine], [data-action="archive-journal-quarantine"]');
    const setQuarantineEnabled = (on) => {
        if (quarantineBtn) quarantineBtn.disabled = !on;
    };

    const fn = window.mfhBridge?.archiveJournalStatus;
    if (typeof fn !== 'function') {
        if (statusEl) {
            statusEl.textContent = window.mfhBridge
                ? '当前版本无法查询归档恢复状态。'
                : '当前环境无法查询归档恢复状态（静态预览）。';
        }
        setQuarantineEnabled(false);
        return;
    }
    try {
        const st = await fn();
        const msg = (st && (st.message || st.detail)) || '状态未知';
        if (statusEl) statusEl.textContent = String(msg);
        // 仅在状态表明可以隔离时启用：residual / canQuarantine，且非 clear。
        const can = Boolean(
            st
            && st.status !== 'clear'
            && (st.status === 'residual' || st.canQuarantine === true)
        );
        setQuarantineEnabled(can);
    } catch (err) {
        if (statusEl) statusEl.textContent = '读取归档恢复状态失败，请稍后重试。';
        setQuarantineEnabled(false);
    }
}

/* ---------- Config save contract (APP-08 / UI-06) ----------
   { ok: false, fieldErrors: [{ path, message }] } → block and show the
   error next to each field; { ok: false, configError } → blocking repair
   entry point; { ok: true, config } → apply. */
/* An invalid field inside a collapsed 高级设置 section must not stay hidden. */
export function revealField(el) {
    let node = el?.parentElement;
    while (node) {
        if (node.tagName === 'DETAILS') node.open = true;
        node = node.parentElement;
    }
}

export function applyFieldErrors(fieldErrors) {
    document.querySelectorAll('[data-config]').forEach((el) => {
        el.classList.remove('is-invalid');
        el.removeAttribute('aria-invalid');
    });
    document.querySelectorAll('[data-field-error]').forEach((el) => { el.remove(); });
    const summary = document.querySelector('[data-config-error-summary]');
    if (summary) { summary.hidden = true; summary.replaceChildren(); }
    const errors = Array.isArray(fieldErrors) ? fieldErrors : [];
    if (errors.length === 0) return false;
    // DOM APIs + textContent throughout: `message`/`path` come from IPC and
    // may echo values the user typed, so they must never be concatenated
    // into innerHTML.
    const list = document.createElement('ul');
    errors.forEach((error, index) => {
        const path = String(error?.path || '');
        const message = String(error?.message || '这个值无法保存。');
        const input = path ? document.querySelector(`[data-config="${path}"]`) : null;
        const errorId = `config-error-${index}`;
        if (input) {
            if (!input.id) input.id = `config-field-${index}`;
            revealField(input);
            input.classList.add('is-invalid');
            input.setAttribute('aria-invalid', 'true');
            const note = document.createElement('div');
            note.className = 'field__error';
            note.id = errorId;
            note.dataset.fieldError = 'true';
            note.textContent = message;
            input.insertAdjacentElement('afterend', note);
            const describedBy = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
            if (!describedBy.includes(errorId)) describedBy.push(errorId);
            input.setAttribute('aria-describedby', describedBy.join(' '));
            const li = document.createElement('li');
            const link = document.createElement('a');
            link.href = `#${encodeURIComponent(input.id)}`;
            link.dataset.configErrorLink = input.id;
            link.textContent = message;
            li.appendChild(link);
            list.appendChild(li);
        } else {
            const li = document.createElement('li');
            li.textContent = message;
            list.appendChild(li);
        }
    });
    if (summary) {
        const title = document.createElement('div');
        title.className = 'error-summary__title';
        title.textContent = `有 ${errors.length} 项设置没有保存`;
        summary.replaceChildren(title, list);
        summary.hidden = false;
        summary.setAttribute('role', 'alert');
        summary.setAttribute('tabindex', '-1');
        summary.focus?.({ preventScroll: false });
    }
    return true;
}

export function showConfigError(configError) {
    const signature = String(configError?.message || 'config-error');
    const repeated = getState()._configErrorSignature === signature;
    getState()._configErrorSignature = signature;
    getState().configError = configError || { message: '本机配置文件无法读取。' };
    const mount = document.querySelector('[data-config-blocker]');
    const message = configError?.message || '本机配置文件无法读取。';
    if (mount) {
        const title = document.createElement('div');
        title.className = 'strong';
        title.textContent = '配置文件损坏，需要重建后才能继续使用';
        const detail = document.createElement('div');
        detail.className = 'small mt-12';
        detail.textContent = sanitizeText(message);
        const guide = document.createElement('div');
        guide.className = 'small mt-12';
        guide.textContent = '「备份并重建配置」会把损坏的文件另存为备份，再用本页当前填写的内容重新写一份可用的配置。除配置文件外不会删除任何数据。';
        const actions = document.createElement('div');
        actions.className = 'row gap-8 mt-12';
        const repair = document.createElement('button');
        repair.className = 'btn btn--sm btn--primary';
        repair.type = 'button';
        repair.dataset.action = 'repair-config';
        repair.textContent = '备份并重建配置';
        const reload = document.createElement('button');
        reload.className = 'btn btn--sm';
        reload.type = 'button';
        reload.dataset.action = 'discard-config';
        reload.textContent = '再试一次读取';
        actions.append(repair, reload);
        mount.replaceChildren(title, detail, guide, actions);
        mount.hidden = false;
        mount.setAttribute('role', 'alert');
    }
    text('[data-summary="config-path"]', '配置文件损坏');
    if (!repeated) {
        showToast('配置文件损坏', '请到「邮箱与保存」页点击「备份并重建配置」后再运行。', 'err', { scope: 'global' });
    }
}

export function clearConfigError() {
    getState().configError = null;
    getState()._configErrorSignature = '';
    document.querySelectorAll('[data-config-blocker]').forEach((el) => {
        el.hidden = true;
        el.replaceChildren();
    });
}

/* COPY-14: common IMAP folder names shown in Chinese; value stays machine name. */
export const MAILBOX_DISPLAY = {
    INBOX: '收件箱',
    SENT: '已发送',
    'SENT MESSAGES': '已发送',
    'SENT ITEMS': '已发送',
    DRAFTS: '草稿箱',
    DRAFT: '草稿箱',
    TRASH: '已删除',
    'DELETED MESSAGES': '已删除',
    JUNK: '垃圾邮件',
    SPAM: '垃圾邮件',
    ARCHIVE: '归档',
    ARCHIVES: '归档',
    JUNKMAIL: '垃圾邮件',
};
export function mailboxDisplayName(name) {
    const raw = String(name || '');
    if (!raw) return raw;
    const upper = raw.toUpperCase();
    if (MAILBOX_DISPLAY[upper]) return MAILBOX_DISPLAY[upper];
    // Gmail-style "[Gmail]/已发送邮件" etc. — keep server label as-is when already CJK.
    if (/[\u4e00-\u9fff]/.test(raw)) return raw;
    return raw;
}

export function setMailboxOptions(mailboxes, selected) {
    const select = document.querySelector('[data-config="imap.mailbox"]');
    if (!select) return;
    const chosen = new Set(selected || Array.from(select.selectedOptions).map((opt) => opt.value));
    const list = Array.isArray(mailboxes) && mailboxes.length > 0 ? mailboxes : ['INBOX'];
    for (const value of chosen) {
        if (value && !list.includes(value)) list.push(value);
    }
    select.innerHTML = list
        .map((name) => `<option value="${escapeHtml(name)}"${chosen.has(name) ? ' selected' : ''}>${escapeHtml(mailboxDisplayName(name))}</option>`)
        .join('');
    // Programmatic mutation does not fire change naturally — emit one so autosave / status pills react.
    select.dispatchEvent(new Event('change', { bubbles: true }));
}
