# Renderer 逻辑与功能缺陷审查报告
审查日期：2026-07-29 ｜ 审查范围：`gui-design/scripts/shell.js`（完整 3031 行）、`gui-design/index.html`、`gui-design/pages/dashboard.html`、`gui-design/pages/inbox.html`、`gui-design/pages/library.html`、`gui-design/pages/pending.html`、`gui-design/pages/config.html`、`gui-design/pages/settings.html`、`electron/preload.cjs`；为核对 IPC 事件和摘要字段的直接生产方，补读 `src/electron/main.ts:542-544,680-725,747-827,863-1059,1144-1150,1663-1708,1724-1836,1846-2045,2334-2381`、`src/electron/summary.ts:36-50,250-328,331-346`、`src/pending/summary.ts:166-198`；为复核 toast 点击拦截，补读 `gui-design/styles/main.css:1025-1103`、`gui-design/tests/e2e.mjs:124-129,720-742`；并核对既有审查 `docs/CODE_REVIEW_FINDINGS_2026-07-27.md:440-615`。遵守只读约束，未运行构建、安装或测试。

## 摘要

当前 renderer 的基础安全性和路由正确性比 2026-07-27 基线明显改善：邮件、文件名等外部字符串在进入 `innerHTML` 前基本都经过转义；SPA 使用单调 token 防止旧导航提交；pending 不再截断第 7 条之后的记录；toast 也已有关闭、粘性和去重机制。

最严重的三个问题是：第一，下载/OCR 的“部分成功”会被渲染为绿色成功终态，失败票据很容易被忽略；第二，配置页的 450ms 自动保存与每次导航触发的 `getConfig()` 回填互不协调，存在确定的旧值覆盖窗口；第三，“复制为 CSV”导出的既不是当前筛选结果也不是完整数据集，而且没有防 Excel 公式注入。

此外，发票库有两处指标绑定错误；显式刷新失败后仍会追加成功提示；OCR 停止请求拒绝时按钮无法恢复；同类长任务的其它入口不会随互斥状态锁定；toast 仍会挡住底层控件并主动丢弃未确认错误。

建议先统一“任务终态”与“部分失败”契约，再把配置保存改成串行、带 revision 的状态机，随后修正导出边界。继续在单个 3031 行文件中逐点打补丁，会让这些跨路由、跨状态的竞态反复出现。

## `shell.js` 结构地图与具体拆分

| 当前行段 | 当前职责 | 建议模块 |
|---|---|---|
| `1-203` | 图标、导航、主题、复选框、live region | `shell/chrome.js`、`shell/a11y.js` |
| `205-553` | 全局事件委托、静态标记升级、互斥状态、About 状态 | `shell/bootstrap.js`、`state/operation-state.js`、`pages/about.js` |
| `555-742` | SPA 页面加载、脚本执行、历史记录和导航竞态 | `router.js` |
| `744-927` | 数字/日期格式化、脱敏、标签、排序 | `shared/format.js`、`shared/sanitize.js` |
| `929-1211` | summary/config 拉取、IPC 进度订阅、实时日志、OCR/文件进度 | `bridge/summary-client.js`、`jobs/progress.js` |
| `1213-1467` | summary store、当前批次、分页游标和“加载更多” | `state/summary-store.js`、`state/paging.js` |
| `1469-1771` | inbox/library/pending 三个页面的列表渲染 | `pages/inbox.js`、`pages/library.js`、`pages/pending.js` |
| `1773-1906` | 配置回填、邮箱/识别状态、页面 live-state replay | `pages/config-hydrate.js` |
| `1908-2206` | 搜索、busy guard、动作分派、OCR 控制、快捷设置保存 | `shell/actions.js`、`jobs/ocr-controller.js` |
| `2208-2703` | IPC 动作、配置错误/修复、邮箱、重置、pending 动作 | 按领域拆成 `actions/files.js`、`actions/config.js`、`actions/pending.js` |
| `2705-2851` | 预览、日志/表格 CSV 导出、HTML 转义 | `shared/export.js` |
| `2853-3031` | toast 生命周期和公共 API 暴露 | `shell/toast.js`、`shell/public-api.js` |

