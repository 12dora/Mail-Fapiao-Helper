# UI 布局、响应式与动画审查报告
审查日期：2026-07-29 ｜ 审查范围：`gui-design/styles/main.css`；`gui-design/index.html`；`gui-design/pages/config.html`、`dashboard.html`、`inbox.html`、`library.html`、`pending.html`、`settings.html`；`gui-design/scripts/shell.js` 中设置样式、class、尺寸和过渡的代码；`src/electron/main.ts:175-197` 的 `BrowserWindow` 配置；并以 `docs/CODE_REVIEW_FINDINGS_2026-07-27.md` 作为旧问题核对基线

## 摘要

当前 UI 已有较完整的 token、窄屏表格降级、异步进度、骨架屏和 reduced-motion 支持，上一轮多数高价值 UI 问题已修复。
本轮确认 10 项仍存问题：2 项 P1、6 项 P2、2 项 P3；没有发现 P0。
最严重的是邮箱未配置或仅保存但未验证时，侧栏仍显示绿色脉冲点，给非技术用户传达了错误的“已连接”状态。
其次，默认 1180px 窗口正落在 Dashboard 双栏布局的危险宽度内；“开始获取邮件”和“查看将要执行的操作”会参与 flex 收缩，主按钮还会因 `overflow: hidden` 裁字。
第三，侧栏完整邮箱地址和“关于”页完整路径都没有截断/换行契约，在真实最小窗口及默认双栏卡片中会横向溢出。
动效方面，路由回访、toast 退出和待确认 accordion 都存在“代码看似有动画、实际仍瞬间切换”的确定性缺口。
建议先修状态点语义和 Dashboard 操作行，再统一长文本收缩规则，最后收拢无效动效与死 CSS。

## findings 汇总表

| ID | 严重度 | 标题 | 位置 |
| --- | --- | --- | --- |
| UI-01 | P1 | 未配置/未验证邮箱仍显示绿色脉冲“在线”状态 | `gui-design/styles/main.css:332-351`；`gui-design/scripts/shell.js:127-130`、`1793-1800` |
| UI-02 | P1 | 默认窗口宽度会压缩并裁切首屏长按钮 | `gui-design/pages/dashboard.html:101-109`；`gui-design/styles/main.css:479-496` |
| UI-03 | P2 | 侧栏完整邮箱地址挤压时钟和主题按钮 | `gui-design/scripts/shell.js:127-132`；`gui-design/styles/main.css:323-357` |
| UI-04 | P2 | “关于”页完整路径可撑破双栏卡片 | `gui-design/pages/settings.html:46-65`；`gui-design/styles/main.css:1331-1341` |
| UI-05 | P2 | SPA 回访页面没有真实路由过渡 | `gui-design/pages/dashboard.html:22`；`gui-design/styles/main.css:406-417`；`gui-design/scripts/shell.js:698-700` |
| UI-06 | P2 | Accordion 从 `0` 到 `none` 无法动画 | `gui-design/styles/main.css:1411-1417`；`gui-design/scripts/shell.js:1682-1696` |
| UI-07 | P2 | Toast 只有进入动画，所有退出都瞬间删除 | `gui-design/styles/main.css:1041-1052`；`gui-design/scripts/shell.js:2924-2945`、`2970-2980` |
| UI-08 | P2 | Settings 使用了不存在的标题和间距类 | `gui-design/pages/settings.html:24-45`；`gui-design/styles/main.css:1226-1242` |
| UI-09 | P3 | 760px 响应式分支在桌面产品中不可达 | `gui-design/styles/main.css:1295-1328`；`src/electron/main.ts:177-182` |
| UI-10 | P3 | 多组组件样式已无任何页面消费者 | `gui-design/styles/main.css:630-651`、`860-861`、`1109-1135` |

## 详细发现

### UI-01 未配置/未验证邮箱仍显示绿色脉冲“在线”状态

- 严重度：P1
- 位置：`gui-design/styles/main.css:332-351`；`gui-design/scripts/shell.js:127-130`、`1793-1800`
- 置信度：CONFIRMED
- 证据：

  ```html
  <span class="status-dot" data-mail-status-dot aria-hidden="true"></span>
  ```

  ```css
  .status-dot {
    width: 7px; height: 7px;
    border-radius: 50%;
    background: var(--ok);
  }
  .status-dot::after {
    border: 1.5px solid var(--ok);
    animation: pulse 2.2s ease-out infinite;
  }
  ```

  ```js
  const configured = realHost && realUser && credentialStored(secrets, pass);
  const verified = configured && window.FPH.credentialsVerified === true;
  document.querySelectorAll('[data-mail-status-dot]').forEach((el) => {
      el.classList.toggle('is-off', !configured);
  });
  ```

