import { announce, escapeHtml, prefersReducedMotion, text } from './dom.js';
import { fmtInt } from './formatters.js';
import { eventMessage } from './redaction.js';
import { getState } from './state.js';

export function logTime() {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
}

export function consoleLine(tag, message, kind = '') {
    return `<div class="console__line"><span class="console__time">${logTime()}</span><span class="console__tag ${kind}">${escapeHtml(tag)}</span><span class="console__msg">${escapeHtml(message)}</span></div>`;
}

/* ---------- Live log: follow-on-tail instead of forced scroll (FB-05) ---------- */
export const NEAR_BOTTOM_PX = 24;

export function isNearBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
}

export function ensureLogHost(el) {
    let host = el.parentElement;
    if (!host || !host.classList.contains('log-host')) {
        host = document.createElement('div');
        host.className = 'log-host';
        el.parentElement?.insertBefore(host, el);
        host.appendChild(el);
    }
    let jump = host.querySelector('.log-jump');
    if (!jump) {
        jump = document.createElement('button');
        jump.type = 'button';
        jump.className = 'log-jump';
        jump.hidden = true;
        jump.textContent = '有新消息 · 跳到最新';
        jump.addEventListener('click', () => {
            scrollLogToBottom(el);
            jump.hidden = true;
            el.focus?.();
        });
        host.appendChild(jump);
    }
    if (!el.dataset.logWired) {
        el.dataset.logWired = 'true';
        if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
        el.addEventListener('scroll', () => {
            if (isNearBottom(el)) jump.hidden = true;
        });
    }
    return jump;
}