页面内联控制器也应搬出 HTML：`dashboard.html:296-589` 拆为 `pages/dashboard-controller.js`，`config.html:347-702` 拆为 `pages/config-controller.js`。拆分后由 router 显式调用 `mount(root)` / `unmount(root)`，不要继续依赖全局 one-shot flag 和全局 `document.querySelector`。

## 错误呈现审计矩阵

| 错误/警告来源 | 当前用户可见路径 | 结论 |
|---|---|---|
| `[data-action]` handler 的 rejected promise | `shell.js:314-319` 转为粘性错误 toast | 已覆盖 |
| SPA 页面加载失败 | `shell.js:733-734` 错误 toast | 已覆盖 |
| `getSummary()` 拒绝 | `shell.js:929-937` 错误 toast | 有覆盖，但显式刷新随后错误地再报“已刷新”，见 FE-04 |
| `getConfig()` 拒绝/损坏 | `shell.js:940-956,2413-2450` 阻断卡片 + 全局错误 toast | 有覆盖，但“重新读取”随后错误地再报成功，见 FE-04 |
| 本地数字校验/后端字段校验 | `config.html:510-533`、`shell.js:2354-2410` 就地错误 + 汇总 | 已覆盖 |
| fetch 最终失败 | `dashboard.html:525-548` 错误 toast；progress error 本身只更新 Dashboard | 最终失败已覆盖 |
| OCR/files `kind:"warn"`、单文件失败、部分成功 | `shell.js:1100-1132,1186-1210` 只进计数、live region 和当前页日志；业务部分失败但进程 `ok` 时最终 toast 仍为绿色 | 未正确覆盖，见 FE-01 |
| 打开路径、复制、pending 操作和邮箱测试失败 | `shell.js:2275-2338,2536-2593,2638-2702` 页面错误 toast | 已覆盖 |
| 空结果/无内容 | organize、加载更多、导出等路径使用 warn toast 或空状态 | 已覆盖 |
| `getOpState()` / `getAppInfo()` 拒绝 | `shell.js:459-465,501-506` 静默吞掉 | `getOpState()` 会破坏长任务互斥，见 FE-13；About 元数据失败仅降级为“未知”，未单列 finding |

## findings 汇总表

| ID | 严重度 | 标题 | 位置 |
|---|---|---|---|
| FE-01 | P1 | 部分失败被渲染为绿色“完成/成功” | `gui-design/scripts/shell.js:1109-1131` |
| FE-02 | P1 | 自动保存与导航回填存在旧值覆盖竞态 | `gui-design/pages/config.html:553-592` |
| FE-03 | P1 | 发票库把“总记录数”和“待识别数”绑定到错误文案 | `gui-design/scripts/shell.js:1500-1508` |
| FE-04 | P1 | 摘要/配置读取失败后仍追加成功提示 | `gui-design/scripts/shell.js:929-956` |
| FE-05 | P1 | 邮件和文件字段可触发 CSV/Excel 公式注入 | `gui-design/scripts/shell.js:2767-2825` |
| FE-06 | P1 | CSV 导出既忽略当前筛选又静默漏掉未加载记录 | `gui-design/scripts/shell.js:2793-2825` |
| FE-07 | P2 | `stopOcr()` 的 IPC 拒绝会永久卡住停止按钮 | `gui-design/scripts/shell.js:2148-2178` |
| FE-08 | P2 | 互斥状态不锁同类任务的其它入口，可重复提交 | `gui-design/scripts/shell.js:468-482` |
| FE-09 | P2 | 既有 toast 点击拦截问题仍然存在 | `gui-design/styles/main.css:1026-1053` |
| FE-10 | P1 | toast 生命周期会删除尚未确认的错误 | `gui-design/scripts/shell.js:2875-2898` |
| FE-11 | P2 | 每次导航都会把已加载的后续分页重置为第一页 | `gui-design/scripts/shell.js:686-740` |
| FE-12 | P2 | 文件下载百分比是按条数每次加 4% 的伪进度 | `gui-design/scripts/shell.js:1186-1200` |
| FE-13 | P2 | 当前任务状态读取失败被静默吞掉，控制器按空闲渲染 | `gui-design/scripts/shell.js:455-465` |
| FE-14 | P3 | 已存在可证明的无调用函数和孤儿 action 分支 | `gui-design/scripts/shell.js:876-881` |

