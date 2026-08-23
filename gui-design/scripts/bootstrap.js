import { loadBridgeConfig, loadBridgeSummary, wireOperationProgress } from './bridge.js';
import { applyLiveState } from './config-view.js';
import { announce, isChecked, setChecked } from './dom.js';
import { enforceMatchScope } from './filters.js';
import { wireOpState } from './op-state.js';
import { handleAction, persistConfigCheck, wireSearch } from './operations.js';
import { renderPendingGroups } from './pending-view.js';
import { wireLogFollow } from './progress.js';
import { renderInboxRows, renderLibraryRows } from './records.js';
import { markPageLoaded, pageIdFromPath, showPage, updateActiveNav } from './router.js';
import { getMotion, getTheme, refreshClock, setMotion, setTheme, sidebarHTML, titlebarHTML, upgradeStaticMarkup } from './shell-ui.js';
import { getState } from './state.js';
import { showToast } from './toast.js';

/* ---------- Wiring ---------- */
let bootstrapWired = false;

export function injectShell() {
    if (!document.body.dataset.page && location.pathname.endsWith('/index.html')) {
        window.location.replace('pages/dashboard.html');
        return false;
    }
    // Inject titlebar (drag region) + sidebar shell if marker exists.
    const titleMount = document.getElementById('titlebar-mount');
    if (titleMount) titleMount.outerHTML = titlebarHTML();

    const shellMount = document.getElementById('app-shell');
    if (shellMount) {
        const active = document.body.dataset.page || '';
        shellMount.outerHTML = sidebarHTML(active);
    }

    // Theme apply
    setTheme(getTheme());
    setMotion(getMotion());
    return true;
}

export function wireDelegatedClick() {
    // Theme toggle buttons and common controls.
    document.body.addEventListener('click', (e) => {
        const t = e.target.closest('[data-theme-toggle]');
        if (t) { setTheme(getTheme() === 'light' ? 'dark' : 'light'); }

        // Ripple coords for primary buttons
        const btn = e.target.closest('.btn--primary');
        if (btn) {
            const r = btn.getBoundingClientRect();
            btn.style.setProperty('--rx', `${e.clientX - r.left}px`);
            btn.style.setProperty('--ry', `${e.clientY - r.top}px`);
        }

        // Group accordion toggles (native button + aria-expanded/controls)
        const gh = e.target.closest('.group__head');
        if (gh) {
            const group = gh.closest('.group');
            const open = !group.classList.contains('is-open');
            group.classList.toggle('is-open', open);
            gh.setAttribute('aria-expanded', open ? 'true' : 'false');
            const body = gh.getAttribute('aria-controls') ? document.getElementById(gh.getAttribute('aria-controls')) : null;
            if (body) body.setAttribute('aria-hidden', open ? 'false' : 'true');
        }

        const spaLink = e.target.closest('a[data-spa-page]');
        if (spaLink) {
            e.preventDefault();
            showPage(spaLink.dataset.spaPage, spaLink.getAttribute('href'));
            return;
        }
        const pageLink = e.target.closest('a[href$=".html"]');
        const pageId = pageLink ? pageIdFromPath(pageLink.getAttribute('href') || '') : '';
        if (pageLink && pageId) {
            e.preventDefault();
            showPage(pageId, pageLink.getAttribute('href'));
            return;
        }

        const sortButton = e.target.closest('.table thead th .th-sort');
        if (sortButton) {
            const sortHeader = sortButton.closest('th');
            const key = sortHeader?.dataset.sortKey;
            if (key) {
                const page = document.body.dataset.page;
                const stateKey = page === 'library' ? 'sortLibrary' : page === 'inbox' ? 'sortInbox' : '';
                if (stateKey) {
                    const prev = getState()[stateKey] || { key: '', dir: 'asc' };
                    const dir = prev.key === key && prev.dir === 'asc' ? 'desc' : 'asc';
                    getState()[stateKey] = { key, dir };
                    getState().sortKey = key;
                    getState().sortDir = dir;
                    sortHeader.parentElement.querySelectorAll('th[data-sort-key]').forEach((x) => x.setAttribute('aria-sort', 'none'));
                    sortHeader.setAttribute('aria-sort', dir === 'asc' ? 'ascending' : 'descending');
                    if (page === 'inbox') renderInboxRows();
                    else if (page === 'library') renderLibraryRows();
                    announce(`已按${sortButton.textContent.trim()}${dir === 'asc' ? '升序' : '降序'}排序`);
                }
            }
        }

        // Tabs
        const tab = e.target.closest('.tabs .tab');
        if (tab) {
            tab.parentElement.querySelectorAll('.tab').forEach((t) => {
                t.classList.remove('is-active');
                t.setAttribute('aria-pressed', 'false');
            });
            tab.classList.add('is-active');
            tab.setAttribute('aria-pressed', 'true');
            if (tab.dataset.libraryTab) renderLibraryRows();
            if (tab.dataset.pendingTab) renderPendingGroups();
        }

        // Filter chip toggle (native button + aria-pressed)
        const chip = e.target.closest('.filterbar .chip[data-toggle]');
        if (chip) {
            const on = !chip.classList.contains('is-active');
            chip.classList.toggle('is-active', on);
            chip.setAttribute('aria-pressed', on ? 'true' : 'false');
            const filter = String(chip.dataset.filter || '');
            if (filter.startsWith('inbox-')) renderInboxRows();
            else if (filter.startsWith('library-')) renderLibraryRows();
            else { renderInboxRows(); renderLibraryRows(); }
        }

        const action = e.target.closest('[data-action]');
        if (action && !t && !action.closest('.tabs') && !action.closest('#date-preset-buttons')) {
            // Catch here so any action handler that rejects (e.g. an IPC error)
            // shows feedback instead of becoming a silent unhandled rejection.
            Promise.resolve(handleAction(action)).catch((err) => showToast('运行失败', '这个操作没有完成，请重试。', 'err', { detail: err?.message }));
        }
    });
}