- 问题：CSS 没有任何 `.status-dot.is-off` 规则，而且 `verified` 根本没有参与 dot 的 class。结果是“邮箱未配置”“设置已保存但未测试”“已验证”三种状态都显示相同的绿色点和无限脉冲。对不理解邮箱协议的用户，绿色动态状态是比旁边小字更强的“连接正常”信号，因此这是确定的错误状态反馈。
- 建议修复：明确三态 class，例如 `.is-unconfigured` 使用 `--fg-deco` 且无动画、`.is-saved` 使用 `--warn` 且无动画、`.is-verified` 使用 `--ok`；JS 按 `configured/verified` 设置且只让 `.is-verified::after` 运行。若产品并无持久连接概念，建议完全去掉 pulse，避免把“曾测试成功”表达成“当前在线”。

### UI-02 默认窗口宽度会压缩并裁切首屏长按钮

- 严重度：P1
- 位置：`gui-design/pages/dashboard.html:101-109`；`gui-design/styles/main.css:479-496`、`524-535`、`1213-1227`、`1251-1258`
- 置信度：CONFIRMED
- 证据：

  ```html
  <div class="row gap-8 mb-12">
      <button class="btn btn--primary" id="run-btn" type="button">…开始获取邮件</button>
      <button class="btn" type="button" data-action="preview-fetch">查看将要执行的操作</button>
      <div style="flex: 1;"></div>
      <span class="mono small muted" id="range-preview">--</span>
  </div>
  ```

  ```css
  .btn {
    height: 28px;
    padding: 0 12px;
  }
  .btn--primary { position: relative; overflow: hidden; }
  .row { display: flex; align-items: center; gap: 10px; }
  .dashboard-section {
    grid-template-columns: minmax(0, 1.25fr) minmax(300px, 0.75fr);
  }
  ```

- 问题：真实默认窗口为 1180px；扣除 232px 侧栏、页面 padding 和 grid gap 后，左侧 compact card 的内容宽度约 519px。两个按钮、三个 gap 和完整日期文案（例如 `2026-07-01 至 2026-07-29（含首尾两天全天）`）的单行宽度约 540–560px。`.row` 不换行，按钮也没有 `flex-shrink: 0`/`white-space: nowrap`，所以按钮参与收缩；固定 28px 高度无法容纳换行，主按钮还被 `overflow: hidden` 直接裁切。该问题约出现在 1121–1230px，恰好覆盖默认 1180px；窗口缩到 1120px 后 grid 反而变单栏，问题才消失。
- 建议修复：把按钮精简为准确的 4 字文案：`开始获取邮件` → `获取邮件`，`查看将要执行的操作` → `操作预览`。同时给该行独立 class（如 `.fetch-actions`）并设置 `flex-wrap: wrap`；让 `#range-preview` 在空间不足时 `flex: 1 1 100%; min-width: 0; overflow-wrap: anywhere`，不要依靠压缩固定高度按钮来腾空间。其余审查到的按钮行要么总宽度可落在约 519px 内，要么位于已有 `flex-wrap: wrap` 的 `.filterbar`，未发现同等级裁切风险。

### UI-03 侧栏完整邮箱地址挤压时钟和主题按钮

- 严重度：P2
- 位置：`gui-design/scripts/shell.js:127-132`、`1795-1797`；`gui-design/styles/main.css:323-357`、`1421-1432`
- 置信度：CONFIRMED
- 证据：

  ```html
  <div class="sidebar__foot">
      <span class="status-dot" data-mail-status-dot aria-hidden="true"></span>
      <span data-mail-status-label>邮箱未配置</span>
      <span class="sidebar__foot-meta" data-clock>--:--</span>
      <button class="theme-toggle" type="button" data-theme-toggle>…</button>
  </div>
  ```

  ```js
  el.textContent = verified ? `已连接 · ${user}`
      : configured ? `已保存 · ${user}` : '邮箱未配置';
  ```

  ```css
  .sidebar__foot {
    padding: 10px 14px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .sidebar__foot-meta { margin-left: auto; }
  .theme-toggle { width: 28px; height: 28px; }
  ```