## 详细发现

### FE-01 部分失败被渲染为绿色“完成/成功”
- 严重度：P1
- 位置：`gui-design/scripts/shell.js:1109-1131`、`gui-design/scripts/shell.js:1193-1209`、`gui-design/scripts/shell.js:2267-2271`、`src/electron/main.ts:747-768`
- 置信度：CONFIRMED
- 证据：
  ```ts
  const ocrErrored = data.kind === 'err';
  // ...
  done: !ocrErrored && (Boolean(data.done) || percent >= 100),
  ```
  ```ts
  const fileErrored = data.kind === 'err';
  // ...
  done: !fileErrored && (Boolean(data.done) || percent >= 100),
  ```
  ```ts
  kind: current.failed > 0 || current.partial > 0 ? 'warn' : 'ok',
  done: true,
  ```
  ```ts
  result?.ok ? 'ok' : 'err',
  ```
- 问题：主进程明确把 `failed > 0` 或 `partial > 0` 的文件终态发成 `kind: "warn"`；renderer 却只把 `"err"` 当异常，所以进度条进入 `is-done`，最终 `runBridgeAction()` 又只按进程级 `result.ok` 发绿色 toast。OCR 的单文件失败也走相同逻辑。用户不在 Dashboard/Library 当前页时，只会看到短暂绿色“获取完成/识别完成”，单票失败只留在隐藏日志、计数或待确认列表里。这不是纯文案问题，而是把需要继续处理的报销材料标成成功终态。
- 建议修复：定义统一终态 `success | partial | failed | canceled`，不要从 `kind !== "err"` 推导。`failed > 0` 或 `partial > 0` 时进度条、历史和 toast 都使用 `partial/warn`；toast 至少保留到用户确认，并提供“查看失败项/待确认”按钮。`runPipeline`/`runOcr` 的 IPC 返回值也应携带结构化计数和终态，renderer 不再从进程退出是否为 0 推断业务是否完整。

### FE-02 自动保存与导航回填存在旧值覆盖竞态
- 严重度：P1
- 位置：`gui-design/pages/config.html:553-592`、`gui-design/scripts/shell.js:728-732`、`gui-design/scripts/shell.js:940-948`、`gui-design/scripts/shell.js:1808-1816`
- 置信度：CONFIRMED
- 证据：
  ```js
  window.MFH_CONFIG_HAS_PENDING_SAVE = () => saveTimer !== 0;
  // ...
  saveTimer = window.setTimeout(() => {
      saveTimer = 0;
      saveConfigNow().catch((err) => {
  ```
  ```js
  await loadBridgeSummary();
  await loadBridgeConfig();
  ```
  ```js
  const set = (selector, value) => {
      const el = document.querySelector(selector);
      if (el && value !== undefined && value !== null) el.value = value;
  };
  ```
