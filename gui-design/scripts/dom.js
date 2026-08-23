/* ---------- Checkbox helpers ----------
   `.check` is now a native <input type="checkbox">. These helpers keep
   working if any legacy div.check.is-on markup is still around. */
export function isChecked(el) {
    if (!el) return false;
    if (typeof el.checked === 'boolean' && el.tagName === 'INPUT') return el.checked;
    return el.classList.contains('is-on');
}
export function setChecked(el, value) {
    if (!el) return;
    const on = Boolean(value);
    if (el.tagName === 'INPUT') el.checked = on;
    else el.classList.toggle('is-on', on);
}
export function checkedBySelector(selector, scope) {
    return isChecked((scope || document).querySelector(selector));
}

/* ---------- Screen-reader announcements ---------- */
export function liveRegion(kind) {
    const id = kind === 'alert' ? 'mfh-live-alert' : 'mfh-live-status';
    let el = document.getElementById(id);
    if (!el) {
        el = document.createElement('div');
        el.id = id;
        el.className = 'sr-only';
        if (kind === 'alert') {
            el.setAttribute('role', 'alert');
        } else {
            el.setAttribute('role', 'status');
            el.setAttribute('aria-live', 'polite');
        }
        document.body.appendChild(el);
    }
    return el;
}

export const ANNOUNCE_THROTTLE_MS = 700;
export let lastAnnounceAt = 0;
export let announceTimer = 0;
export function announce(message, kind = 'status') {
    if (!message) return;
    if (kind === 'alert') {
        liveRegion('alert').textContent = String(message);
        return;
    }
    // Throttle progress chatter so a fast task does not flood the SR queue.
    const now = Date.now();
    const region = liveRegion('status');
    window.clearTimeout(announceTimer);
    const wait = Math.max(0, ANNOUNCE_THROTTLE_MS - (now - lastAnnounceAt));
    announceTimer = window.setTimeout(() => {
        lastAnnounceAt = Date.now();
        region.textContent = String(message);
    }, wait);
}

export function prefersReducedMotion() {
    if (document.documentElement.getAttribute('data-motion') === 'off') return true;
    return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
}

/* Restart page enter motion on every SPA commit, including cached revisits.
   UI-05 / NEW-DEFECT 4: generation-guard so a stale 400ms timeout from a
   rapid A→B→A revisit cannot strip the newer animation class. */
export let pageEnterGen = 0;
export function playPageEnter(mainEl) {
    const page = mainEl?.querySelector?.('.page') || mainEl;
    if (!page || !page.classList) return;
    const gen = ++pageEnterGen;
    page.dataset.pageEnterGen = String(gen);
    page.classList.remove('is-page-entering');
    // Force reflow so re-adding the class retriggers the animation.
    void page.offsetWidth;
    page.classList.add('is-page-entering');
    const clear = () => {
        if (page.dataset.pageEnterGen !== String(gen)) return;
        page.classList.remove('is-page-entering');
    };
    page.addEventListener('animationend', clear, { once: true });
    window.setTimeout(clear, 400);
}

export function text(selector, value) {
    document.querySelectorAll(selector).forEach((el) => { el.textContent = value; });
}

export function activeMain() {
    return document.querySelector('main.main:not([style*="display: none"])') || document;
}

export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    })[ch]);
}

