import { loadBridgeConfig, loadBridgeSummary } from './bridge.js';
import { applyLiveState } from './config-view.js';
import { announce, playPageEnter } from './dom.js';
import { wireLogFollow } from './progress.js';
import { searchPlaceholder, upgradeStaticMarkup } from './shell-ui.js';
import { dismissPageToasts, showToast } from './toast.js';

export const SPA_PAGES = new Set(['dashboard', 'inbox', 'library', 'pending', 'config', 'settings']);
export const PAGE_META = {
    dashboard: { heading: '开始处理', title: '开始处理 · 发票助手' },
    inbox:     { heading: '邮件记录', title: '邮件记录 · 发票助手' },
    library:   { heading: '发票库',   title: '发票库 · 发票助手' },
    pending:   { heading: '待确认',   title: '待确认 · 发票助手' },
    config:    { heading: '邮箱与保存', title: '邮箱与保存 · 发票助手' },
    settings:  { heading: '关于',     title: '关于 · 发票助手' },
};
export const PAGE_SCRIPT_INIT = {
    config: () => window.MFH_PAGE_INIT?.config?.(),
};

export function pageIdFromPath(pathname) {
    const match = /\/([^/]+)\.html$/.exec(pathname);
    const name = match?.[1] || '';
    return SPA_PAGES.has(name) ? name : '';
}

export function pathForPage(pageId) {
    if (!SPA_PAGES.has(pageId)) return '';
    return `${pageId}.html`;
}

export function markPageLoaded(pageId) {
    if (!pageId) return;
    const main = document.querySelector('main.main');
    if (main) {
        main.dataset.spaPage = pageId;
        main.dataset.spaLoaded = 'true';
    }
    document.body.dataset.page = pageId;
}

export function updateActiveNav(pageId) {
    document.querySelectorAll('[data-spa-page]').forEach((link) => {
        const active = link.dataset.spaPage === pageId;
        link.classList.toggle('is-active', active);
        if (link.classList.contains('nav-item')) {
            if (active) link.setAttribute('aria-current', 'page');
            else link.removeAttribute('aria-current');
        }
    });
}

/* Per-page in-flight load cache: a double click can never append two
   <main> elements or execute a page's inline script twice. */
export const pageLoads = new Map();
// Monotonic navigation token — only the newest request may commit.
export let navToken = 0;

export async function loadPageMain(pageId, href) {
    const existing = document.querySelector(`main.main[data-spa-page="${pageId}"]`);
    if (existing) return existing;
    const cached = pageLoads.get(pageId);
    if (cached) return cached;
    const promise = (async () => {
        const url = href || pathForPage(pageId);
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`无法加载页面：${url}`);
        const html = await response.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const main = doc.querySelector('main.main');
        if (!main) throw new Error(`页面缺少 main：${url}`);
        // A concurrent request may have finished while we were awaiting.
        const raced = document.querySelector(`main.main[data-spa-page="${pageId}"]`);
        if (raced) return raced;
        const clone = main.cloneNode(true);
        clone.dataset.spaPage = pageId;
        clone.dataset.spaLoaded = 'true';
        clone.style.display = 'none';
        document.querySelector('.app')?.appendChild(clone);
        upgradeStaticMarkup(clone);
        for (const script of doc.querySelectorAll('script')) {
            // 壳层脚本只在首屏执行一次；SPA 导航重放它们会重复注册事件委托与
            // 桥接订阅。shell-ready.js 自身幂等，这里跳过只是省一次无谓的取回。
            if (script.src && /\/scripts\/shell(-ready)?\.js/.test(script.src)) continue;
            if (script.src && /\.\.\/scripts\/shell(-ready)?\.js/.test(script.getAttribute('src') || '')) continue;
            const node = document.createElement('script');
            if (script.src) node.src = script.src;
            else node.textContent = script.textContent || '';
            document.body.appendChild(node);
            if (!script.src) node.remove();
        }
        PAGE_SCRIPT_INIT[pageId]?.();
        return clone;
    })();
    pageLoads.set(pageId, promise);
    try {
        return await promise;
    } catch (err) {
        pageLoads.delete(pageId); // Allow a retry after a failed load.
        throw err;
    }
}

/* The link and the content own their pending state separately: a stale
   navigation may only clear what it set itself, otherwise finishing first
   would wipe the newer navigation's feedback (FB-03). */
export function setNavLinkPending(pageId, pending) {
    document.querySelectorAll('.nav-item[data-spa-page]').forEach((link) => {
        if (link.dataset.spaPage !== pageId) return;
        if (pending) link.setAttribute('aria-busy', 'true');
        else link.removeAttribute('aria-busy');
    });
}