- 问题：用户修改配置后有 450ms 防抖窗口。若在窗口内导航，`showPage()` 会无条件调用 `loadBridgeConfig()`；`applyConfig()` 又用全局 selector 回填仍缓存于 DOM 的隐藏 Config 表单。只要这次 IPC 回填先于 timer，用户刚输入的新值就被磁盘旧值覆盖，随后 timer 收集并保存的也是旧值。另一个确定缺口是 timer 开始执行前就被置 0，因此 `MFH_CONFIG_HAS_PENDING_SAVE()` 看不到正在进行的保存；此时“重新读取配置”不会警告。并发 save 也没有 revision，较早请求的 UI 状态可以覆盖较新的“正在保存”状态。
- 建议修复：建立单一 `ConfigDraftStore`，至少包含 `draft`、`dirtyRevision`、`savedRevision`、`saveInFlight`。所有保存串行化；旧 revision 完成不得更新新 revision 的 UI。导航前 `flush()` 并等待完成，或明确提示用户；`loadBridgeConfig()` 只在 draft 未 dirty 时 hydrate。`HAS_PENDING_SAVE` 必须同时覆盖 timer、dirty draft 和 in-flight promise。

### FE-03 发票库把“总记录数”和“待识别数”绑定到错误文案
- 严重度：P1
- 位置：`gui-design/pages/library.html:25-28`、`gui-design/pages/library.html:94-100`、`gui-design/scripts/shell.js:1500-1508`、`src/electron/summary.ts:314-320`
- 置信度：CONFIRMED
- 证据：
  ```html
  <div class="stat__label">待识别文件</div>
  <div class="stat__value" data-lib="total">0</div>
  ```
  ```js
  text('[data-lib="total"]', fmtInt(library.total || library.pending || 0));
  text('[data-lib="pending"]', fmtInt(library.pending));
  ```
  ```html
  <span class="small muted">结账单/堂食明细</span>
  <span class="mono strong" data-lib="pending">0</span>
  ```
- 问题：后端的 `library.total` 是发票库切片前的全部记录数，`library.pending` 才是待识别/待补充数。当前第一张卡把 total 标成“待识别文件”，会把已成功识别和已归档记录也算进去；下方又把真正的 pending 数挂在“结账单/堂食明细”这个完全不同的类别上。用户会得到两个错误业务结论：待处理工作量被夸大，且某类餐饮材料数量凭空等于待识别总数。
- 建议修复：第一张卡绑定 `library.pending` 并保留“待识别文件”；若需要总量，新增明确的“发票库总记录”卡绑定 `library.total`。“结账单/堂食明细”必须绑定后端真实 documentType/category 计数；在后端尚无该字段前删除该卡，不能复用 pending 占位。

### FE-04 摘要/配置读取失败后仍追加成功提示
- 严重度：P1
- 位置：`gui-design/scripts/shell.js:929-956`、`gui-design/scripts/shell.js:2020-2021`、`gui-design/scripts/shell.js:2059-2068`
- 置信度：CONFIRMED
- 证据：
  ```js
  } catch (err) {
      showToast('读取本地数据失败', '无法读取本机的邮件和发票记录，请确认配置文件是否完整。', 'err', { detail: err?.message });
  }
  ```
  ```js
  if (name === 'reload-summary') { await loadBridgeSummary(); showToast('已刷新', '本地列表已重新读取。'); return; }
  ```
  ```js
  await loadBridgeConfig();
  // ...
  showToast('已重新读取配置', '已从本机恢复最新配置。');
  ```
- 问题：`loadBridgeSummary()` 和 `loadBridgeConfig()` 都在内部捕获异常并正常 resolve；调用者无法知道失败，仍无条件显示“已刷新”或“已从本机恢复最新配置”。失败场景会同时出现一个粘性红色错误和一个绿色成功提示；配置读取失败时表单保留原有 DOM 值，却被成功提示描述为刚从磁盘恢复。
- 建议修复：loader 返回 `{ok, data, error}` 或直接重新抛出；显式用户动作只在 `ok === true` 时显示成功。后台静默刷新可以由统一 error boundary 负责 toast，但不能把失败折叠成成功的 `Promise<void>`。

### FE-05 邮件和文件字段可触发 CSV/Excel 公式注入
- 严重度：P1
- 位置：`gui-design/scripts/shell.js:2767-2770`、`gui-design/scripts/shell.js:2793-2804`、`gui-design/scripts/shell.js:2810-2822`
- 置信度：CONFIRMED
- 证据：
  ```js
  const csvField = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  ```
  ```js
  row.from || '',
  row.subject || '',
  ```
  ```js
  row.seller || '',
  row.filename || '',
  ```