- 问题：默认 232px 侧栏扣除 padding、状态点、时钟、主题按钮和三个 gap 后，状态文字约只剩 113px；900–980px 窗口使用 196px 侧栏时只剩约 77px。JS 却拼入完整、不可自然断行的邮箱地址，且状态 span 没有 `min-width: 0`、ellipsis 或 wrap 规则，主题按钮也没有 `flex-shrink: 0`。常规公司邮箱已足以越界，导致文字伸入主区、时钟/主题按钮被压缩或裁掉。
- 建议修复：可见文案只保留 `已连接` / `已保存`，把完整地址放到 `title` 或可点击详情中；若必须显示地址，给状态 span 增加 `min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap`，并给 `.status-dot`、`.sidebar__foot-meta`、`.theme-toggle` 设置 `flex-shrink: 0`。

### UI-04 “关于”页完整路径可撑破双栏卡片

- 严重度：P2
- 位置：`gui-design/pages/settings.html:46-65`；`gui-design/pages/config.html:99-107`；`gui-design/scripts/shell.js:1842-1849`；`gui-design/styles/main.css:1331-1341`
- 置信度：CONFIRMED
- 证据：

  ```html
  <div class="setting-row">
      <div class="setting-row__main">…</div>
      <span class="mono small muted" data-settings-path="samples">./samples/raw</span>
  </div>
  ```

  ```js
  setText('[data-settings-path="samples"]', cfg.paths?.samples);
  setText('[data-settings-path="invoices"]', cfg.paths?.invoices);
  setText('[data-settings-path="pending"]', cfg.paths?.pending);
  ```

  ```css
  .setting-row {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .setting-row__main { flex: 1; min-width: 0; }
  ```

- 问题：配置页明确允许填写“完整路径”，Settings 又原样显示该值。默认 1180px 时 `.grid-2` 中单卡内容宽约 402px，减去 16px gap 后，任何渲染宽度超过约 386px 的无空格路径都会成为该 flex 行的不可收缩最小宽度；只有左侧 `.setting-row__main` 有 `min-width: 0`，路径 span 没有。结果是卡片和 `.page` 出现横向滚动或路径压过其它内容，Windows 的 `AppData` 路径与 macOS 的 `Application Support` 路径尤其容易触发。
- 建议修复：为值增加专用 `.setting-row__value`，至少使用 `min-width: 0; max-width: 55%; overflow-wrap: anywhere; text-align: right`；若希望单行，改用 `overflow: hidden; text-overflow: ellipsis; white-space: nowrap`，并通过 `title`/“复制路径”保留完整值。不要只给左侧说明区设置 `min-width: 0`。

### UI-05 SPA 回访页面没有真实路由过渡

- 严重度：P2
- 位置：`gui-design/pages/dashboard.html:22`；`gui-design/styles/main.css:406-417`；`gui-design/scripts/shell.js:593-625`、`686-700`
- 置信度：CONFIRMED
- 证据：

  ```html
  <div class="page stagger">
  ```

  ```css
  .page {
    animation: pageIn var(--dur-3) var(--ease-out) both;
  }
  @keyframes pageIn {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  ```

  ```js
  document.querySelectorAll('main.main').forEach((main) => {
      main.style.display = main === target ? '' : 'none';
  });
  ```

- 问题：`.page` 的 CSS animation 只在节点首次进入渲染树时运行。SPA 会缓存已经加载的 `<main>`，回访时只是把两个 `display` 值同步互换；已完成的 `.page` animation 不会重启，而 `display: none` 也不可过渡。因此首访可能淡入，后续所有常见导航却瞬间切页，动效行为前后不一致，像页面被硬替换。
- 建议修复：在每次 commit 时显式给 target 添加 `.is-page-entering`，用 `opacity` + `transform` 做 160–200ms `var(--ease-out)` 进入，并在 `animationend` 后移除；若加入离场，先给旧页 `.is-page-leaving`，等 120–160ms 后再设 `display:none`。也可用 View Transitions API 并保留 class fallback。现有 reduced-motion 全局规则可继续接管时长。

### UI-06 Accordion 从 `0` 到 `none` 无法动画

- 严重度：P2
- 位置：`gui-design/styles/main.css:1411-1417`；`gui-design/scripts/shell.js:1682-1696`
- 置信度：CONFIRMED
- 证据：

  ```css
  .group__body {
    max-height: 0;
    overflow: hidden;
    transition: max-height var(--dur-4) var(--ease-out);
  }
  .group.is-open .group__body { max-height: none; }
  ```

  ```html
  <div class="group is-open">
      …
      <div class="group__body" id="${bodyId}" role="region">
          <div class="group__inner">…</div>
      </div>
  </div>
  ```