export function setContentPending(pending) {
    const current = document.querySelector('main.main:not([style*="display: none"])');
    if (!current) return;
    if (pending) current.setAttribute('aria-busy', 'true');
    else current.removeAttribute('aria-busy');
}

export function showLoadingHint(pageId, token) {
    // Only surfaced when the load is actually slow (~150ms), so fast local
    // navigations never flash a skeleton.
    return window.setTimeout(() => {
        if (token !== navToken) return;
        const current = document.querySelector('main.main:not([style*="display: none"])');
        if (!current || current.querySelector('.page-skeleton')) return;
        const hint = document.createElement('div');
        hint.className = 'page-skeleton';
        hint.dataset.navSkeleton = String(token);
        const note = document.createElement('div');
        note.className = 'page-skeleton__note';
        note.textContent = `正在打开「${PAGE_META[pageId]?.heading || '页面'}」…`;
        hint.appendChild(note);
        for (const width of ['40%', '100%', '80%']) {
            const bar = document.createElement('div');
            bar.className = 'skeleton';
            bar.style.height = width === '40%' ? '14px' : '10px';
            bar.style.width = width;
            hint.appendChild(bar);
        }
        current.appendChild(hint);
        announce(`正在打开${PAGE_META[pageId]?.heading || '页面'}`);
    }, 150);
}

/* Only removes the skeleton this navigation created. */
export function clearLoadingHint(timer, token) {
    window.clearTimeout(timer);
    document.querySelectorAll(`[data-nav-skeleton="${token}"]`).forEach((el) => el.remove());
}

export async function showPage(pageId, href, opts = {}) {
    if (!SPA_PAGES.has(pageId)) return;
    const current = document.querySelector('main.main:not([style*="display: none"])');
    if (current?.dataset.spaPage === pageId) return;
    const token = ++navToken;
    setNavLinkPending(pageId, true);
    setContentPending(true);
    const hintTimer = showLoadingHint(pageId, token);
    try {
        const target = await loadPageMain(pageId, href);
        // A newer navigation started while this one was loading: discard.
        if (token !== navToken) return;
        document.querySelectorAll('main.main').forEach((main) => {
            main.style.display = main === target ? '' : 'none';
        });
        document.body.dataset.page = pageId;
        updateActiveNav(pageId);
        const meta = PAGE_META[pageId];
        if (meta) document.title = meta.title;
        const search = document.querySelector('[data-global-search]');
        if (search) {
            const placeholder = searchPlaceholder(pageId);
            search.placeholder = placeholder;
            document.querySelector('label[for="global-search"]')?.replaceChildren(placeholder);
        }
        target.scrollTop = 0;
        target.querySelector('.page')?.scrollTo?.({ top: 0, behavior: 'auto' });
        const heading = target.querySelector('.toolbar__title');
        if (heading) {
            heading.setAttribute('tabindex', '-1');
            heading.focus({ preventScroll: true });
        }
        wireLogFollow();
        // Non-sticky page toasts belong to the page the user just left.
        // Sticky errors stay until the user dismisses them (FE-10).
        dismissPageToasts();
        // Replay route enter animation for cached SPA pages (UI-05).
        playPageEnter(target);
        // A freshly inserted page must reflect the live state (running job,
        // real app version/channel) instead of its static placeholders.
        applyLiveState(pageId);
        announce(`${meta?.heading || pageId} 已打开`);
        if (opts.push !== false) {
            history.pushState({ page: pageId }, '', pathForPage(pageId));
        }
        // Flush config autosave before any hydrate that might overwrite drafts (FE-02).
        if (typeof window.MFH_CONFIG_FLUSH_SAVE === 'function') {
            try { await window.MFH_CONFIG_FLUSH_SAVE(); } catch { /* save error already toasted */ }
        }
        await loadBridgeSummary();
        await loadBridgeConfig();
        // Replay again once the summary/config payloads have landed: the
        // OCR status cards and the mutex locks depend on them.
        if (token === navToken) applyLiveState(pageId);
    } catch (err) {
        if (token === navToken) showToast('页面加载失败', '请重试，或重启应用。', 'err', { detail: err?.message });
    } finally {
        // Never clear a newer navigation's feedback: the skeleton is keyed by
        // token and the content busy flag only belongs to the current one.
        clearLoadingHint(hintTimer, token);
        setNavLinkPending(pageId, false);
        if (token === navToken) setContentPending(false);
    }
}