- 问题：`from`、`subject` 来自外部邮件，`seller`、`filename` 来自附件或识别结果。当前 CSV 编码只转义双引号；字段以 `=`, `+`, `-`, `@` 开头时，Excel 打开或粘贴 CSV 会把它作为公式，而不是普通文本。攻击者只需发送主题为 `=...` 的发票邮件，即可把公式带入报销人员复制的表格。
- 建议修复：在 CSV 边界统一做 spreadsheet-safe 编码：对去除前导空白后以 `[=+\-@]` 开头的字符串前置 `'`，并处理制表符、回车等公式绕过字符。更稳妥的是生成有显式文本单元格类型的 `.xlsx`。为主题、发件人、销售方、文件名各增加公式前缀回归用例。

### FE-06 CSV 导出既忽略当前筛选又静默漏掉未加载记录
- 严重度：P1
- 位置：`gui-design/scripts/shell.js:1473-1483`、`gui-design/scripts/shell.js:1519-1536`、`gui-design/scripts/shell.js:2793-2825`
- 置信度：CONFIRMED
- 证据：
  ```js
  const rows = sortRows(loadedRows.filter((row) => {
      if (query && !haystack.includes(query)) return false;
      if (attachmentOnly && !row.hasAttachment) return false;
  ```
  ```js
  if (page === 'library') {
      const rows = window.FPH.libraryRows || [];
      // ...
      for (const row of rows) {
  ```
- 问题：页面显示的是搜索、tab、销售方、附件/链接筛选后的 `rows`；导出却重新读取未筛选的 `window.FPH.inboxRows/libraryRows`。同时这两个数组只包含已加载分页，不包含 `total - cursor` 的后续记录。结果既不是“当前可见表格”，也不是“完整发票库”：用户筛选“识别失败”后仍会复制所有已加载记录；用户以为导出了全部时，又会静默缺少尚未加载的记录。用于报销核对时会直接产生漏项或混项。
- 建议修复：明确提供两个动作：“复制当前筛选结果”和“导出全部记录”。前者复用纯函数 `selectVisibleRows(state)`，渲染和导出共同调用；后者把 filter/sort 传给后端生成完整文件，或先明确要求加载全部。toast/文件名必须写明实际导出条数与总数，未加载完整时不得无提示地声称导出完成。

### FE-07 `stopOcr()` 的 IPC 拒绝会永久卡住停止按钮
- 严重度：P2
- 位置：`gui-design/scripts/shell.js:1980-1998`、`gui-design/scripts/shell.js:2148-2178`、`gui-design/scripts/shell.js:314-319`
- 置信度：NEEDS-RUNTIME-CHECK
- 证据：
  ```js
  if (!isOcrToggle) {
      button.disabled = wasDisabled;
      button.innerHTML = original;
  }
  ```
  ```js
  el.disabled = true;
  el.dataset.ocrMode = 'stopping';
  el.textContent = '正在停止…';
  // ...
  const result = await fn();
  ```
- 问题：停止前先把所有 OCR 按钮设为 disabled；若 `ipcRenderer.invoke('mfh:stop-ocr')` reject，异常上抛到全局 click catch，只显示通用 toast。`withBusyButton()` 又刻意不恢复 `ocr-toggle`，所以页面永久停在“正在停止…”，5 秒 fallback 也不会创建（它位于成功 await 之后）。这正是后台/IPC 异常时长任务控件卡死的路径。
- 建议修复：在 `stopOcr()` 内部 `try/catch/finally`；失败时重新读取 `getOpState()`，任务仍在则恢复“再次尝试停止”，已结束则恢复 idle。fallback 应在发起停止请求前建立，任何退出路径都负责清理。
- 运行确认：在 renderer fixture 中让 `stopOcr()` 返回 rejected promise，点击“停止识别”，5 秒后断言按钮可用且 label 不再是“正在停止…”。