export function wireInputChange() {
    // Read-only tables: no persistent selection highlight (nothing consumed it).

    document.body.addEventListener('input', (e) => {
        if (e.target.matches('[data-search="inbox"]')) renderInboxRows();
        if (e.target.matches('[data-search="library"]')) renderLibraryRows();
    });

    document.body.addEventListener('change', (e) => {
        if (e.target.matches('[data-library-seller]')) renderLibraryRows();
        const ck = e.target.closest('.check');
        if (!ck) return;
        const on = isChecked(ck);
        const configKey = ck.dataset.configCheck;
        if (configKey) {
            document.querySelectorAll(`.check[data-config-check="${configKey}"]`).forEach((peer) => {
                if (peer !== ck) setChecked(peer, on);
            });
            // Persist the change for checks outside the config page; the config page
            // has its own debounced auto-save that already handles its own checks.
            if (!ck.closest('main.main[data-spa-page="config"]') && document.body.dataset.page !== 'config') {
                persistConfigCheck(configKey, on);
            }
        }
        if (ck.dataset.fetchCheck === 'matchSubject' || ck.dataset.fetchCheck === 'matchBody') {
            enforceMatchScope(ck);
        }
        if (String(ck.dataset.filter || '').startsWith('library-')) renderLibraryRows();
        if (String(ck.dataset.filter || '').startsWith('inbox-')) renderInboxRows();
    });
}

export function wireGlobalLifecycle() {
    refreshClock();
    window.setInterval(refreshClock, 30000);
    wireSearch();
}

export function startHydration() {
    loadBridgeSummary();
    loadBridgeConfig();
    wireOperationProgress();
    wireOpState();
    window.addEventListener('popstate', () => {
        const page = pageIdFromPath(location.pathname);
        if (page) showPage(page, null, { push: false });
    });
    const initialPage = document.body.dataset.page || pageIdFromPath(location.pathname);
    markPageLoaded(initialPage);
    updateActiveNav(initialPage);
    upgradeStaticMarkup(document);
    wireLogFollow();
    applyLiveState(initialPage);
}

/* 壳层只允许绑定一次，避免重复注册委托事件与桥接订阅。 */
export function wire() {
    if (bootstrapWired) return;
    bootstrapWired = true;
    if (!injectShell()) return;
    wireDelegatedClick();
    wireInputChange();
    wireGlobalLifecycle();
    startHydration();
}

