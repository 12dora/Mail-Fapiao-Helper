import { escapeHtml, text } from './dom.js';

/* ---------- Inline icons (lucide-style, 16×16) ---------- */
export const ICON = {
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

export const NAV = [
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

/* ---------- Platform-correct modifier key ---------- */
export const IS_APPLE = /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '');
export const MOD_KEY = IS_APPLE ? '⌘' : 'Ctrl';
export const SEARCH_HINT = {
    inbox: '在已加载的邮件记录中搜索…',
    library: '在已加载的发票库中搜索…',
};
export function searchPlaceholder(pageId) {
    return SEARCH_HINT[pageId] || '搜索发票库（已加载记录）…';
}

export function navHTML(active) {
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

export function rel(path) {
    return document.body.dataset.page ? path : `pages/${path}`;
}

export function sidebarHTML(active) {
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

export function titlebarHTML() {
    return `<div class="titlebar" aria-hidden="true"></div>`;
}

/* ---------- Theme persistence ---------- */
export function getTheme() { return localStorage.getItem('fph_theme') || 'light'; }
export function setTheme(t) {
    if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('fph_theme', t);
    document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
        btn.innerHTML = t === 'light' ? ICON.moon : ICON.sun;
        btn.setAttribute('aria-label', t === 'light' ? '切换到深色主题' : '切换到亮色主题');
        btn.setAttribute('title', t === 'light' ? '切换到深色主题' : '切换到亮色主题');
    });
}

export function getMotion() { return localStorage.getItem('fph_motion') || 'on'; }
export function setMotion(v) {
    if (v === 'off') document.documentElement.setAttribute('data-motion', 'off');
    else document.documentElement.removeAttribute('data-motion');
    localStorage.setItem('fph_motion', v);
}

/* ---------- Progressive upgrade of static page markup ----------
   Keeps the hand-written HTML readable while guaranteeing the
   accessibility contract (sortable headers, progress semantics,
   focusable page heading) on every page, including SPA-loaded ones. */
export function upgradeStaticMarkup(root) {
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

export function refreshClock() {
    const now = new Date();
    const text = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    document.querySelectorAll('[data-clock]').forEach((el) => { el.textContent = text; });
}


