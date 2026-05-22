/* 发票助手桌面端壳层。
   为 Electron 预留 window.mfhBridge，当前静态预览会使用本地演示数据。 */

(function () {
    'use strict';

    // Initialise the shared scratch object early so async code that fires before
    // wire() / DOMContentLoaded (e.g. config readiness resolvers) has a target.
    window.FPH = window.FPH || {};

    /* ---------- Inline icons (lucide-style, 16×16) ---------- */
    const ICON = {
        play:     '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg>',
        inbox:    '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"></polyline><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path></svg>',
        library:  '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="9" y1="13" x2="15" y2="13"></line><line x1="9" y1="17" x2="15" y2="17"></line></svg>',
        pending:  '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>',
        config:   '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle></svg>',
        info:     '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>',
        search:   '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>',
        sun:      '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"></circle><line x1="12" y1="2" x2="12" y2="4"></line><line x1="12" y1="20" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="6.34" y2="6.34"></line><line x1="17.66" y1="17.66" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="4" y2="12"></line><line x1="20" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="6.34" y2="17.66"></line><line x1="17.66" y1="6.34" x2="19.07" y2="4.93"></line></svg>',
        moon:     '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>',
        chev:     '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>',
        refresh:  '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"></path><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"></path></svg>',
        download: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>',
        filter:   '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>',
        stop:     '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="1"></rect></svg>',
        plus:     '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>',
        clock:    '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>'
    };

    const NAV = [
        { group: '日常操作', items: [
            { id: 'dashboard', label: '开始处理', href: 'dashboard.html', icon: 'play',    badge: '⌘R' },
            { id: 'inbox',     label: '邮件记录', href: 'inbox.html',     icon: 'inbox',   badge: '0', badgeKey: 'inbox' },
            { id: 'library',   label: '发票库',   href: 'library.html',   icon: 'library', badge: '0', badgeKey: 'library' },
            { id: 'pending',   label: '待确认',   href: 'pending.html',   icon: 'pending', badge: '0', badgeKey: 'pending'  },
        ]},
        { group: '设置', items: [
            { id: 'config',    label: '邮箱与保存', href: 'config.html',    icon: 'config' },
            { id: 'settings',  label: '关于',       href: 'settings.html',  icon: 'info'   },
        ]},
    ];
    const SPA_PAGES = new Set(['dashboard', 'inbox', 'library', 'pending', 'config', 'settings']);
    const PAGE_SCRIPT_INIT = {
        dashboard: () => window.MFH_PAGE_INIT?.dashboard?.(),
        config: () => window.MFH_PAGE_INIT?.config?.(),
    };

    function navHTML(active) {
        return NAV.map(sec => `
            <div class="nav-group">
                <div class="nav-group__title">${sec.group}</div>
                ${sec.items.map(it => `
                    <a class="nav-item ${it.id === active ? 'is-active' : ''}" href="${document.body.dataset.page ? it.href : rel(it.href)}" data-spa-page="${it.id}">
                        <span class="nav-item__icon">${ICON[it.icon]}</span>
                        <span>${it.label}</span>
                        ${it.badge ? `<span class="nav-item__badge" ${it.badgeKey ? `data-nav-badge="${it.badgeKey}"` : ''}>${it.badge}</span>` : ''}
                    </a>
                `).join('')}
            </div>
        `).join('');
    }

    function rel(path) {
        return document.body.dataset.page ? path : `pages/${path}`;
    }

    function sidebarHTML(active) {
        return `
            <aside class="sidebar">
                <div class="sidebar__brand">
                    <div class="sidebar__logo">F</div>
                    <div>
                        <div class="sidebar__title">发票助手</div>
                        <div class="sidebar__ver">本地预览版</div>
                    </div>
                </div>
                <div class="sidebar__search">
                    <span class="sidebar__search-icon">${ICON.search}</span>
                    <input type="text" placeholder="搜索发票或邮件…" aria-label="搜索发票或邮件" data-global-search>
                    <kbd>⌘K</kbd>
                </div>
                <div class="sidebar__nav">
                    ${navHTML(active)}
                </div>
                <div class="sidebar__foot">
                    <span class="status-dot" data-mail-status-dot></span>
                    <span data-mail-status-label>邮箱未配置</span>
                    <span class="sidebar__foot-meta" data-clock>--:--</span>
                    <button class="theme-toggle" data-theme-toggle aria-label="切换到深色主题" title="切换到深色主题">${ICON.moon}</button>
                </div>
            </aside>
        `;
    }

    function titlebarHTML() {
        return `<div class="titlebar" aria-hidden="true"></div>`;
    }

    /* ---------- Theme persistence ---------- */
    function getTheme() { return localStorage.getItem('fph_theme') || 'light'; }
    function setTheme(t) {
        if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
        else document.documentElement.removeAttribute('data-theme');
        localStorage.setItem('fph_theme', t);
        document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
            btn.innerHTML = t === 'light' ? ICON.moon : ICON.sun;
            btn.setAttribute('aria-label', t === 'light' ? '切换到深色主题' : '切换到亮色主题');
            btn.setAttribute('title', t === 'light' ? '切换到深色主题' : '切换到亮色主题');
        });
    }

    function getMotion() { return localStorage.getItem('fph_motion') || 'on'; }
    function setMotion(v) {
        if (v === 'off') document.documentElement.setAttribute('data-motion', 'off');
        else document.documentElement.removeAttribute('data-motion');
        localStorage.setItem('fph_motion', v);
    }

    /* ---------- Wiring ---------- */
    function wire() {
        if (!document.body.dataset.page && location.pathname.endsWith('/index.html')) {
            window.location.replace('pages/dashboard.html');
            return;
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

            // Group accordion toggles
            const gh = e.target.closest('.group__head');
            if (gh) gh.parentElement.classList.toggle('is-open');

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

            const sortHeader = e.target.closest('.table thead th');
            if (sortHeader) {
                const key = sortHeader.dataset.sortKey;
                if (key) {
                    const page = document.body.dataset.page;
                    const stateKey = page === 'library' ? 'sortLibrary' : page === 'inbox' ? 'sortInbox' : '';
                    if (stateKey) {
                        const prev = window.FPH[stateKey] || { key: '', dir: 'asc' };
                        const dir = prev.key === key && prev.dir === 'asc' ? 'desc' : 'asc';
                        window.FPH[stateKey] = { key, dir };
                        window.FPH.sortKey = key;
                        window.FPH.sortDir = dir;
                        sortHeader.parentElement.querySelectorAll('th').forEach(x => x.classList.remove('is-sorted', 'is-sorted-desc'));
                        sortHeader.classList.add('is-sorted');
                        if (dir === 'desc') sortHeader.classList.add('is-sorted-desc');
                        if (page === 'inbox') renderInboxRows();
                        else if (page === 'library') renderLibraryRows();
                    }
                }
            }

            // Tabs
            const tab = e.target.closest('.tabs .tab');
            if (tab) {
                tab.parentElement.querySelectorAll('.tab').forEach(t => t.classList.remove('is-active'));
                tab.classList.add('is-active');
                if (tab.dataset.libraryTab) renderLibraryRows();
                if (tab.dataset.pendingTab) renderPendingGroups();
            }

            // Filter chip toggle
            const chip = e.target.closest('.filterbar .chip[data-toggle]');
            if (chip) {
                chip.classList.toggle('is-active');
                const filter = String(chip.dataset.filter || '');
                if (filter.startsWith('inbox-')) renderInboxRows();
                else if (filter.startsWith('library-')) renderLibraryRows();
                else { renderInboxRows(); renderLibraryRows(); }
            }

            // Toggle controls
            const tg = e.target.closest('.toggle');
            if (tg) tg.classList.toggle('is-on');

            let ck = e.target.closest('.check');
            if (!ck) {
                // Clicking on label text should also toggle the inner .check (no native checkbox here).
                const label = e.target.closest('label');
                if (label && !label.classList.contains('field__label')) {
                    const inner = label.querySelector('.check');
                    if (inner) ck = inner;
                }
            }
            if (ck) {
                ck.classList.toggle('is-on');
                const configKey = ck.dataset.configCheck;
                if (configKey) {
                    const isOn = ck.classList.contains('is-on');
                    document.querySelectorAll(`.check[data-config-check="${configKey}"]`).forEach((peer) => {
                        if (peer !== ck) peer.classList.toggle('is-on', isOn);
                    });
                    // Persist the change for checks outside the config page; the config page
                    // has its own debounced auto-save that already handles its own checks.
                    if (!ck.closest('main.main[data-spa-page="config"]') && document.body.dataset.page !== 'config') {
                        persistConfigCheck(configKey, isOn);
                    }
                }
                if (ck.dataset.filter === 'library-failed') renderLibraryRows();
            }

            const action = e.target.closest('[data-action]');
            if (action && !t && !action.closest('.tabs') && !action.closest('#date-preset-buttons')) handleAction(action);
        });

        document.body.addEventListener('click', (e) => {
            const row = e.target.closest('.table tbody tr');
            if (!row) return;
            row.parentElement.querySelectorAll('tr').forEach(x => x.classList.remove('is-selected'));
            row.classList.add('is-selected');
        });

        document.body.addEventListener('input', (e) => {
            if (e.target.matches('[data-search="inbox"]')) renderInboxRows();
            if (e.target.matches('[data-search="library"]')) renderLibraryRows();
        });

        document.body.addEventListener('change', (e) => {
            if (e.target.matches('[data-library-seller]')) renderLibraryRows();
        });

        refreshClock();
        window.setInterval(refreshClock, 30000);
        wireSearch();
        loadBridgeSummary();
        loadBridgeConfig();
        wireOperationProgress();
        window.addEventListener('popstate', () => {
            const page = pageIdFromPath(location.pathname);
            if (page) showPage(page, null, { push: false });
        });
        markPageLoaded(document.body.dataset.page || pageIdFromPath(location.pathname));
    }

    function pageIdFromPath(pathname) {
        const match = /\/([^/]+)\.html$/.exec(pathname);
        const name = match?.[1] || '';
        return SPA_PAGES.has(name) ? name : '';
    }

    function pathForPage(pageId) {
        if (!SPA_PAGES.has(pageId)) return '';
        return `${pageId}.html`;
    }

    function markPageLoaded(pageId) {
        if (!pageId) return;
        const main = document.querySelector('main.main');
        if (main) {
            main.dataset.spaPage = pageId;
            main.dataset.spaLoaded = 'true';
        }
        document.body.dataset.page = pageId;
    }

    function updateActiveNav(pageId) {
        document.querySelectorAll('[data-spa-page]').forEach((link) => {
            link.classList.toggle('is-active', link.dataset.spaPage === pageId);
        });
    }

    async function loadPageMain(pageId, href) {
        const url = href || pathForPage(pageId);
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`无法加载页面：${url}`);
        const html = await response.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const main = doc.querySelector('main.main');
        if (!main) throw new Error(`页面缺少 main：${url}`);
        const clone = main.cloneNode(true);
        clone.dataset.spaPage = pageId;
        clone.dataset.spaLoaded = 'true';
        clone.style.display = 'none';
        document.querySelector('.app')?.appendChild(clone);
        for (const script of doc.querySelectorAll('script')) {
            if (script.src && script.src.includes('/scripts/shell.js')) continue;
            if (script.src && script.getAttribute('src')?.includes('../scripts/shell.js')) continue;
            const node = document.createElement('script');
            if (script.src) node.src = script.src;
            else node.textContent = script.textContent || '';
            document.body.appendChild(node);
            if (!script.src) node.remove();
        }
        PAGE_SCRIPT_INIT[pageId]?.();
        return clone;
    }

    async function showPage(pageId, href, opts = {}) {
        if (!SPA_PAGES.has(pageId)) return;
        const current = document.querySelector('main.main:not([style*="display: none"])');
        if (current?.dataset.spaPage === pageId) return;
        try {
            let target = document.querySelector(`main.main[data-spa-page="${pageId}"]`);
            if (!target) target = await loadPageMain(pageId, href);
            document.querySelectorAll('main.main').forEach((main) => {
                main.style.display = main === target ? '' : 'none';
            });
            document.body.dataset.page = pageId;
            updateActiveNav(pageId);
            await loadBridgeSummary();
            await loadBridgeConfig();
            if (opts.push !== false) {
                history.pushState({ page: pageId }, '', pathForPage(pageId));
            }
        } catch (err) {
            showToast('页面加载失败', err?.message || '请重试。', 'err');
        }
    }

    function refreshClock() {
        const now = new Date();
        const text = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        document.querySelectorAll('[data-clock]').forEach((el) => { el.textContent = text; });
    }

    function text(selector, value) {
        document.querySelectorAll(selector).forEach((el) => { el.textContent = value; });
    }

    function activeMain() {
        return document.querySelector('main.main:not([style*="display: none"])') || document;
    }

    function fmtInt(value) {
        return Number(value || 0).toLocaleString('zh-CN');
    }

    function fmtDateTime(value) {
        const d = new Date(value);
        if (!Number.isFinite(d.getTime())) return '';
        return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    function fmtDuration(ms) {
        const n = Number(ms || 0);
        if (!Number.isFinite(n) || n <= 0) return '';
        if (n < 1000) return `${Math.round(n)} 毫秒`;
        return `${(n / 1000).toFixed(1)} 秒`;
    }

    function historyTime(value) {
        const d = new Date(value);
        if (!Number.isFinite(d.getTime())) return '未知时间';
        const today = new Date();
        const sameDay = d.getFullYear() === today.getFullYear()
            && d.getMonth() === today.getMonth()
            && d.getDate() === today.getDate();
        const day = sameDay ? '今天' : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        return `${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    function pill(label, kind = '') {
        return `<span class="pill ${kind ? `pill--${kind}` : ''}">${label}</span>`;
    }

    function sourceLabel(source) {
        if (source === 'http') return '本机识别';
        if (source === 'cli') return '单次识别';
        return source || '归档文件';
    }

    function documentTypeLabel(value) {
        if (value === 'itinerary') return '行程单';
        if (value === 'supporting') return '支撑材料';
        if (value === 'invoice') return '发票';
        return value || '未分类';
    }

    function reasonLabel(value) {
        const v = String(value || '');
        if (v.includes('rule_unhandled')) return '暂未识别';
        if (v.includes('parse_failed')) return '解析失败';
        if (v.includes('supporting')) return '支撑材料';
        if (v.includes('missing_file')) return '文件缺失';
        if (v.includes('http_403') || v.includes('403')) return '链接过期';
        if (v.includes('no_pdf_links')) return '没有下载文件';
        return v ? '需要确认' : '待处理';
    }

    function statusPill(label) {
        if (label === '完整') return pill('完整', 'ok');
        if (label === '待补充') return pill('待补充', 'warn');
        if (label === '识别失败') return pill('识别失败', 'err');
        return pill(label || '已识别');
    }

    function sortableValue(row, key) {
        const value = row?.[key];
        if (key === 'date') {
            const t = Date.parse(value || '');
            return Number.isFinite(t) ? t : 0;
        }
        if (key === 'bodyLinkCount') return Number(value || 0);
        if (key === 'hasAttachment') return value ? 1 : 0;
        if (key === 'amount') return Number(String(value || '').replace(/[^\d.-]/g, '')) || 0;
        return String(value || '').toLowerCase();
    }

    function sortRows(rows, scope) {
        const page = document.body.dataset.page;
        const stateKey = scope || (page === 'library' ? 'sortLibrary' : page === 'inbox' ? 'sortInbox' : '');
        const state = stateKey ? window.FPH[stateKey] : null;
        const key = state?.key || '';
        if (!key) return rows;
        const dir = state?.dir === 'asc' ? 1 : -1;
        return rows.slice().sort((a, b) => {
            const av = sortableValue(a, key);
            const bv = sortableValue(b, key);
            if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
            return String(av).localeCompare(String(bv), 'zh-CN') * dir;
        });
    }

    async function loadBridgeSummary() {
        if (!window.mfhBridge?.getSummary) return;
        try {
            const summary = await window.mfhBridge.getSummary();
            window.FPH.summary = summary;
            applySummary(summary);
        } catch (err) {
            showToast('读取本地数据失败', err?.message || '请检查配置文件是否完整。', 'err');
        }
    }

    async function loadBridgeConfig() {
        if (!window.mfhBridge?.getConfig) return;
        try {
            const payload = await window.mfhBridge.getConfig();
            window.FPH.configPayload = payload;
            applyConfig(payload.config || {}, payload.secrets || {});
        } catch {
            // Config page keeps its inline defaults when no local config exists.
        } finally {
            window.FPH.configReady = true;
            window.FPH._configReadyResolvers?.forEach((resolve) => resolve());
            window.FPH._configReadyResolvers = [];
        }
    }

    function whenConfigReady() {
        if (!window.mfhBridge?.getConfig) return Promise.resolve();
        if (window.FPH?.configReady) return Promise.resolve();
        return new Promise((resolve) => {
            window.FPH._configReadyResolvers = window.FPH._configReadyResolvers || [];
            window.FPH._configReadyResolvers.push(resolve);
        });
    }

    function wireOperationProgress() {
        window.mfhBridge?.onOperationProgress?.((data) => {
            if (!data || data.operation !== 'ocr') return;
            applyOcrProgress(data);
        });
        window.mfhBridge?.onFileProgress?.((data) => {
            if (!data || data.operation !== 'files') return;
            applyFileProgress(data);
        });
    }

    function logTime() {
        const now = new Date();
        return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    }

    function consoleLine(tag, message, kind = '') {
        return `<div class="console__line"><span class="console__time">${logTime()}</span><span class="console__tag ${kind}">${escapeHtml(tag)}</span><span class="console__msg">${escapeHtml(message)}</span></div>`;
    }

    function resetOcrProgress(message = '正在准备识别文件。') {
        document.querySelectorAll('[data-ocr-progress]').forEach((el) => {
            el.classList.remove('is-idle', 'is-done', 'is-error');
        });
        document.querySelectorAll('[data-ocr-bar]').forEach((el) => {
            el.style.setProperty('--p', '0%');
        });
        text('[data-ocr-phase]', '准备识别');
        text('[data-ocr-counts]', '0 / 0');
        text('[data-ocr-parsed]', '0');
        text('[data-ocr-skipped]', '0');
        text('[data-ocr-failed]', '0');
        setOcrControlState('running');
        document.querySelectorAll('[data-ocr-parallel]').forEach((el) => { el.disabled = true; });
        document.querySelectorAll('[data-ocr-log]').forEach((el) => {
            el.innerHTML = consoleLine('准备', message);
            el.scrollTop = el.scrollHeight;
        });
    }

    function appendOcrLog(message, kind = '') {
        if (!message) return;
        document.querySelectorAll('[data-ocr-log]').forEach((el) => {
            el.querySelectorAll('[data-placeholder]').forEach((p) => p.remove());
            el.insertAdjacentHTML('beforeend', consoleLine(kind === 'ok' ? '成功' : kind === 'warn' ? '提醒' : kind === 'err' ? '失败' : '进度', message, kind));
            el.scrollTop = el.scrollHeight;
        });
    }

    function applyOcrProgress(data) {
        const total = Number(data.total || 0);
        const processed = Number(data.processed || 0);
        const parsed = Number(data.parsed || 0);
        const skipped = Number(data.skipped || 0);
        const failed = Number(data.failed || 0);
        const percent = data.percent === undefined
            ? (total > 0 ? Math.min(96, Math.round((processed / total) * 100)) : 12)
            : Math.max(0, Math.min(100, Number(data.percent) || 0));
        const ocrErrored = data.kind === 'err';
        document.querySelectorAll('[data-ocr-progress]').forEach((el) => {
            el.classList.remove('is-idle');
            el.classList.toggle('is-error', ocrErrored);
            el.classList.toggle('is-done', !ocrErrored && (Boolean(data.done) || percent >= 100));
        });
        document.querySelectorAll('[data-ocr-bar]').forEach((el) => {
            el.style.setProperty('--p', `${percent}%`);
        });
        text('[data-ocr-phase]', data.phase || (data.done ? '识别完成' : '正在识别'));
        text('[data-ocr-counts]', `${fmtInt(processed)} / ${fmtInt(total)}`);
        text('[data-ocr-parsed]', fmtInt(parsed));
        text('[data-ocr-skipped]', fmtInt(skipped));
        text('[data-ocr-failed]', fmtInt(failed));
        setOcrControlState(data.done ? 'idle' : 'running');
        document.querySelectorAll('[data-ocr-parallel]').forEach((el) => { el.disabled = !data.done; });
        if (data.done) {
            window.clearTimeout(window.FPH?._stopOcrFallback);
            if (window.FPH) window.FPH._stopOcrFallback = 0;
        }
        appendOcrLog(data.message, data.kind || '');
    }

    function hasRecognizedResults() {
        const summary = window.FPH.summary || {};
        const library = summary.library || {};
        const pending = Number(library.pending || 0);
        return pending <= 0 && (Number(library.recognized || 0) > 0 || (window.FPH.libraryRows || []).length > 0);
    }

    function setOcrControlState(state) {
        const running = state === 'running';
        document.querySelectorAll('[data-action="ocr-toggle"]').forEach((el) => {
            el.disabled = false;
            el.classList.toggle('btn--danger', running);
            el.classList.toggle('btn--primary', !running);
            const ownerMain = el.closest('main.main');
            const ownerPage = ownerMain?.dataset.spaPage || document.body.dataset.page;
            const longLabel = ownerPage === 'dashboard';
            if (running) {
                el.dataset.ocrMode = 'stop';
                el.textContent = '停止识别';
            } else if (hasRecognizedResults()) {
                el.dataset.ocrMode = 'rerun';
                el.textContent = longLabel ? '重新识别发票文件' : '重新识别';
            } else {
                el.dataset.ocrMode = 'start';
                el.textContent = longLabel ? '开始识别发票文件' : '开始识别';
            }
        });
    }

    function resetFileProgress(message = '正在准备获取发票文件。') {
        document.querySelectorAll('[data-file-progress]').forEach((el) => {
            el.classList.remove('is-idle', 'is-done', 'is-error');
        });
        document.querySelectorAll('[data-file-bar]').forEach((el) => {
            el.style.setProperty('--p', '0%');
        });
        text('[data-file-phase]', '准备获取');
        text('[data-file-counts]', '0 封');
        text('[data-file-processed]', '0');
        text('[data-file-skipped]', '0');
        text('[data-file-failed]', '0');
        document.querySelectorAll('[data-file-log]').forEach((el) => {
            el.innerHTML = consoleLine('准备', message);
            el.scrollTop = el.scrollHeight;
        });
    }

    function appendFileLog(message, kind = '') {
        if (!message) return;
        document.querySelectorAll('[data-file-log]').forEach((el) => {
            el.querySelectorAll('[data-placeholder]').forEach((p) => p.remove());
            el.insertAdjacentHTML('beforeend', consoleLine(kind === 'ok' ? '完成' : kind === 'warn' ? '提醒' : kind === 'err' ? '失败' : '进度', message, kind));
            el.scrollTop = el.scrollHeight;
        });
    }

    function applyFileProgress(data) {
        const processed = Number(data.processed || 0);
        const skipped = Number(data.skipped || 0);
        const failed = Number(data.failed || 0);
        const percent = data.percent === undefined
            ? Math.min(96, 12 + (processed + skipped + failed) * 4)
            : Math.max(0, Math.min(100, Number(data.percent) || 0));
        const fileErrored = data.kind === 'err';
        document.querySelectorAll('[data-file-progress]').forEach((el) => {
            el.classList.remove('is-idle');
            el.classList.toggle('is-error', fileErrored);
            el.classList.toggle('is-done', !fileErrored && (Boolean(data.done) || percent >= 100));
        });
        document.querySelectorAll('[data-file-bar]').forEach((el) => {
            el.style.setProperty('--p', `${percent}%`);
        });
        text('[data-file-phase]', data.phase || (data.done ? '获取完成' : '正在获取'));
        text('[data-file-counts]', `${fmtInt(processed)} 封`);
        text('[data-file-processed]', fmtInt(processed));
        text('[data-file-skipped]', fmtInt(skipped));
        text('[data-file-failed]', fmtInt(failed));
        appendFileLog(data.message, data.kind || '');
    }

    function applySummary(summary) {
        window.FPH.summary = summary;
        const inbox = summary.inbox || {};
        const library = summary.library || {};
        const pending = summary.pending || {};
        text('[data-nav-badge="inbox"]', fmtInt(inbox.total));
        text('[data-nav-badge="library"]', fmtInt(library.recognized));
        text('[data-nav-badge="pending"]', fmtInt(pending.total));
        text('[data-summary="config-path"]', summary.configExists ? '本机配置已加载' : '使用示例配置预览');

        applyDashboardSummary(summary);
        applyInboxSummary(inbox);
        applyLibrarySummary(library);
        applyPendingSummary(pending);
        applyHistory(summary.history || []);
        applyCurrentBatch(inbox.rows || []);
        setOcrControlState('idle');
    }

    function applyDashboardSummary(summary) {
        const inbox = summary.inbox || {};
        const library = summary.library || {};
        const pending = summary.pending || {};
        text('[data-dash="cached-mails"]', fmtInt(inbox.total));
        text('[data-dash="cached-range"]', inbox.earliestMonth && inbox.latestMonth ? `${inbox.earliestMonth} 至 ${inbox.latestMonth}` : '暂无本地缓存');
        text('[data-dash="recognized"]', fmtInt(library.recognized));
        text('[data-dash="failed"]', fmtInt(library.failed));
        text('[data-dash="ignored"]', fmtInt(library.ignored));
        const ocrGroups = library.ocr?.byDocumentType || [];
        const groupCount = (key) => ocrGroups.find((group) => group.key === key)?.count || 0;
        text('[data-dash="invoice-like"]', fmtInt(Math.max(0, groupCount('invoice') || library.invoiceLike || 0)));
        text('[data-dash="itinerary"]', fmtInt(groupCount('itinerary') || library.itinerary || 0));
        text('[data-dash="supporting"]', fmtInt(groupCount('supporting') || library.supporting || 0));
        text('[data-dash="pending-total"]', `${fmtInt(pending.total)} 封`);
    }

    function applyHistory(history) {
        const mount = document.querySelector('[data-run-history]');
        if (!mount) return;
        mount.innerHTML = history.slice(0, 6).map((item) => {
            const kind = item.status === 'success' ? 'ok' : item.status === 'partial' ? 'warn' : 'err';
            const label = item.status === 'success' ? '成功' : item.status === 'partial' ? '部分成功' : '失败';
            return `
                <div class="history-item history-item--${kind}">
                    <div class="row row--between mb-12">
                        <span class="mono small strong">${escapeHtml(historyTime(item.time))}</span>
                        ${pill(label, kind)}
                    </div>
                    <div class="small muted">${escapeHtml(item.title || '本地操作')}</div>
                    <div class="mono small muted mt-12">${escapeHtml(item.message || '已记录')} ${item.durationMs ? `· ${escapeHtml(fmtDuration(item.durationMs))}` : ''}</div>
                </div>
            `;
        }).join('') || `
                <div class="empty empty--compact">
                    <div class="empty__title">还没有运行记录</div>
                    <div class="empty__sub">点击“开始获取邮件”或“开始识别发票文件”后，这里会显示真实结果。</div>
                </div>
            `;
        const total = document.querySelector('[data-history-total]');
        if (total) total.textContent = `${fmtInt(history.length)} 条记录`;
    }

    function applyCurrentBatch(rows) {
        const tbody = document.querySelector('[data-current-batch-rows]');
        if (!tbody) return;
        tbody.innerHTML = rows.slice(0, 12).map((row, index) => `
            <tr>
                <td class="faint">${String(index + 1).padStart(2, '0')}</td>
                <td class="mono">${fmtDateTime(row.date)}</td>
                <td>${escapeHtml(row.subject || '无主题')}</td>
                <td class="small">${escapeHtml(shortSender(row.from))}</td>
                <td class="mono col-num">${row.hasAttachment ? '有' : '-'}</td>
                <td class="mono col-num">${fmtInt(row.bodyLinkCount)}</td>
                <td>${pill('已缓存', 'ok')}</td>
            </tr>
        `).join('') || '<tr><td colspan="7" class="muted">本地暂无缓存邮件。完成抓取后会在这里显示。</td></tr>';
    }

    function applyInboxSummary(inbox) {
        text('[data-inbox="total"]', fmtInt(inbox.total));
        text('[data-inbox="with-attachment"]', fmtInt(inbox.withAttachment));
        text('[data-inbox="with-links"]', fmtInt(inbox.withLinks));
        text('[data-inbox="earliest"]', inbox.earliestMonth || '暂无');
        const total = Number(inbox.total || 0);
        const pct = (n) => total > 0 ? `占比 ${Math.round((Number(n || 0) / total) * 100)}%` : '占比 —';
        text('[data-inbox-delta="attachment"]', pct(inbox.withAttachment));
        text('[data-inbox-delta="links"]', pct(inbox.withLinks));
        if (Array.isArray(inbox.rows)) window.FPH.inboxRows = inbox.rows.slice();
        renderInboxRows();
    }

    function renderInboxRows() {
        const scope = activeMain();
        const tbody = scope.querySelector('[data-inbox-rows]');
        if (!tbody) return;
        const query = String(scope.querySelector('[data-search="inbox"]')?.value || '').trim().toLowerCase();
        const attachmentOnly = scope.querySelector('[data-filter="inbox-attachment"]')?.classList.contains('is-active');
        const linksOnly = scope.querySelector('[data-filter="inbox-links"]')?.classList.contains('is-active');
        const rows = sortRows((window.FPH.inboxRows || []).filter((row) => {
            const haystack = `${row.messageId || ''} ${row.from || ''} ${row.subject || ''} ${row.mailbox || ''}`.toLowerCase();
            if (query && !haystack.includes(query)) return false;
            if (attachmentOnly && !row.hasAttachment) return false;
            if (linksOnly && Number(row.bodyLinkCount || 0) <= 0) return false;
            return true;
        }), 'sortInbox');
        tbody.innerHTML = rows.slice(0, 80).map((row) => `
            <tr>
                <td class="mono">${fmtDateTime(row.date)}</td>
                <td>${escapeHtml(shortSender(row.from))}<br><span class="small muted">${escapeHtml(row.from || '')}</span></td>
                <td>${escapeHtml(row.subject || '无主题')}</td>
                <td class="mono col-num">${row.hasAttachment ? '有' : '-'}</td>
                <td class="mono col-num">${fmtInt(row.bodyLinkCount)}</td>
                <td><span class="pill">${escapeHtml(row.mailbox || '邮箱')}</span></td>
                <td>${pill('已缓存', 'ok')}</td>
            </tr>
        `).join('') || `<tr><td colspan="7" class="muted">没有找到匹配邮件。你可以换个关键词或取消筛选。</td></tr>`;
        text('[data-inbox-page]', `显示 ${fmtInt(Math.min(rows.length, 80))} · 共 ${fmtInt(rows.length)} 行`);
    }

    function applyLibrarySummary(library) {
        text('[data-lib="total"]', fmtInt(library.total || library.pending || 0));
        text('[data-lib="recognized"]', fmtInt(library.recognized));
        text('[data-lib="ignored"]', fmtInt(library.ignored));
        text('[data-lib="failed"]', fmtInt(library.failed));
        text('[data-lib="pending"]', fmtInt(library.pending));
        text('[data-lib="invoice-like"]', fmtInt(library.invoiceLike));
        text('[data-lib="itinerary"]', fmtInt(library.itinerary));
        text('[data-lib="supporting"]', fmtInt(library.supporting));

        if (Array.isArray(library.rows)) window.FPH.libraryRows = library.rows.slice();
        renderLibraryRows();
        updateSellerOptions(window.FPH.libraryRows || []);
    }

    function renderLibraryRows() {
        const scope = activeMain();
        const tbody = scope.querySelector('[data-library-rows]');
        if (!tbody) return;
        const query = String(scope.querySelector('[data-search="library"]')?.value || '').trim().toLowerCase();
        const activeTab = scope.querySelector('[data-library-tab].is-active')?.dataset.libraryTab || 'all';
        const seller = scope.querySelector('[data-library-seller]')?.value || '';
        const failedOnly = scope.querySelector('[data-filter="library-failed"]')?.classList.contains('is-on');
        const rows = sortRows((window.FPH.libraryRows || []).filter((row) => {
            const haystack = `${row.seller || ''} ${row.invoiceNo || ''} ${row.amount || ''} ${row.filename || ''} ${row.error || ''}`.toLowerCase();
            if (query && !haystack.includes(query)) return false;
            if (seller && row.seller !== seller) return false;
            const status = String(row.status || '');
            const docType = String(row.documentType || '');
            if (failedOnly && status !== '识别失败') return false;
            if (activeTab === 'recognized' && status === '识别失败') return false;
            if (activeTab === 'failed' && status !== '识别失败') return false;
            if (activeTab === 'supporting' && docType !== 'supporting') return false;
            if (activeTab === 'itinerary' && docType !== 'itinerary') return false;
            return true;
        }), 'sortLibrary');
        tbody.innerHTML = rows.slice(0, 80).map((row) => `
            <tr>
                <td class="mono">${escapeHtml((row.date || '').slice(0, 10))}</td>
                <td>${escapeHtml(row.seller || '未识别销售方')}</td>
                <td class="mono">${escapeHtml(row.invoiceNo || '-')}</td>
                <td class="mono col-num">${escapeHtml(row.amount || '-')}</td>
                <td><span class="pill">${escapeHtml(sourceLabel(row.source))}</span></td>
                <td class="mono small">${escapeHtml(row.filename || '')}</td>
                <td>${statusPill(row.status)}</td>
                <td><button class="btn btn--sm" data-action="open-row-file" data-file-path="${escapeHtml(row.filePath || '')}"${row.filePath ? '' : ' disabled title="该记录没有对应文件路径"'}>打开</button></td>
            </tr>
        `).join('') || `<tr><td colspan="8" class="muted">没有找到匹配结果。你可以换个关键词或取消筛选。</td></tr>`;
        text('[data-library-page]', `显示 ${fmtInt(Math.min(rows.length, 80))} · 共 ${fmtInt(rows.length)} 条`);
        text('[data-library-sellers]', seller ? `销售方：${seller}` : '销售方：全部');
    }

    function updateSellerOptions(rows) {
        const select = activeMain().querySelector('[data-library-seller]');
        if (!select) return;
        const sellers = Array.from(new Set(rows.map((row) => row.seller).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN'));
        const current = select.value;
        select.innerHTML = '<option value="">全部销售方</option>' + sellers.map((seller) => `<option value="${escapeHtml(seller)}">${escapeHtml(seller)}</option>`).join('');
        if (sellers.includes(current)) select.value = current;
    }

    const KNOWN_PENDING_ACTIONS = new Set(['refresh_link', 'retry', 'ignore', 'manual_archive']);
    function actionText(action) {
        if (action === 'refresh_link') return ['打开原始邮件', '在邮件中刷新授权后重新抓取'];
        if (action === 'retry') return ['重新尝试', '适合临时网络失败'];
        if (action === 'ignore') return ['确认忽略', '从待确认队列中移除'];
        if (action === 'manual_archive') return ['选择文件归档', '把下载好的文件复制到归档目录'];
        return ['等待新版本', '当前版本暂未支持这种处理方式'];
    }

    function applyPendingSummary(pending) {
        window.FPH.pending = pending;
        text('[data-pending="total"]', fmtInt(pending.total));
        const groups = pending.groups || [];
        document.querySelectorAll('[data-pending-stats]').forEach((mount) => {
            if (groups.length === 0) {
                mount.innerHTML = `
                    <div class="stat">
                        <div class="stat__label">暂无待确认</div>
                        <div class="stat__value">0</div>
                        <div class="stat__delta is-flat">无需处理</div>
                    </div>
                `;
                return;
            }
            mount.innerHTML = groups.map((group) => {
                const [action] = actionText(group.action);
                return `
                    <div class="stat">
                        <div class="stat__label">${escapeHtml(group.title || '待确认')}</div>
                        <div class="stat__value">${fmtInt(group.count)}</div>
                        <div class="stat__delta">${escapeHtml(action)}</div>
                    </div>
                `;
            }).join('');
        });
        renderPendingGroups();
    }

    function renderPendingGroups() {
        const mount = activeMain().querySelector('[data-pending-groups]');
        if (!mount) return;
        const pending = window.FPH.pending || {};
        const activeTab = activeMain().querySelector('[data-pending-tab].is-active')?.dataset.pendingTab || 'all';
        const allGroups = pending.groups || [];
        const groups = allGroups.filter((group) => {
            if (activeTab === 'all') return true;
            return group.action === activeTab;
        });
        const emptyMarkup = allGroups.length === 0
            ? '<div class="card"><div class="strong">暂无待确认邮件</div><div class="small muted mt-12">当前本地队列为空。</div></div>'
            : '<div class="card"><div class="strong">当前分类暂无邮件</div><div class="small muted mt-12">切换到「全部」可以查看其它分类的邮件。</div></div>';
        mount.innerHTML = groups.map((group) => {
            const [primary, note] = actionText(group.action);
            const isKnownAction = KNOWN_PENDING_ACTIONS.has(group.action);
            const disabledAttr = isKnownAction ? '' : ' disabled title="当前版本暂未支持这种处理方式"';
            const rows = (group.rows || []).slice(0, 6).map((row) => `
                <div class="card card--tight pending-item">
                    <div class="row gap-8 mb-12">
                        ${pill(reasonLabel(row.reason), group.action === 'refresh_link' ? 'warn' : '')}
                        <span class="pill">${escapeHtml(note)}</span>
                        <span class="mono small muted">${escapeHtml(row.hash)}</span>
                    </div>
                    <div class="strong pending-item__subject">${escapeHtml(row.subject || '无主题')}</div>
                    <div class="mono small muted">${escapeHtml((row.date || '').slice(0, 10))} · ${escapeHtml(row.from || '')}</div>
                    <div class="row gap-8 mt-12">
                        <button class="btn btn--sm btn--primary" data-action="pending-primary" data-hash="${escapeHtml(row.hash)}" data-action-kind="${escapeHtml(group.action)}"${disabledAttr}>${primary}</button>
                        <button class="btn btn--sm btn--ghost" data-action="copy-text" data-copy-text="${escapeHtml(row.reason)}">复制原因</button>
                    </div>
                </div>
            `).join('');
            return `
                <div class="group is-open">
                    <div class="group__head">
                        ${ICON.chev.replace('class="ic"', 'class="ic group__chev"')}
                        <div class="group__title">${escapeHtml(group.title)}</div>
                        <span class="group__count">${fmtInt(group.count)}</span>
                    </div>
                    <div class="group__body">
                        <div class="group__inner">
                            <div class="small muted mb-12">${escapeHtml(group.description || '')}</div>
                            ${rows || '<div class="card card--tight muted">暂无明细</div>'}
                        </div>
                    </div>
                </div>
            `;
        }).join('') || emptyMarkup;
    }

    function applyMailStatus(cfg, secrets) {
        const imap = cfg?.imap || {};
        const host = typeof imap.host === 'string' ? imap.host.trim() : '';
        const user = typeof imap.user === 'string' ? imap.user.trim() : '';
        const pass = typeof imap.pass === 'string' ? imap.pass.trim() : '';
        // Secrets are redacted at the IPC boundary; consult the boolean shadow if available.
        const hasPass = Boolean(secrets?.imapPass ?? pass);
        const configured = Boolean(host && user && hasPass);
        document.querySelectorAll('[data-mail-status-label]').forEach((el) => {
            el.textContent = configured ? `已配置 · ${user}` : '邮箱未配置';
        });
        document.querySelectorAll('[data-mail-status-dot]').forEach((el) => {
            el.classList.toggle('is-off', !configured);
        });
        document.querySelectorAll('[data-mail-status-meta]').forEach((el) => {
            el.textContent = configured ? `邮箱已配置 · ${host}` : '请先在「配置」页填写邮箱';
        });
    }

    function applyConfig(cfg, secrets = {}) {
        applyMailStatus(cfg, secrets);
        const set = (selector, value) => {
            const el = document.querySelector(selector);
            if (el && value !== undefined && value !== null) el.value = value;
        };
        set('[data-config="imap.host"]', cfg.imap?.host);
        set('[data-config="imap.port"]', cfg.imap?.port);
        set('[data-config="imap.user"]', cfg.imap?.user);
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
            el.classList.toggle('is-on', cfg.imap?.tls !== false);
        });
        set('[data-config="filter.keywords"]', Array.isArray(cfg.filter?.keywords) ? cfg.filter.keywords.join(', ') : '');
        const matchSubject = cfg.filter?.matchSubject !== false;
        const matchBody = cfg.filter?.matchBody !== false;
        document.querySelectorAll('[data-fetch-check="matchSubject"]').forEach((el) => el.classList.toggle('is-on', matchSubject));
        document.querySelectorAll('[data-fetch-check="matchBody"]').forEach((el) => el.classList.toggle('is-on', matchBody));
        set('[data-config="paths.samples"]', cfg.paths?.samples);
        set('[data-config="paths.invoices"]', cfg.paths?.invoices);
        set('[data-config="paths.pending"]', cfg.paths?.pending);
        const setText = (selector, value) => {
            document.querySelectorAll(selector).forEach((el) => {
                if (value) el.textContent = value;
            });
        };
        setText('[data-settings-path="samples"]', cfg.paths?.samples);
        setText('[data-settings-path="invoices"]', cfg.paths?.invoices);
        setText('[data-settings-path="pending"]', cfg.paths?.pending);
        set('[data-config="output.csv"]', cfg.output?.csv);
        set('[data-config="rename.rule"]', cfg.rename?.rule);
        set('[data-config="rename.fallback"]', cfg.rename?.fallback);
        set('[data-config="rename.typeDirRule"]', cfg.rename?.typeDirRule);
        window.MFH_UPDATE_RENAME_PREVIEW?.();
        document.querySelectorAll('[data-config-check="rename.avoidConflictBeforeOcr"]').forEach((el) => {
            el.classList.toggle('is-on', cfg.rename?.avoidConflictBeforeOcr !== false);
        });
        document.querySelectorAll('[data-config-check="rename.applyAfterOcr"]').forEach((el) => {
            el.classList.toggle('is-on', cfg.rename?.applyAfterOcr === true);
        });
        document.querySelectorAll('[data-config-check="rename.organizeByType"]').forEach((el) => {
            el.classList.toggle('is-on', cfg.rename?.organizeByType === true);
        });
        set('[data-config="network.retries"]', cfg.network?.retries);
        set('[data-config="network.retryDelayMs"]', cfg.network?.retryDelayMs);
        set('[data-config="ocr.provider"]', cfg.ocr?.enabled === false ? 'none' : (cfg.ocr?.provider || 'efapiao'));
        set('[data-config="ocr.ocrMode"]', cfg.ocr?.ocrMode || 'auto');
        set('[data-config="ocr.executionMode"]', cfg.ocr?.executionMode);
        set('[data-config="ocr.resultsCsv"]', cfg.ocr?.resultsCsv);
        set('[data-config="ocr.serviceHost"]', cfg.ocr?.serviceHost);
        set('[data-config="ocr.servicePort"]', cfg.ocr?.servicePort);
        set('[data-config="ocr.serviceWorkers"]', cfg.ocr?.serviceWorkers);
        set('[data-config="ocr.batchSize"]', cfg.ocr?.batchSize);
        const setSecretPlaceholder = (selector, hasValue) => {
            const el = document.querySelector(selector);
            if (!el) return;
            if (hasValue && !el.value) {
                el.placeholder = '已保存（留空则不修改）';
            }
        };
        setSecretPlaceholder('[data-config="imap.pass"]', Boolean(secrets.imapPass ?? cfg.imap?.pass));
        setSecretPlaceholder('[data-config="ocr.credentials.tencentSecretId"]', Boolean(secrets.tencentSecretId ?? cfg.ocr?.credentials?.tencentSecretId ?? cfg.ocr?.credentials?.secretId));
        setSecretPlaceholder('[data-config="ocr.credentials.tencentSecretKey"]', Boolean(secrets.tencentSecretKey ?? cfg.ocr?.credentials?.tencentSecretKey ?? cfg.ocr?.credentials?.secretKey));
        set('[data-config="ocr.credentials.tencentRegion"]', cfg.ocr?.credentials?.tencentRegion || cfg.ocr?.credentials?.region || 'ap-shanghai');
        set('[data-config="playwright.browserManagement"]', cfg.playwright?.browserManagement || 'app-managed');
        set('[data-config="playwright.timeoutMs"]', cfg.playwright?.timeoutMs);
    }

    function wireSearch() {
        document.querySelector('[data-global-search]')?.addEventListener('keydown', async (event) => {
            if (event.key !== 'Enter') return;
            const q = String(event.currentTarget.value || '').trim();
            if (!q) return;
            // Honor current page: searching from inbox should filter inbox, not jump to library.
            const currentPage = document.body.dataset.page;
            const targetPage = currentPage === 'inbox' ? 'inbox' : 'library';
            await showPage(targetPage);
            const selector = targetPage === 'inbox' ? '[data-search="inbox"]' : '[data-search="library"]';
            const input = document.querySelector(`main.main:not([style*="display: none"]) ${selector}`);
            if (input) {
                input.value = q;
                if (targetPage === 'inbox') renderInboxRows();
                else renderLibraryRows();
            }
        });
        document.addEventListener('keydown', (event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
                const input = document.querySelector('[data-global-search]');
                if (!input) return;
                event.preventDefault();
                input.focus();
                input.select?.();
            }
        });
        const params = new URLSearchParams(window.location.search);
        const q = params.get('q');
        if (q) {
            const input = document.querySelector('[data-search="library"], [data-search="inbox"]');
            if (input) {
                input.value = q;
                window.setTimeout(() => {
                    renderLibraryRows();
                    renderInboxRows();
                }, 0);
            }
        }
    }

    // Async-button guard: prevents double-clicks and shows a "正在…" label while awaiting.
    const BUSY_ACTIONS = new Set([
        'test-connection',
        'reload-mailboxes',
        'developer-reset',
        'clear-secret',
        'organize',
        'rename-organize',
        'run-pipeline',
        'rerun-pipeline',
        'pending-primary',
        'discard-config',
        'ocr-toggle',
    ]);
    const BUSY_LABELS = {
        'test-connection': '正在连接邮箱…',
        'reload-mailboxes': '正在读取…',
        'developer-reset': '正在删除…',
        'clear-secret': '正在清除…',
        'organize': '正在整理…',
        'rename-organize': '正在改名…',
        'run-pipeline': '正在获取…',
        'rerun-pipeline': '正在重新获取…',
        'pending-primary': '处理中…',
        'discard-config': '正在读取…',
    };

    async function withBusyButton(button, runner) {
        if (button.dataset.busy === 'true') return undefined;
        const original = button.innerHTML;
        const wasDisabled = button.disabled;
        const isOcrToggle = button.dataset.action === 'ocr-toggle';
        button.dataset.busy = 'true';
        button.disabled = true;
        const label = BUSY_LABELS[button.dataset.action];
        if (label) button.textContent = label;
        try {
            return await runner();
        } finally {
            button.dataset.busy = '';
            // For ocr-toggle, setOcrControlState / stopOcr own the label and disabled state
            // for the full lifecycle of the OCR run, so don't restore here.
            if (!isOcrToggle) {
                button.disabled = wasDisabled;
                button.innerHTML = original;
            }
        }
    }

    async function handleAction(action) {
        const name = action.dataset.action;
        if (BUSY_ACTIONS.has(name)) {
            // For pending-primary, also lock peer buttons so users can't fire on multiple rows.
            const peers = name === 'pending-primary'
                ? Array.from(document.querySelectorAll('[data-action="pending-primary"]')).filter((el) => el !== action)
                : [];
            const peerStates = peers.map((el) => ({ el, wasDisabled: el.disabled }));
            for (const { el } of peerStates) el.disabled = true;
            try {
                return await withBusyButton(action, () => handleActionImpl(action, name));
            } finally {
                for (const { el, wasDisabled } of peerStates) el.disabled = wasDisabled;
            }
        }
        return handleActionImpl(action, name);
    }

    async function handleActionImpl(action, name) {
        if (name === 'reload-summary') { await loadBridgeSummary(); showToast('已刷新', '本地列表已重新读取。'); return; }
        if (name === 'preview-fetch') { showFetchPreview(); return; }
        if (name === 'export-log') { exportVisibleLog(); return; }
        if (name === 'export-table') { exportVisibleTable(action); return; }
        if (name === 'copy-text') { await copyText(action.dataset.copyText || ''); return; }
        if (name === 'open-invoices-folder') { await openConfiguredPath('paths.invoices', './invoices'); return; }
        if (name === 'open-pending-folder') { await openConfiguredPath('paths.pending', './pending'); return; }
        if (name === 'open-samples-folder') { await openConfiguredPath('paths.samples', './samples/raw'); return; }
        if (name === 'open-row-file') { await openRowFile(action); return; }
        if (name === 'ocr-toggle') { await handleOcrToggle(action); return; }
        if (name === 'organize' || name === 'rename-organize') {
            const fn = window.mfhBridge?.organize;
            if (!fn) { bridgeUnavailable(); return; }
            const applyRename = name === 'rename-organize';
            const result = await fn({ applyRename });
            if (result?.summary) applySummary(result.summary);
            const empty = typeof result?.message === 'string' && result.message.includes('目前没有可整理');
            const kind = result?.ok ? (empty ? 'warn' : 'ok') : 'err';
            const successTitle = applyRename ? '改名完成' : '整理完成';
            const emptyTitle = '没有可整理的识别结果';
            const title = result?.ok ? (empty ? emptyTitle : successTitle) : '运行失败';
            const okFallback = applyRename ? '已按当前规则改名并整理输出。' : '已按当前规则整理输出。';
            showToast(title, result?.message || (result?.ok ? okFallback : '请查看最近运行记录。'), kind);
            return;
        }
        if (name === 'run-pipeline') { await runBridgeAction('runPipeline', { avoidConflictBeforeOcr: downloadRenameEnabled(), force: false }, '获取完成', '已从本地邮件中获取发票文件。'); return; }
        if (name === 'rerun-pipeline') {
            const confirmed = window.confirm('重新获取会忽略已处理标记，重新跑一遍所有邮件。确认继续吗？');
            if (!confirmed) return;
            await runBridgeAction('runPipeline', { avoidConflictBeforeOcr: downloadRenameEnabled(), force: true }, '重新获取完成', '已重新获取本地邮件中的发票文件。');
            return;
        }
        if (name === 'test-connection') { await testConnection(); return; }
        if (name === 'reload-mailboxes') { await reloadMailboxes(); return; }
        if (name === 'discard-config') {
            const hasPending = window.MFH_CONFIG_HAS_PENDING_SAVE?.() === true;
            if (hasPending && !window.confirm('当前还有未保存的改动，重新读取后会被丢弃。确认继续吗？')) {
                return;
            }
            window.MFH_CONFIG_CANCEL_PENDING_SAVE?.();
            await loadBridgeConfig();
            // Clear any lingering invalid markers since values just came from disk.
            document.querySelectorAll('[data-config].is-invalid').forEach((el) => el.classList.remove('is-invalid'));
            showToast('已重新读取配置', '已从本机恢复最新配置。');
            return;
        }
        if (name === 'developer-reset') { await developerReset(); return; }
        if (name === 'pending-primary') { await handlePendingAction(action); return; }
        if (name === 'clear-secret') { await clearSecret(action); return; }
    }

    async function clearSecret(action) {
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
            await window.mfhBridge.saveConfig(patch);
            await loadBridgeConfig();
            const input = document.querySelector(`[data-config="${key}"]`);
            if (input) input.value = '';
            showToast('已清除', `${label}已从本机配置中移除。`, 'warn');
        } catch (err) {
            showToast('清除失败', err?.message || '请重试。', 'err');
        }
    }

    function selectedOcrConcurrency() {
        const scope = activeMain();
        const value = Number(scope.querySelector('[data-ocr-parallel]')?.value || 1);
        return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
    }

    function downloadRenameEnabled() {
        return activeMain().querySelector('[data-download-rename-toggle]')?.classList.contains('is-on') !== false;
    }

    async function handleOcrToggle(action) {
        const mode = action.dataset.ocrMode || 'start';
        if (mode === 'stop') {
            await stopOcr();
            return;
        }
        if (mode === 'rerun') {
            const confirmed = window.confirm('重新识别会删除已有识别结果，并把发票队列重置为待识别。确认继续吗？');
            if (!confirmed) {
                // withBusyButton skips the disabled restore for ocr-toggle, so reset here.
                setOcrControlState('idle');
                return;
            }
            await runOcr(true);
            return;
        }
        if (mode === 'stopping') {
            // Already requested a stop; ignore stacked clicks.
            return;
        }
        await runOcr(false);
    }

    async function runOcr(force) {
        await runBridgeAction('runOcr', {
            force: Boolean(force),
            resetResults: Boolean(force),
            concurrency: selectedOcrConcurrency(),
        }, '识别完成', '已尝试识别本地文件。');
    }

    async function stopOcr() {
        const fn = window.mfhBridge?.stopOcr;
        if (!fn) { bridgeUnavailable(); return; }
        document.querySelectorAll('[data-action="ocr-toggle"]').forEach((el) => {
            el.disabled = true;
            el.dataset.ocrMode = 'stopping';
            el.textContent = '正在停止…';
        });
        const result = await fn();
        if (!result?.ok) {
            setOcrControlState('running');
        } else {
            // Safety net: if the engine ignored SIGTERM, restore the button so the user can retry.
            window.clearTimeout(window.FPH?._stopOcrFallback);
            const timer = window.setTimeout(() => {
                document.querySelectorAll('[data-action="ocr-toggle"]').forEach((el) => {
                    if (el.dataset.ocrMode === 'stopping') {
                        el.disabled = false;
                        el.dataset.ocrMode = 'stop';
                        el.textContent = '再次尝试停止';
                    }
                });
            }, 5000);
            if (window.FPH) window.FPH._stopOcrFallback = timer;
        }
        showToast(result?.ok ? '正在停止识别' : '停止失败', result?.message || '', result?.ok ? 'warn' : 'err');
    }

    function bridgeUnavailable() {
        showToast('请在桌面版中使用', '这个操作需要调用本机程序。静态预览只能查看界面。', 'warn');
    }

    function persistConfigCheck(key, value) {
        const fn = window.mfhBridge?.saveConfig;
        if (!fn) return; // Static preview: no-op rather than nag with a toast.
        const parts = String(key || '').split('.').filter(Boolean);
        if (parts.length === 0) return;
        const patch = {};
        let cur = patch;
        for (let i = 0; i < parts.length - 1; i++) {
            cur[parts[i]] = {};
            cur = cur[parts[i]];
        }
        cur[parts[parts.length - 1]] = value;
        Promise.resolve(fn(patch)).catch((err) => {
            showToast('保存失败', err?.message || '请稍后重试。', 'err');
        });
    }

    async function runBridgeAction(method, payload, okTitle, okMessage) {
        const fn = window.mfhBridge?.[method];
        if (!fn) { bridgeUnavailable(); return; }
        if (method === 'runOcr') resetOcrProgress();
        if (method === 'runPipeline') resetFileProgress();
        let result;
        try {
            result = await fn(payload);
        } catch (err) {
            if (method === 'runOcr') {
                applyOcrProgress({
                    phase: '识别失败',
                    percent: 100,
                    total: 0,
                    processed: 0,
                    parsed: 0,
                    skipped: 0,
                    failed: 0,
                    message: err?.message || '识别失败，请查看最近运行记录。',
                    kind: 'err',
                    done: true,
                });
            }
            if (method === 'runPipeline') {
                applyFileProgress({
                    phase: '获取失败',
                    percent: 100,
                    message: err?.message || '获取发票文件失败，请查看最近运行记录。',
                    kind: 'err',
                    done: true,
                });
            }
            showToast('运行失败', err?.message || '请查看最近运行记录。', 'err');
            return;
        }
        if (result?.summary) applySummary(result.summary);
        if (method === 'runOcr' && !result?.ok && !result?.summary) {
            applyOcrProgress({
                phase: '识别失败',
                percent: 100,
                message: result?.message || result?.stderr || result?.error || '识别失败，请查看最近运行记录。',
                kind: 'err',
                done: true,
            });
        }
        if (method === 'runPipeline' && !result?.ok && !result?.summary) {
            applyFileProgress({
                phase: '获取失败',
                percent: 100,
                message: result?.message || result?.stderr || result?.error || '获取发票文件失败，请查看最近运行记录。',
                kind: 'err',
                done: true,
            });
        }
        showToast(result?.ok ? okTitle : '运行失败', result?.ok ? (result?.message || okMessage) : (result?.message || result?.stderr || result?.error || '请查看最近运行记录。'), result?.ok ? 'ok' : 'err');
    }

    async function openConfiguredPath(key, fallback) {
        const cfg = window.FPH.configPayload?.config || {};
        const value = key.split('.').reduce((cur, part) => cur?.[part], cfg) || fallback;
        if (!window.mfhBridge?.openPath) { bridgeUnavailable(); return; }
        const result = await window.mfhBridge.openPath({ path: value });
        showToast(result?.ok ? '已打开文件夹' : '打开失败', result?.ok ? value : (result?.error || value), result?.ok ? 'ok' : 'err');
    }

    async function openRowFile(action) {
        const value = action.dataset.filePath || '';
        if (!value) {
            showToast('打开失败', '这条记录没有对应文件路径，请先归档源文件。', 'err');
            return;
        }
        if (!window.mfhBridge?.openPath) { bridgeUnavailable(); return; }
        const result = await window.mfhBridge.openPath({ path: value, reveal: true });
        showToast(result?.ok ? '已打开文件位置' : '打开失败', result?.ok ? '已定位到对应文件。' : (result?.error || value), result?.ok ? 'ok' : 'err');
    }

    async function copyText(value, label) {
        try {
            if (window.mfhBridge?.copyText) {
                await window.mfhBridge.copyText({ text: value });
            } else if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(value);
            } else {
                throw new Error('当前环境没有剪贴板权限');
            }
        } catch (err) {
            showToast('复制失败', err?.message || '请改用桌面版或检查权限。', 'err');
            return;
        }
        showToast('已复制', label ? `${label}已复制到剪贴板。` : '内容已复制到剪贴板。');
    }

    async function testConnection() {
        const fn = window.mfhBridge?.testMailConnection;
        if (!fn) { bridgeUnavailable(); return; }
        const payload = typeof window.collectConfigPayload === 'function' ? window.collectConfigPayload() : undefined;
        if (payload && window.mfhBridge?.saveConfig) {
            await window.mfhBridge.saveConfig(payload);
        }
        const result = await fn(payload);
        const toastKind = result?.ok ? (result.kind === 'warn' ? 'warn' : 'ok') : 'err';
        const toastTitle = result?.ok
            ? (result.kind === 'warn' ? '连接成功，但需要调整' : '邮箱连接正常')
            : '邮箱连接失败';
        showToast(toastTitle, result?.message || '', toastKind);
        if (result?.ok) await reloadMailboxes({ silent: true });
    }

    function setMailboxOptions(mailboxes, selected) {
        const select = document.querySelector('[data-config="imap.mailbox"]');
        if (!select) return;
        const chosen = new Set(selected || Array.from(select.selectedOptions).map((opt) => opt.value));
        const list = Array.isArray(mailboxes) && mailboxes.length > 0 ? mailboxes : ['INBOX'];
        for (const value of chosen) {
            if (value && !list.includes(value)) list.push(value);
        }
        select.innerHTML = list
            .map((name) => `<option value="${escapeHtml(name)}"${chosen.has(name) ? ' selected' : ''}>${escapeHtml(name)}</option>`)
            .join('');
        // Programmatic mutation does not fire change naturally — emit one so autosave / status pills react.
        select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async function reloadMailboxes(opts = {}) {
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
            if (statusEl) statusEl.textContent = result?.message || '读取失败';
            if (!opts.silent) showToast('读取失败', result?.message || '请先填写邮箱主机、账号和授权码。', 'err');
        }
    }

    async function developerReset() {
        const confirmed = window.confirm('确认删除本机缓存、已归档发票、待确认队列、识别结果、运行历史和邮箱增量同步状态吗？下次运行将作为首次同步，可能会重新抓取大量旧邮件。该操作不能撤销。');
        if (!confirmed) return;
        if (!window.mfhBridge?.developerReset) { bridgeUnavailable(); return; }
        const result = await window.mfhBridge.developerReset();
        if (result?.summary) applySummary(result.summary);
        showToast(
            '已重置本机数据',
            `删除 ${fmtInt(result?.removed?.length || 0)} 个位置。邮箱配置保留，邮件缓存已清除。`,
        );
    }

    async function handlePendingAction(action) {
        const kind = action.dataset.actionKind;
        const hash = action.dataset.hash || '';
        if (kind === 'retry') {
            await runBridgeAction('runPipeline', { onlyMail: hash }, '已重新尝试', '这封邮件已重新处理。');
            return;
        }
        if (kind === 'refresh_link') {
            const fn = window.mfhBridge?.pendingRefreshLink;
            if (!fn) { bridgeUnavailable(); return; }
            const result = await fn({ hash });
            showToast(result?.ok ? '已打开原始邮件' : '没有找到原始邮件', result?.message || '', result?.ok ? 'ok' : 'err');
            return;
        }
        if (kind === 'ignore') {
            const confirmed = window.confirm('确认把这封邮件从待确认队列中移除吗？原始邮件仍会保留在邮件缓存里。');
            if (!confirmed) return;
            const fn = window.mfhBridge?.pendingIgnore;
            if (!fn) { bridgeUnavailable(); return; }
            const result = await fn({ hash });
            if (result?.summary) applySummary(result.summary);
            showToast(result?.ok ? '已忽略' : '忽略失败', result?.message || '', result?.ok ? 'ok' : 'warn');
            return;
        }
        if (kind && kind !== 'manual_archive') {
            // Unknown future action: refuse to fall back to manual archive (which would
            // surprise users by opening a file picker for an unrelated row).
            showToast('暂不支持该操作', '请升级到新版本后再处理这类邮件。', 'warn');
            return;
        }
        const fn = window.mfhBridge?.pendingManualArchive;
        if (!fn) { bridgeUnavailable(); return; }
        const result = await fn({ hash });
        if (result?.summary) applySummary(result.summary);
        if (result?.canceled) {
            showToast('已取消归档', '没有选择文件，待确认队列保持不变。', 'warn');
            return;
        }
        showToast(result?.ok ? '已归档' : '归档失败', result?.message || '', result?.ok ? 'ok' : 'err');
    }

    function showFetchPreview() {
        const from = document.getElementById('date-from')?.value || '开始日期';
        const to = document.getElementById('date-to')?.value || '结束日期';
        const matchSubject = document.querySelector('[data-fetch-check="matchSubject"]')?.classList.contains('is-on');
        const matchBody = document.querySelector('[data-fetch-check="matchBody"]')?.classList.contains('is-on');
        const dryRun = document.querySelector('[data-fetch-check="dryRun"]')?.classList.contains('is-on');
        const cfg = window.FPH.configPayload?.config || {};
        const keywords = Array.isArray(cfg.filter?.keywords) && cfg.filter.keywords.length > 0
            ? cfg.filter.keywords.join('、')
            : '发票';
        const mailboxes = Array.isArray(cfg.imap?.mailbox) && cfg.imap.mailbox.length > 0
            ? cfg.imap.mailbox.join('、')
            : '所有文件夹';
        const matchParts = [];
        if (matchSubject) matchParts.push('主题');
        if (matchBody) matchParts.push('正文');
        const matchText = matchParts.length > 0 ? matchParts.join(' + ') : '关键词不匹配';
        const lines = [
            `日期：${from} 至 ${to}`,
            `关键词：${keywords}`,
            `匹配范围：${matchText}`,
            `邮箱文件夹：${mailboxes}`,
            dryRun ? '模式：只预览，不保存原件' : '模式：保存命中邮件到本机',
        ];
        showToast('将要执行的抓取', lines.join(' · '));
    }

    function exportVisibleLog() {
        const scope = activeMain();
        const blocks = [
            { name: '获取邮件', el: scope.querySelector('#console-out') },
            { name: '获取发票文件', el: scope.querySelector('[data-file-log]') },
            { name: '识别发票文件', el: scope.querySelector('[data-ocr-log]') },
        ];
        const parts = blocks.map((block) => {
            if (!block.el) return '';
            const lines = Array.from(block.el.querySelectorAll('.console__line, .ocr-log__line'))
                // Skip placeholder lines (marked with data-placeholder) so the export only contains real run output.
                .filter((line) => !line.hasAttribute('data-placeholder'))
                .map((line) => line.textContent.trim())
                .filter(Boolean);
            if (lines.length === 0) return '';
            return `# ${block.name}\n${lines.join('\n')}`;
        }).filter(Boolean);
        copyText(parts.join('\n\n') || '暂无实时日志', '运行日志');
    }

    function tableSourceLabel() {
        const page = document.body.dataset.page;
        if (page === 'inbox') return '收件箱';
        if (page === 'library') return '发票库';
        if (page === 'pending') return '待确认队列';
        return '当前表格';
    }

    function exportVisibleTable(action) {
        const scope = activeMain();
        const page = document.body.dataset.page;
        const csvField = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
        if (page === 'pending') {
            const groups = window.FPH.pending?.groups || [];
            const lines = [['分组', '动作', '主题', '日期', '发件人', '原因', '编号'].map(csvField).join(',')];
            for (const group of groups) {
                const [primary] = actionText(group.action);
                for (const row of group.rows || []) {
                    lines.push([
                        group.title || '',
                        primary || '',
                        row.subject || '',
                        (row.date || '').slice(0, 10),
                        row.from || '',
                        row.reason || '',
                        row.hash || '',
                    ].map(csvField).join(','));
                }
            }
            if (lines.length === 1) { showToast('没有可复制的内容', '当前待确认队列为空。', 'warn'); return; }
            copyText(lines.join('\n'), '待确认队列 CSV');
            return;
        }
        if (page === 'inbox') {
            const rows = window.FPH.inboxRows || [];
            const lines = [['日期', '发件人', '主题', '附件', '链接数', '邮箱'].map(csvField).join(',')];
            for (const row of rows) {
                lines.push([
                    fmtDateTime(row.date),
                    row.from || '',
                    row.subject || '',
                    row.hasAttachment ? '有' : '',
                    Number(row.bodyLinkCount || 0),
                    row.mailbox || '',
                ].map(csvField).join(','));
            }
            if (lines.length === 1) { showToast('没有可复制的内容', '当前收件箱为空。', 'warn'); return; }
            copyText(lines.join('\n'), '收件箱 CSV');
            return;
        }
        if (page === 'library') {
            const rows = window.FPH.libraryRows || [];
            const lines = [['开票日期', '销售方', '发票号码', '金额', '来源', '文件名', '状态'].map(csvField).join(',')];
            for (const row of rows) {
                lines.push([
                    (row.date || '').slice(0, 10),
                    row.seller || '',
                    row.invoiceNo || '',
                    row.amount || '',
                    sourceLabel(row.source),
                    row.filename || '',
                    row.status || '',
                ].map(csvField).join(','));
            }
            if (lines.length === 1) { showToast('没有可复制的内容', '当前发票库为空。', 'warn'); return; }
            copyText(lines.join('\n'), '发票库 CSV');
            return;
        }
        const table = action.closest('.card')?.querySelector('table') || scope.querySelector('table');
        if (!table) { showToast('没有可复制的表格', '当前页面没有表格内容。', 'warn'); return; }
        const csv = Array.from(table.querySelectorAll('tr')).map((tr) => (
            Array.from(tr.children).map((cell) => csvField(cell.textContent.trim())).join(',')
        )).join('\n');
        copyText(csv, `${tableSourceLabel()} CSV`);
    }

    function shortSender(value) {
        const text = String(value || '');
        const lt = text.indexOf('<');
        if (lt > 0) return text.slice(0, lt).trim().replace(/^"|"$/g, '') || text;
        return text.split('@')[0] || text;
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
        })[ch]);
    }

    function showToast(title, sub, kind = 'ok', duration = 2600) {
        let stack = document.querySelector('.toast-stack');
        if (!stack) {
            stack = document.createElement('div');
            stack.className = 'toast-stack';
            stack.setAttribute('aria-live', 'polite');
            document.body.appendChild(stack);
        }
        const toast = document.createElement('div');
        toast.className = `toast ${kind}`;
        toast.innerHTML = `<div>${title}</div><div class="toast__sub">${sub}</div>`;
        stack.appendChild(toast);
        window.setTimeout(() => toast.remove(), Math.max(1500, Number(duration) || 2600));
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wire);
    } else {
        wire();
    }

    // Expose for inline buttons
    window.FPH = Object.assign(window.FPH || {}, {
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
        whenConfigReady,
        ICON,
    });
})();
