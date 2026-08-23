import { prefersReducedMotion } from './dom.js';
import { sanitizeText } from './redaction.js';

/* showToast(title, sub, kind, options)
   options: number (legacy duration) | { duration, detail, sticky, scope }
   - success/info → role="status", auto-dismiss, page-scoped
   - failures (kind === 'err') → role="alert", sticky until dismissed,
     global scope so navigation cannot silently drop them (FE-10)
   - hover/focus pauses the dismissal timer
   - technical output only appears inside the redacted「诊断信息」disclosure
   - exit always goes through dismissToastElement for a leave animation (UI-07) */
let toastClipboardCallback = () => undefined;

export function setToastClipboardCallback(callback) {
    toastClipboardCallback = callback;
}

export const MAX_VISIBLE_TOASTS = 4;
export const TOAST_LEAVE_MS = 160;

export function toastStack() {
    let stack = document.querySelector('.toast-stack');
    if (!stack) {
        stack = document.createElement('div');
        stack.className = 'toast-stack';
        document.body.appendChild(stack);
    }
    return stack;
}

export function clearToastTimer(toast) {
    if (!toast) return;
    const id = Number(toast.dataset.toastTimer || 0);
    if (id) window.clearTimeout(id);
    delete toast.dataset.toastTimer;
}

export function dismissToastElement(toast, opts = {}) {
    if (!toast || toast.dataset.toastLeaving === 'true') return;
    // UI-07 / NEW-DEFECT 6: centralize timer cleanup so dismissed toasts
    // never keep a duration callback that fires after DOM removal.
    clearToastTimer(toast);
    if (prefersReducedMotion() || opts.immediate) {
        toast.dataset.toastLeaving = 'true';
        toast.remove();
        return;
    }
    toast.dataset.toastLeaving = 'true';
    toast.classList.add('is-leaving');
    const finish = () => { if (toast.isConnected) toast.remove(); };
    toast.addEventListener('animationend', finish, { once: true });
    window.setTimeout(finish, TOAST_LEAVE_MS + 40);
}

/* Sticky errors must never be deleted by trim or navigation. Disposable
   toasts go first; if sticky still overflow, the stack scrolls (FE-10). */
export function trimToastStack(stack) {
    const toasts = Array.from(stack.querySelectorAll('.toast:not(.is-leaving)'));
    const excess = toasts.length - MAX_VISIBLE_TOASTS;
    if (excess <= 0) return;
    const disposable = toasts.filter((el) => el.dataset.toastSticky !== 'true');
    disposable.slice(0, excess).forEach((el) => dismissToastElement(el));
}

/* Close non-sticky page-scoped toasts only. Sticky/global errors survive. */
export function dismissPageToasts() {
    document.querySelectorAll('.toast[data-toast-scope="page"]').forEach((el) => {
        if (el.dataset.toastSticky === 'true') return;
        dismissToastElement(el);
    });
}

export function normalizeToastOptions(title, sub, kind, options) {
    const opts = typeof options === 'number'
        ? { duration: options }
        : (options && typeof options === 'object' ? options : {});
    const isError = kind === 'err';
    const sticky = opts.sticky ?? isError;
    // Errors default to global so SPA navigation cannot wipe unacked failures.
    const scope = opts.scope ? opts.scope : (isError || sticky ? 'global' : 'page');
    const duration = Math.max(1500, Number(opts.duration) || (kind === 'warn' ? 4200 : 2600));
    const detail = opts.detail ? sanitizeText(opts.detail) : '';
    const safeSub = sub ? sanitizeText(sub) : '';
    const signature = `${kind}|${title}|${safeSub}|${detail}`;
    return { detail, duration, isError, safeSub, scope, signature, sticky };
}

export function mergeRepeatedToast(stack, signature) {
    // Merge repeats of the same message instead of stacking copies.
    const existing = Array.from(stack.querySelectorAll('.toast:not(.is-leaving)'))
        .find((el) => el.dataset.toastSignature === signature);
    if (existing) {
        const count = Number(existing.dataset.toastCount || 1) + 1;
        existing.dataset.toastCount = String(count);
        let badge = existing.querySelector('[data-toast-repeat]');
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'toast__repeat';
            badge.dataset.toastRepeat = 'true';
            existing.querySelector('[data-toast-title]')?.appendChild(badge);
        }
        badge.textContent = ` ×${count}`;
        stack.appendChild(existing); // Re-sort to the bottom so it stays visible.
        existing.dispatchEvent(new CustomEvent('mfh:toast-repeat'));
        return existing;
    }
    return null;
}

