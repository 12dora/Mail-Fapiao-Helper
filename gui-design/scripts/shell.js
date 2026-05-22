/* 发票助手桌面端壳层。
   为 Electron 预留 window.mfhBridge，当前静态预览会使用本地演示数据。 */

(function () {
    'use strict';

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
                    <span class="status-dot"></span>
                    <span>邮箱已连接</span>
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
                    const currentKey = window.FPH.sortKey;
                    window.FPH.sortDir = currentKey === key && window.FPH.sortDir === 'asc' ? 'desc' : 'asc';
                    window.FPH.sortKey = key;
                    sortHeader.parentElement.querySelectorAll('th').forEach(x => x.classList.remove('is-sorted', 'is-sorted-desc'));
                    sortHeader.classList.add('is-sorted');
                    if (window.FPH.sortDir === 'desc') sortHeader.classList.add('is-sorted-desc');
                    renderInboxRows();
                    renderLibraryRows();
                }
            }

            // Tabs
            const tab = e.target.closest('.tabs .tab');
            if (tab) {
                tab.parentElement.querySelectorAll('.tab').forEach(t => t.classList.remove('is-active'));
                tab.classList.add('is-active');
                renderLibraryRows();
                if (tab.dataset.pendingTab) renderPendingGroups();
            }

            // Filter chip toggle
            const chip = e.target.closest('.filterbar .chip[data-toggle]');
            if (chip) {
                chip.classList.toggle('is-active');
                renderInboxRows();
                renderLibraryRows();
            }

            // Toggle controls
            const tg = e.target.closest('.toggle');
            if (tg) tg.classList.toggle('is-on');

            const ck = e.target.closest('.check');
            if (ck) {
                ck.classList.toggle('is-on');
                renderLibraryRows();
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

    function sortRows(rows) {
        const key = window.FPH.sortKey;
        if (!key) return rows;
        const dir = window.FPH.sortDir === 'asc' ? 1 : -1;
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
            applyConfig(payload.config || {});
        } catch {
            // Config page keeps its inline defaults when no local config exists.
        }
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
            el.classList.remove('is-idle', 'is-done');
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
        document.querySelectorAll('[data-ocr-progress]').forEach((el) => {
            el.classList.remove('is-idle');
            el.classList.toggle('is-done', Boolean(data.done) || percent >= 100);
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
            if (running) {
                el.dataset.ocrMode = 'stop';
                el.textContent = '停止识别';
            } else if (hasRecognizedResults()) {
                el.dataset.ocrMode = 'rerun';
                el.textContent = document.body.dataset.page === 'dashboard' ? '重新识别发票文件' : '重新识别';
            } else {
                el.dataset.ocrMode = 'start';
                el.textContent = document.body.dataset.page === 'dashboard' ? '开始识别发票文件' : '开始识别';
            }
        });
    }

    function resetFileProgress(message = '正在准备获取发票文件。') {
        document.querySelectorAll('[data-file-progress]').forEach((el) => {
            el.classList.remove('is-idle', 'is-done');
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
        document.querySelectorAll('[data-file-progress]').forEach((el) => {
            el.classList.remove('is-idle');
            el.classList.toggle('is-done', Boolean(data.done) || percent >= 100);
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
        const groups = pending.groups || [];
        const slots = document.querySelectorAll('[data-pending-line]');
        slots.forEach((slot, index) => {
            const group = groups[index];
            slot.innerHTML = group
                ? `<span>${group.title}</span><span class="strong">${fmtInt(group.count)}</span>`
                : '<span>暂无待确认邮件</span><span class="strong">0</span>';
        });
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
        text('[data-inbox="latest"]', inbox.latestMonth || '暂无');
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
        }));
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
        }));
        tbody.innerHTML = rows.slice(0, 80).map((row) => `
            <tr>
                <td class="mono">${escapeHtml((row.date || '').slice(0, 10))}</td>
                <td>${escapeHtml(row.seller || '未识别销售方')}</td>
                <td class="mono">${escapeHtml(row.invoiceNo || '-')}</td>
                <td class="mono col-num">${escapeHtml(row.amount || '-')}</td>
                <td><span class="pill">${escapeHtml(sourceLabel(row.source))}</span></td>
                <td class="mono small">${escapeHtml(row.filename || '')}</td>
                <td>${statusPill(row.status)}</td>
                <td><button class="btn btn--sm" data-action="open-row-file" data-file-path="${escapeHtml(row.filePath || row.filename || '')}">打开</button></td>
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

    function actionText(action) {
        if (action === 'refresh_link') return ['刷新链接', '需要用户重新打开平台或授权'];
        if (action === 'retry') return ['重新尝试', '适合临时网络失败'];
        if (action === 'ignore') return ['确认忽略', '确认不是发票后可忽略'];
        return ['手动归档', '保存已下载的文件'];
    }

    function applyPendingSummary(pending) {
        window.FPH.pending = pending;
        text('[data-pending="total"]', fmtInt(pending.total));
        const groups = pending.groups || [];
        document.querySelectorAll('[data-pending-stat]').forEach((el, index) => {
            const group = groups[index];
            const value = el.querySelector('.stat__value');
            const label = el.querySelector('.stat__label');
            const delta = el.querySelector('.stat__delta');
            if (!group) {
                if (label) label.textContent = '暂无待确认';
                if (value) value.textContent = '0';
                if (delta) delta.textContent = '无需处理';
                return;
            }
            const [action] = actionText(group.action);
            if (label) label.textContent = group.title;
            if (value) value.textContent = fmtInt(group.count);
            if (delta) delta.textContent = action;
        });
        renderPendingGroups();
    }

    function renderPendingGroups() {
        const mount = activeMain().querySelector('[data-pending-groups]');
        if (!mount) return;
        const pending = window.FPH.pending || {};
        const activeTab = activeMain().querySelector('[data-pending-tab].is-active')?.dataset.pendingTab || 'all';
        const groups = (pending.groups || []).filter((group) => {
            if (activeTab === 'all') return true;
            if (activeTab === 'manual_archive') {
                return !['refresh_link', 'retry', 'ignore'].includes(group.action);
            }
            return group.action === activeTab;
        });
        mount.innerHTML = groups.map((group) => {
            const [primary, note] = actionText(group.action);
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
                        <button class="btn btn--sm btn--primary" data-action="pending-primary" data-hash="${escapeHtml(row.hash)}" data-action-kind="${escapeHtml(group.action)}">${primary}</button>
                        <button class="btn btn--sm" data-action="open-pending-folder">打开待确认文件夹</button>
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
        }).join('') || '<div class="card"><div class="strong">暂无待确认邮件</div><div class="small muted mt-12">当前本地队列为空。</div></div>';
    }

    function applyConfig(cfg) {
        const set = (selector, value) => {
            const el = document.querySelector(selector);
            if (el && value !== undefined && value !== null) el.value = value;
        };
        set('[data-config="imap.host"]', cfg.imap?.host);
        set('[data-config="imap.port"]', cfg.imap?.port);
        set('[data-config="imap.user"]', cfg.imap?.user);
        const mailboxSelect = document.querySelector('[data-config="imap.mailbox"]');
        if (mailboxSelect && Array.isArray(cfg.imap?.mailbox)) {
            const selected = new Set(cfg.imap.mailbox);
            Array.from(mailboxSelect.options).forEach((opt) => {
                opt.selected = selected.has(opt.value);
            });
        }
        document.querySelectorAll('[data-config-check="imap.tls"]').forEach((el) => {
            el.classList.toggle('is-on', cfg.imap?.tls !== false);
        });
        set('[data-config="filter.keywords"]', Array.isArray(cfg.filter?.keywords) ? cfg.filter.keywords.join(', ') : '');
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
        set('[data-config="ocr.credentials.tencentSecretId"]', cfg.ocr?.credentials?.tencentSecretId || cfg.ocr?.credentials?.secretId || '');
        set('[data-config="ocr.credentials.tencentSecretKey"]', cfg.ocr?.credentials?.tencentSecretKey || cfg.ocr?.credentials?.secretKey || '');
        set('[data-config="ocr.credentials.tencentRegion"]', cfg.ocr?.credentials?.tencentRegion || cfg.ocr?.credentials?.region || 'ap-shanghai');
        set('[data-config="playwright.browserManagement"]', cfg.playwright?.browserManagement || 'app-managed');
        set('[data-config="playwright.timeoutMs"]', cfg.playwright?.timeoutMs);
    }

    function wireSearch() {
        document.querySelector('[data-global-search]')?.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            const q = encodeURIComponent(event.currentTarget.value.trim());
            if (!q) return;
            showPage('library', `library.html?q=${q}`);
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

    async function handleAction(action) {
        const name = action.dataset.action;
        if (name === 'open-dashboard') { await showPage('dashboard', rel('dashboard.html')); return; }
        if (name === 'open-pending-page') { await showPage('pending', rel('pending.html')); return; }
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
        if (name === 'organize') {
            const fn = window.mfhBridge?.organize;
            if (!fn) { bridgeUnavailable(); return; }
            const result = await fn({});
            if (result?.summary) applySummary(result.summary);
            const empty = typeof result?.message === 'string' && result.message.includes('目前没有可整理');
            const kind = result?.ok ? (empty ? 'warn' : 'ok') : 'err';
            const title = result?.ok ? (empty ? '没有可整理的识别结果' : '整理完成') : '运行失败';
            showToast(title, result?.message || (result?.ok ? '已按当前规则整理输出。' : '请查看最近运行记录。'), kind);
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
        if (name === 'discard-config') { window.location.reload(); return; }
        if (name === 'developer-reset') { await developerReset(); return; }
        if (name === 'pending-primary') { handlePendingAction(action); return; }
    }

    function selectedOcrConcurrency() {
        const value = Number(document.querySelector('[data-ocr-parallel]')?.value || 1);
        return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
    }

    function downloadRenameEnabled() {
        return document.querySelector('[data-download-rename-toggle]')?.classList.contains('is-on') !== false;
    }

    async function handleOcrToggle(action) {
        const mode = action.dataset.ocrMode || 'start';
        if (mode === 'stop') {
            await stopOcr();
            return;
        }
        if (mode === 'rerun') {
            const confirmed = window.confirm('重新识别会删除已有识别结果，并把发票队列重置为待识别。确认继续吗？');
            if (!confirmed) return;
            await runOcr(true);
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
        const result = await fn();
        showToast(result?.ok ? '正在停止识别' : '停止失败', result?.message || '', result?.ok ? 'warn' : 'err');
    }

    function bridgeUnavailable() {
        showToast('请在桌面版中使用', '这个操作需要调用本机程序。静态预览只能查看界面。', 'warn');
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
            showToast('打开失败', '这条记录没有对应文件路径。', 'err');
            return;
        }
        if (!window.mfhBridge?.openPath) { bridgeUnavailable(); return; }
        const result = await window.mfhBridge.openPath({ path: value, reveal: true });
        showToast(result?.ok ? '已打开文件位置' : '打开失败', result?.ok ? '已定位到对应文件。' : (result?.error || value), result?.ok ? 'ok' : 'err');
    }

    async function copyText(value, label) {
        if (window.mfhBridge?.copyText) await window.mfhBridge.copyText({ text: value });
        else await navigator.clipboard?.writeText(value);
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
        showToast(result?.ok ? '邮箱连接正常' : '邮箱连接失败', result?.message || '', result?.ok ? 'ok' : 'err');
    }

    async function developerReset() {
        const confirmed = window.confirm('确认删除本机缓存、已归档发票、待确认队列和识别结果吗？这个操作不能撤销。');
        if (!confirmed) return;
        if (!window.mfhBridge?.developerReset) { bridgeUnavailable(); return; }
        const result = await window.mfhBridge.developerReset();
        if (result?.summary) applySummary(result.summary);
        showToast('已重置本机数据', `删除 ${fmtInt(result?.removed?.length || 0)} 个位置。`);
    }

    function handlePendingAction(action) {
        const kind = action.dataset.actionKind;
        if (kind === 'retry') {
            runBridgeAction('runPipeline', { onlyMail: action.dataset.hash }, '已重新尝试', '这封邮件已重新处理。');
            return;
        }
        if (kind === 'refresh_link') {
            showToast('需要重新授权', '请打开原邮件或对应平台刷新下载链接，再重新抓取。', 'warn');
            return;
        }
        if (kind === 'ignore') {
            showToast('尚未确认忽略', '当前版本会保留原始邮件；后续将加入单封忽略状态。', 'warn');
            return;
        }
        showToast('请选择文件', '当前版本请先把文件放入归档目录，再运行“开始识别”。', 'warn');
    }

    function showFetchPreview() {
        const from = document.getElementById('date-from')?.value || '开始日期';
        const to = document.getElementById('date-to')?.value || '结束日期';
        showToast('将要执行', `搜索 ${from} 至 ${to} 的邮件，并保存命中的原始邮件。`);
    }

    function exportVisibleLog() {
        const text = Array.from(document.querySelectorAll('#console-out .console__line')).map((line) => line.textContent.trim()).join('\n');
        copyText(text || '暂无实时日志', '日志');
    }

    function exportVisibleTable(action) {
        const table = action.closest('.card')?.querySelector('table') || document.querySelector('table');
        if (!table) { showToast('没有可复制的表格', '当前页面没有表格内容。', 'warn'); return; }
        const csv = Array.from(table.querySelectorAll('tr')).map((tr) => (
            Array.from(tr.children).map((cell) => `"${cell.textContent.trim().replace(/"/g, '""')}"`).join(',')
        )).join('\n');
        copyText(csv, 'CSV');
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

    function showToast(title, sub, kind = 'ok') {
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
        window.setTimeout(() => toast.remove(), 2600);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wire);
    } else {
        wire();
    }

    // Expose for inline buttons
    window.FPH = {
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
        ICON
    };
})();