export function scrollLogToBottom(el) {
    el.scrollTo?.({ top: el.scrollHeight, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    if (!el.scrollTo) el.scrollTop = el.scrollHeight;
}

export function appendLogLine(el, html, { reset = false } = {}) {
    const jump = ensureLogHost(el);
    const stick = reset || isNearBottom(el);
    if (reset) el.innerHTML = html;
    else {
        el.querySelectorAll('[data-placeholder]').forEach((p) => p.remove());
        el.insertAdjacentHTML('beforeend', html);
    }
    if (stick) {
        el.scrollTop = el.scrollHeight;
        jump.hidden = true;
    } else {
        jump.hidden = false;
    }
}

export function wireLogFollow() {
    document.querySelectorAll('[data-ocr-log], [data-file-log], #console-out').forEach((el) => ensureLogHost(el));
}

/* ---------- Accessible progress ---------- */
export function setProgressState(progressSelector, barSelector, opts) {
    const {
        percent, label, indeterminate = false, done = false, error = false, partial = false,
    } = opts;
    document.querySelectorAll(progressSelector).forEach((el) => {
        el.classList.remove('is-idle');
        el.classList.toggle('is-error', error);
        el.classList.toggle('is-partial', Boolean(partial) && !error);
        el.classList.toggle('is-done', done && !error);
        el.classList.toggle('is-indeterminate', indeterminate);
        el.setAttribute('role', 'progressbar');
        el.setAttribute('aria-valuemin', '0');
        el.setAttribute('aria-valuemax', '100');
        if (indeterminate) {
            el.removeAttribute('aria-valuenow');
            el.setAttribute('aria-valuetext', label || '正在准备…');
        } else {
            el.setAttribute('aria-valuenow', String(Math.round(percent)));
            el.setAttribute('aria-valuetext', label || `${Math.round(percent)}%`);
        }
    });
    document.querySelectorAll(barSelector).forEach((el) => {
        el.style.setProperty('--p', `${indeterminate ? 0 : percent}%`);
    });
}

export function resetOcrProgress(message = '正在准备识别文件。') {
    setProgressState('[data-ocr-progress]', '[data-ocr-bar]', {
        percent: 0, indeterminate: true, label: '正在准备识别文件',
    });
    text('[data-ocr-phase]', '准备识别');
    text('[data-ocr-counts]', '0 / 0');
    text('[data-ocr-parsed]', '0');
    text('[data-ocr-skipped]', '0');
    text('[data-ocr-failed]', '0');
    setOcrControlState('running');
    document.querySelectorAll('[data-ocr-parallel]').forEach((el) => { el.disabled = true; });
    document.querySelectorAll('[data-ocr-log]').forEach((el) => {
        appendLogLine(el, consoleLine('准备', message), { reset: true });
    });
    announce('已开始识别，正在准备。');
}

export function appendOcrLog(message, kind = '') {
    if (!message) return;
    document.querySelectorAll('[data-ocr-log]').forEach((el) => {
        appendLogLine(el, consoleLine(kind === 'ok' ? '成功' : kind === 'warn' ? '提醒' : kind === 'err' ? '失败' : '进度', message, kind));
    });
}

export function applyOcrProgress(data) {
    const total = Number(data.total || 0);
    const processed = Number(data.processed || 0);
    const parsed = Number(data.parsed || 0);
    const skipped = Number(data.skipped || 0);
    const failed = Number(data.failed || 0);
    const percent = data.percent === undefined
        ? (total > 0 ? Math.min(96, Math.round((processed / total) * 100)) : 12)
        : Math.max(0, Math.min(100, Number(data.percent) || 0));
    // FE-01：三态终态 — success / partial(warn) / failure(err)。
    const ocrErrored = data.kind === 'err';
    const ocrPartial = data.kind === 'warn' && Boolean(data.done);
    const phase = data.phase || (data.done
        ? (ocrErrored ? '识别失败' : ocrPartial ? '部分完成' : '识别完成')
        : '正在识别');
    setProgressState('[data-ocr-progress]', '[data-ocr-bar]', {
        percent,
        done: !ocrErrored && (Boolean(data.done) || percent >= 100),
        error: ocrErrored,
        partial: ocrPartial,
        label: total > 0 ? `${phase}：${processed} / ${total}，${percent}%` : `${phase}，${percent}%`,
    });
    text('[data-ocr-phase]', phase);
    text('[data-ocr-counts]', `${fmtInt(processed)} / ${fmtInt(total)}`);
    text('[data-ocr-parsed]', fmtInt(parsed));
    text('[data-ocr-skipped]', fmtInt(skipped));
    text('[data-ocr-failed]', fmtInt(failed));
    setOcrControlState(data.done ? 'idle' : 'running');
    document.querySelectorAll('[data-ocr-parallel]').forEach((el) => { el.disabled = !data.done; });
    if (data.done) {
        window.clearTimeout(getState()?._stopOcrFallback);
        if (getState()) getState()._stopOcrFallback = 0;
    }
    const readable = eventMessage(data);
    appendOcrLog(readable, data.kind || '');
    if (ocrErrored) announce(`识别失败：${readable || '请查看诊断信息'}`, 'alert');
    else if (ocrPartial) announce(`识别部分完成：成功 ${parsed}，失败 ${failed}，跳过 ${skipped}。`);
    else if (data.done) announce(`识别完成：成功 ${parsed}，跳过 ${skipped}，失败 ${failed}。`);
    else announce(`识别进行中：${processed} / ${total}`);
}

export function hasRecognizedResults() {
    const summary = getState().summary || {};
    const library = summary.library || {};
    const pending = Number(library.pending || 0);
    return pending <= 0 && (Number(library.recognized || 0) > 0 || (getState().libraryRows || []).length > 0);
}

export function setOcrControlState(state) {
    const running = state === 'running';
    document.querySelectorAll('[data-action="ocr-toggle"]').forEach((el) => {
        el.disabled = false;
        el.classList.toggle('btn--danger', running);
        el.classList.toggle('btn--primary', !running);
        // COPY-16: one action vocabulary everywhere — 开始识别 / 重新识别 / 停止识别.
        if (running) {
            el.dataset.ocrMode = 'stop';
            el.textContent = '停止识别';
        } else if (hasRecognizedResults()) {
            el.dataset.ocrMode = 'rerun';
            el.textContent = '重新识别';
        } else {
            el.dataset.ocrMode = 'start';
            el.textContent = '开始识别';
        }
    });
}

export function resetFileProgress(message = '正在准备获取发票文件。') {
    setProgressState('[data-file-progress]', '[data-file-bar]', {
        percent: 0, indeterminate: true, label: '正在准备获取发票文件',
    });
    text('[data-file-phase]', '准备获取');
    text('[data-file-counts]', '0 封');
    text('[data-file-processed]', '0');
    text('[data-file-skipped]', '0');
    text('[data-file-failed]', '0');
    document.querySelectorAll('[data-file-log]').forEach((el) => {
        appendLogLine(el, consoleLine('准备', message), { reset: true });
    });
    announce('已开始获取发票文件，正在准备。'); // COPY-16: 获取发票文件
}

export function appendFileLog(message, kind = '') {
    if (!message) return;
    document.querySelectorAll('[data-file-log]').forEach((el) => {
        appendLogLine(el, consoleLine(kind === 'ok' ? '完成' : kind === 'warn' ? '提醒' : kind === 'err' ? '失败' : '进度', message, kind));
    });
}

export function applyFileProgress(data) {
    const processed = Number(data.processed || 0);
    const skipped = Number(data.skipped || 0);
    const failed = Number(data.failed || 0);
    const total = Number(data.total || 0);
    // FE-01：三态终态 — success / partial(warn) / failure(err)。
    const fileErrored = data.kind === 'err';
    const filePartial = data.kind === 'warn' && Boolean(data.done);
    const phase = data.phase || (data.done
        ? (fileErrored ? '获取失败' : filePartial ? '部分完成' : '获取完成')
        : '正在获取');
    // Without a known total, never invent a fake percentage (FE-12). Even if
    // the backend still sends a synthetic percent, prefer indeterminate.
    const hasTotal = total > 0;
    const indeterminate = !data.done && !fileErrored && !hasTotal;
    let percent = 0;
    if (hasTotal) {
        percent = data.percent === undefined
            ? Math.min(96, Math.round(((processed + skipped + failed) / total) * 100))
            : Math.max(0, Math.min(100, Number(data.percent) || 0));
    } else if (data.done) {
        percent = 100;
    }
    const countLabel = `已处理 ${fmtInt(processed)} 封，失败 ${fmtInt(failed)}`;
    setProgressState('[data-file-progress]', '[data-file-bar]', {
        percent,
        indeterminate,
        done: !fileErrored && Boolean(data.done),
        error: fileErrored,
        partial: filePartial,
        label: indeterminate ? `${phase}：${countLabel}` : `${phase}，${percent}%`,
    });
    text('[data-file-phase]', phase);
    text('[data-file-counts]', hasTotal
        ? `${fmtInt(processed + skipped + failed)} / ${fmtInt(total)} 封`
        : `${fmtInt(processed)} 封`);
    text('[data-file-processed]', fmtInt(processed));
    text('[data-file-skipped]', fmtInt(skipped));
    text('[data-file-failed]', fmtInt(failed));
    const readable = eventMessage(data);
    appendFileLog(readable, data.kind || '');
    if (fileErrored) announce(`获取发票文件失败：${readable || '请查看诊断信息'}`, 'alert');
    else if (filePartial) announce(`获取发票文件部分完成：处理 ${processed} 封，失败 ${failed} 封。`);
    else if (data.done) announce(`获取发票文件完成：处理 ${processed} 封，跳过 ${skipped} 封，失败 ${failed} 封。`);
    else announce(`正在获取发票文件：${countLabel}`);
}