- 问题：`max-height: 0` 与 `max-height: none` 之间不能插值；声明的 420ms transition 不会产生展开/收起过程，body 会直接跳变，只有箭头旋转。注释为了保证所有行可达而取消固定上限是正确目标，但当前写法牺牲了实际动画。
- 建议修复：使用无固定上限的 grid 模式：`.group__body { display:grid; grid-template-rows:0fr; transition:grid-template-rows 180ms var(--ease-out); }`、`.group.is-open .group__body { grid-template-rows:1fr; }`、`.group__inner { min-height:0; overflow:hidden; }`。这既不会截断长组，也能真实过渡。

### UI-07 Toast 只有进入动画，所有退出都瞬间删除

- 严重度：P2
- 位置：`gui-design/styles/main.css:1041-1052`、`1103-1107`；`gui-design/scripts/shell.js:2875-2889`、`2924-2945`、`2970-2980`
- 置信度：CONFIRMED
- 证据：

  ```css
  .toast {
    animation: toastIn var(--dur-3) var(--ease-spring);
  }
  @keyframes toastIn {
    from { opacity: 0; transform: translateX(20px); }
    to   { opacity: 1; transform: translateX(0); }
  }
  ```

  ```js
  const toast = document.createElement('div');
  toast.className = `toast ${kind}`;
  …
  const dismiss = () => { window.clearTimeout(timer); toast.remove(); };
  close.addEventListener('click', dismiss);
  timer = window.setTimeout(dismiss, duration);
  ```

- 问题：进入有 260ms 动画，但自动消失、手动关闭、页面切换清理和 stack trimming 最终都直接 `remove()`。toast 会突然消失，下方 toast 也会立即跳位；连续操作时这比完全无动画更像渲染故障。
- 建议修复：统一走 `dismissToast()`：先加 `.is-leaving`，以 `opacity` + `transform: translateX(12px)` 做 120–160ms `var(--ease-out)`，在 `animationend` 或兜底 timer 后删除；reduced-motion 时直接删除。`trimToastStack()` 与 `dismissPageToasts()` 也应调用同一 helper，避免只有关闭按钮路径有退场。

### UI-08 Settings 使用了不存在的标题和间距类

- 严重度：P2
- 位置：`gui-design/pages/settings.html:24-45`、`73-74`、`102-104`；`gui-design/styles/main.css:1226-1242`
- 置信度：CONFIRMED
- 证据：

  ```html
  <div class="row row--between mb-16">
      <div>
          <div class="h2">发票助手</div>
          <div class="small muted mt-4">从邮箱保存发票、行程单和识别结果</div>
      </div>
  </div>
  …
  <div class="h3 mb-16">数据保存</div>
  ```

  ```css
  .mt-12  { margin-top: 12px; }
  .mt-16  { margin-top: 16px; }
  .mt-24  { margin-top: 24px; }
  .mb-12  { margin-bottom: 12px; }
  .small  { font-size: 11.5px; }
  ```

- 问题：整份样式表没有 `.h2`、`.h3`、`.mt-4` 或 `.mb-16` 定义。Settings 的产品名和三个区块标题因此退化为普通 13px、常规字重正文，声明的 4px/16px 间距也完全不生效；这不是偏好问题，而是 markup 与 CSS 契约断开。
- 建议修复：优先改成语义元素并复用现有组件，例如 `<h2 class="card__title">`、必要时新增明确的 `.section-title`；把 `mt-4`/`mb-16` 替换为已定义 utility 或补齐 token 化规则。完成后 grep 所有页面，禁止继续保留“引用但未定义”的 class。

### UI-09 760px 响应式分支在桌面产品中不可达

- 严重度：P3
- 位置：`gui-design/styles/main.css:1295-1328`；`src/electron/main.ts:177-182`
- 置信度：CONFIRMED
- 证据：

  ```css
  @media (max-width: 760px) {
    :root { --sidebar-w: 64px; }
    .sidebar__title,
    .sidebar__ver,
    .sidebar__search,
    .nav-group__title { display: none; }
    …
  }
  ```

  ```ts
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 640,
  });
  ```