### FE-08 互斥状态不锁同类任务的其它入口，可重复提交
- 严重度：P2
- 位置：`gui-design/scripts/shell.js:438-488`、`gui-design/pages/dashboard.html:166-167`
- 置信度：CONFIRMED
- 证据：
  ```js
  const conflicts = Boolean(busyKind) && busyKind !== group.kind;
  if (conflicts) {
      el.disabled = true;
  }
  ```
  ```html
  <button ... data-action="run-pipeline">开始获取发票文件</button>
  <button ... data-action="rerun-pipeline">重新获取（忽略已处理）</button>
  ```
- 问题：运行中的 `pipeline` 对 pipeline 组计算 `conflicts === false`。被点击按钮由本地 busy guard 禁用，但同组的“重新获取”仍可点击；新窗口在 fetch/pipeline/organize 已运行时，同类按钮也全部显示可用。主进程互斥门会拒绝第二次提交，因此当前不会并行写数据，但用户会经历可避免的确认框和“运行失败”，并误以为第一次任务出了问题。
- 建议修复：任何 `busyKind` 都锁住所有启动入口；只为当前 OCR 任务保留专用“停止”入口。按钮状态应由 `{kind, jobId, phase}` 唯一派生，本地 busy 只负责点击到 op-state 到达之间的极短窗口。

### FE-09 既有 toast 点击拦截问题仍然存在
- 严重度：P2
- 位置：`gui-design/styles/main.css:1026-1053`、`gui-design/tests/e2e.mjs:124-129`
- 置信度：CONFIRMED
- 证据：
  ```css
  .toast-stack {
    position: fixed;
    right: 18px;
    bottom: 18px;
    z-index: 80;
  }
  ```
  ```js
  /* Error toasts are sticky by design (FB-02): they stay until dismissed and can
     otherwise intercept clicks on the controls underneath. */
  document.querySelectorAll('.toast').forEach((toast) => toast.remove());
  ```
- 问题：这是既有审查中提到的 toast 拦截 tab 点击问题，当前树仍未修复。固定定位、最高层级的 stack/toast 没有 pointer-events 穿透策略；当前 e2e 甚至需要直接删掉所有 toast 才能继续点底层控件。toast 覆盖到右下方按钮或筛选项时，用户必须先意识到并关闭提示才能操作。
- 建议修复：`.toast-stack { pointer-events: none; }`，仅 `.toast` 及其交互子元素设 `pointer-events: auto`；同时避免 toast 覆盖主要操作区，必要时为内容区预留 inset。删除测试中的强制清除 workaround，改为断言 toast 空白区域不拦截底层点击、toast 自身按钮仍可操作。

### FE-10 toast 生命周期会删除尚未确认的错误
- 严重度：P1
- 位置：`gui-design/scripts/shell.js:719-720`、`gui-design/scripts/shell.js:2875-2898`
- 置信度：CONFIRMED
- 证据：
  ```js
  // Page-scoped errors belong to the page the user just left.
  dismissPageToasts();
  ```
  ```js
  const ordered = disposable.concat(toasts.filter((el) => el.dataset.toastSticky === 'true'));
  ordered.slice(0, excess).forEach((el) => el.remove());
  ```
  ```js
  const sticky = opts.sticky ?? isError;
  const scope = opts.scope === 'global' ? 'global' : 'page';
  ```
- 问题：错误默认是 sticky，却默认也是 page scope；任何导航都会直接删除它。若连续出现 5 个不同错误，`trimToastStack()` 在删完普通 toast 后继续删除最老的 sticky error，也没有错误中心或历史作为替代。也就是说“粘性”只表示不按时间消失，并不保证用户确认前可追溯；配置保存、打开文件、复制等失败可以在未阅读时永久丢失。
- 建议修复：错误应进入持久 notification store，以稳定 ID 标记已读/未读；视图层最多显示 4 条，但折叠为“还有 N 条错误”而不是删除。页面导航只能隐藏关联视图，不能删除未确认错误。后台任务和配置保存失败至少保留到用户关闭或问题解决。

