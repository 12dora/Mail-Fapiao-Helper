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
            // No shortcut badge here: the only real global shortcut is ⌘/Ctrl+K
            // (search focus), and it is shown on the search box itself.
            { id: 'dashboard', label: '开始处理', href: 'dashboard.html', icon: 'play' },
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
    const PAGE_META = {
        dashboard: { heading: '运行控制台', title: '运行控制台 · 发票助手' },
        inbox:     { heading: '邮件记录',   title: '收件箱 · 发票助手' },
        library:   { heading: '发票库',     title: '发票库 · 发票助手' },
        pending:   { heading: '待处理队列', title: '待处理队列 · 发票助手' },
        config:    { heading: '配置',       title: '配置 · 发票助手' },
        settings:  { heading: '关于',       title: '关于 · 发票助手' },
    };
    const PAGE_SCRIPT_INIT = {
        dashboard: () => window.MFH_PAGE_INIT?.dashboard?.(),
        config: () => window.MFH_PAGE_INIT?.config?.(),
    };

    /* ---------- Platform-correct modifier key ---------- */
    const IS_APPLE = /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '');
    const MOD_KEY = IS_APPLE ? '⌘' : 'Ctrl';
    const SEARCH_HINT = {
        inbox: '在已加载的邮件记录中搜索…',
        library: '在已加载的发票库中搜索…',
    };
    function searchPlaceholder(pageId) {
        return SEARCH_HINT[pageId] || '搜索发票库（已加载记录）…';
    }

    /* ---------- Checkbox helpers ----------
       `.check` is now a native <input type="checkbox">. These helpers keep
       working if any legacy div.check.is-on markup is still around. */
    function isChecked(el) {
        if (!el) return false;
        if (typeof el.checked === 'boolean' && el.tagName === 'INPUT') return el.checked;
        return el.classList.contains('is-on');
    }
    function setChecked(el, value) {
        if (!el) return;
        const on = Boolean(value);
        if (el.tagName === 'INPUT') el.checked = on;
        else el.classList.toggle('is-on', on);
    }
    function checkedBySelector(selector, scope) {
        return isChecked((scope || document).querySelector(selector));
    }

    function navHTML(active) {
        return NAV.map(sec => `
            <div class="nav-group">
                <div class="nav-group__title">${sec.group}</div>
                ${sec.items.map(it => `
                    <a class="nav-item ${it.id === active ? 'is-active' : ''}" href="${document.body.dataset.page ? it.href : rel(it.href)}" data-spa-page="${it.id}"${it.id === active ? ' aria-current="page"' : ''}>
                        <span class="nav-item__icon" aria-hidden="true">${ICON[it.icon]}</span>
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
        const placeholder = searchPlaceholder(active);
        return `
            <aside class="sidebar">
                <div class="sidebar__brand">
                    <div class="sidebar__logo" aria-hidden="true">F</div>
                    <div>
                        <div class="sidebar__title">发票助手</div>
                        <div class="sidebar__ver" data-app-version>版本读取中…</div>
                    </div>
                </div>
                <div class="sidebar__search">
                    <span class="sidebar__search-icon" aria-hidden="true">${ICON.search}</span>
                    <label class="sr-only" for="global-search">${escapeHtml(placeholder)}</label>
                    <input type="search" id="global-search" placeholder="${escapeHtml(placeholder)}" data-global-search>
                    <kbd title="${MOD_KEY}+K 聚焦搜索">${MOD_KEY}K</kbd>
                </div>
                <nav class="sidebar__nav" aria-label="主导航">
                    ${navHTML(active)}
                </nav>
                <div class="sidebar__foot">
                    <span class="status-dot" data-mail-status-dot aria-hidden="true"></span>
                    <span data-mail-status-label>邮箱未配置</span>
                    <span class="sidebar__foot-meta" data-clock>--:--</span>
                    <button class="theme-toggle" type="button" data-theme-toggle aria-label="切换到深色主题" title="切换到深色主题">${ICON.moon}</button>
                </div>
            </aside>
        `;
    }

    /* ---------- Screen-reader announcements ---------- */
    function liveRegion(kind) {
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

    const ANNOUNCE_THROTTLE_MS = 700;
    let lastAnnounceAt = 0;
    let announceTimer = 0;
    function announce(message, kind = 'status') {
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

    function prefersReducedMotion() {
        if (document.documentElement.getAttribute('data-motion') === 'off') return true;
        return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
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
                        const prev = window.FPH[stateKey] || { key: '', dir: 'asc' };
                        const dir = prev.key === key && prev.dir === 'asc' ? 'desc' : 'asc';
                        window.FPH[stateKey] = { key, dir };
                        window.FPH.sortKey = key;
                        window.FPH.sortDir = dir;
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

            // Toggle controls
            const tg = e.target.closest('.toggle');
            if (tg) tg.classList.toggle('is-on');

            const action = e.target.closest('[data-action]');
            if (action && !t && !action.closest('.tabs') && !action.closest('#date-preset-buttons')) {
                // Catch here so any action handler that rejects (e.g. an IPC error)
                // shows feedback instead of becoming a silent unhandled rejection.
                Promise.resolve(handleAction(action)).catch((err) => showToast('运行失败', '这个操作没有完成，请重试。', 'err', { detail: err?.message }));
            }
        });

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

        refreshClock();
        window.setInterval(refreshClock, 30000);
        wireSearch();
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

    /* ---------- Progressive upgrade of static page markup ----------
       Keeps the hand-written HTML readable while guaranteeing the
       accessibility contract (sortable headers, progress semantics,
       focusable page heading) on every page, including SPA-loaded ones. */
    function upgradeStaticMarkup(root) {
        const scope = root || document;
        scope.querySelectorAll?.('.toolbar__title:not([tabindex])').forEach((el) => {
            el.setAttribute('tabindex', '-1');
        });
        scope.querySelectorAll?.('.table thead th[data-sort-key]').forEach((th) => {
            if (th.querySelector('.th-sort')) return;
            const label = th.textContent.trim();
            th.textContent = '';
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'th-sort';
            button.textContent = label;
            button.setAttribute('aria-label', `按${label}排序`);
            th.appendChild(button);
            if (!th.hasAttribute('aria-sort')) th.setAttribute('aria-sort', 'none');
        });
        scope.querySelectorAll?.('.progress').forEach((el) => {
            if (el.hasAttribute('role')) return;
            el.setAttribute('role', 'progressbar');
            el.setAttribute('aria-valuemin', '0');
            el.setAttribute('aria-valuemax', '100');
            el.setAttribute('aria-valuenow', '0');
            if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby')) {
                el.setAttribute('aria-label', el.hasAttribute('data-ocr-progress') ? '识别进度'
                    : el.hasAttribute('data-file-progress') ? '获取发票文件进度' : '获取邮件进度');
            }
            el.setAttribute('aria-valuetext', '尚未开始');
        });
    }

    /* Subject/body are the only two keyword match scopes; turning both off would
       silently match nothing (and the backend quietly re-enables subject). */
    function enforceMatchScope(changed) {
        const subject = document.querySelector('[data-fetch-check="matchSubject"]');
        const body = document.querySelector('[data-fetch-check="matchBody"]');
        if (!subject || !body) return;
        if (isChecked(subject) || isChecked(body)) return;
        setChecked(changed, true);
        showToast('至少需要一个匹配范围', '“匹配主题”和“匹配正文”不能同时关闭，否则不会命中任何邮件。已为你恢复。', 'warn');
    }

    /* Reflects the backend-normalised filter (contract: normalizedFilter) back
       into the controls so the UI never claims a setting the run did not use. */
    function applyNormalizedFilter(normalized) {
        if (!normalized || typeof normalized !== 'object') return;
        if (typeof normalized.matchSubject === 'boolean') {
            document.querySelectorAll('[data-fetch-check="matchSubject"]').forEach((el) => setChecked(el, normalized.matchSubject));
        }
        if (typeof normalized.matchBody === 'boolean') {
            document.querySelectorAll('[data-fetch-check="matchBody"]').forEach((el) => setChecked(el, normalized.matchBody));
        }
        window.FPH.normalizedFilter = normalized;
        const note = document.querySelector('[data-normalized-filter]');
        if (note) {
            const parts = [];
            if (normalized.matchSubject) parts.push('主题');
            if (normalized.matchBody) parts.push('正文');
            const keywords = Array.isArray(normalized.keywords) ? normalized.keywords.join('、') : '';
            note.textContent = `本次实际使用：匹配${parts.join(' + ') || '（无）'}${keywords ? ` · 关键词 ${keywords}` : ''}`;
        }
    }

    /* ---------- Mutually exclusive operations (contract: 'op-state') ---------- */
    const MUTEX_GROUPS = [
        { kind: 'fetch',    selector: '#run-btn' },
        { kind: 'pipeline', selector: '[data-action="run-pipeline"], [data-action="rerun-pipeline"]' },
        { kind: 'ocr',      selector: '[data-action="ocr-toggle"]' },
        { kind: 'organize', selector: '[data-action="organize"], [data-action="rename-organize"]' },
    ];

    async function wireOpState() {
        const subscribe = window.mfhBridge?.onOpState;
        if (typeof subscribe === 'function') {
            subscribe((payload) => {
                const running = payload?.running || null;
                window.FPH.opState = running;
                applyOpState(running);
            });
        }
        // Subscribing only sees FUTURE transitions. Ask for the current state so
        // a window opened mid-run does not render idle controls (FB-01).
        const read = window.mfhBridge?.getOpState;
        if (typeof read !== 'function') return;
        try {
            const state = await read();
            window.FPH.opState = state?.running || null;
            applyOpState(window.FPH.opState);
        } catch {
            // Older main process without the handler: stay in degraded mode.
        }
    }

    function applyOpState(running) {
        const busyKind = running?.kind || '';
        for (const group of MUTEX_GROUPS) {
            document.querySelectorAll(group.selector).forEach((el) => {
                const conflicts = Boolean(busyKind) && busyKind !== group.kind;
                if (conflicts) {
                    el.disabled = true;
                    el.dataset.opLocked = 'true';
                    el.title = '另一个任务正在运行，完成后可再操作。';
                } else if (el.dataset.opLocked === 'true') {
                    el.disabled = false;
                    delete el.dataset.opLocked;
                    el.removeAttribute('title');
                }
            });
        }
        // The OCR toggle must show "停止识别" for a job that started before this
        // page (or this window) existed.
        if (busyKind === 'ocr') setOcrControlState('running');
        // Let the dashboard re-apply its own date-range validity after unlocking.
        if (!busyKind) window.MFH_DASHBOARD_REFRESH_RUN_BTN?.();
    }

    function ocrJobRunning() {
        return window.FPH.opState?.kind === 'ocr';
    }

    /* ---------- About / version metadata (COPY-07B) ---------- */
    let appInfoLoaded = false;

    async function loadAppInfo(opts = {}) {
        if (appInfoLoaded && !opts.force) { renderAppInfo(); return; }
        let info = null;
        try {
            const fn = window.mfhBridge?.getAppInfo;
            if (typeof fn === 'function') info = await fn();
        } catch {
            info = null;
        }
        window.FPH.appInfo = info || null;
        appInfoLoaded = true;
        renderAppInfo();
    }

    /**
     * 把已取到的应用信息写进当前 DOM。SPA 新插入的 About 页不会重新执行
     * `loadAppInfo()`，若不在 commit 后重渲染，版本/渠道会一直停在 HTML 里的
     * 「读取中…」占位符——那样 COPY-07B 在用户唯一的进入路径上等于没修。
     */
    function renderAppInfo() {
        const info = window.FPH.appInfo;
        const version = info?.version ? `v${info.version}` : '版本未知';
        const channel = info?.channel || (window.mfhBridge ? '桌面版' : '静态预览');
        document.querySelectorAll('[data-app-version]').forEach((el) => { el.textContent = version; });
        document.querySelectorAll('[data-about-version]').forEach((el) => { el.textContent = version; });
        document.querySelectorAll('[data-about-channel]').forEach((el) => { el.textContent = channel; });
        applyOcrStatusCards();
    }

    /* “已配置” must reflect real config, never a hardcoded pill. */
    function applyOcrStatusCards() {
        const cfg = window.FPH.configPayload?.config || {};
        const secrets = window.FPH.configPayload?.secrets || {};
        const ocr = cfg.ocr || {};
        const engineEnabled = ocr.enabled !== false;
        const engineEl = document.querySelector('[data-about-engine]');
        if (engineEl) {
            engineEl.className = `pill ${engineEnabled ? 'pill--ok' : ''}`;
            engineEl.textContent = engineEnabled ? `已启用 · ${ocr.provider || 'efapiao'}` : '未启用（只保存原件）';
        }
        const hasId = Boolean(secrets.tencentSecretId ?? ocr.credentials?.tencentSecretId ?? ocr.credentials?.secretId);
        const hasKey = Boolean(secrets.tencentSecretKey ?? ocr.credentials?.tencentSecretKey ?? ocr.credentials?.secretKey);
        const cloudEl = document.querySelector('[data-about-cloud]');
        if (cloudEl) {
            const configured = hasId && hasKey;
            cloudEl.className = `pill ${configured ? 'pill--warn' : ''}`;
            cloudEl.textContent = configured ? '已填写密钥（会上传发票文件）' : '未填写密钥（不会上传文件）';
        }
        const modeEl = document.querySelector('[data-about-ocr-mode]');
        if (modeEl) {
            const mode = ocr.ocrMode || 'auto';
            modeEl.textContent = mode === 'disabled' ? '仅本地规则，不调用云端 OCR'
                : mode === 'required' ? '每个文件都调用云端 OCR'
                : '规则优先，必要时调用云端 OCR';
        }
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
    const pageLoads = new Map();
    // Monotonic navigation token — only the newest request may commit.
    let navToken = 0;

    async function loadPageMain(pageId, href) {
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
    function setNavLinkPending(pageId, pending) {
        document.querySelectorAll('.nav-item[data-spa-page]').forEach((link) => {
            if (link.dataset.spaPage !== pageId) return;
            if (pending) link.setAttribute('aria-busy', 'true');
            else link.removeAttribute('aria-busy');
        });
    }

    function setContentPending(pending) {
        const current = document.querySelector('main.main:not([style*="display: none"])');
        if (!current) return;
        if (pending) current.setAttribute('aria-busy', 'true');
        else current.removeAttribute('aria-busy');
    }

    function showLoadingHint(pageId, token) {
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
    function clearLoadingHint(timer, token) {
        window.clearTimeout(timer);
        document.querySelectorAll(`[data-nav-skeleton="${token}"]`).forEach((el) => el.remove());
    }

    async function showPage(pageId, href, opts = {}) {
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
            // Page-scoped errors belong to the page the user just left.
            dismissPageToasts();
            // A freshly inserted page must reflect the live state (running job,
            // real app version/channel) instead of its static placeholders.
            applyLiveState(pageId);
            announce(`${meta?.heading || pageId} 已打开`);
            if (opts.push !== false) {
                history.pushState({ page: pageId }, '', pathForPage(pageId));
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

    /* ---------- Redaction (COPY-01 / COPY-05) ----------
       Anything that can reach a toast, the log export, a history entry or the
       clipboard passes through here first. This mirrors the rule set of
       src/electron/sanitize.ts so that the renderer fallback path (err.message,
       legacy stderr/error) is redacted just as strictly as main-process events:
       URL query/fragment, credential-looking assignments, ANY absolute
       POSIX/Windows/UNC path, and long content hashes. */
    const SECRET_PARAM_RE = /(token|secret|key|sign|signature|auth|password|passwd|pass|credential|session|ticket|code)/i;
    const SECRET_ASSIGN_RE = /\b(token|secret|secretid|secretkey|apikey|api_key|key|sign|signature|auth|authorization|password|passwd|pass|credential)(\s*[=:]\s*)("?)([^\s"',;&)]+)\3/gi;
    const URL_RE = /\b(?:https?|ftp|file):\/\/[^\s"'<>）)\]，。；]+/gi;
    const UNC_PATH_RE = /\\\\[A-Za-z0-9._$-]+(?:\\[^\s"'<>|,;]+)+/g;
    const WIN_PATH_RE = /\b[A-Za-z]:\\[^\s"'<>|,;]+/g;
    // Any absolute POSIX path with at least two segments. The lookbehind keeps
    // date-like `2026/05/21` and relative `a/b/c` out.
    const POSIX_PATH_RE = /(?<![A-Za-z0-9])(?:\/[A-Za-z0-9._@+\u4e00-\u9fa5-]+){2,}\/?/g;
    const HASH_RE = /\b(?=[0-9a-f]*[a-f])[0-9a-f]{12,}\b/gi;
    // Private-use sentinel for already-redacted fragments. Never a NUL byte:
    // a literal 0x00 makes the source file look binary to git and tooling.
    const KEEP_MARK = '\uE000';

    function redactUrlText(raw) {
        try {
            const url = new URL(raw);
            const hasSecret = Array.from(url.searchParams.keys()).some((key) => SECRET_PARAM_RE.test(key));
            const base = `${url.protocol}//${url.host}${url.pathname}`;
            if (url.search || url.hash) return `${base}${hasSecret ? '?<凭据参数已隐藏>' : '?…'}`;
            return base;
        } catch {
            return raw.replace(/[?#].*$/, '');
        }
    }

    function redactPathText(raw) {
        const parts = String(raw).trim().split(/[\\/]/).filter(Boolean);
        const base = parts.length > 0 ? parts[parts.length - 1] : '';
        return raw.includes('\\') ? `…\\${base}` : `…/${base}`;
    }

    function sanitizeText(value, opts = {}) {
        if (value === undefined || value === null) return '';
        let out = typeof value === 'string' ? value : String(value);
        // Park each redacted fragment so later rules cannot re-slice a URL path
        // or an already-shortened filename.
        const kept = [];
        const keep = (replacement) => {
            kept.push(replacement);
            return `${KEEP_MARK}${kept.length - 1}${KEEP_MARK}`;
        };
        out = out.replace(URL_RE, (match) => keep(redactUrlText(match)));
        out = out.replace(UNC_PATH_RE, (match) => keep(redactPathText(match)));
        out = out.replace(WIN_PATH_RE, (match) => keep(redactPathText(match)));
        out = out.replace(POSIX_PATH_RE, (match) => keep(redactPathText(match)));
        out = out.replace(SECRET_ASSIGN_RE, (_m, key, sep) => `${key}${sep}***`);
        out = out.replace(HASH_RE, (match) => `${match.slice(0, 6)}…`);
        out = out.replace(new RegExp(`${KEEP_MARK}(\\d+)${KEEP_MARK}`, 'g'), (_m, index) => kept[Number(index)] ?? '');
        const max = Number(opts.maxLength) || 1200;
        if (out.length > max) out = `${out.slice(0, max)}…`;
        return out;
    }

    /* Short, shareable reference for a pending row instead of a raw hash. */
    function supportRef(hash) {
        const value = String(hash || '').trim();
        return value ? value.slice(0, 6).toUpperCase() : '——';
    }

    /* Prefer the backend's concise Chinese `message`; fall back to a redacted
       version of whatever legacy field is available. */
    function eventMessage(data) {
        const message = typeof data?.message === 'string' ? data.message : '';
        return sanitizeText(message);
    }

    function eventDetail(data) {
        const detail = data?.detail ?? data?.stderr ?? data?.error ?? '';
        const text = typeof detail === 'string' ? detail : '';
        if (!text) return '';
        return sanitizeText(text).slice(0, 1200);
    }

    function pill(label, kind = '') {
        return `<span class="pill ${kind ? `pill--${kind}` : ''}">${escapeHtml(label)}</span>`;
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
        if (label === '已归档') return pill('已归档');
        return pill(label || '未知状态');
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
            showToast('读取本地数据失败', '无法读取本机的邮件和发票记录，请确认配置文件是否完整。', 'err', { detail: err?.message });
        }
    }

    async function loadBridgeConfig() {
        if (!window.mfhBridge?.getConfig) return;
        try {
            const payload = await window.mfhBridge.getConfig();
            window.FPH.configPayload = payload;
            // A corrupted config must show a blocking repair entry point, never "已加载".
            if (payload?.configError) showConfigError(payload.configError);
            else clearConfigError();
            applyConfig(payload.config || {}, payload.secrets || {});
        } catch (err) {
            showConfigError({ message: '无法读取本机配置文件。' });
            window.FPH.configLoadError = err?.message || '';
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

    /* ---------- Live log: follow-on-tail instead of forced scroll (FB-05) ---------- */
    const NEAR_BOTTOM_PX = 24;

    function isNearBottom(el) {
        return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    }

    function ensureLogHost(el) {
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

    function scrollLogToBottom(el) {
        el.scrollTo?.({ top: el.scrollHeight, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
        if (!el.scrollTo) el.scrollTop = el.scrollHeight;
    }

    function appendLogLine(el, html, { reset = false } = {}) {
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

    function wireLogFollow() {
        document.querySelectorAll('[data-ocr-log], [data-file-log], #console-out').forEach((el) => ensureLogHost(el));
    }

    /* ---------- Accessible progress ---------- */
    function setProgressState(progressSelector, barSelector, opts) {
        const { percent, label, indeterminate = false, done = false, error = false } = opts;
        document.querySelectorAll(progressSelector).forEach((el) => {
            el.classList.remove('is-idle');
            el.classList.toggle('is-error', error);
            el.classList.toggle('is-done', done);
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

    function resetOcrProgress(message = '正在准备识别文件。') {
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
        announce('已开始识别发票文件，正在准备。');
    }

    function appendOcrLog(message, kind = '') {
        if (!message) return;
        document.querySelectorAll('[data-ocr-log]').forEach((el) => {
            appendLogLine(el, consoleLine(kind === 'ok' ? '成功' : kind === 'warn' ? '提醒' : kind === 'err' ? '失败' : '进度', message, kind));
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
        const phase = data.phase || (data.done ? '识别完成' : '正在识别');
        setProgressState('[data-ocr-progress]', '[data-ocr-bar]', {
            percent,
            done: !ocrErrored && (Boolean(data.done) || percent >= 100),
            error: ocrErrored,
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
            window.clearTimeout(window.FPH?._stopOcrFallback);
            if (window.FPH) window.FPH._stopOcrFallback = 0;
        }
        const readable = eventMessage(data);
        appendOcrLog(readable, data.kind || '');
        if (ocrErrored) announce(`识别失败：${readable || '请查看诊断信息'}`, 'alert');
        else if (data.done) announce(`识别完成：成功 ${parsed}，跳过 ${skipped}，失败 ${failed}。`);
        else announce(`识别进行中：${processed} / ${total}`);
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
        announce('已开始获取发票文件，正在准备。');
    }

    function appendFileLog(message, kind = '') {
        if (!message) return;
        document.querySelectorAll('[data-file-log]').forEach((el) => {
            appendLogLine(el, consoleLine(kind === 'ok' ? '完成' : kind === 'warn' ? '提醒' : kind === 'err' ? '失败' : '进度', message, kind));
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
        const phase = data.phase || (data.done ? '获取完成' : '正在获取');
        setProgressState('[data-file-progress]', '[data-file-bar]', {
            percent,
            done: !fileErrored && (Boolean(data.done) || percent >= 100),
            error: fileErrored,
            label: `${phase}，${percent}%`,
        });
        text('[data-file-phase]', phase);
        text('[data-file-counts]', `${fmtInt(processed)} 封`);
        text('[data-file-processed]', fmtInt(processed));
        text('[data-file-skipped]', fmtInt(skipped));
        text('[data-file-failed]', fmtInt(failed));
        const readable = eventMessage(data);
        appendFileLog(readable, data.kind || '');
        if (fileErrored) announce(`获取发票文件失败：${readable || '请查看诊断信息'}`, 'alert');
        else if (data.done) announce(`获取发票文件完成：处理 ${processed}，跳过 ${skipped}，失败 ${failed}。`);
        else announce(`正在获取发票文件：已处理 ${processed}`);
    }

    /* Backend status enum (src/electron/summary.ts). 已识别 = 完整 only. */
    const STATUS = {
        COMPLETE: '完整',
        PARTIAL: '待补充',
        ARCHIVED: '已归档',
        FAILED: '识别失败',
    };

    function applySummary(summary, opts = {}) {
        window.FPH.summary = summary;
        const inbox = summary.inbox || {};
        const library = summary.library || {};
        const pending = summary.pending || {};
        text('[data-nav-badge="inbox"]', fmtInt(inbox.total));
        text('[data-nav-badge="library"]', fmtInt(library.recognized));
        text('[data-nav-badge="pending"]', fmtInt(pending.total));
        text('[data-summary="config-path"]', summary.configExists ? '本机配置已加载' : '尚未保存本机配置');

        applyDashboardSummary(summary);
        applyInboxSummary(inbox);
        applyLibrarySummary(library);
        applyPendingSummary(pending, opts);
        applyHistory(summary.history || []);
        // The "本次抓取" table is owned by the last run, never by the full INDEX.
        renderCurrentBatch();
        // A plain summary refresh must not reset the controls of a job that is
        // still running (FB-01 / APP-05).
        setOcrControlState(ocrJobRunning() ? 'running' : 'idle');
        applyOpState(window.FPH.opState || null);
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

    /* ---------- "本次抓取" is scoped to the batch the backend just returned ---------- */
    function setCurrentBatch(result) {
        const rows = result?.batch?.rows ?? result?.batchRows ?? result?.newRows ?? null;
        const total = result?.batch?.total ?? result?.batchTotal ?? (Array.isArray(rows) ? rows.length : undefined);
        window.FPH.currentBatch = Array.isArray(rows)
            ? { rows, total: Number(total ?? rows.length), known: true }
            : { rows: [], total: Number(total ?? 0), known: total !== undefined };
        renderCurrentBatch();
    }

    function renderCurrentBatch() {
        const tbody = document.querySelector('[data-current-batch-rows]');
        if (!tbody) return;
        const batch = window.FPH.currentBatch;
        const note = document.querySelector('[data-current-batch-note]');
        if (!batch) {
            tbody.innerHTML = '<tr><td colspan="7" class="muted">本次还没有运行。点击“开始获取邮件”后，这里只显示这一次新保存的邮件。</td></tr>';
            if (note) note.textContent = '只显示最近一次运行新增的邮件，不是全部本地缓存。';
            return;
        }
        if (!batch.known) {
            tbody.innerHTML = '<tr><td colspan="7" class="muted">本次运行没有返回明细，请到「邮件记录」查看全部本地缓存邮件。</td></tr>';
            if (note) note.textContent = '本次运行没有返回逐封明细。';
            return;
        }
        tbody.innerHTML = batch.rows.map((row, index) => `
            <tr>
                <td class="faint">${String(index + 1).padStart(2, '0')}</td>
                <td class="mono">${fmtDateTime(row.date)}</td>
                <td>${escapeHtml(row.subject || '无主题')}</td>
                <td class="small">${escapeHtml(shortSender(row.from))}</td>
                <td class="mono col-num">${row.hasAttachment ? '有' : '-'}</td>
                <td class="mono col-num">${fmtInt(row.bodyLinkCount)}</td>
                <td>${pill('本次新增', 'ok')}</td>
            </tr>
        `).join('') || '<tr><td colspan="7" class="muted">本次运行没有新增邮件（命中的邮件此前已经保存过）。</td></tr>';
        if (note) {
            note.textContent = batch.total > batch.rows.length
                ? `本次新增 ${fmtInt(batch.total)} 封，下面列出前 ${fmtInt(batch.rows.length)} 封。完整列表见「邮件记录」。`
                : `本次新增 ${fmtInt(batch.total)} 封。`;
        }
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
        mergeSection('inbox', inbox);
        renderInboxRows();
    }

    /* ---------- Offset-based paging (contract 5) ---------- */
    const PAGE_SIZE = 80;

    function rowIdentity(kind, row) {
        if (kind === 'inbox') {
            return String(row.messageId || row.hash || `${row.date || ''}|${row.subject || ''}|${row.from || ''}`);
        }
        return String(row.filePath || `${row.hash || ''}|${row.filename || ''}|${row.invoiceNo || ''}`);
    }

    /* The paging cursor is always derived from what the SERVER reported
       (`offset + rows.length`), never from the locally de-duplicated row count.
       Using the local length skips boundary rows whenever the dataset shifts
       between two requests, and makes `loaded < total` stall forever. */
    function mergeSection(kind, payload) {
        const storeKey = kind === 'inbox' ? 'inboxRows' : 'libraryRows';
        if (!Array.isArray(payload?.rows)) return (window.FPH[storeKey] || []).length;
        const incoming = payload.rows;
        const offset = Number(payload.offset || 0);
        if (offset > 0) {
            const store = window.FPH[storeKey] || [];
            const seen = new Set(store.map((row) => rowIdentity(kind, row)));
            window.FPH[storeKey] = store.concat(incoming.filter((row) => !seen.has(rowIdentity(kind, row))));
            window.FPH[`${kind}Cursor`] = Math.max(Number(window.FPH[`${kind}Cursor`] || 0), offset + incoming.length);
        } else {
            window.FPH[storeKey] = incoming.slice();
            window.FPH[`${kind}Cursor`] = incoming.length;
        }
        window.FPH[`${kind}Total`] = Number(payload.total ?? window.FPH[storeKey].length);
        window.FPH[`${kind}Limit`] = Number(payload.limit || PAGE_SIZE) || PAGE_SIZE;
        return window.FPH[storeKey].length;
    }

    function sectionCursor(kind) {
        const storeKey = kind === 'inbox' ? 'inboxRows' : 'libraryRows';
        const cursor = window.FPH[`${kind}Cursor`];
        return Number.isFinite(Number(cursor)) ? Number(cursor) : (window.FPH[storeKey] || []).length;
    }

    async function reloadSectionFromStart(kind, limit) {
        const fn = window.mfhBridge?.getSummary;
        if (typeof fn !== 'function') return;
        const args = kind === 'inbox'
            ? { inboxOffset: 0, inboxLimit: limit }
            : { libraryOffset: 0, libraryLimit: limit };
        const summary = await fn(args);
        const section = kind === 'inbox' ? summary?.inbox : summary?.library;
        window.FPH[`${kind}Total`] = undefined;
        window.FPH[`${kind}Cursor`] = 0;
        window.FPH[kind === 'inbox' ? 'inboxRows' : 'libraryRows'] = [];
        mergeSection(kind, section && { ...section, offset: 0 });
        if (kind === 'inbox') renderInboxRows();
        else { renderLibraryRows(); updateSellerOptions(window.FPH.libraryRows || []); }
    }

    async function loadMoreRows(kind, button) {
        const fn = window.mfhBridge?.getSummary;
        if (typeof fn !== 'function') { bridgeUnavailable(); return; }
        const limit = window.FPH[`${kind}Limit`] || PAGE_SIZE;
        const cursor = sectionCursor(kind);
        const prevTotal = Number(window.FPH[`${kind}Total`] ?? NaN);
        const args = kind === 'inbox'
            ? { inboxOffset: cursor, inboxLimit: limit }
            : { libraryOffset: cursor, libraryLimit: limit };
        let summary;
        try {
            summary = await fn(args);
        } catch (err) {
            showToast('加载更多失败', '请稍后重试。', 'err', { detail: err?.message });
            return;
        }
        const section = kind === 'inbox' ? summary?.inbox : summary?.library;
        const total = Number(section?.total ?? prevTotal);
        // The dataset moved under us (a run added/removed records): every
        // server-side slice shifted, so anything we keep would silently skip or
        // duplicate boundary rows. Restart from page one.
        if (Number.isFinite(prevTotal) && Number.isFinite(total) && total !== prevTotal) {
            await reloadSectionFromStart(kind, limit);
            showToast('列表已更新', `记录数量变成了 ${fmtInt(total)} 条，已重新从第一页加载。`, 'warn');
            announce('记录数量发生变化，已重新从第一页加载。');
            return;
        }
        const serverOffset = Number(section?.offset ?? cursor);
        const returned = Array.isArray(section?.rows) ? section.rows.length : 0;
        const before = (window.FPH[kind === 'inbox' ? 'inboxRows' : 'libraryRows'] || []).length;
        const after = mergeSection(kind, section);
        if (kind === 'inbox') renderInboxRows(); else { renderLibraryRows(); updateSellerOptions(window.FPH.libraryRows || []); }
        if (returned === 0 || serverOffset + returned >= total) {
            // Only the server cursor may declare the end of the dataset.
            if (button) { button.disabled = true; button.textContent = '没有更多记录了'; }
            announce('没有更多记录了。');
            return;
        }
        announce(after > before
            ? `已加载 ${after - before} 条记录，共 ${after} 条。`
            : `已读取 ${returned} 条记录，其中没有新内容。`);
    }

    function renderLoadMore(kind, loaded, total) {
        const scope = activeMain();
        const mount = scope.querySelector(`[data-load-more="${kind}"]`);
        if (!mount) return;
        // Remaining is measured against the server cursor, not the de-duplicated
        // local length, so dedupe can never hide reachable records.
        const cursor = sectionCursor(kind);
        const remaining = Math.max(0, Number(total || 0) - cursor);
        mount.replaceChildren();
        if (remaining > 0) {
            const button = document.createElement('button');
            button.className = 'btn btn--sm';
            button.type = 'button';
            button.dataset.action = 'load-more';
            button.dataset.loadKind = kind;
            button.textContent = `加载更多（还有 ${fmtInt(remaining)} 条）`;
            const note = document.createElement('span');
            note.className = 'small muted';
            note.textContent = `搜索、排序和筛选只作用于已加载的 ${fmtInt(loaded)} 条记录。`;
            mount.append(button, note);
        } else {
            const note = document.createElement('span');
            note.className = 'small muted';
            note.textContent = `已加载全部 ${fmtInt(loaded)} 条记录。`;
            mount.append(note);
        }
    }

    function renderInboxRows() {
        const scope = activeMain();
        const tbody = scope.querySelector('[data-inbox-rows]');
        if (!tbody) return;
        const query = String(scope.querySelector('[data-search="inbox"]')?.value || '').trim().toLowerCase();
        const attachmentOnly = scope.querySelector('[data-filter="inbox-attachment"]')?.classList.contains('is-active');
        const linksOnly = scope.querySelector('[data-filter="inbox-links"]')?.classList.contains('is-active');
        const loadedRows = window.FPH.inboxRows || [];
        const rows = sortRows(loadedRows.filter((row) => {
            const haystack = `${row.messageId || ''} ${row.from || ''} ${row.subject || ''} ${row.mailbox || ''}`.toLowerCase();
            if (query && !haystack.includes(query)) return false;
            if (attachmentOnly && !row.hasAttachment) return false;
            if (linksOnly && Number(row.bodyLinkCount || 0) <= 0) return false;
            return true;
        }), 'sortInbox');
        tbody.innerHTML = rows.map((row) => `
            <tr>
                <td class="mono">${fmtDateTime(row.date)}</td>
                <td>${escapeHtml(shortSender(row.from))}<br><span class="small muted">${escapeHtml(row.from || '')}</span></td>
                <td>${escapeHtml(row.subject || '无主题')}<span class="cell-sub">${escapeHtml(row.mailbox || '邮箱')} · ${row.hasAttachment ? '有附件' : '无附件'} · 链接 ${fmtInt(row.bodyLinkCount)}</span></td>
                <td class="mono col-num col-secondary">${row.hasAttachment ? '有' : '-'}</td>
                <td class="mono col-num col-secondary">${fmtInt(row.bodyLinkCount)}</td>
                <td class="col-secondary"><span class="pill">${escapeHtml(row.mailbox || '邮箱')}</span></td>
                <td>${pill('已缓存', 'ok')}</td>
            </tr>
        `).join('') || `<tr><td colspan="7" class="muted">没有找到匹配邮件。你可以换个关键词或取消筛选。</td></tr>`;
        const total = Number(window.FPH.inboxTotal ?? loadedRows.length);
        text('[data-inbox-page]', `显示 ${fmtInt(rows.length)} · 已加载 ${fmtInt(loadedRows.length)} · 共 ${fmtInt(total)} 行`);
        renderLoadMore('inbox', loadedRows.length, total);
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

        mergeSection('library', library);
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
        const loadedRows = window.FPH.libraryRows || [];
        const rows = sortRows(loadedRows.filter((row) => {
            const haystack = `${row.seller || ''} ${row.invoiceNo || ''} ${row.amount || ''} ${row.filename || ''} ${row.error || ''}`.toLowerCase();
            if (query && !haystack.includes(query)) return false;
            if (seller && row.seller !== seller) return false;
            const status = String(row.status || '');
            const docType = String(row.documentType || '');
            // Status semantics come from the backend enum: 已识别 = 完整 only.
            if (activeTab === 'recognized' && status !== STATUS.COMPLETE) return false;
            if (activeTab === 'partial' && status !== STATUS.PARTIAL) return false;
            if (activeTab === 'failed' && status !== STATUS.FAILED) return false;
            if (activeTab === 'supporting' && docType !== 'supporting') return false;
            if (activeTab === 'itinerary' && docType !== 'itinerary') return false;
            return true;
        }), 'sortLibrary');
        tbody.innerHTML = rows.map((row) => `
            <tr>
                <td class="mono">${escapeHtml((row.date || '').slice(0, 10))}</td>
                <td>${escapeHtml(row.seller || '未识别销售方')}<span class="cell-sub">${escapeHtml(sourceLabel(row.source))} · ${escapeHtml(row.filename || '未记录文件名')}</span></td>
                <td class="mono">${escapeHtml(row.invoiceNo || '-')}</td>
                <td class="mono col-num">${escapeHtml(row.amount || '-')}</td>
                <td class="col-secondary"><span class="pill">${escapeHtml(sourceLabel(row.source))}</span></td>
                <td class="mono small col-secondary">${escapeHtml(row.filename || '')}</td>
                <td>${statusPill(row.status)}</td>
                <td><button class="btn btn--sm" type="button" data-action="open-row-file" data-file-path="${escapeHtml(row.filePath || '')}"${row.filePath ? '' : ' disabled title="该记录没有对应文件路径"'}>打开</button></td>
            </tr>
        `).join('') || `<tr><td colspan="8" class="muted">没有找到匹配结果。你可以换个关键词或取消筛选。</td></tr>`;
        const total = Number(window.FPH.libraryTotal ?? loadedRows.length);
        text('[data-library-page]', `显示 ${fmtInt(rows.length)} · 已加载 ${fmtInt(loadedRows.length)} · 共 ${fmtInt(total)} 条`);
        text('[data-library-sellers]', seller ? `销售方：${seller}（仅在已加载记录中筛选）` : '销售方：全部（仅在已加载记录中筛选）');
        renderLoadMore('library', loadedRows.length, total);
    }

    function updateSellerOptions(rows) {
        const select = activeMain().querySelector('[data-library-seller]');
        if (!select) return;
        const sellers = Array.from(new Set(rows.map((row) => row.seller).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN'));
        const current = select.value;
        select.innerHTML = '<option value="">全部销售方（已加载记录）</option>' + sellers.map((seller) => `<option value="${escapeHtml(seller)}">${escapeHtml(seller)}</option>`).join('');
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

    /* Internal product notes leaked into user-facing descriptions. Until the
       backend supplies `userMessage`, drop any sentence that reads like a
       developer instruction rather than user guidance. */
    const INTERNAL_NOTE_RE = /(GUI\s*应|界面应|默认保持|保留\s*reason|reason\s*字段|TODO|后续版本再)/i;
    function cleanDescription(value) {
        return String(value || '')
            .split(/(?<=[。；;])/)
            .filter((sentence) => sentence.trim() && !INTERNAL_NOTE_RE.test(sentence))
            .join('')
            .trim();
    }

    function rowCategory(row) {
        return String(row?.category || reasonLabel(row?.reason) || '需要确认');
    }
    function rowUserMessage(row, group) {
        if (row?.userMessage) return String(row.userMessage);
        const desc = cleanDescription(group?.userMessage || group?.description);
        return desc || '这封邮件没有自动取得发票文件。';
    }
    function rowNextStep(row, group) {
        if (row?.nextStep) return String(row.nextStep);
        const [, note] = actionText(group?.action);
        return note;
    }

    function applyPendingSummary(pending, opts = {}) {
        window.FPH.pending = pending;
        const total = Number(pending.total || 0);
        text('[data-pending="total"]', fmtInt(total));
        const groups = pending.groups || [];
        // Zero queue: hide every affordance that only makes sense with records.
        document.querySelectorAll('[data-pending-nonempty]').forEach((el) => { el.hidden = total === 0; });
        document.querySelectorAll('[data-pending-empty]').forEach((el) => { el.hidden = total !== 0; });
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
        // FB-04: a targeted row removal owns the DOM; do not blow the list away.
        if (!opts.preservePendingDom) renderPendingGroups();
    }

    function pendingRowMarkup(row, group) {
        const [primary] = actionText(group.action);
        const isKnownAction = KNOWN_PENDING_ACTIONS.has(group.action);
        const disabledAttr = isKnownAction ? '' : ' disabled title="当前版本暂未支持这种处理方式"';
        const ref = supportRef(row.hash);
        return `
            <div class="card card--tight pending-item" data-pending-row="${escapeHtml(row.hash || '')}" data-pending-action="${escapeHtml(group.action || '')}">
                <div class="row gap-8 mb-12">
                    ${pill(rowCategory(row), group.action === 'refresh_link' ? 'warn' : '')}
                    <span class="pill">${escapeHtml(rowNextStep(row, group))}</span>
                </div>
                <div class="strong pending-item__subject">${escapeHtml(row.subject || '无主题')}</div>
                <div class="mono small muted">${escapeHtml((row.date || '').slice(0, 10))} · ${escapeHtml(row.from || '')}</div>
                <div class="small muted mt-12">${escapeHtml(rowUserMessage(row, group))}</div>
                <div class="row gap-8 mt-12">
                    <button class="btn btn--sm btn--primary" type="button" data-action="pending-primary" data-hash="${escapeHtml(row.hash || '')}" data-action-kind="${escapeHtml(group.action)}"${disabledAttr}>${escapeHtml(primary)}</button>
                    <button class="btn btn--sm btn--ghost" type="button" data-action="copy-diagnostics" data-hash="${escapeHtml(row.hash || '')}">复制诊断信息</button>
                </div>
                <details class="toast__detail mt-12">
                    <summary>诊断信息（已脱敏）</summary>
                    <pre>支持编号：${escapeHtml(ref)}
原因：${escapeHtml(sanitizeText(row.reason || '未记录'))}</pre>
                </details>
            </div>
        `;
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
            ? '<div class="card"><div class="strong" tabindex="-1" data-pending-empty-focus>待确认队列是空的</div><div class="small muted mt-12">所有邮件都已经自动处理完成，这里不需要你做任何事。</div></div>'
            : '<div class="card"><div class="strong" tabindex="-1" data-pending-empty-focus>当前分类暂无邮件</div><div class="small muted mt-12">切换到「全部」可以查看其它分类的邮件。</div></div>';
        mount.innerHTML = groups.map((group, index) => {
            const headId = `pending-head-${index}`;
            const bodyId = `pending-body-${index}`;
            // Every row is rendered: no group is silently truncated.
            const rows = (group.rows || []).map((row) => pendingRowMarkup(row, group)).join('');
            const groupTotal = Number(group.total ?? group.count ?? (group.rows || []).length);
            const shown = (group.rows || []).length;
            const description = cleanDescription(group.userMessage || group.description);
            return `
                <div class="group is-open" data-pending-group="${escapeHtml(group.action || '')}">
                    <h3 class="group__heading">
                        <button class="group__head" type="button" id="${headId}" aria-expanded="true" aria-controls="${bodyId}">
                            ${ICON.chev.replace('class="ic"', 'class="ic group__chev"')}
                            <span class="group__title">${escapeHtml(group.title)}</span>
                            <span class="group__count">${fmtInt(groupTotal)}</span>
                        </button>
                    </h3>
                    <div class="group__body" id="${bodyId}" role="region" aria-labelledby="${headId}">
                        <div class="group__inner">
                            ${description ? `<div class="small muted mb-12">${escapeHtml(description)}</div>` : ''}
                            <div data-pending-rows>${rows || '<div class="card card--tight muted">暂无明细</div>'}</div>
                            ${groupTotal > shown ? `<div class="small muted mt-12" data-group-more>本地只取回了 ${fmtInt(shown)} / ${fmtInt(groupTotal)} 条，请点击“刷新列表”重新读取。</div>` : ''}
                        </div>
                    </div>
                </div>
            `;
        }).join('') || emptyMarkup;
    }

    /* Terminal state after the last queued item is handled: rebuild the region
       so the user sees the real empty state instead of a stale group whose body
       just says "这一组已经处理完了" (FB-04 / UI-08C). */
    function showPendingTerminalState(announcement) {
        renderPendingGroups();
        const focusTarget = activeMain().querySelector('[data-pending-empty-focus]')
            || document.querySelector('[data-pending-empty] [data-action="reload-summary"]');
        if (focusTarget) {
            if (!focusTarget.hasAttribute('tabindex') && !/^(BUTTON|A|INPUT|SELECT)$/.test(focusTarget.tagName)) {
                focusTarget.setAttribute('tabindex', '-1');
            }
            focusTarget.focus?.({ preventScroll: false });
        }
        announce(`${announcement || '已处理这封邮件'}，待确认队列已经清空。`);
    }

    /* FB-04: remove a single card in place, keep the rest of the DOM (and the
       expansion state) alive, and hand focus to a sensible neighbour. */
    function removePendingRowInPlace(hash, announcement) {
        const card = document.querySelector(`[data-pending-row="${CSS.escape(String(hash || ''))}"]`);
        if (!card) return false;
        const container = card.closest('[data-pending-rows]') || card.parentElement;
        const group = card.closest('.group');
        const siblings = Array.from(container?.querySelectorAll(':scope > .pending-item') || []);
        const index = siblings.indexOf(card);
        const nextCard = siblings[index + 1] || siblings[index - 1] || null;
        const focusTarget = nextCard?.querySelector('[data-action="pending-primary"]')
            || group?.querySelector('.group__head')
            || document.querySelector('[data-pending-groups]');

        const groupsMount = group?.closest('[data-pending-groups]');

        const finish = () => {
            card.remove();
            const remaining = Array.from(container?.querySelectorAll(':scope > .pending-item') || []).length;
            const countEl = group?.querySelector('.group__count');
            if (countEl) countEl.textContent = fmtInt(remaining);
            if (remaining === 0) {
                // An emptied group is stale: drop it. When it was the last one,
                // fall through to the real empty state instead of leaving a
                // hollow accordion behind.
                group?.remove();
                const groupsLeft = groupsMount?.querySelectorAll('.group').length || 0;
                if (groupsLeft === 0) {
                    showPendingTerminalState(announcement);
                    return;
                }
                const nextHead = groupsMount?.querySelector('.group__head');
                nextHead?.focus?.({ preventScroll: false });
                announce(`${announcement || '已处理这封邮件'}，这一组已经处理完，还有 ${groupsLeft} 组待确认。`);
                return;
            }
            if (focusTarget) {
                if (!focusTarget.hasAttribute('tabindex') && !/^(BUTTON|A|INPUT|SELECT)$/.test(focusTarget.tagName)) {
                    focusTarget.setAttribute('tabindex', '-1');
                }
                focusTarget.focus?.({ preventScroll: false });
            }
            announce(`${announcement || '已处理这封邮件'}，本组还剩 ${remaining} 封。`);
        };

        if (prefersReducedMotion()) {
            finish();
        } else {
            card.style.maxHeight = `${card.offsetHeight}px`;
            requestAnimationFrame(() => card.classList.add('is-removing'));
            window.setTimeout(finish, 180);
        }
        return true;
    }

    /* Values shipped in config.example.json must never read as "configured". */
    const PLACEHOLDER_HOSTS = new Set(['imap.example.com', 'smtp.example.com', 'mail.example.com']);
    const PLACEHOLDER_USERS = new Set(['me@example.com', 'user@example.com', 'you@example.com']);
    const PLACEHOLDER_SECRETS = new Set(['***', '******', 'your-password', 'changeme', 'password']);

    function credentialStored(secrets, rawPass) {
        // The IPC boundary redacts secrets; prefer its boolean shadow.
        if (typeof secrets?.imapPass === 'boolean') return secrets.imapPass;
        const value = String(rawPass || '').trim();
        if (!value) return false;
        return !PLACEHOLDER_SECRETS.has(value);
    }

    function applyMailStatus(cfg, secrets) {
        const imap = cfg?.imap || {};
        const host = typeof imap.host === 'string' ? imap.host.trim() : '';
        const user = typeof imap.user === 'string' ? imap.user.trim() : '';
        const pass = typeof imap.pass === 'string' ? imap.pass.trim() : '';
        const realHost = Boolean(host) && !PLACEHOLDER_HOSTS.has(host.toLowerCase());
        const realUser = Boolean(user) && !PLACEHOLDER_USERS.has(user.toLowerCase());
        const configured = realHost && realUser && credentialStored(secrets, pass);
        const verified = configured && window.FPH.credentialsVerified === true;
        document.querySelectorAll('[data-mail-status-label]').forEach((el) => {
            el.textContent = verified ? `已连接 · ${user}` : configured ? `已保存 · ${user}` : '邮箱未配置';
        });
        document.querySelectorAll('[data-mail-status-dot]').forEach((el) => {
            el.classList.toggle('is-off', !configured);
        });
        document.querySelectorAll('[data-mail-status-meta]').forEach((el) => {
            el.textContent = verified ? `邮箱已连接 · ${host}`
                : configured ? '邮箱设置已保存，建议先点“测试邮箱连接”'
                : '请先在「邮箱与保存」页填写邮箱';
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
            setChecked(el, cfg.imap?.tls !== false);
        });
        set('[data-config="filter.keywords"]', Array.isArray(cfg.filter?.keywords) ? cfg.filter.keywords.join(', ') : '');
        const matchSubject = cfg.filter?.matchSubject !== false;
        const matchBody = cfg.filter?.matchBody !== false;
        document.querySelectorAll('[data-fetch-check="matchSubject"]').forEach((el) => setChecked(el, matchSubject));
        document.querySelectorAll('[data-fetch-check="matchBody"]').forEach((el) => setChecked(el, matchBody));
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
            setChecked(el, cfg.rename?.avoidConflictBeforeOcr !== false);
        });
        document.querySelectorAll('[data-config-check="rename.applyAfterOcr"]').forEach((el) => {
            setChecked(el, cfg.rename?.applyAfterOcr === true);
        });
        document.querySelectorAll('[data-config-check="rename.organizeByType"]').forEach((el) => {
            setChecked(el, cfg.rename?.organizeByType === true);
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
        // playwright.browserManagement is intentionally not surfaced: the setting
        // was never read by the CLI (APP-19). Chrome/Edge must exist on the system.
        set('[data-config="playwright.timeoutMs"]', cfg.playwright?.timeoutMs);
        applyOcrStatusCards();
    }

    /* ---------- Page-commit hook ----------
       One place for "re-render the current real state onto this DOM".
       A page inserted by the SPA loader starts from the static placeholders in
       its HTML, so every piece of state that does NOT arrive through the
       summary/config payloads must be replayed here. FB-01 (a running job's
       controls) and COPY-07B (About version/channel) are the same root cause,
       so they deliberately share this hook instead of separate call sites.
       Runs once from wire() and after every showPage() commit. */
    function applyLiveState(pageId) {
        applyOpState(window.FPH.opState || null);
        renderAppInfo();
        if (!appInfoLoaded || pageId === 'settings') {
            // Also recovers when the bridge only became available after wire().
            Promise.resolve(loadAppInfo({ force: pageId === 'settings' })).catch(() => {});
        }
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
                announce(`已在${targetPage === 'inbox' ? '邮件记录' : '发票库'}的已加载记录中搜索「${q}」`);
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
        'load-more',
        'repair-config',
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
        'load-more': '正在加载…',
        'repair-config': '正在重建…',
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
        if (name === 'load-more') { await loadMoreRows(action.dataset.loadKind || 'inbox', action); return; }
        if (name === 'copy-diagnostics') { await copyPendingDiagnostics(action.dataset.hash || ''); return; }
        if (name === 'copy-text') { await copyText(sanitizeText(action.dataset.copyText || '')); return; }
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
            showToast(title, eventMessage(result) || (result?.ok ? okFallback : '请查看最近运行记录。'), kind, {
                detail: result?.ok ? '' : eventDetail(result),
            });
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
        if (name === 'repair-config') { await repairConfig(); return; }
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
            const saved = await saveConfigChecked(patch);
            if (!saved.ok) return;
            window.FPH.credentialsVerified = false;
            await loadBridgeConfig();
            const input = document.querySelector(`[data-config="${key}"]`);
            if (input) input.value = '';
            showToast('已清除', `${label}已从本机配置中移除。`, 'warn');
        } catch (err) {
            showToast('清除失败', '没能清除这项凭据，请重试。', 'err', { detail: err?.message });
        }
    }

    function selectedOcrConcurrency() {
        const scope = activeMain();
        const value = Number(scope.querySelector('[data-ocr-parallel]')?.value || 1);
        return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
    }

    function downloadRenameEnabled() {
        const el = activeMain().querySelector('[data-download-rename-toggle]');
        return el ? isChecked(el) : true;
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
        showToast(
            result?.ok ? '正在停止识别' : '停止失败',
            eventMessage(result) || (result?.ok ? '已经发出停止指令，正在等待引擎退出。' : '没能停止识别，请稍后重试。'),
            result?.ok ? 'warn' : 'err',
            { detail: result?.ok ? '' : eventDetail(result) },
        );
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
        Promise.resolve(fn(patch)).then((result) => {
            if (result && result.ok === false) {
                if (result.configError) showConfigError(result.configError);
                else applyFieldErrors(result.fieldErrors);
                showToast('这项设置没有保存', eventMessage(result) || '请到「邮箱与保存」页检查设置。', 'err');
            }
        }).catch((err) => {
            showToast('保存失败', '这项设置没有写入本机，请稍后重试。', 'err', { detail: err?.message });
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
            const failMessage = '操作没有完成，本地数据没有变化。';
            if (method === 'runOcr') {
                applyOcrProgress({
                    phase: '识别失败',
                    percent: 100,
                    total: 0,
                    processed: 0,
                    parsed: 0,
                    skipped: 0,
                    failed: 0,
                    message: failMessage,
                    kind: 'err',
                    done: true,
                });
            }
            if (method === 'runPipeline') {
                applyFileProgress({
                    phase: '获取失败',
                    percent: 100,
                    message: failMessage,
                    kind: 'err',
                    done: true,
                });
            }
            showToast('运行失败', failMessage, 'err', { detail: err?.message, scope: 'global' });
            return;
        }
        if (result?.summary) applySummary(result.summary);
        if (result?.normalizedFilter) applyNormalizedFilter(result.normalizedFilter);
        if (method === 'runPipeline') setCurrentBatch(result);
        const readable = eventMessage(result);
        const detail = eventDetail(result);
        if (method === 'runOcr' && !result?.ok && !result?.summary) {
            applyOcrProgress({
                phase: '识别失败',
                percent: 100,
                message: readable || '识别失败，请查看诊断信息。',
                kind: 'err',
                done: true,
            });
        }
        if (method === 'runPipeline' && !result?.ok && !result?.summary) {
            applyFileProgress({
                phase: '获取失败',
                percent: 100,
                message: readable || '获取发票文件失败，请查看诊断信息。',
                kind: 'err',
                done: true,
            });
        }
        showToast(
            result?.ok ? okTitle : '运行失败',
            result?.ok ? (readable || okMessage) : (readable || '操作没有完成。展开诊断信息可以查看技术细节。'),
            result?.ok ? 'ok' : 'err',
            { detail: result?.ok ? '' : detail, scope: 'global' },
        );
    }

    async function openConfiguredPath(key, fallback) {
        const cfg = window.FPH.configPayload?.config || {};
        const value = key.split('.').reduce((cur, part) => cur?.[part], cfg) || fallback;
        if (!window.mfhBridge?.openPath) { bridgeUnavailable(); return; }
        const result = await window.mfhBridge.openPath({ path: value });
        showToast(
            result?.ok ? '已打开文件夹' : '打开失败',
            result?.ok ? '已在系统文件管理器中打开。' : '无法打开这个文件夹，请确认它仍然存在。',
            result?.ok ? 'ok' : 'err',
            { detail: result?.ok ? '' : eventDetail(result) },
        );
    }

    async function openRowFile(action) {
        const value = action.dataset.filePath || '';
        if (!value) {
            showToast('打开失败', '这条记录没有对应文件路径，请先归档源文件。', 'err');
            return;
        }
        if (!window.mfhBridge?.openPath) { bridgeUnavailable(); return; }
        const result = await window.mfhBridge.openPath({ path: value, reveal: true });
        showToast(
            result?.ok ? '已打开文件位置' : '打开失败',
            result?.ok ? '已定位到对应文件。' : '无法定位这个文件，它可能已经被移动或删除。',
            result?.ok ? 'ok' : 'err',
            { detail: result?.ok ? '' : eventDetail(result) },
        );
    }

    /* Diagnostics are always redacted before they reach the clipboard. */
    async function copyPendingDiagnostics(hash) {
        const groups = window.FPH.pending?.groups || [];
        let found = null;
        let owner = null;
        for (const group of groups) {
            const row = (group.rows || []).find((item) => String(item.hash || '') === String(hash));
            if (row) { found = row; owner = group; break; }
        }
        if (!found) { showToast('没有找到这条记录', '请先点击“刷新列表”。', 'warn'); return; }
        const lines = [
            `支持编号：${supportRef(found.hash)}`,
            `分类：${rowCategory(found)}`,
            `下一步：${rowNextStep(found, owner)}`,
            `主题：${found.subject || '无主题'}`,
            `日期：${(found.date || '').slice(0, 10)}`,
            `原因：${sanitizeText(found.reason || '未记录')}`,
        ];
        await copyText(lines.join('\n'), '诊断信息');
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
            showToast('复制失败', '当前环境不允许写入剪贴板，请改用桌面版或检查权限。', 'err', { detail: err?.message });
            return;
        }
        showToast('已复制', label ? `${label}已复制到剪贴板。` : '内容已复制到剪贴板。');
    }

    /* ---------- Config save contract (APP-08 / UI-06) ----------
       { ok: false, fieldErrors: [{ path, message }] } → block and show the
       error next to each field; { ok: false, configError } → blocking repair
       entry point; { ok: true, config } → apply. */
    /* An invalid field inside a collapsed 高级设置 section must not stay hidden. */
    function revealField(el) {
        let node = el?.parentElement;
        while (node) {
            if (node.tagName === 'DETAILS') node.open = true;
            node = node.parentElement;
        }
    }

    function applyFieldErrors(fieldErrors) {
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

    function showConfigError(configError) {
        const signature = String(configError?.message || 'config-error');
        const repeated = window.FPH._configErrorSignature === signature;
        window.FPH._configErrorSignature = signature;
        window.FPH.configError = configError || { message: '本机配置文件无法读取。' };
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

    function clearConfigError() {
        window.FPH.configError = null;
        window.FPH._configErrorSignature = '';
        document.querySelectorAll('[data-config-blocker]').forEach((el) => {
            el.hidden = true;
            el.replaceChildren();
        });
    }

    /* APP-08: the only way out of a corrupted config file. Plain saves keep
       returning `configError`, so the repair must explicitly ask the main
       process to quarantine the broken file and rebuild from this payload. */
    async function repairConfig() {
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
        const backupPath = result?.backupPath || result?.configError?.backupPath || '';
        showToast(
            '配置已重建',
            backupPath
                ? `已用当前填写的内容重新生成配置，损坏的旧文件已另存为备份：${sanitizeText(backupPath)}`
                : '已用当前填写的内容重新生成配置，损坏的旧文件已另存为备份。',
            'ok',
            { duration: 8000 },
        );
        announce('配置已重建，可以继续使用。');
    }

    /* Shared entry point used by the config page's autosave and by
       testConnection: a failed save must never be treated as success. */
    async function saveConfigChecked(payload) {
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

    async function testConnection() {
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
            // Only a real successful connection may mark credentials as configured.
            window.FPH.credentialsVerified = true;
            await reloadMailboxes({ silent: true });
            await loadBridgeConfig();
        }
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
            if (statusEl) statusEl.textContent = eventMessage(result) || '读取失败';
            if (!opts.silent) showToast('读取失败', eventMessage(result) || '请先填写邮箱主机、账号和授权码。', 'err', { detail: eventDetail(result) });
        }
    }

    async function developerReset() {
        const first = window.confirm([
            '重置应用数据（将删除所有本机数据）',
            '',
            '以下内容会被永久删除，且不能撤销：',
            '· 已归档的发票和行程单原件（财务原件，删除后无法恢复）',
            '· 本机缓存的邮件原文',
            '· 待确认队列',
            '· 识别结果清册和 CSV',
            '· 运行历史记录',
            '· 邮箱增量同步状态（下次运行会当作首次同步）',
            '',
            '不会删除：邮箱与保存设置。',
            '',
            '确认继续吗？',
        ].join('\n'));
        if (!first) return;
        const second = window.confirm('再次确认：已归档的发票原件会被删除。请先自行备份需要保留的文件。确定要删除吗？');
        if (!second) return;
        if (!window.mfhBridge?.developerReset) { bridgeUnavailable(); return; }
        const result = await window.mfhBridge.developerReset();
        if (result?.summary) applySummary(result.summary);
        // Reset only touches paths inside the app-managed data directory.
        const skipped = Array.isArray(result?.skippedExternal) ? result.skippedExternal : [];
        const removedCount = fmtInt(result?.removed?.length || 0);
        const sub = skipped.length > 0
            ? `已删除 ${removedCount} 个应用管理的位置。有 ${fmtInt(skipped.length)} 个位置保存在应用目录之外，没有被删除，需要你自行处理。`
            : `已删除 ${removedCount} 个应用管理的位置。邮箱与保存设置已保留。`;
        showToast('仅重置了应用管理的数据', sub, skipped.length > 0 ? 'warn' : 'ok', {
            detail: skipped.length > 0 ? `未删除的外部位置：\n${skipped.map((item) => sanitizeText(item)).join('\n')}` : '',
            sticky: skipped.length > 0,
            scope: 'global',
        });
    }

    /* Queue is empty after this operation: the summary must own the DOM so the
       real empty state renders (a preserved DOM would keep the stale group). */
    function pendingQueueEmptyAfter(result) {
        const total = result?.summary?.pending?.total;
        return Number.isFinite(Number(total)) && Number(total) === 0;
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
            showToast(
                result?.ok ? '已打开原始邮件' : '没有找到原始邮件',
                eventMessage(result) || (result?.ok ? '请在邮件里重新获取下载链接后再回来重试。' : '本机缓存里找不到这封邮件，可以先刷新列表。'),
                result?.ok ? 'ok' : 'err',
                { detail: result?.ok ? '' : eventDetail(result) },
            );
            return;
        }
        if (kind === 'ignore') {
            const confirmed = window.confirm('确认把这封邮件从待确认队列中移除吗？原始邮件仍会保留在邮件缓存里。');
            if (!confirmed) return;
            const fn = window.mfhBridge?.pendingIgnore;
            if (!fn) { bridgeUnavailable(); return; }
            const result = await fn({ hash });
            // Update the affected row in place, then refresh counters without
            // rebuilding the whole list (keeps focus and expansion state).
            // When it was the last queued item, let the summary re-render and
            // show the real empty state instead.
            const emptied = pendingQueueEmptyAfter(result);
            const removed = result?.ok && !emptied ? removePendingRowInPlace(hash, '已从待确认队列中移除') : false;
            if (result?.summary) applySummary(result.summary, { preservePendingDom: removed });
            if (result?.ok && emptied) showPendingTerminalState('已从待确认队列中移除');
            showToast(
                result?.ok ? '已忽略' : '忽略失败',
                eventMessage(result) || (result?.ok ? '这封邮件已从待确认队列移除，原始邮件仍保留在缓存里。' : '没能更新待确认队列，请重试。'),
                result?.ok ? 'ok' : 'err',
                { detail: result?.ok ? '' : eventDetail(result) },
            );
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
        if (result?.canceled) {
            if (result?.summary) applySummary(result.summary);
            showToast('已取消归档', '没有选择文件，待确认队列保持不变。', 'warn');
            return;
        }
        const emptied = pendingQueueEmptyAfter(result);
        const removed = result?.ok && !emptied ? removePendingRowInPlace(hash, '已归档并移出待确认队列') : false;
        if (result?.summary) applySummary(result.summary, { preservePendingDom: removed });
        if (result?.ok && emptied) showPendingTerminalState('已归档并移出待确认队列');
        showToast(
            result?.ok ? '已归档' : '归档失败',
            eventMessage(result) || (result?.ok ? '文件已复制到归档目录，并加入识别队列。' : '文件没有归档成功，待确认记录保持不变。'),
            result?.ok ? 'ok' : 'err',
            { detail: result?.ok ? '' : eventDetail(result) },
        );
    }

    function showFetchPreview() {
        const from = document.getElementById('date-from')?.value || '开始日期';
        const to = document.getElementById('date-to')?.value || '结束日期';
        const matchSubject = checkedBySelector('[data-fetch-check="matchSubject"]');
        const matchBody = checkedBySelector('[data-fetch-check="matchBody"]');
        const dryRun = checkedBySelector('[data-fetch-check="dryRun"]');
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
        if (matchParts.length === 0) {
            showToast('还不能运行', '“匹配主题”和“匹配正文”至少要选一个，否则不会命中任何邮件。', 'warn');
            return;
        }
        const matchText = matchParts.join(' + ');
        const lines = [
            `日期：${from} 至 ${to}（按本机日历日，含起止当天全天）`,
            `关键词：${keywords}`,
            `匹配范围：${matchText}`,
            `邮箱文件夹：${mailboxes}`,
            dryRun ? '模式：只预览，不保存原件' : '模式：保存命中邮件到本机',
        ];
        showToast('将要执行的抓取', lines.join(' · '), 'ok', { duration: 6000 });
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
        // Redact before the log ever reaches the clipboard (URLs with tokens,
        // absolute local paths, full content hashes).
        const body = sanitizeText(parts.join('\n\n'));
        copyText(body ? `${body}\n\n（已移除链接参数、本机绝对路径和完整编号）` : '暂无实时日志', '运行日志');
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
            const lines = [['分组', '下一步', '主题', '日期', '发件人', '原因分类', '支持编号', '诊断原因（已脱敏）'].map(csvField).join(',')];
            for (const group of groups) {
                const [primary] = actionText(group.action);
                for (const row of group.rows || []) {
                    lines.push([
                        group.title || '',
                        primary || '',
                        row.subject || '',
                        (row.date || '').slice(0, 10),
                        row.from || '',
                        rowCategory(row),
                        supportRef(row.hash),
                        sanitizeText(row.reason || ''),
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

    /* showToast(title, sub, kind, options)
       options: number (legacy duration) | { duration, detail, sticky }
       - success/info → role="status", auto-dismiss
       - failures that need action (kind === 'err') → role="alert", never
         auto-dismiss, always closable
       - hover/focus pauses the dismissal timer
       - technical output only appears inside the redacted「诊断信息」disclosure */
    const MAX_VISIBLE_TOASTS = 4;

    function toastStack() {
        let stack = document.querySelector('.toast-stack');
        if (!stack) {
            stack = document.createElement('div');
            stack.className = 'toast-stack';
            document.body.appendChild(stack);
        }
        return stack;
    }

    /* Sticky errors used to grow without bound: with no cap, no dedupe and no
       scroll the oldest toasts left the viewport and their close buttons became
       unreachable (FB-02). */
    function trimToastStack(stack) {
        const toasts = Array.from(stack.querySelectorAll('.toast'));
        const excess = toasts.length - MAX_VISIBLE_TOASTS;
        if (excess <= 0) return;
        // Drop auto-dismissing toasts first; only then the oldest sticky ones.
        const disposable = toasts.filter((el) => el.dataset.toastSticky !== 'true');
        const ordered = disposable.concat(toasts.filter((el) => el.dataset.toastSticky === 'true'));
        ordered.slice(0, excess).forEach((el) => el.remove());
    }

    /* Close every page-scoped toast; background job failures are marked
       `scope: 'global'` and survive navigation. */
    function dismissPageToasts() {
        document.querySelectorAll('.toast[data-toast-scope="page"]').forEach((el) => el.remove());
    }

    function showToast(title, sub, kind = 'ok', options) {
        const opts = typeof options === 'number'
            ? { duration: options }
            : (options && typeof options === 'object' ? options : {});
        const isError = kind === 'err';
        const sticky = opts.sticky ?? isError;
        const scope = opts.scope === 'global' ? 'global' : 'page';
        const duration = Math.max(1500, Number(opts.duration) || (kind === 'warn' ? 4200 : 2600));
        const detail = opts.detail ? sanitizeText(opts.detail) : '';
        const safeSub = sub ? sanitizeText(sub) : '';
        const signature = `${kind}|${title}|${safeSub}|${detail}`;

        const stack = toastStack();

        // Merge repeats of the same message instead of stacking copies.
        const existing = Array.from(stack.querySelectorAll('.toast'))
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
        close.textContent = '\u00d7';

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
        stack.appendChild(toast);
        trimToastStack(stack);

        let timer = 0;
        const dismiss = () => { window.clearTimeout(timer); toast.remove(); };
        const schedule = () => {
            if (sticky) return;
            window.clearTimeout(timer);
            timer = window.setTimeout(dismiss, duration);
        };
        close.addEventListener('click', dismiss);
        toast.querySelector('[data-toast-copy]')?.addEventListener('click', () => {
            copyText(`${title}\n${safeSub}\n\n${detail}`, '诊断信息');
        });
        toast.addEventListener('mouseenter', () => window.clearTimeout(timer));
        toast.addEventListener('mouseleave', schedule);
        toast.addEventListener('focusin', () => window.clearTimeout(timer));
        toast.addEventListener('focusout', schedule);
        toast.addEventListener('mfh:toast-repeat', schedule);
        schedule();
        return toast;
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
        applyNormalizedFilter,
        setCurrentBatch,
        saveConfigChecked,
        applyFieldErrors,
        showConfigError,
        clearConfigError,
        repairConfig,
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
})();