- 问题：Electron 窗口不能缩到 760px，因此这整段 64px 图标侧栏逻辑在实际桌面产品中永远不会执行。它不直接破坏用户流程，但形成 33 行不可达 CSS，也容易让维护者误以为 760px 是受支持视口；文件头的“Designed for Electron (1100×700 min)”与真实 900×640 也进一步放大了这个误导。
- 建议修复：若产品坚持 `minWidth: 900`，删除 760px 分支并把文件头改成真实 900×640；若确实要支持 compact sidebar，则先完成 760px 下各页面和 Windows frame 的验收，再有意识地降低 `minWidth`，不要只保留不可达样式。

### UI-10 多组组件样式已无任何页面消费者

- 严重度：P3
- 位置：`gui-design/styles/main.css:537-553`、`630-651`、`860-861`、`1109-1135`、`1171-1180`；`gui-design/scripts/shell.js:310-312`
- 置信度：CONFIRMED
- 证据：

  ```css
  .kbd-row { display: inline-flex; gap: 4px; }
  .toggle { … }
  .row-expand { height: 0; overflow: hidden; transition: height var(--dur-3) var(--ease-out); }
  .scrim { … }
  .modal { … }
  .empty__glyph { … }
  ```

  ```js
  const tg = e.target.closest('.toggle');
  if (tg) tg.classList.toggle('is-on');
  ```

- 问题：在 `gui-design/index.html`、全部六个 `pages/*.html` 以及 shell 动态模板中，均没有 `.kbd-row`、`.toggle`、`.row-expand`、`.scrim`、`.modal` 或 `.empty__glyph` 元素；`.toggle` 只剩一个不会命中的事件委托。上述规则包含两组 keyframes、弹层 z-index 和一套旧 toggle 交互，增加审查与修改成本，也让真正使用的 native `.check`/现有确认流程更难辨认。
- 建议修复：确认近期没有对应功能分支后删除这些 selector、keyframes 和 `.toggle` handler；若 modal 是确定的近期需求，应在真正引入可访问 dialog markup 时一并实现，而不是长期保留无消费者的半套样式。

## 明确排除的项（我检查过但认为不是问题）

- 上一轮 `FB-01` 的“长任务只有视觉进度”已修复：`gui-design/scripts/shell.js:1053-1073` 会同步 `role="progressbar"`、`aria-valuenow`/`aria-valuetext`，Dashboard 和 Library 也有明确进度容器；本轮不重复报告。
- 上一轮 `FB-02` 的“错误 toast 短暂且不可关闭”已修复：`gui-design/scripts/shell.js:2853-2859`、`2924-2988` 区分 `alert/status`、错误默认 sticky、提供关闭按钮并在 hover/focus 时暂停。UI-07 只针对仍缺失的退出动画。
- 上一轮 `FB-03` 的异步导航 pending、标题和焦点恢复已修复：`gui-design/scripts/shell.js:639-740` 已有 `aria-busy`、150ms 延迟骨架、标题聚焦和公告。UI-05 是缓存页面回访仍瞬切的新残余问题。
- 上一轮 `FB-04` 的 Pending 整表重绘/焦点丢失已修复：`gui-design/scripts/shell.js:1720-1769` 会就地折叠单卡、转移焦点并在 reduced-motion 下直接完成。
- 上一轮 `UI-07` 的窄屏表格滚动条不可达已按主要路径修复：`gui-design/styles/main.css:1277-1292` 在 ≤980px 限制容器高度、隐藏次要列并在主单元格重复信息；没有证据证明当前静态列在 900px 最小窗口下仍不可达。
- `prefers-reduced-motion` 和应用内 motion-off 已覆盖现有动画/transition：`gui-design/styles/main.css:1549-1569` 停止无限 shimmer/pulse，并保留语义进度状态。
- 没有发现用可点击 `<div>` 代替按钮的新问题：tabs、chips、排序头、accordion 和 checkbox 均已改为 native control；现存 `<details>/<summary>` 也保留浏览器键盘语义。
- Console 的 `#0a0b0e`、`#d3d5db` 等硬编码颜色是有意保持跨主题的固定深色表面，`gui-design/styles/main.css:925-940` 已写明原因且文字对比度使用亮色变体，因此不作为“绕过 token”上报。
- `!important` 仅出现在 `.hide`、`[hidden]`、`.sr-only` 和 reduced-motion 覆盖中，均用于确定性可见性/无障碍契约，没有形成互相覆盖的 `!important` 链。
