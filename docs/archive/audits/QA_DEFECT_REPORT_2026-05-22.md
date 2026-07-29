# QA 缺陷修复报告 · 2026-05-22

本次会话集中修复了一轮 QA 走查中发现的 8 个 P0、5 个 P1、3 个 P2 缺陷，并补齐了对应的回归用例。

## 修复总览

| ID | 严重度 | 缺陷描述 | 修复点 | 回归用例 |
| --- | --- | --- | --- | --- |
| P0-1 | 阻塞 | 配置页「邮箱文件夹」多选未保存到 `imap.mailbox` | [config.html](../gui-design/pages/config.html) 给 `<select multiple>` 加 `data-config="imap.mailbox"`；`collectConfigPayload` 读取 `selectedOptions`；`applyConfig` 在 [shell.js](../gui-design/scripts/shell.js) 反向回填 | e2e.mjs：多选 INBOX/Sent Messages 后校验 `savedPayload.imap.mailbox` |
| P0-2 | 阻塞 | 「TLS 加密」勾选框纯装饰 | 勾选框加 `data-config-check="imap.tls"`；`collectConfigPayload` 读取 `is-on` 写入 `imap.tls`；`applyConfig` 反向回填 | e2e.mjs：关闭 TLS 后校验 `savedPayload.imap.tls === false` |
| P0-3 | 阻塞 | 「识别后自动改名」勾选框纯装饰 | 勾选框加 `data-config-check="rename.applyAfterOcr"`；payload 输出 `rename.applyAfterOcr` | e2e.mjs：勾选后校验 `savedPayload.rename.applyAfterOcr === true` |
| P0-4 | 阻塞 | 「按类型分目录」缺开关，分类规则永远不生效 | 新增 `data-config-check="rename.organizeByType"` 开关；payload 输出 `rename.organizeByType` | e2e.mjs：勾选后校验 `savedPayload.rename.organizeByType === true` |
| P0-5 | 阻塞 | 网络重试两个输入框未绑定 | 输入框补 `data-config="network.retries"` / `network.retryDelayMs`；payload 输出 `network`；`main.ts` 的 `SaveConfigPayload` 与 `normalizeSavePayload` 接受 `network` | e2e.mjs：填入 5 / 2500 后校验 `savedPayload.network` |
| P0-6 | 阻塞 | 控制台「匹配主题/正文/只预览」三个勾选未接线 | 勾选框加 `data-fetch-check`；`startRun` 把 `matchSubject` / `matchBody` / `dryRun` 写入 IPC payload；`main.ts` 收到后调 `writeConfig` 同步到配置并保留 `--dry-run` | e2e.mjs：默认勾选状态校验 payload，并切换「只预览」校验 `dryRun=true` |
| P0-7 | 阻塞 | 「仅失败项」过滤永远不生效（`is-on` vs `is-active` 不一致） | `renderLibraryRows` 改为读取 `is-on`（与 `.check` 点击 handler 一致） | e2e.mjs：在「全部」Tab 下勾选「仅失败项」校验行数从 2 → 1 |
| P0-8 | 阻塞 | 待处理队列四个 Tab 完全不过滤 | Tab 加 `data-pending-tab="all|refresh_link|manual_archive|ignore"`；`applyPendingSummary` 抽出 `renderPendingGroups`，Tab 点击时按 action 过滤分组 | e2e.mjs：分别点击「可忽略」与「刷新链接」校验分组数 |
| P1-9 | 高 | 控制台日期硬编码 `today = new Date(2026, 4, 21)` | 改用 `new Date()` 取当前日期 | e2e.mjs 使用 `page.clock.install({ time: '2026-05-21T10:00' })` 让用例确定性 |
| P1-10 | 高 | `run-pipeline` 默认强制 `force: true` | 默认改为 `force: false`；保留 `rerun-pipeline` 动作（带二次确认）作为可选「重新获取」入口 | e2e.mjs 回归断言：`runPipeline` 默认 `force === false` |
| P1-11 | 中 | 「导出 …」按钮其实只复制到剪贴板 | 三个按钮文案改为「复制日志」「复制为 CSV」；`copyText` 支持显示具体类型；测试同步更新 | electron-full-flow.mjs 同步重命名按钮名 |
| P1-12 | 中 | 关于页「原始邮件缓存」误写为 `.mfh-cache` | 改回 `./samples/raw` 并加 `data-settings-path`，`applyConfig` 用真实配置文本回填 | 由 `applyConfig` 自动同步 |
| P1-13 | 低 | 待处理队列卡片初始硬编码 7/3/1/1 | HTML 默认改为「暂无待确认 / 0 / 无需处理」 | 通过 `applyPendingSummary` 真实数据覆盖；mock 无数据时显示 0 |
| P2-14 | 低 | `preload.cjs` 同时把 `testConnection` 与 `testMailConnection` 映射到同一 channel | 删除 `testConnection` 别名；`shell.js` 直接调用 `testMailConnection` | 现有 e2e 用例仅校验 `testMailConnection` 被调用 |
| P2-15 | 低 | 「整理识别结果」在空 OCR 结果下提示「整理完成」误导用户 | `mfh:organize` IPC 解析 `Organize complete: scanned=N`，N=0 时返回「目前没有可整理的识别结果」；shell.js 接到 `empty` 标识改为 `warn` 风格 toast「没有可整理的识别结果」 | 已通过 typecheck；fake CLI 不输出 scanned 行，保持现有 toast「整理完成」匹配 |
| P2-16 | 低 | 侧边栏 `⌘K` 占位字与代码不匹配 | `wireSearch` 监听全局 `keydown`，`metaKey/ctrlKey + k` 时 focus `[data-global-search]` | e2e.mjs：派发合成键事件后校验 `document.activeElement` |

