// Injects the shared sidebar nav into every page based on data-page attribute on <body>.
// Also wires small interactive niceties (filters, console scroll, fake progress).

(function () {
    const NAV = [
        { group: '工作流 · WORKFLOW', items: [
            { id: 'dashboard', label: '运行台',     en: 'Run Console',     href: 'dashboard.html', idx: '01' },
            { id: 'inbox',     label: '邮件清册',   en: 'Inbox Ledger',    href: 'inbox.html',     idx: '02' },
            { id: 'library',   label: '发票档案',   en: 'Invoice Library', href: 'library.html',   idx: '03' },
            { id: 'pending',   label: '待人工',     en: 'Manual Queue',    href: 'pending.html',   idx: '04' },
        ]},
        { group: '系统 · SYSTEM', items: [
            { id: 'config',    label: '配置',       en: 'Configuration',   href: 'config.html',    idx: '05' },
            { id: 'settings',  label: '关于',       en: 'About & Build',   href: 'settings.html',  idx: '06' },
        ]},
    ];

    function renderNav(active) {
        const sections = NAV.map(sec => `
            <div class="nav-section">${sec.group}</div>
            <ul class="nav-list">
                ${sec.items.map(it => `
                    <li class="nav-item">
                        <a href="${it.href}" class="${it.id === active ? 'is-active' : ''}">
                            <span class="nav-idx">${it.idx}</span>
                            <span><b style="font-weight:500">${it.label}</b>
                                <span style="display:block;font-family:var(--f-mono);font-size:10px;letter-spacing:0.16em;color:#6e7589;text-transform:uppercase;margin-top:1px">${it.en}</span>
                            </span>
                        </a>
                    </li>
                `).join('')}
            </ul>
        `).join('');

        return `
            <nav class="nav">
                <div class="nav-brand">
                    <div class="nav-brand-chop">票</div>
                    <div class="nav-brand-title">发票助手</div>
                    <div class="nav-brand-sub">Mail Fapiao Helper · v0.1</div>
                </div>
                ${sections}
                <div class="nav-foot">
                    <span class="dot">●</span> IMAP 已连接<br>
                    me@example.com<br>
                    上次同步 14:02 UTC
                </div>
            </nav>
        `;
    }

    function mount() {
        const active = document.body.dataset.page || '';
        const mount = document.getElementById('app-shell');
        if (!mount) return;
        mount.outerHTML = renderNav(active);
    }

    document.addEventListener('DOMContentLoaded', mount);
})();