### FE-11 每次导航都会把已加载的后续分页重置为第一页
- 严重度：P2
- 位置：`gui-design/scripts/shell.js:686-740`、`gui-design/scripts/shell.js:1357-1373`、`src/electron/summary.ts:42-50`
- 置信度：CONFIRMED
- 证据：
  ```js
  await loadBridgeSummary();
  await loadBridgeConfig();
  ```
  ```js
  } else {
      window.FPH[storeKey] = incoming.slice();
      window.FPH[`${kind}Cursor`] = incoming.length;
  }
  ```
- 问题：用户通过“加载更多”拿到第二页后，只要切换任意页面，`showPage()` 就再次请求无 offset 的 summary；`mergeSection()` 看到 `offset === 0` 会用第一页完整替换缓存并重置 cursor。后端默认页大小为 500，所以问题在 500+ 记录时出现：返回列表后，用户已加载的后续记录、基于它们的销售方选项和搜索范围全部消失，只能重复加载。
- 建议修复：summary 的统计字段与分页 rows 分开存储。全局刷新只更新 counts；列表页 refresh 请求 `limit = max(cursor, initialLimit)`，或按 identity 合并第一页并保持后续页。只有显式“重新从第一页加载”才允许清空 rows/cursor。

### FE-12 文件下载百分比是按条数每次加 4% 的伪进度
- 严重度：P2
- 位置：`gui-design/scripts/shell.js:1186-1200`、`src/electron/main.ts:772-799`
- 置信度：CONFIRMED
- 证据：
  ```js
  const percent = data.percent === undefined
      ? Math.min(96, 12 + (processed + skipped + failed) * 4)
      : Math.max(0, Math.min(100, Number(data.percent) || 0));
  ```
  ```ts
  percent: Math.min(95, 12 + current.processed * 4),
  ```
- 问题：文件任务没有总量时，每处理一封就固定增加 4%，第 21 封左右便显示 95%，无论后面还有 1 封还是 1000 封。虽然事件来自真实 backend，百分比不是实际完成比例；长任务会长时间卡在 95%，对非技术用户等同于“程序是不是死了”的错误信号。
- 建议修复：开始任务时先计算/返回 `total`；能确定总量时用 `completed / total`。不能确定时使用真正的 indeterminate progress，只显示“已处理 N 封、失败 M 封”和当前阶段，不显示伪百分比。

### FE-13 当前任务状态读取失败被静默吞掉，控制器按空闲渲染
- 严重度：P2
- 位置：`gui-design/scripts/shell.js:446-465`、`gui-design/scripts/shell.js:468-488`
- 置信度：NEEDS-RUNTIME-CHECK
- 证据：
  ```js
  try {
      const state = await read();
      window.FPH.opState = state?.running || null;
      applyOpState(window.FPH.opState);
  } catch {
      // Older main process without the handler: stay in degraded mode.
  }
  ```
- 问题：subscription 只接收未来变化，代码也明确说明新窗口必须主动读取当前状态；但读取失败被无提示吞掉。此时 `window.FPH.opState` 保持空，所有长任务启动按钮按 idle 渲染。若主进程里已有任务，新窗口会允许用户提交冲突操作；若是版本不兼容，用户也得不到“需要升级/重启”的可操作说明。
- 建议修复：在状态未成功同步前把所有破坏性/长任务入口置为“正在确认任务状态”；失败时显示持久页面 banner 和“重试/重启应用”。只有明确取得 `{running:null}` 才解锁。
- 运行确认：让 `getOpState()` reject，同时模拟已有任务但不发送新的 `op-state` 事件；检查所有 fetch/pipeline/OCR/organize 启动按钮保持禁用并出现可见错误。