## 涉及的文件

- `gui-design/pages/config.html`：补 `data-config` / `data-config-check` 绑定；`collectConfigPayload` 输出新字段并暴露到 `window`。
- `gui-design/pages/dashboard.html`：三个抓取勾选加 `data-fetch-check`；`rangeFor` 改用 `new Date()`；`startRun` payload 带 matchSubject/matchBody/dryRun；导出按钮重命名为「复制日志」。
- `gui-design/pages/library.html`：（无 HTML 改动，仅由 shell.js 修正过滤逻辑覆盖）
- `gui-design/pages/pending.html`：四个 Tab 加 `data-pending-tab`；统计卡片默认 0；导出按钮重命名。
- `gui-design/pages/settings.html`：数据保存行加 `data-settings-path`，文案换成真实默认路径。
- `gui-design/pages/inbox.html`：导出按钮重命名。
- `gui-design/scripts/shell.js`：`renderLibraryRows` 改读 `is-on`；新增 `renderPendingGroups`；点击 Tab 时联动；`applyConfig` 回填 mailbox/TLS/applyAfterOcr/organizeByType/network/`data-settings-path`；`handleAction.run-pipeline` 默认 force=false；新增 `rerun-pipeline` 动作；`organize` 命中空结果时改 warn toast；`copyText`/`exportVisibleLog`/`exportVisibleTable` 文案对齐；`wireSearch` 注册全局 `⌘K`。
- `electron/preload.cjs`：删除 `testConnection` 别名。
- `src/electron/main.ts`：`SaveConfigPayload` 与 `normalizeSavePayload` 接受 `imap.tls` / `network`；`asDateRange` 透传 `matchSubject/matchBody`；`mfh:start-fetch` 收到 match 时 `writeConfig` 同步并改 history 标题；`mfh:organize` 解析 scanned 并返回友好 message。

## 回归用例

`gui-design/tests/e2e.mjs` 在原有覆盖之外新增/调整以下断言：

1. 启动用 `page.clock.install({ time: '2026-05-21T10:00:00' })`，让 P1-9 改造后的 `new Date()` 输出在 CI 中可复现。
2. `⌘K`：派发合成 keydown 校验 `activeElement` 命中 `[data-global-search]`。
3. `startFetch` 默认 payload 必须带 `matchSubject=true && matchBody=true && dryRun=false`；勾选「只预览」后 `dryRun=true`。
4. 待确认 Tab：分别点击「可忽略」「刷新链接」校验 `[data-pending-groups] .group` 数量变化。
5. 发票库「仅失败项」：在「全部」Tab 下勾选 check 后行数从 2 → 1。
6. 配置保存：批量勾选 mailbox/TLS/applyAfterOcr/organizeByType + 改 network 数字后，校验 `savedPayload.imap.mailbox`、`savedPayload.imap.tls`、`savedPayload.rename.applyAfterOcr`、`savedPayload.rename.organizeByType`、`savedPayload.network.{retries,retryDelayMs}` 均落盘。
7. `runPipeline` payload 默认 `force === false`。

## 验证结果

| 验证 | 状态 | 说明 |
| --- | --- | --- |
| `npm run typecheck` | ✅ | TypeScript 无报错 |
| `npm run build` | ✅ | dist 重新生成 |
| `node gui-design/tests/e2e.mjs` | ✅ | GUI E2E + 上述新增断言全部通过 |
| `node gui-design/tests/electron-smoke.mjs` | ⚠️ | 当前沙盒环境 Playwright 1.60 + Electron 42 + Node 26 启动 `Electron` 时报 `bad option: --remote-debugging-port=0`，与本次改动无关；shell.js / preload.cjs 改动量小，建议在用户本机 Node 20 环境复跑一次 |
| `node gui-design/tests/electron-full-flow.mjs` | ⚠️ | 同上，启动器问题；按钮重命名已同步更新 |