export function constructToastElement(title, kind, normalized) {
    const { detail, isError, safeSub, scope, signature, sticky } = normalized;
    const toast = document.createElement('div');
    toast.className = `toast ${kind}`;
    toast.setAttribute('role', isError ? 'alert' : 'status');
    toast.setAttribute('aria-live', isError ? 'assertive' : 'polite');
    toast.tabIndex = -1;
    toast.dataset.toastSignature = signature;
    toast.dataset.toastScope = scope;
    toast.dataset.toastSticky = sticky ? 'true' : 'false';
    toast.dataset.toastCount = '1';

    const close = document.createElement('button');
    close.className = 'toast__close';
    close.type = 'button';
    close.setAttribute('aria-label', '关闭提示');
    close.textContent = '×';

    const titleEl = document.createElement('div');
    titleEl.className = 'strong';
    titleEl.dataset.toastTitle = 'true';
    titleEl.textContent = String(title ?? '');

    toast.append(close, titleEl);
    if (safeSub) {
        const subEl = document.createElement('div');
        subEl.className = 'toast__sub';
        subEl.textContent = safeSub;
        toast.appendChild(subEl);
    }
    if (detail) {
        const details = document.createElement('details');
        details.className = 'toast__detail';
        const summaryEl = document.createElement('summary');
        summaryEl.textContent = '诊断信息（已脱敏）';
        const pre = document.createElement('pre');
        pre.textContent = detail;
        details.append(summaryEl, pre);
        const actions = document.createElement('div');
        actions.className = 'toast__actions';
        const copyBtn = document.createElement('button');
        copyBtn.className = 'btn btn--sm btn--ghost';
        copyBtn.type = 'button';
        copyBtn.dataset.toastCopy = 'true';
        copyBtn.textContent = '复制诊断信息';
        actions.appendChild(copyBtn);
        toast.append(details, actions);
    }
    return toast;
}

export function wireToastDetailCopy(toast, title, safeSub, detail) {
    toast.querySelector('[data-toast-copy]')?.addEventListener('click', () => {
        toastClipboardCallback(`${title}\n${safeSub}\n\n${detail}`, '诊断信息');
    });
}

export function wireToastLifecycle(toast, sticky, duration) {
    const dismiss = () => dismissToastElement(toast);
    const schedule = () => {
        // UI-07: refuse scheduling for sticky, leaving, or disconnected toasts
        // (trim/mouseleave/focusout can race after dismissal).
        if (sticky) return;
        if (toast.dataset.toastLeaving === 'true') return;
        if (!toast.isConnected) return;
        clearToastTimer(toast);
        const timer = window.setTimeout(dismiss, duration);
        toast.dataset.toastTimer = String(timer);
    };
    toast.querySelector('.toast__close')?.addEventListener('click', dismiss);
    toast.addEventListener('mouseenter', () => clearToastTimer(toast));
    toast.addEventListener('mouseleave', schedule);
    toast.addEventListener('focusin', () => clearToastTimer(toast));
    toast.addEventListener('focusout', schedule);
    toast.addEventListener('mfh:toast-repeat', schedule);
    schedule();
}

export function showToast(title, sub, kind = 'ok', options) {
    const normalized = normalizeToastOptions(title, sub, kind, options);
    const stack = toastStack();
    const existing = mergeRepeatedToast(stack, normalized.signature);
    if (existing) return existing;

    const toast = constructToastElement(title, kind, normalized);
    stack.appendChild(toast);
    // Trim may immediately dismiss this toast when sticky items fill the stack.
    trimToastStack(stack);
    wireToastDetailCopy(toast, title, normalized.safeSub, normalized.detail);
    wireToastLifecycle(toast, normalized.sticky, normalized.duration);
    return toast;
}