### FE-14 已存在可证明的无调用函数和孤儿 action 分支
- 严重度：P3
- 位置：`gui-design/scripts/shell.js:54-57`、`gui-design/scripts/shell.js:876-881`、`gui-design/scripts/shell.js:2027`、`gui-design/pages/dashboard.html:587-588`
- 置信度：CONFIRMED
- 证据：
  ```js
  function documentTypeLabel(value) {
      if (value === 'itinerary') return '行程单';
      if (value === 'supporting') return '支撑材料';
      if (value === 'invoice') return '发票';
      return value || '未分类';
  }
  ```
  ```js
  if (name === 'copy-text') { await copyText(sanitizeText(action.dataset.copyText || '')); return; }
  ```
  ```js
  window.MFH_PAGE_INIT.dashboard = () => {};
  ```
- 问题：在完整 `shell.js`、全部页面和生成 markup 中，`documentTypeLabel()` 只有定义没有调用；没有任何 `data-action="copy-text"` 生产方；Dashboard 的 `PAGE_SCRIPT_INIT` 入口是空函数。`MUTEX_GROUPS` 里还保留了页面中不存在的 `data-action="organize"` selector。这些不是未来接口声明，而是重构后遗留的不可达分支，会增加 action/selector 审计噪声。
- 建议修复：删除无调用函数、空 init 和孤儿 action；若确实要保留扩展点，改成有类型/测试覆盖的注册表，不要在生产分派器里保留无法触发的字符串分支。

## 明确排除的项（我检查过但认为不是问题）

1. **未发现当前 backend/email 字符串可直接造成 DOM XSS。** Inbox、library、pending、history 和 current-batch 的外部字段在拼入 `innerHTML` 前均调用 `escapeHtml()`（例如 `shell.js:1264-1275,1312-1321,1484-1493,1537-1547,1633-1655`）；配置错误使用 DOM API + `textContent`（`shell.js:2364-2398`）。固定 `ICON` 和固定状态片段使用 `innerHTML` 不构成外部输入链。CSV 公式注入是另一个边界，已单列 FE-05。
2. **未发现 SPA 导航旧请求覆盖新页面。** `shell.js:590-597,686-740` 使用单调 `navToken`，提交和清理都检查 token；旧导航不会把新页面切回去。
3. **未发现每次 SPA 导航重复注册整套全局 listener。** `shell.js` 在 loader 中被明确跳过（`shell.js:615-617`）；Dashboard/Config 内联脚本有 one-shot/root guard（`dashboard.html:302-303`、`config.html:683-689`）；preload 的 progress 注册还会先 `removeAllListeners`（`electron/preload.cjs:25-43`）。这不等于架构理想，但当前没有可证明的 double-fire leak。
4. **既有“pending 每组只显示 6 条”问题已修复，不再报告。** Renderer 对 `group.rows` 全量 map（`shell.js:1676-1677`），生产方也明确逐行 push、不截断（`src/pending/summary.ts:171-185`）。
5. **既有“关键错误 2.6 秒自动消失且无关闭按钮”已基本修复。** 当前 `kind === "err"` 默认 sticky，使用 `role="alert"`，并创建可访问关闭按钮（`shell.js:2895-2898,2924-2938`）。本报告只保留仍存在的点击遮挡和未确认错误被生命周期删除问题（FE-09、FE-10）。
6. **既有空数字被 `Number('')` 强制变 0 的问题已修复。** `config.html:359-364` 对空值返回 `undefined`，`config.html:510-530` 对必填端口、整数和范围逐字段校验并展示原值。
7. **表格排序本身未发现当前页状态串页。** Inbox 和 Library 已分别使用 `sortInbox` / `sortLibrary`（`shell.js:268-280,914-926`），并复制数组后排序，不会原地改变 summary store。
8. **后台子进程正常以失败结果结束时，OCR/files 主动作不会永久停在 running。** `runBridgeAction()` 对 rejected invoke 和无 summary 的失败结果都有显式终态回填（`shell.js:2213-2266`）。FE-07 只针对独立的 `stopOcr()` rejection 路径。
