/* Mail Fapiao Helper — shell.
   Renders sidebar nav, wires theme toggle, motion toggle, button ripple,
   group accordions, table sorting, console autoscroll, fake progress. */

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
        { group: 'WORKFLOW', items: [
            { id: 'dashboard', label: 'Run',      href: 'dashboard.html', icon: 'play',    badge: '⌘R' },
            { id: 'inbox',     label: 'Inbox',    href: 'inbox.html',     icon: 'inbox',   badge: '482' },
            { id: 'library',   label: 'Library',  href: 'library.html',   icon: 'library', badge: '341' },
            { id: 'pending',   label: 'Pending',  href: 'pending.html',   icon: 'pending', badge: '12'  },
        ]},
        { group: 'SYSTEM', items: [
            { id: 'config',    label: 'Config',   href: 'config.html',    icon: 'config' },
            { id: 'settings',  label: 'About',    href: 'settings.html',  icon: 'info'   },
        ]},
    ];

    function navHTML(active) {
        return NAV.map(sec => `
            <div class="nav-group">
                <div class="nav-group__title">${sec.group}</div>
                ${sec.items.map(it => `
                    <a class="nav-item ${it.id === active ? 'is-active' : ''}" href="${it.href}">
                        <span class="nav-item__icon">${ICON[it.icon]}</span>
                        <span>${it.label}</span>
                        ${it.badge ? `<span class="nav-item__badge">${it.badge}</span>` : ''}
                    </a>
                `).join('')}
            </div>
        `).join('');
    }

    function sidebarHTML(active) {
        return `
            <aside class="sidebar">
                <div class="sidebar__brand">
                    <div class="sidebar__logo">F</div>
                    <div>
                        <div class="sidebar__title">Fapiao Helper</div>
                        <div class="sidebar__ver">v0.1.0 · dev</div>
                    </div>
                </div>
                <div class="sidebar__search">
                    <span class="sidebar__search-icon">${ICON.search}</span>
                    <input type="text" placeholder="Quick find…" aria-label="Quick find">
                    <kbd>⌘K</kbd>
                </div>
                <div class="sidebar__nav">
                    ${navHTML(active)}
                </div>
                <div class="sidebar__foot">
                    <span class="status-dot"></span>
                    <span>IMAP connected</span>
                    <span class="sidebar__foot-meta">14:02</span>
                </div>
            </aside>
        `;
    }

    function titlebarHTML() {
        return `<div class="titlebar" aria-hidden="true"></div>`;
    }

    /* ---------- Theme persistence ---------- */
    function getTheme() { return localStorage.getItem('fph_theme') || 'dark'; }
    function setTheme(t) {
        if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
        else document.documentElement.removeAttribute('data-theme');
        localStorage.setItem('fph_theme', t);
        const btn = document.querySelector('[data-theme-toggle]');
        if (btn) btn.innerHTML = t === 'light' ? ICON.moon : ICON.sun;
    }

    function getMotion() { return localStorage.getItem('fph_motion') || 'on'; }
    function setMotion(v) {
        if (v === 'off') document.documentElement.setAttribute('data-motion', 'off');
        else document.documentElement.removeAttribute('data-motion');
        localStorage.setItem('fph_motion', v);
    }

    /* ---------- Wiring ---------- */
    function wire() {
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

        // Theme toggle buttons
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

            // Tabs
            const tab = e.target.closest('.tabs .tab');
            if (tab) {
                tab.parentElement.querySelectorAll('.tab').forEach(t => t.classList.remove('is-active'));
                tab.classList.add('is-active');
            }

            // Filter chip toggle
            const chip = e.target.closest('.filterbar .chip[data-toggle]');
            if (chip) chip.classList.toggle('is-active');

            // Toggle controls
            const tg = e.target.closest('.toggle');
            if (tg) tg.classList.toggle('is-on');

            const ck = e.target.closest('.check');
            if (ck) ck.classList.toggle('is-on');
        });

        // Sort header click — visual only
        document.querySelectorAll('.table thead th').forEach(th => {
            th.addEventListener('click', () => {
                th.parentElement.querySelectorAll('th').forEach(x => x.classList.remove('is-sorted'));
                th.classList.add('is-sorted');
            });
        });

        // Table row select
        document.querySelectorAll('.table tbody tr').forEach(tr => {
            tr.addEventListener('click', () => {
                tr.parentElement.querySelectorAll('tr').forEach(x => x.classList.remove('is-selected'));
                tr.classList.add('is-selected');
            });
        });

        // Page-specific: dashboard run (auto-runs on load)
        if (document.body.dataset.page === 'dashboard') initRunSimulation();
    }

    /* ---------- Dashboard run simulation ---------- */
    function initRunSimulation() {
        const out = document.getElementById('console-out');
        const bar = document.getElementById('prog-bar');
        const pctEl = document.getElementById('prog-pct');
        const cntEl = document.getElementById('prog-count');
        const statusEl = document.getElementById('run-status');
        if (!out || !bar) return;

        const lines = [
            ['08:14:02', 'init',    'Loading config from <code>./config.json</code>',                       ''],
            ['08:14:02', 'imap',    'Connecting to imap.example.com:993 (TLS)',                            ''],
            ['08:14:03', 'imap',    'Authenticated as <strong>me@example.com</strong>',                    'ok'],
            ['08:14:03', 'filter',  'since=2026-04-20 until=2026-05-20 · keywords=["发票","invoice"]',     ''],
            ['08:14:04', 'fetch',   'Found 482 matching messages, queued for download',                   'ok'],
            ['08:14:05', 'fetch',   'msg #00041 · 携程旅行 · downloading attachment (4.2 MB)',             ''],
            ['08:14:06', 'extract', 'msg #00041 · pdf-parse → seller=Ctrip, amount=¥1,280.00',            'ok'],
            ['08:14:07', 'fetch',   'msg #00042 · 滴滴出行 · no attachment, scanning body for link',       ''],
            ['08:14:08', 'extract', 'msg #00042 · OCR fallback engaged (poor pdf quality)',               'warn'],
            ['08:14:09', 'extract', 'msg #00042 · OCR success · amount=¥48.50',                          'ok'],
            ['08:14:10', 'fetch',   'msg #00043 · 京东商城 · 3 attachments',                              ''],
            ['08:14:11', 'extract', 'msg #00043 · attachment 2/3 invalid PDF, queued for manual review',  'warn'],
        ];

        let i = 0;
        const start = Date.now();
        const total = 482;

        function appendLine(L) {
            const div = document.createElement('div');
            div.className = 'console__line';
            div.innerHTML = `<span class="console__time">${L[0]}</span><span class="console__tag ${L[3]}">${L[1]}</span><span class="console__msg">${L[2]}</span>`;
            out.appendChild(div);
            out.scrollTop = out.scrollHeight;
        }

        const tick = () => {
            if (i < lines.length) {
                appendLine(lines[i++]);
            }
            const elapsed = (Date.now() - start) / 1000;
            const fakeCount = Math.min(total, Math.round(elapsed * 24));
            const pct = Math.min(100, (fakeCount / total) * 100);
            bar.style.setProperty('--p', pct.toFixed(1) + '%');
            if (pctEl) pctEl.textContent = pct.toFixed(0) + '%';
            if (cntEl) cntEl.textContent = `${fakeCount} / ${total}`;
            if (fakeCount >= total) {
                bar.parentElement.classList.add('is-done');
                if (statusEl) {
                    statusEl.innerHTML = '<span class="pill pill--ok"><span class="pill__dot"></span>Completed</span>';
                }
                appendLine(['08:14:24', 'done', `processed ${total} messages, 329 invoices, 12 queued for review`, 'ok']);
                clearInterval(loop);
            }
        };
        const loop = setInterval(tick, 700);
        tick();
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
        ICON
    };
})();
