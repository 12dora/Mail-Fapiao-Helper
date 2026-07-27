# Mail Fapiao Helper 综合代码审查发现

审查日期：2026-07-27  
审查基线：`39bae7b`（`main`）  
性质：本文件是代码审查报告，不表示下列问题已经修复，也不表示已经对真实邮箱、正式安装包或所有平台完成端到端验收。

## 执行摘要

本次审查合并了 12 份专项报告，并对当前源码中的重复根因、相互矛盾的严重度和行号进行了复核。原始报告中的同一根因没有重复计数；纯样式偏好、证据不足的推测、仅属缺少覆盖而非现存故障的条目，以及被当前代码反驳的条目均未纳入。最终保留 **62 个规范化问题**：

| 类别 | 高 | 中 | 合计 |
| --- | ---: | ---: | ---: |
| APP 缺陷 | 12 | 18 | 30 |
| 过度技术化/内部化 UI 文案 | 3 | 5 | 8 |
| 缺少关键动画/状态反馈 | 1 | 4 | 5 |
| 不合理、难用或损坏的布局/UI | 3 | 7 | 10 |
| 代码异味、测试腐化、死代码和开发残留 | 4 | 5 | 9 |
| **合计** | **23** | **39** | **62** |

按置信度计：**已确认 54 个，强证据 7 个，需运行时验证 1 个**。

没有单列“低”严重度：若一个低优先级条目仅涉及文档措辞、包体微小冗余或审美偏好，且没有独立用户风险，本报告将其排除或并入更具体的根因。

### 最优先修复顺序

1. **先保护数据完整性**：建立 Electron 全局操作协调器和 CLI 跨进程锁，修复归档/CSV/状态/待确认队列的事务边界（APP-03～APP-05、APP-17、APP-18A、APP-18B）。
2. **消除静默漏票**：把提取流程改成可组合、可表达部分成功的批处理协议，并修复错误的 OFD 去重（APP-01、APP-02）。
3. **统一票据身份**：以稳定 artifact ID 或 `hash + filename + contentHash` 贯穿归档、OCR、摘要和整理（APP-06A、APP-06B、APP-14B、APP-14C）。
4. **修复配置与日期契约**：共享配置校验/迁移逻辑，统一本地日历日期和 ISO 时间戳边界（APP-07、APP-08）。
5. **关闭高风险安全缺口**：升级可达的脆弱解析器，收窄临时配置和文件权限，并对日志/IPC 做脱敏（APP-09、APP-22、COPY-01、COPY-02）。
6. **恢复主要工作流的可达性**：取消不可到达的记录上限，补齐键盘、表单标签和进度语义（UI-01～UI-03、FB-01）。
7. **建立可信发布门禁**：修复测试假阳性、生产内置 fake backend、签名和 tag/源码对应关系，再把确定性测试接入 CI（CODE-01～CODE-04、CODE-05A、CODE-05B）。

### 审查范围

- TypeScript CLI：IMAP 获取、提取器调度、站点处理器、下载/归档、状态和 CSV、OCR、整理/重命名。
- Electron：主进程、preload、IPC、子进程、窗口/实例生命周期、配置和文件对话框。
- Renderer：`gui-design/pages`、`gui-design/scripts/shell.js`、全局样式、响应式和无障碍语义。
- 质量与发布：全部已提交测试脚本、`package.json`、lockfile、release workflow、打包资源和说明文档。
- 证据来源：`01-core-pipeline.md` 至 `12-holistic.md`；其中重复项按当前源码根因合并。

### 验证命令与结果

| 命令/检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 本次复核通过。 |
| `npm test --if-present` | 退出码 0，但实际没有 `test` 脚本，也没有运行测试；这是 CODE-01 的证据，不是测试通过。 |
| `npm run build` | 多份专项报告记录为通过；本次合并阶段未重复生成构建产物。 |
| `node gui-design/tests/cli-regression.mjs` | 独立复核通过；专项阶段的完整隔离构建曾在 900 ms 并发阈值处失败（约 2.0～2.5 秒），说明该绝对耗时断言会随环境波动，见 CODE-03。 |
| `node gui-design/tests/electron-smoke.mjs` | 独立复核通过。 |
| `node gui-design/tests/electron-full-flow.mjs` | 独立复核在 [gui-design/tests/electron-full-flow.mjs:108](../gui-design/tests/electron-full-flow.mjs#L108) 的固定日期断言处失败。 |
| `node gui-design/tests/e2e-fixes.mjs` | 独立复核通过。 |
| `node gui-design/tests/e2e.mjs` | 独立复核已启动 Chromium 并进入应用交互，但在 [gui-design/tests/e2e.mjs:433](../gui-design/tests/e2e.mjs#L433) 因 toast 拦截“失败”tab 点击而失败。专项阶段曾在 Chromium 缺失时复现 launch 失败；源码确认该失败路径会泄漏 HTTP server。 |
| `npm audit --omit=dev --json` | 独立复核再次确认 APP-09 所述的可达 `adm-zip` 和 `linkify-it` advisory。 |
| `git status --short` | 写入本报告前工作树干净。 |

### 已知限制

- 浏览器测试使用 synthetic bridge/fake data，不等于真实邮箱、真实 CLI、正式安装包或第三方站点端到端验收；通用 `e2e.mjs` 当前仍失败。
- Windows 进程树、SmartScreen 和 macOS Gatekeeper/签名只在对应平台能力范围内验证；Windows 子进程遗留问题需要目标平台复测。
- 未连接真实邮箱或真实第三方开票平台；站点问题使用当前处理器逻辑和受控响应进行判断。
- 安全依赖项以当前 lockfile 和专项 `npm audit --omit=dev` 结果为基线；升级后应重新审计。

严重度含义：**高**表示可能造成静默漏票/错归属、数据损坏或泄露、破坏主要工作流或发布信任；**中**表示存在可复现的功能、可访问性、可恢复性、测试可靠性或运维缺陷，但通常有替代路径或影响范围较窄。

置信度含义：

- **已确认**：当前代码路径直接成立，或已有受控复现。
- **强证据**：静态契约明确且触发条件现实，但未在所有目标运行时复现。
- **需运行时验证**：依赖特定 OS、浏览器、网络或安装包环境。

---

## 一、APP 缺陷

### APP-01 — 提取协议只能选择一个来源，且不能可靠表达部分成功

- **严重度 / 置信度**：高 / 已确认
- **位置**：[src/pipeline.ts:309-355](../src/pipeline.ts#L309)、[src/extract/registry.ts:6-10](../src/extract/registry.ts#L6)、[src/extract/directLink.ts:212-216](../src/extract/directLink.ts#L212)、[src/extract/thirdParty.ts:104-110](../src/extract/thirdParty.ts#L104)、[src/extract/attachment.ts:159-264](../src/extract/attachment.ts#L159)
- **证据与根因**：pipeline 在第一个 `canHandle()` 为真的提取器处 `break`。附件、普通直链和站点链接不能共同贡献 artifact；`directLink.canHandle()` 又会因任一站点链接而放弃整封邮件。第三方链接循环没有逐链接隔离，前一个坏链接会丢弃已取得和后续的好链接；附件提取在已有成功文件时会把超限/损坏条目只记日志并返回完整成功。
- **用户影响**：混合附件+链接、站点链接+直链、多站点链接或“一个小文件+一个超限文件”的邮件会静默漏票，邮件随后仍可能被标记为已处理。
- **触发/复现**：在同一邮件放入附件 A 和直链 B；或先放过期站点链接、再放有效链接；或同时放正常 PDF 与超限 PDF。
- **修复建议**：把提取器改为可组合的候选源；以 artifact 为单位汇总成功/失败并按内容身份去重。只要任一候选失败，就持久化可见的部分结果和待确认记录，不得把整封邮件提交为完整成功。
- **来源**：`01-core-pipeline.md`、`03-extract-sites-ocr.md`、`12-holistic.md`

### APP-02 — 直链流程把无关 OFD 当成 PDF 重复件删除

- **严重度 / 置信度**：高 / 已确认
- **位置**：[src/extract/directLink.ts:186-196](../src/extract/directLink.ts#L186)、[src/extract/directLink.ts:311](../src/extract/directLink.ts#L311)、对照 [src/extract/attachment.ts:101-139](../src/extract/attachment.ts#L101)
- **证据与根因**：`preferPdfOverDuplicateOfd()` 只判断邮件中是否存在任意 PDF，随后删除所有非行程单 OFD；它没有比较发票号、规范化文件名或内容身份。附件流程已有较安全的 `sameDocument()`，但两处逻辑没有复用。
- **用户影响**：邮件同时含发票 A 的 PDF 和发票 B 的 OFD 时，B 会无提示消失。
- **触发/复现**：提供不相关的 `a.pdf` 与 `b.ofd` 直链，主题和文件名不含行程单关键词。
- **修复建议**：共享同一文档身份算法；只有可靠匹配的 PDF/OFD 才去重，精确内容重复再由 content hash 消除。
- **来源**：`03-extract-sites-ocr.md`、`12-holistic.md`

### APP-03 — 归档、元数据和处理状态不是一个事务，失败/重试会丢任务或制造孤儿文件

- **严重度 / 置信度**：高 / 已确认
- **位置**：[src/download/downloader.ts:118-160](../src/download/downloader.ts#L118)、[src/pipeline.ts:358-418](../src/pipeline.ts#L358)、[src/index.ts:567-590](../src/index.ts#L567)
- **证据与根因**：文件先被最终化，之后才逐行追加 `invoices.csv` 和 OCR queue。后续写入失败不会回滚已落盘文件；连待确认写入也失败时，异常仍被吞掉并提交 `processedHashes`。`--force`/`--only-mail` 重跑会新建碰撞文件，而 CSV 去重不删除或复用新文件。
- **用户影响**：磁盘满、CSV 被 Excel 锁定、权限变化或中断可造成未索引文件、部分批次、重复文件，甚至既无归档也无待确认记录却不再自动重试。
- **触发/复现**：让发票 CSV 和待确认目录同时不可写；或在同一邮件上重复执行 `--only-mail`。
- **修复建议**：先在唯一事务目录暂存完整批次，预验证所有目标，再原子提交文件与元数据；失败时回滚本批次文件。以 `(messageId, source, contentHash)` 在最终化前做幂等协调，只有 durable pending 或完整归档成功后才提交 processed state。
- **来源**：`01-core-pipeline.md`、`10-config-reliability.md`、`12-holistic.md`

### APP-04 — “选择文件归档”绕过归档台账和 OCR 队列，且队列更新不可恢复

- **严重度 / 置信度**：高 / 已确认
- **位置**：[src/electron/main.ts:308-335](../src/electron/main.ts#L308)、[src/electron/main.ts:1281-1317](../src/electron/main.ts#L1281)、[src/ocr/runner.ts:240-246](../src/ocr/runner.ts#L240)、[src/electron/summary.ts:212-227](../src/electron/summary.ts#L212)
- **证据与根因**：手动归档逐个复制文件到最终目录，然后直接重写 `pending.csv`；既不追加归档 CSV，也不追加 `ocr-pending.csv`。摘要靠目录扫描仍能显示松散文件，而 OCR 只读取队列。多文件复制和 live CSV 重写没有 staging、原子替换或回滚。
- **用户影响**：UI 显示归档成功，但“开始识别”称无文件；原待确认上下文已删除。中途失败还会留下部分副本，重试产生 `-1/-2` 重复件。
- **触发/复现**：对 `manual_archive` 条目选择 PDF 后启动 OCR；或选择两个文件并让第二个不可读。
- **修复建议**：把手动导入路由到与自动归档相同的事务服务；校验格式、计算 hash、写 archive ledger 和 OCR queue 全部成功后才移除 pending 行。
- **来源**：`02-electron-integration.md`、`10-config-reliability.md`、`12-holistic.md`

### APP-05 — Electron 和 CLI 缺少统一操作锁，多个写入者会覆盖状态和队列

- **严重度 / 置信度**：高 / 已确认
- **位置**：[src/electron/main.ts:720-805](../src/electron/main.ts#L720)、[src/electron/main.ts:949-1079](../src/electron/main.ts#L949)、[src/electron/main.ts:1357-1380](../src/electron/main.ts#L1357)、[src/state.ts:43-49](../src/state.ts#L43)、[src/ocr/runner.ts:109-177](../src/ocr/runner.ts#L109)、[gui-design/scripts/shell.js:653-669](../gui-design/scripts/shell.js#L653)
- **证据与根因**：fetch、normal/force pipeline、OCR、organize 可独立启动；摘要刷新还会把 OCR 控件无条件恢复为 idle。主进程没有兼容矩阵或互斥，`activeChildren` 只用于退出清理；应用也没有 single-instance lock。CLI/多实例共享固定 `.tmp`、全量 state 和 OCR queue 快照。
- **用户影响**：可丢 processed/fetched hash、擦除新加入的 OCR 行、生成重复文件、交错进度；第二次 OCR 覆盖 `activeOcrProcess` 后“停止”只能停一个进程。
- **触发/复现**：运行 OCR 时导航刷新并再次点击；同时点击正常与强制 pipeline；启动两个应用实例/两个 CLI；或在 macOS 任务运行中关闭唯一窗口，再从 Dock 重开窗口并再次启动任务。
- **修复建议**：在 main 维护带 job ID 的操作注册表和兼容矩阵，向所有窗口广播；获取 single-instance lock；数据目录再加跨进程文件锁、唯一临时名和锁内 merge-on-commit。
- **来源**：`02-electron-integration.md`、`04-frontend-behavior.md`、`10-config-reliability.md`、`11-packaging-runtime.md`、`12-holistic.md`

### APP-06A — OCR 摘要和整理使用易冲突的身份键

- **严重度 / 置信度**：高 / 已确认
- **位置**：[src/ocr/runner.ts:75-90](../src/ocr/runner.ts#L75)、[src/ocr/summary.ts:72-90](../src/ocr/summary.ts#L72)、[src/electron/summary.ts:153-170](../src/electron/summary.ts#L153)、[src/rename/rename.ts:160-170](../src/rename/rename.ts#L160)
- **证据与根因**：runner 用 `hash + filename` 索引结果，两个摘要和 organizer 却用 `hash + source`；相同来源名的不同文件会折叠。
- **用户影响**：一个 OCR 失败可被显示为成功，某张票从整理输出消失，或票 B 的字段被归到票 A 的邮件/来源。
- **触发/复现**：同一邮件放两份都叫 `invoice.pdf`、但内容不同的附件，让一份识别成功、一份失败。
- **修复建议**：引入持久化 artifact ID，并在 runner、摘要、Electron 和整理中统一；至少采用 `hash + filename + contentHash`，并为 legacy 行做显式迁移。
- **来源**：`01-core-pipeline.md`、`03-extract-sites-ocr.md`、`09-code-health.md`

### APP-06B — OCR 不校验归档字节是否仍匹配 pending `contentHash`

- **严重度 / 置信度**：高 / 已确认
- **位置**：[src/ocr/runner.ts:351-383](../src/ocr/runner.ts#L351)
- **证据与根因**：pending 行携带 `contentHash`，但 OCR 按文件名读取最终文件后不重新计算或比对内容 hash，也不在提交前验证大小。
- **用户影响**：文件被替换、编号复用或 pending 指向错误文件时，票 B 的识别字段会继续写在票 A 的邮件/来源身份下，后续整理扩大错归属。
- **触发/复现**：建立文件 A 的 pending 行，保持原 `contentHash`，把 numbered file 替换成文件 B 后运行 OCR。
- **修复建议**：OCR 前按同一算法校验 hash 和大小；不匹配时记录 `content_hash_mismatch` 并停止识别。结果行继续携带 `contentHash`，供下游身份校验。
- **来源**：`03-extract-sites-ocr.md`

### APP-07 — 日期范围同时错误处理本地日期和完整 ISO `until`

- **严重度 / 置信度**：高 / 已确认
- **位置**：[src/mail/fetcher.ts:26-38](../src/mail/fetcher.ts#L26)、[src/mail/fetcher.ts:174-185](../src/mail/fetcher.ts#L174)、[src/index.ts:120-127](../src/index.ts#L120)、[gui-design/pages/dashboard.html:307-346](../gui-design/pages/dashboard.html#L307)
- **证据与根因**：`YYYY-MM-DD` 被 `Date.parse` 当作 UTC 午夜，导致本地日历日偏移；所有 `until` 又统一加 86,400,000 ms，即使输入本来是完整 ISO 时间戳。固定毫秒还不表达 DST 日历日。
- **用户影响**：会计期间/“今天”筛选漏掉当天清晨并混入次日邮件；精确时间上限被放宽整整 24 小时。
- **触发/复现**：在 Asia/Singapore 选择单日并放入 07:00 本地邮件；或传 `--until 2026-07-27T12:30:00Z`。
- **修复建议**：显式区分 date-only 和 timestamp；date-only 按用户/业务时区的本地午夜做日历加一天，完整时间戳保留精确 instant。IMAP 查询和客户端过滤必须共享同一窗口。
- **来源**：`01-core-pipeline.md`、`10-config-reliability.md`

### APP-08 — 配置保存、校验、迁移和 fallback 契约互相矛盾

- **严重度 / 置信度**：高 / 已确认
- **位置**：[gui-design/pages/config.html:355-459](../gui-design/pages/config.html#L355)、[gui-design/scripts/shell.js:1392-1396](../gui-design/scripts/shell.js#L1392)、[src/electron/main.ts:150-229](../src/electron/main.ts#L150)、[src/config.ts:177-203](../src/config.ts#L177)、[src/config.ts:295-328](../src/config.ts#L295)、[src/electron/summary.ts:90-103](../src/electron/summary.ts#L90)
- **证据与根因**：空数字被 `Number('')` 变为 0，UI 只检查 finite，main 未用正式 schema 验证合并结果便写盘。旧/坏配置又被静默替换成 example；renderer 忽略 `configError` 并显示“已加载”。必需但已无运行作用的 `output.dir/pendingDir` 无法从 GUI 补齐，损坏 JSON 也无法覆盖修复。main-process 连接测试 handler 自身会忽略一次冗余 `writeConfig` 失败；但正常 renderer 流程先在 `shell.js:1392-1396` 等待 `saveConfig`，保存失败会阻止随后测试，不能据此声称普通 UI 会测试旧值。
- **用户影响**：页面可显示已保存/已加载，但后续 CLI 使用坏文件失败；摘要还可能指向 example 默认目录，让用户误以为数据丢失。
- **触发/复现**：清空 service port、输入 `70000` 或 `1.5` workers；删除旧配置的 `output.pendingDir`；截断 JSON。
- **修复建议**：建立 schema version、迁移和共享 validator；main 在原子替换前验证完整候选并返回字段错误。坏配置展示阻断式修复入口和备份，不允许 mutating action 静默使用 example 路径。
- **来源**：`04-frontend-behavior.md`、`09-code-health.md`、`10-config-reliability.md`

### APP-09 — 两个已知脆弱解析器直接处理不可信邮件/ZIP

- **严重度 / 置信度**：高 / 强证据
- **位置**：[package.json:25-29](../package.json#L25)、[package-lock.json:636-643](../package-lock.json#L636)、[package-lock.json:2802-2809](../package-lock.json#L2802)、[package-lock.json:2841-2856](../package-lock.json#L2841)、[src/sites/common.ts:69-82](../src/sites/common.ts#L69)、[src/mail/fetcher.ts:142-147](../src/mail/fetcher.ts#L142)
- **证据与根因**：lockfile 使用 `adm-zip@0.5.17`，可达路径会对下载 ZIP 调 `getData()`；专项 audit 报告其 4 GB 分配 DoS。`mailparser@3.9.8` 带入 `linkify-it@5.0.0`，不可信正文直接进入已报告的二次复杂度路径。
- **用户影响**：恶意或被攻陷的发票链接可耗尽内存；特制邮件正文可长时间占满 CPU，并在缓存后重复触发。
- **触发/复现**：处理对应 advisory 的构造 ZIP；或抓取超长对抗性 URL/`mailto` 样式正文。
- **修复建议**：升级并锁定已修复版本，重跑 audit；在解析前增加原始邮件/正文大小限制、超时和 worker 隔离，ZIP 继续做 entry/总量/压缩比防护。
- **来源**：`11-packaging-runtime.md`

### APP-10A — 第三方链接清理保留中文句末标点

- **严重度 / 置信度**：中 / 已确认
- **位置**：[src/extract/thirdParty.ts:8-42](../src/extract/thirdParty.ts#L8)
- **证据与根因**：第三方 URL 清理只解码两个 HTML entity 并 trim，文本正则会把 `。`、`，`、`）` 等中文句末标点保留在 token 中；直链提取已有不同的清理逻辑。
- **用户影响**：有效供应商链接会因 token 多出标点而请求失败并进入待确认。
- **触发/复现**：处理正文 `请下载：https://m-itravel.hwht.com/invoiceViewDownload?token=abc。`。
- **修复建议**：让直链和第三方提取共享一个经过测试的 URL normalizer，只剥离已知 prose delimiter，并在 handler 匹配前重新解析验证。
- **来源**：`03-extract-sites-ocr.md`、`09-code-health.md`

### APP-10B — Baiwang 的 `match` 与 `handle` 对短链 host 判定不一致

- **严重度 / 置信度**：中 / 已确认
- **位置**：[src/sites/baiwang.ts:82-110](../src/sites/baiwang.ts#L82)
- **证据与根因**：`match()` 接受 `www.bwjf.cn/u/` 和 `fp.bwjf.cn/u/`，但 `handle()` 只为 `fp.bwjf.cn` 调用短链解析。
- **用户影响**：被明确识别为受支持的 `www` 短链仍必然进入手动处理。
- **触发/复现**：处理 `https://www.bwjf.cn/u/<code>`；handler 不发解析请求并抛出 `baiwang_download_url_missing`。
- **修复建议**：让 `match` 和 `handle` 复用同一 host/path predicate，对两个已接受 host 都解析短链并校验最终 redirect。
- **来源**：`03-extract-sites-ocr.md`

### APP-10C — Taobao ZIP helper 排除 OFD-only 发票包

- **严重度 / 置信度**：中 / 已确认
- **位置**：[src/sites/common.ts:69-86](../src/sites/common.ts#L69)、[src/sites/taobao.ts:27-34](../src/sites/taobao.ts#L27)、[src/sites/taobaoFlash.ts:23-30](../src/sites/taobaoFlash.ts#L23)
- **证据与根因**：两个 Taobao handler 都调用 `pdfsFromZip()`，而 helper 只保留扩展名为 `.pdf` 的 entry，尽管其他流程把 OFD 作为一级支持格式。
- **用户影响**：合法 OFD-only 包被报为 `*_no_pdf`，用户只能手动恢复。
- **触发/复现**：让任一 Taobao endpoint 返回只含 `invoice.ofd` 的有效 ZIP。
- **修复建议**：把 helper 泛化为受支持文档提取，保留既有 entry/总量限制，并为 PDF、OFD 和明确允许的图片设置正确 format/OCR metadata。
- **来源**：`03-extract-sites-ocr.md`

### APP-10D — Nuonuo 与 Ping An 的 MIME/magic 校验方向相反

- **严重度 / 置信度**：中 / 已确认
- **位置**：[src/sites/nuonuo.ts:116-122](../src/sites/nuonuo.ts#L116)、[src/sites/pingan.ts:55-63](../src/sites/pingan.ts#L55)
- **证据与根因**：Nuonuo 仅接受 `application/pdf`，会拒绝带 `%PDF` magic 的通用 MIME；Ping An 则把任意 `application/octet-stream` 当 PDF，不核对字节。
- **用户影响**：有效 PDF 会进入待确认，而 JSON、错误页或 gateway body 可能被归档并送 OCR。
- **触发/复现**：让 Nuonuo 返回 `%PDF` + `application/octet-stream`；让 Ping An 返回 JSON + 同一 MIME。
- **修复建议**：共享文档响应验证器；通用 MIME 必须配合 magic bytes，声明为 PDF 的响应也应检查签名，除非有明确、受测的供应商解包规则。
- **来源**：`03-extract-sites-ocr.md`

### APP-11 — fetched state 会阻止丢失缓存或新输出目录的恢复

- **严重度 / 置信度**：中 / 已确认
- **位置**：[src/index.ts:346-391](../src/index.ts#L346)
- **证据与根因**：代码在检查目标 `.eml` 前先按 `fetchedHashes` 跳过邮件；状态不绑定 `--out`，也不验证文件存在且非空。
- **用户影响**：切换缓存目录、移动/删除样本后，fetch 仍称邮件已知，新目录为空，后续 run 无邮件可处理。
- **触发/复现**：正常 fetch 后删除 samples，或保持同一 state 改用 `--out <new-dir>`。
- **修复建议**：先解析预期目标，只有 state 和有效文件同时存在才跳过；缺失时重写并修复索引。必要时将 fetch state 与缓存身份绑定。
- **来源**：`01-core-pipeline.md`

### APP-12 — 检测到的文档格式可与最终扩展名冲突

- **严重度 / 置信度**：中 / 已确认
- **位置**：[src/download/downloader.ts:28-55](../src/download/downloader.ts#L28)、[src/download/downloader.ts:127-150](../src/download/downloader.ts#L127)
- **证据与根因**：`artifactExt` 依据 magic bytes 判格式，但 `safeFilename` 保留已有扩展名而不是替换。OFD bytes 可保存为 `.pdf`，返回 metadata 却是 `ofd`。
- **用户影响**：文件由错误应用打开、看似损坏，外部工具和内部 metadata 对同一文件意见不一致。
- **触发/复现**：给 OFD/PK 内容建议名 `invoice.pdf`，并启用 named output。
- **修复建议**：最终文件名由清洗后的 stem 加规范扩展构成；已知文档扩展与 magic 不一致时替换，并加入双向错标测试。
- **来源**：`01-core-pipeline.md`

### APP-13 — HTTP 重试没有应用级 deadline

- **严重度 / 置信度**：中 / 强证据
- **位置**：[src/pipeline.ts:232-270](../src/pipeline.ts#L232)、[src/util/net.ts:141-172](../src/util/net.ts#L141)、[src/config.ts:283-307](../src/config.ts#L283)
- **证据与根因**：重试只在 `fetch` reject 或返回可重试状态后发生，没有 `AbortSignal`/timeout；capped body 限字节但不限时间。接受连接后不发完 header、或持续滴流的服务器可永久占住 worker。
- **用户影响**：一个或多个链接填满 concurrency 后，整个 run 看似永远卡住，也不会形成可恢复的 network failure。
- **触发/复现**：指向接受连接但不结束响应的受控端点。
- **修复建议**：增加验证过的 per-attempt `network.timeoutMs`，让 deadline 覆盖 header 与 body，超时可重试、取消 body，耗尽后形成明确 pending reason。
- **来源**：`01-core-pipeline.md`

### APP-14A — 托管 OCR 子进程退出后服务仍被标记为 ready

- **严重度 / 置信度**：高 / 已确认
- **位置**：[src/ocr/efapiao.ts:223-298](../src/ocr/efapiao.ts#L223)
- **证据与根因**：`waitForHealth()` 在 ready 后移除临时 exit listener，之后子进程退出不会使 service state 失效；后续 `ensureService()` 只见 `existing.ready` 就直接复用。
- **用户影响**：本地服务崩溃或被终止后，本次应用/CLI 生命周期内的后续 OCR 会持续连接失效服务；serve 模式失败，auto 模式反复付出失败后再降级。
- **触发/复现**：成功启动托管服务，kill child，再在同一进程识别下一份文件。
- **修复建议**：保留持久 `exit/close` listener，原子地将 state 标为 not-ready 并移出 registry；下一次请求同步重启，同时持续 drain stdout/stderr。
- **来源**：`03-extract-sites-ocr.md`

### APP-14B — 结构为空的 `status:"ok"` 被接受为识别成功

- **严重度 / 置信度**：中 / 已确认
- **位置**：[src/ocr/efapiao.ts:446-471](../src/ocr/efapiao.ts#L446)
- **证据与根因**：provider 只依据顶层 `status:"ok"` 生成 success，不要求票号、销售方、金额、日期、票种或任何可用字段。
- **用户影响**：不支持或损坏的文档会从待处理/失败工作量中消失，却没有可用发票数据，正常重跑还会跳过它。
- **触发/复现**：让服务返回 `{"status":"ok","data":{}}`。
- **修复建议**：按 document type 定义最小有效字段；结构为空或不完整时记录明确的 parse/partial 状态并保留人工复核入口。
- **来源**：`03-extract-sites-ocr.md`

### APP-14C — 中断后已落盘 OCR error 仍会被摘要为 pending

- **严重度 / 置信度**：中 / 已确认
- **位置**：[src/ocr/summary.ts:108-149](../src/ocr/summary.ts#L108)、[src/ocr/runner.ts:250-252](../src/ocr/runner.ts#L250)
- **证据与根因**：结果 error 会立即 append，但默认顺序执行只在末尾 checkpoint pending CSV；摘要只用 success 覆盖 pending 状态，遇到 error 仍沿用旧 pending。
- **用户影响**：取消、崩溃或强退后失败数被低估，UI 声称仍待处理，而下一次运行又可能把它视作已有失败结果而跳过。
- **触发/复现**：在 error result append 后、最终 `writePendingCsv()` 前终止进程，再读取摘要。
- **修复建议**：摘要将 authoritative result 的 success/error 分别映射为 recognized/failed；同时把单项结果和 pending checkpoint 做成可恢复的原子提交。
- **来源**：`03-extract-sites-ocr.md`

### APP-15 — SPA 页面加载可重复执行脚本并提交过期导航

- **严重度 / 置信度**：中 / 强证据
- **位置**：[gui-design/scripts/shell.js:305-347](../gui-design/scripts/shell.js#L305)、[gui-design/pages/config.html:425-510](../gui-design/pages/config.html#L425)
- **证据与根因**：`showPage()` 没有 in-flight promise cache、navigation token 或取消。双击未缓存页可追加两个 `<main>` 并重复执行 inline script；不同页请求可逆序完成。Config 的顶层 lexical state 还可能重复声明。
- **用户影响**：快速导航会落到错误页、重复绑定 listener、破坏 autosave 初始化或污染 history。
- **触发/复现**：延迟一个 `file:` fetch 后快速点击两个未加载页面，或双击 Config。
- **修复建议**：按 page 缓存加载 promise，使用单调 navigation token/AbortController，仅最新请求可 commit；initializer 模块化并保证只执行一次。
- **来源**：`02-electron-integration.md`、`07-motion-animation.md`

### APP-16 — Windows 停止/退出可能遗留 `efapiao serve`

- **严重度 / 置信度**：高 / 需运行时验证
- **位置**：[src/electron/main.ts:1098-1102](../src/electron/main.ts#L1098)、[src/electron/main.ts:1362-1373](../src/electron/main.ts#L1362)、[src/index.ts:831-848](../src/index.ts#L831)、[src/ocr/efapiao.ts:282-301](../src/ocr/efapiao.ts#L282)
- **证据与根因**：Electron 只 kill Node CLI；CLI 依赖 POSIX 风格 SIGTERM handler 停服务。Windows `ChildProcess.kill('SIGTERM')` 不保证执行 JS 清理，服务又被 `unref()`。
- **用户影响**：`efapiao.exe serve` 可占用端口并携带旧配置继续运行，后续 OCR 连接错误服务或启动失败。
- **触发/复现**：Windows service mode 启动后点击停止或退出，再检查进程和端口。
- **修复建议**：使用 kill-on-close Windows Job Object，或按已验证 PID 精确终止整棵进程树并等待退出；app quit 应等待 tracked children 清理。
- **来源**：`02-electron-integration.md`

### APP-17 — “重新识别”先破坏旧结果，再准备新运行

- **严重度 / 置信度**：中 / 已确认
- **位置**：[src/electron/main.ts:371-413](../src/electron/main.ts#L371)、[src/electron/main.ts:1026-1061](../src/electron/main.ts#L1026)、[gui-design/scripts/shell.js:1223-1245](../gui-design/scripts/shell.js#L1223)
- **证据与根因**：确认重跑后先删除 results，再原地改 queue、写 run config、启动 child；后续任一步失败都没有恢复。外部绝对 results path 会被静默跳过删除，但仍 `--force` 追加。
- **用户影响**：重跑未启动就丢旧结果，或外部 CSV 保留并积累重复历史。
- **触发/复现**：配置 dataDir 外的 results CSV；或在删除结果后让 queue/run-config 路径不可写。
- **修复建议**：先准备并校验全部替代物；旧结果移动到备份，原子安装 queue，确认启动/完成后再删除备份，失败则恢复。明确支持或禁止外部路径。
- **来源**：`10-config-reliability.md`

### APP-18A — 损坏的 `state.json` 会永久阻断 fetch/run

- **严重度 / 置信度**：中 / 已确认
- **位置**：[src/state.ts:20-40](../src/state.ts#L20)、[src/index.ts:346-348](../src/index.ts#L346)、[src/index.ts:498-505](../src/index.ts#L498)
- **证据与根因**：无效 JSON 会在 fetch/run 进入恢复逻辑前直接抛错；现有 INDEX、缓存和 invoices 台账没有重建路径，GUI 只提供会同时删除业务数据的 reset。
- **用户影响**：一个派生 metadata 文件被截断或手工改坏后，邮件获取和处理会在每次重试时永久阻塞。
- **触发/复现**：把 `state.json` 截断为无效 JSON 后执行 fetch 或 run。
- **修复建议**：隔离损坏 state 到带时间戳的备份，从 INDEX/缓存/invoices 重建可恢复身份，并提供“仅重建状态”入口。
- **来源**：`10-config-reliability.md`

### APP-18B — 可选 GUI history 写失败会把已完成操作报告为失败

- **严重度 / 置信度**：中 / 已确认
- **位置**：[src/electron/main.ts:876-900](../src/electron/main.ts#L876)、[src/electron/main.ts:949-1095](../src/electron/main.ts#L949)
- **证据与根因**：fetch、pipeline、OCR 和 organize child 成功后，handler 在返回真实结果前同步写 history；该 read-modify-overwrite 失败会 reject 整个 IPC。
- **用户影响**：票据/状态可能已经提交，UI 却显示“运行失败”，诱导用户重跑重复或破坏性操作。
- **触发/复现**：让 `.mfh-cache` 不可写、配置的业务输出目录仍可写，再执行任一操作。
- **修复建议**：history 改为 best-effort 且原子写；失败只返回非致命告警，不得覆盖真实 operation result，并隔离损坏历史文件。
- **来源**：`10-config-reliability.md`

### APP-19 — “应用自动准备浏览器”是无效设置，安装包也不含浏览器

- **严重度 / 置信度**：中 / 已确认
- **位置**：[gui-design/pages/config.html:294-312](../gui-design/pages/config.html#L294)、[src/config.ts:277-280](../src/config.ts#L277)、[src/index.ts:39-55](../src/index.ts#L39)、[package.json:46-59](../package.json#L46)
- **证据与根因**：设置被保存但 `launchBrowser()` 从不读取；桌面始终先找系统 Chrome/Edge，再找 Playwright cache。包配置不携带 Chromium。
- **用户影响**：用户选择“应用自动准备”仍可能在无系统浏览器机器上无法处理第三方开票站点。
- **触发/复现**：打包环境无 Chrome/Edge/Playwright Chromium，选择 app-managed 后处理第三方链接。
- **修复建议**：要么删除该设置并准确说明系统依赖，要么按平台打包浏览器并显式使用其 executable path。
- **来源**：`09-code-health.md`、`12-holistic.md`

### APP-20 — 多处页面标签/筛选与实际数据集不一致

- **严重度 / 置信度**：中 / 已确认
- **位置**：[src/electron/summary.ts:121-143](../src/electron/summary.ts#L121)、[gui-design/scripts/shell.js:715-728](../gui-design/scripts/shell.js#L715)、[gui-design/scripts/shell.js:787-803](../gui-design/scripts/shell.js#L787)、[gui-design/scripts/shell.js:1493-1503](../gui-design/scripts/shell.js#L1493)、[src/electron/main.ts:949-960](../src/electron/main.ts#L949)
- **证据与根因**：“本次抓取”实际展示全量 INDEX 最近行；“已识别”仅排除 `识别失败`，会包含 `待补充/已归档`；主题/正文条件可同时关闭，但 main 又悄悄把 subject 恢复为 true。
- **用户影响**：用户错误判断本次 fetch 是否命中、哪些票已成功识别，以及预览会下载哪些邮件。
- **触发/复现**：已有缓存时执行零新增 fetch；打开含 pending/ignored 的已识别 tab；关闭两个匹配条件再预览并运行。
- **修复建议**：让 run 返回 batch ID/新增行；使用后端枚举定义 status set；backend 的规范化 payload 必须回显到预览和控件状态。
- **来源**：`04-frontend-behavior.md`、`05-ui-copy.md`、`12-holistic.md`

### APP-21 — 重置声称成功，但静默保留配置在 dataDir 外的数据

- **严重度 / 置信度**：中 / 已确认
- **位置**：[gui-design/pages/config.html:101-115](../gui-design/pages/config.html#L101)、[src/electron/main.ts:1321-1354](../src/electron/main.ts#L1321)、[gui-design/scripts/shell.js:1437-1446](../gui-design/scripts/shell.js#L1437)
- **证据与根因**：main 正确限制只删 dataDir 的严格子路径，但返回值没有 `skippedExternal`，UI 仍宣布本地数据已重置。
- **用户影响**：用户可能以为敏感发票已删除，实际外部归档/结果仍保留。
- **触发/复现**：把 invoices/results 配到绝对外部目录后执行重置。
- **修复建议**：保留边界保护；返回并显示跳过路径，称为“仅重置应用管理的数据”。外部清理必须逐路径独立确认。
- **来源**：`10-config-reliability.md`、`12-holistic.md`

### APP-22 — 敏感文件权限和 OCR 临时配置的最小化不足

- **严重度 / 置信度**：中 / 强证据
- **位置**：[src/electron/main.ts:231-246](../src/electron/main.ts#L231)、[src/electron/main.ts:1051-1061](../src/electron/main.ts#L1051)、[src/index.ts:266-303](../src/index.ts#L266)、[src/download/downloader.ts:118-142](../src/download/downloader.ts#L118)、[src/pipeline.ts:160-168](../src/pipeline.ts#L160)
- **证据与根因**：OCR run config 克隆完整配置，包括不相关的 IMAP/LLM secrets；崩溃/强退绕过 finally 后会长期留在可预测 cache 路径。邮件、发票、CSV、staging 使用默认 umask，在常见 POSIX 环境可能为 `0644/0755`。
- **用户影响**：本机其他账号、备份/同步或支持工具可能读取财务文件和残留凭据。
- **触发/复现**：OCR 中强制终止并检查 `ocr-run-config.json`；在共享可遍历父目录和 umask 022 下创建 archive。
- **修复建议**：只生成 OCR 所需最小配置，使用唯一安全临时目录，启动时清理残留并等待退出清理；POSIX 目录 `0700`、敏感文件/临时文件 `0600`，并迁移已管理数据。
- **来源**：`10-config-reliability.md`

### APP-23 — 子进程输出按 chunk 而不是完整行解析，终态进度可丢失

- **严重度 / 置信度**：中 / 已确认
- **位置**：[src/electron/main.ts:757-805](../src/electron/main.ts#L757)
- **证据与根因**：stdout/stderr 各自对每个 chunk 直接 `toString().split(...)`，没有 UTF-8 decoder 或跨 chunk 的 partial-line carry。完整 summary/中文字符可被拆成片段，close 时也不把 carry 交给 parser；同时所有原始 chunk 都被无界保留到子进程结束。
- **用户影响**：任务成功后 OCR/文件进度仍可能不到 100%、最终计数缺失或日志乱码；长运行还会让 Electron 内存随完整输出持续增长。
- **触发/复现**：让 child 分两次写出 `OCR comp` 和 `lete: scanned=...`，或把一个多字节中文字符拆到两个 chunk；终态记录不会被识别。
- **修复建议**：每个 stream 使用独立 `StringDecoder` 和 line carry，只解析完整行并在 close flush；从 exit result 额外发出且只发出一次终态事件，诊断输出仅保留有界 tail/ring buffer。
- **来源**：`02-electron-integration.md`、`09-code-health.md`

---

## 二、过度技术化或内部化的 UI 文案

### COPY-01 — 原始异常、stderr、URL 和本机路径被直接作为默认 UI 文案

- **严重度 / 置信度**：高 / 已确认
- **位置**：[src/electron/main.ts:625-704](../src/electron/main.ts#L625)、[src/electron/main.ts:829-899](../src/electron/main.ts#L829)、[gui-design/scripts/shell.js:1315-1351](../gui-design/scripts/shell.js#L1315)、[gui-design/scripts/shell.js:1517-1535](../gui-design/scripts/shell.js#L1517)
- **证据与根因**：progress、toast、history 和“复制日志”复用 raw stdout/stderr/exception。错误可含英文 config key、绝对路径、邮件 hash、完整签名 URL/token、HTTP/provider code。HTML escaping 只防注入，不提供脱敏或可理解性。
- **用户影响**：普通用户无法行动，且屏幕共享、剪贴板和历史文件会泄漏票据访问 token 和本机身份信息。
- **触发/复现**：任一下载重试、邮箱连接、文件打开、OCR 或 page-load 失败。
- **修复建议**：定义 renderer-safe event contract：稳定 code、简洁中文 message、计数和可选诊断 ID。统一在 log、IPC、history 前去 query/fragment 和 secret 参数；技术详情仅在显式 disclosure 中提供脱敏版本。
- **来源**：`05-ui-copy.md`、`10-config-reliability.md`

### COPY-02 — 云端识别文案没有明确说明发票文件会发送到腾讯云

- **严重度 / 置信度**：高 / 已确认
- **位置**：[gui-design/pages/settings.html:36-91](../gui-design/pages/settings.html#L36)、[gui-design/pages/config.html:221-242](../gui-design/pages/config.html#L221)
- **证据与根因**：现有文案强调密钥在本机和“邮件内容”不上传，却没有直说发票/行程单文件或其渲染内容会被第三方处理；“透传”“本地环境变量”是实现细节，不构成清晰同意。
- **用户影响**：用户可能在不了解财务文档流向的情况下启用云识别。
- **触发/复现**：查看隐私页或填写云凭据。
- **修复建议**：在启用/保存前明确写出“待识别文件会发送到腾讯云，邮件正文不会发送，密钥保存在本设备”，并链接适用隐私条款。
- **来源**：`05-ui-copy.md`

### COPY-03 — 首次安装的示例值会被描述为已配置邮箱

- **严重度 / 置信度**：中 / 已确认
- **位置**：[config.example.json:3-6](../config.example.json#L3)、[src/electron/main.ts:106-110](../src/electron/main.ts#L106)、[gui-design/pages/config.html:29-49](../gui-design/pages/config.html#L29)、[gui-design/scripts/shell.js:928-936](../gui-design/scripts/shell.js#L928)
- **证据与根因**：example 中 `imap.example.com`、`me@example.com` 和 `"***"` 被复制为真实配置；非空 password 使 UI 产生“已配置”状态，HTML 也用真实 value 而不是 placeholder。
- **用户影响**：新用户先看到假成功状态，再收到认证错误，且可能误把示例当自己的已保存设置。
- **触发/复现**：全新 userData 首次启动。
- **修复建议**：首启值为空、示例只放 placeholder；凭据状态只能来自明确设置/连接测试，不用 `"***"` 充当秘密哨兵。
- **来源**：`05-ui-copy.md`

### COPY-04 — “删除本机缓存”严重淡化会删除归档发票的破坏性

- **严重度 / 置信度**：高 / 已确认
- **位置**：[gui-design/pages/config.html:338-344](../gui-design/pages/config.html#L338)、[gui-design/scripts/shell.js:1437-1446](../gui-design/scripts/shell.js#L1437)
- **证据与根因**：按钮像普通 cache cleanup，实际确认中包含邮件、归档发票、待确认、OCR 和历史；成功消息按“位置数”而非用户数据说明。另见 APP-21 的外部路径保留。
- **用户影响**：可能误删不可恢复的财务原件，同时又误以为外部数据也已删除。
- **触发/复现**：Config 底部执行 developer reset。
- **修复建议**：改为“重置应用数据/删除所有本机数据…”，逐项列明且二次确认；成功消息说明实际删除与跳过内容。
- **来源**：`05-ui-copy.md`、`12-holistic.md`

### COPY-05 — 待确认页面直接显示产品设计笔记、hash 和机器 reason

- **严重度 / 置信度**：中 / 已确认
- **位置**：[src/pending/summary.ts:53-110](../src/pending/summary.ts#L53)、[gui-design/scripts/shell.js:888-913](../gui-design/scripts/shell.js#L888)、[gui-design/scripts/shell.js:1551-1563](../gui-design/scripts/shell.js#L1551)
- **证据与根因**：用户可见描述包含“GUI 应提供”“默认保持 manual”“保留 reason”等内部指令；卡片/CSV 暴露 hash 和 `network_retry_failed:GET:<url>` 等机器串。
- **用户影响**：最需要清楚下一步的恢复页反而最难理解，还可能在复制/分享时泄密。
- **触发/复现**：打开任意非空 pending group 或复制其 CSV/reason。
- **修复建议**：machine reason 与用户 action metadata 分离；默认只显示原因分类、结果和下一步，诊断导出使用脱敏 support reference。
- **来源**：`05-ui-copy.md`、`12-holistic.md`

### COPY-06 — 默认设置页暴露大量实现术语，关键校验又不给可操作说明

- **严重度 / 置信度**：中 / 已确认
- **位置**：[gui-design/pages/config.html:29-72](../gui-design/pages/config.html#L29)、[gui-design/pages/config.html:95-183](../gui-design/pages/config.html#L95)、[gui-design/pages/config.html:194-330](../gui-design/pages/config.html#L194)、[gui-design/pages/config.html:440-500](../gui-design/pages/config.html#L440)
- **证据与根因**：普通设置混入 IMAP/TLS、efapiao 拓扑、port/workers/batch、毫秒、config key、BOM、模板 token 和未发布 LLM scaffold；数字失败只说“有数字字段填写非法”，不指出字段/范围。
- **用户影响**：首次设置像编辑配置文件，错误发生时不知道该改哪一项；用户还会误以为 LLM 已经可用。无效的“应用自动准备浏览器”承诺另见 APP-19。
- **触发/复现**：打开 Config 或输入无效数字。
- **修复建议**：默认只保留邮箱、授权码、文件夹、关键词、保存位置和识别/云处理选择；IMAP、命名模板、服务和重试进入高级折叠。错误就地显示字段名、整数范围和用户单位。
- **来源**：`05-ui-copy.md`

### COPY-07A — 搜索文案和 `⌘R` badge 承诺不存在的全局能力

- **严重度 / 置信度**：中 / 已确认
- **位置**：[gui-design/scripts/shell.js:33](../gui-design/scripts/shell.js#L33)、[gui-design/scripts/shell.js:80](../gui-design/scripts/shell.js#L80)、[gui-design/scripts/shell.js:1021-1045](../gui-design/scripts/shell.js#L1021)
- **证据与根因**：“搜索发票或邮件”实际按当前页路由到 inbox 或 library，不是统一搜索；侧栏显示 `⌘R`，但代码只有 `⌘/Ctrl+K` 搜索聚焦 handler。
- **用户影响**：用户在错误数据集里找不到承诺的邮件/发票，也找不到 badge 所示快捷操作。
- **触发/复现**：从非 Inbox 页面搜索邮件，或按 `⌘R` 期待启动/刷新主流程。
- **修复建议**：实现统一结果页或让 placeholder 明确限定当前数据集；移除 `⌘R`，或实现并显示平台正确的快捷键。
- **来源**：`05-ui-copy.md`

### COPY-07B — About 的版本、channel 和识别状态是硬编码产品元数据

- **严重度 / 置信度**：中 / 已确认
- **位置**：[gui-design/pages/settings.html:14-91](../gui-design/pages/settings.html#L14)、[gui-design/scripts/shell.js:68-76](../gui-design/scripts/shell.js#L68)、[package.json:3](../package.json#L3)
- **证据与根因**：已打包应用仍显示“本地预览版/桌面端预览”和硬编码 `v0.1.0`，而 package version 为 `0.0.3`；默认识别引擎又静态显示“已配置”，不读取真实配置。
- **用户影响**：支持截图无法可靠确认安装版本、发布 channel 或 provider 状态，削弱 About 作为诊断与信任界面的作用。
- **触发/复现**：打开任意正式打包版本的侧栏和 About 页，对照 package version 与实际 OCR 配置。
- **修复建议**：从 `app.getVersion()`、构建 channel 和共享配置动态呈现元数据；只有真实启用/配置的 provider 才显示相应状态。
- **来源**：`05-ui-copy.md`、`12-holistic.md`

---

## 三、缺少可用性关键动画或状态反馈

### FB-01 — 长任务进度只有视觉动画，没有可访问的进度/完成状态

- **严重度 / 置信度**：高 / 已确认
- **位置**：[gui-design/pages/dashboard.html:109-130](../gui-design/pages/dashboard.html#L109)、[gui-design/pages/library.html:104-122](../gui-design/pages/library.html#L104)、[gui-design/scripts/shell.js:541-570](../gui-design/scripts/shell.js#L541)
- **证据与根因**：bar、phase、count 和 log 都是普通 `div/span`；只更新 CSS `--p` 和文本，没有 `role="progressbar"`、`aria-valuenow`、`aria-busy` 或持久 live status。
- **用户影响**：屏幕阅读器用户启动 fetch/download/OCR 后无法知道是否开始、进展、失败或完成；禁用按钮像失去响应。
- **触发/复现**：使用辅助技术启动任一长任务。
- **修复建议**：确定进度使用命名 progressbar 和数值；准备阶段用 indeterminate 文本；阶段/终态使用节流的 `aria-live`/`role=status`，错误保留为 `role=alert`。reduced-motion 下停止 shimmer，但保留语义。
- **来源**：`06-layout-usability.md`、`07-motion-animation.md`

### FB-02 — 错误和成功共用短暂 polite toast，关键错误可能来不及读取

- **严重度 / 置信度**：中 / 已确认
- **位置**：[gui-design/scripts/shell.js:1630-1643](../gui-design/scripts/shell.js#L1630)、[gui-design/styles/main.css:956-985](../gui-design/styles/main.css#L956)
- **证据与根因**：所有 toast 都放在 `aria-live=polite`，约 2.6 秒自动删除，无关闭按钮、hover/focus 暂停和页面内持久错误。
- **用户影响**：错误可能排在语音队列后才被删除，低视力/认知障碍用户读不完；许多操作因此没有可复查结果。
- **触发/复现**：连续触发多个 toast 或产生需要操作的错误。
- **修复建议**：普通成功用 status，需处理失败用 alert；提供可访问关闭按钮，聚焦/悬停暂停，关键错误留在相关页面直到解决/关闭。
- **来源**：`07-motion-animation.md`

### FB-03 — 异步导航没有即时 pending 状态，内容提交后也不恢复用户定向

- **严重度 / 置信度**：中 / 强证据
- **位置**：[gui-design/scripts/shell.js:305-347](../gui-design/scripts/shell.js#L305)
- **证据与根因**：未缓存页加载期间旧页保持不变，link 没有 `aria-busy`/loading；完成后只切 DOM，不聚焦新标题、不公告页面。竞态正确性另见 APP-15。
- **用户影响**：慢加载像点击无效，诱发重复点击；键盘/读屏用户不知道页面已经切换。
- **触发/复现**：延迟本地页面 fetch 后用键盘或鼠标导航。
- **修复建议**：立即设置 requested link/current loading 和 content `aria-busy`，延迟显示小型 skeleton/文字；commit 后更新标题、聚焦 page heading 并公告。动画只做短 opacity，尊重 reduced motion。
- **来源**：`06-layout-usability.md`、`07-motion-animation.md`

### FB-04 — 待确认操作整表重绘，项目消失时没有焦点交接或变化提示

- **严重度 / 置信度**：中 / 已确认
- **位置**：[gui-design/scripts/shell.js:842-919](../gui-design/scripts/shell.js#L842)、[gui-design/scripts/shell.js:1463-1487](../gui-design/scripts/shell.js#L1463)
- **证据与根因**：ignore/manual archive 后 `applySummary()` 用 `innerHTML` 替换整个 group mount，焦点按钮随节点消失；展开状态、当前位置和队列变化都不保留。
- **用户影响**：键盘/读屏用户被丢回 document body，视觉用户也会因卡片跳变失去位置。
- **触发/复现**：对 pending row 执行忽略或手动归档。
- **修复建议**：就地更新受影响 row/group；公告结果和剩余数，把焦点移到下一项/上一项/组标题。可对被移除卡片做 150～200ms collapse；reduced-motion 下立即移除但仍交接焦点。
- **来源**：`07-motion-animation.md`

### FB-05 — 实时日志每条事件都强制滚到底部

- **严重度 / 置信度**：中 / 已确认
- **位置**：[gui-design/pages/dashboard.html:383-404](../gui-design/pages/dashboard.html#L383)、[gui-design/scripts/shell.js:528-538](../gui-design/scripts/shell.js#L528)、[gui-design/scripts/shell.js:616-626](../gui-design/scripts/shell.js#L616)
- **证据与根因**：每次 append 都执行 `scrollTop = scrollHeight`，不判断用户是否已离开底部，也没有“跟随最新”开关。
- **用户影响**：查看/复制旧 warning 时不断被拉回，长任务中无法阅读历史输出。
- **触发/复现**：运行任务时向上滚动日志。
- **修复建议**：仅在插入前已接近底部时自动跟随；离开后显示“有新消息/跳到最新”，由用户恢复。reduced-motion 下显式跳转不要 smooth scroll。
- **来源**：`07-motion-animation.md`

---

## 四、不合理、难用或损坏的布局/UI

### UI-01 — 硬编码 6/80/200 条上限使记录和操作永久不可达

- **严重度 / 置信度**：高 / 已确认
- **位置**：[gui-design/scripts/shell.js:740-820](../gui-design/scripts/shell.js#L740)、[gui-design/scripts/shell.js:871-913](../gui-design/scripts/shell.js#L871)、[src/electron/summary.ts:121-143](../src/electron/summary.ts#L121)、[src/electron/summary.ts:185-250](../src/electron/summary.ts#L185)
- **证据与根因**：pending 每组只 render 6 条；inbox/backend 80、library/backend 200 且 renderer 最多 80。没有分页/load more，搜索和 seller filter 只作用于被截断快照。
- **用户影响**：第 7 个待确认项目没有任何 UI 入口；旧邮件/发票无法搜、开、选或处理，页脚却承认还有更多。
- **触发/复现**：同一 pending group 放 7 行，或创建 81+ inbox/library 行。
- **修复建议**：实现 backend pagination/search/sort 和真实 total；pending 必须保证每项可达。Dashboard 预览若保留上限，应明确“前 N 条”并链接完整列表。
- **来源**：`04-frontend-behavior.md`、`06-layout-usability.md`

### UI-02 — 核心 checkbox、accordion 和排序控件是鼠标专用 `div/th`

- **严重度 / 置信度**：高 / 已确认
- **位置**：[gui-design/pages/dashboard.html:84-94](../gui-design/pages/dashboard.html#L84)、[gui-design/pages/config.html:71-127](../gui-design/pages/config.html#L71)、[gui-design/scripts/shell.js:153-215](../gui-design/scripts/shell.js#L153)、[gui-design/scripts/shell.js:904-915](../gui-design/scripts/shell.js#L904)、[gui-design/pages/inbox.html:74-80](../gui-design/pages/inbox.html#L74)
- **证据与根因**：`.check`、`.chip`、pending header、sortable `<th>` 没有 native control、tabindex、键盘 handler、role/state；所有表头还统一显示 pointer hover，即使不可排序。
- **用户影响**：键盘和读屏用户不能修改 TLS/匹配/过滤、展开待确认组或排序；鼠标用户会点击无响应表头。
- **触发/复现**：只用 Tab、Space、Enter 完成 Dashboard/Config/Library/Pending 工作流。
- **修复建议**：使用 native checkbox/button；accordion 同步 `aria-expanded/controls`；只有 sortable header 放 button 并维护 `aria-sort`。
- **来源**：`04-frontend-behavior.md`、`06-layout-usability.md`

### UI-03 — 大量表单控件缺少程序化名称

- **严重度 / 置信度**：高 / 已确认
- **位置**：[gui-design/pages/config.html:29-115](../gui-design/pages/config.html#L29)、[gui-design/pages/dashboard.html:56-60](../gui-design/pages/dashboard.html#L56)、[gui-design/pages/library.html:59-70](../gui-design/pages/library.html#L59)
- **证据与根因**：大量可见 label 没有 `for/id` 关联；seller 和 OCR parallel selector 等控件完全没有 label。
- **用户影响**：读屏和语音控制用户无法可靠辨认、定位或操作邮箱配置、日期、销售方和并行度等关键字段。
- **触发/复现**：使用辅助技术逐字段导航 Config、Dashboard 和 Library 表单，检查每个 control 的 accessible name。
- **修复建议**：所有控件建立真实 `label for/id` 与必要的 `aria-describedby`；相关日期范围用 fieldset/legend 分组，无可见 label 的选择器补充可见或 sr-only label。
- **来源**：`06-layout-usability.md`

### UI-04 — SPA 路由不更新 title、焦点、scroll 或 `aria-current`

- **严重度 / 置信度**：中 / 已确认
- **位置**：[gui-design/scripts/shell.js:299-347](../gui-design/scripts/shell.js#L299)
- **证据与根因**：路由只隐藏/显示 main 和切 class/pushState；焦点留在 sidebar，document title 不同步，active link 无 `aria-current`，也没有滚动策略。
- **用户影响**：读屏不知道目的地变化；键盘用户每次都需重新穿过 shell，窗口标题可能仍描述旧页。
- **触发/复现**：键盘激活侧栏链接后检查焦点和标题。
- **修复建议**：成功导航时设置 title/aria-current，聚焦 `tabindex=-1` 的页面标题/main，并统一新页滚到顶部或恢复策略。
- **来源**：`06-layout-usability.md`

### UI-05 — 浅色主题的次要/状态文字对比度不足

- **严重度 / 置信度**：中 / 已确认
- **位置**：[gui-design/styles/main.css:22-43](../gui-design/styles/main.css#L22)、[gui-design/styles/main.css:649-735](../gui-design/styles/main.css#L649)
- **证据与根因**：`--fg-faint #9aa1ab` 在白底约 2.61:1；green/amber 状态文字约 3.3:1，且用于 10.5～11px 普通文字，低于 4.5:1。
- **用户影响**：低视力用户难读 metadata 和关键成功/警告状态。
- **触发/复现**：默认浅色主题测量相应前景/背景。
- **修复建议**：分离装饰色和文字色 token，确保两主题中普通文字至少 4.5:1，并纳入自动对比度检查。
- **来源**：`06-layout-usability.md`

### UI-06 — Config 保存/校验状态远离编辑字段且只靠颜色

- **严重度 / 置信度**：中 / 已确认
- **位置**：[gui-design/pages/config.html:333-336](../gui-design/pages/config.html#L333)、[gui-design/pages/config.html:440-500](../gui-design/pages/config.html#L440)
- **证据与根因**：长页面唯一 save pill 在最底部；无效字段只有红 class，通用说明也在底部，没有 `aria-invalid`、字段 error、summary link 或聚焦。
- **用户影响**：编辑顶部 port/account 时看不到是否保存；一个错误可阻止全部 autosave，却像静默丢改动。
- **触发/复现**：停留页面顶部输入非法 port，不向下滚。
- **修复建议**：使用 sticky save status；错误紧邻字段、带 `aria-invalid/describedby`，顶部 error summary 链到首个错误。若 autosave 无法明确保证状态，改显式保存。
- **来源**：`06-layout-usability.md`

### UI-07 — 窄窗口表格的横向滚动条位于最多 80 行之后

- **严重度 / 置信度**：中 / 强证据
- **位置**：[gui-design/styles/main.css:744-749](../gui-design/styles/main.css#L744)、[gui-design/styles/main.css:1142-1160](../gui-design/styles/main.css#L1142)、[gui-design/scripts/shell.js:758-808](../gui-design/scripts/shell.js#L758)
- **证据与根因**：`<=980px` 表格 min-width 760px，wrapper 可横滚但不限高；滚动条只在长表底部，重要 status/action 在最右。
- **用户影响**：查看第一行右侧字段要先滚过几十行到底、横移、再返回顶部。
- **触发/复现**：窄窗口加载 80 行 inbox/library。
- **修复建议**：窄屏优先隐藏次要列并提供 row details；若保留横滚，使用局部有界容器、sticky header 和可就近访问的 scrollbar。
- **来源**：`06-layout-usability.md`

### UI-08A — Library 提供两个语义相同的失败筛选

- **严重度 / 置信度**：中 / 已确认
- **位置**：[gui-design/pages/library.html:53-66](../gui-design/pages/library.html#L53)、[gui-design/scripts/shell.js:799-803](../gui-design/scripts/shell.js#L799)
- **证据与根因**：“失败”tab 和“仅失败项”custom checkbox 都执行同一个 `status === "识别失败"` 谓词，却维护两个独立视觉状态。
- **用户影响**：用户必须猜测两个控件是否不同、是否要同时启用，以及清除其中一个会发生什么。
- **触发/复现**：在混合结果上分别启用两个 failed control，再同时启用；结果集始终相同。
- **修复建议**：只保留一个失败筛选；若确需第二个跨维度 toggle，必须定义不同谓词和清晰标签。
- **来源**：`06-layout-usability.md`

### UI-08B — 点击表格行会产生没有消费方的选择状态

- **严重度 / 置信度**：中 / 已确认
- **位置**：[gui-design/scripts/shell.js:249-254](../gui-design/scripts/shell.js#L249)
- **证据与根因**：任意 table body row 点击后获得持久 `is-selected` 高亮，但没有操作读取该状态，行也没有焦点或选择语义。
- **用户影响**：界面暗示记录已被选中、打开或排队，实际既无详情、批量动作，也无键盘等价路径。
- **触发/复现**：点击任意数据行的非操作区域，再尝试 Enter、Space 或邻近 action。
- **修复建议**：只读表格删除持久高亮；若选择是产品需求，使用 native checkbox 或显式可聚焦的详情动作，并提供真正消费 selection 的操作。
- **来源**：`06-layout-usability.md`

### UI-08C — Pending 零队列状态仍显示警告和无意义动作

- **严重度 / 置信度**：中 / 已确认
- **位置**：[gui-design/pages/pending.html:31-60](../gui-design/pages/pending.html#L31)
- **证据与根因**：pending 为空时，页面同时显示“暂无待确认邮件”和“这些邮件大多是……”警告；复制/刷新等面向现有队列的动作仍可见。
- **用户影响**：首次用户会怀疑存在隐藏失败，空状态也提供无数据可操作的 affordance。
- **触发/复现**：以 `pending.groups=[]` 打开 Pending。
- **修复建议**：仅在有记录且与实际 group 组成相符时显示警告；真实空队列只保留一个一致的成功/空状态，并隐藏或禁用无数据动作。
- **来源**：`06-layout-usability.md`

---

## 五、代码异味、测试腐化、死代码和开发残留

### CODE-01 — npm 和发布 CI 没有任何测试门禁

- **严重度 / 置信度**：高 / 已确认
- **位置**：[package.json:11-20](../package.json#L11)、[.github/workflows/release.yml:42-49](../.github/workflows/release.yml#L42)
- **证据与根因**：没有 `test` script；release 只 install/typecheck 后打包，五个 `.mjs` 脚本没有被 package、CI 或 README 的权威入口调用。`npm test --if-present` 因无脚本返回 0。
- **用户影响**：renderer、preload、CLI、Electron 和安装包回归均可在绿色 workflow 下发布。
- **触发/复现**：运行 `npm test` 或检查 release workflow。
- **修复建议**：提供确定性的 unit/integration/browser/electron 脚本和 aggregate `test`；PR 与 release 都必须执行，缺运行时前置条件应快速明确失败。
- **来源**：`08-test-decay.md`、`09-code-health.md`、`12-holistic.md`

### CODE-02 — 现有测试含明确假阳性，并把 fake IPC 流程称为 full-flow

- **严重度 / 置信度**：高 / 已确认
- **位置**：[gui-design/tests/e2e-fixes.mjs:146-211](../gui-design/tests/e2e-fixes.mjs#L146)、[gui-design/tests/e2e.mjs:48-50](../gui-design/tests/e2e.mjs#L48)、[gui-design/tests/electron-full-flow.mjs:10-19](../gui-design/tests/electron-full-flow.mjs#L10)、[gui-design/tests/electron-full-flow.mjs:62-70](../gui-design/tests/electron-full-flow.mjs#L62)、[gui-design/tests/cli-regression.mjs:97-161](../gui-design/tests/cli-regression.mjs#L97)
- **证据与根因**：M1 conditional 是空体，M5 不断言重新启用；text helper 可命中隐藏/旧 SPA 文本；“full-flow”设置 `MFH_E2E_FAKE_CLI=1`，绕过真实 spawn/CLI/提取/OCR；CLI 直接使用可能缺失或过期的 ignored `dist`，两项回归只做弱的非空/不存在断言。
- **用户影响**：具名回归可在功能坏掉时继续绿色，测试名称夸大覆盖范围。
- **触发/复现**：破坏对应真实 CLI 或 re-enable 行为，保留 fake/旧文本，断言仍可能通过。
- **修复建议**：删除 no-op/弱断言；只在 active main 上做可见性和新事件断言；测试命令先构建新输出；fake suite 改名为 renderer/IPC fixture，并新增真实 compiled CLI 集成。
- **来源**：`08-test-decay.md`

### CODE-03 — 测试基础设施依赖固定时间、绝对耗时和不安全资源清理

- **严重度 / 置信度**：中 / 已确认
- **位置**：[gui-design/tests/cli-regression.mjs:271-307](../gui-design/tests/cli-regression.mjs#L271)、[gui-design/tests/electron-full-flow.mjs:107-108](../gui-design/tests/electron-full-flow.mjs#L107)、[gui-design/tests/e2e.mjs:53-57](../gui-design/tests/e2e.mjs#L53)、[gui-design/tests/e2e-fixes.mjs:34-37](../gui-design/tests/e2e-fixes.mjs#L34)
- **证据与根因**：并发测试把 Node 启动/import/I/O 全塞进 900ms；Electron 测试硬编码 2026-05-18～21 却不冻结时钟；browser launch 在 `try/finally` 外，缺 Chromium 时 server 留存；临时目录和 Electron child 也没有稳健嵌套清理/timeout。
- **用户影响**：正确代码会红，前置失败会挂住 CI 并污染 `/tmp`，促使团队忽略测试。
- **触发/复现**：让 Chromium launch 在 server 启动后失败；在慢环境运行 CLI concurrency；或在硬编码日期窗口之外运行 full-flow。
- **修复建议**：进程内记录最大并发或做同环境比率；冻结 clock/timezone；所有资源在 guarded scope 获取并嵌套清理，设置 suite/launch timeout 和进程树终止。
- **来源**：`08-test-decay.md`、`12-holistic.md`

### CODE-04 — 数据破坏性的 fake backend 和测试探针被编译进生产主进程

- **严重度 / 置信度**：高 / 已确认
- **位置**：[src/electron/main.ts:271-288](../src/electron/main.ts#L271)、[src/electron/main.ts:415-495](../src/electron/main.ts#L415)、[src/electron/main.ts:720-745](../src/electron/main.ts#L720)、[package.json:46-50](../package.json#L46)
- **证据与根因**：约 225 行 `fakeFetch/fakePipeline/fakeOcr` 由继承环境变量 `MFH_E2E_FAKE_CLI=1` 激活，并按真实配置路径无条件覆盖 INDEX、OCR CSV、pending 和 PDF；测试 globals 通过 `executeJavaScript` 注入，测试程序本身也被打包。
- **用户影响**：正式应用若继承该变量会停止真实工作并覆盖真实票据索引/结果；生产审计面显著扩大。
- **触发/复现**：带该环境变量启动正式包并执行工作流。
- **修复建议**：使用专用测试入口或从 harness 注入 command runner；生产 bundle 不得含可由环境变量切换的数据生成 backend、测试 globals 和 `gui-design/tests/**`。
- **来源**：`08-test-decay.md`、`09-code-health.md`

### CODE-05A — 发布物缺少平台签名和 notarization

- **严重度 / 置信度**：高 / 强证据
- **位置**：[package.json:61-64](../package.json#L61)、[.github/workflows/release.yml:48-52](../.github/workflows/release.yml#L48)、[README.md:56-75](../README.md#L56)
- **证据与根因**：mac identity 明确为 null，CI 禁止证书发现；专项 macOS 构建 strict signature verify 失败，Windows 也未配置 Authenticode。
- **用户影响**：Gatekeeper/SmartScreen 会阻止或警告正常安装；README 还引导用户递归移除 quarantine，削弱发布信任和受管设备可部署性。
- **触发/复现**：在干净 macOS 打开 CI DMG/ZIP 或运行 strict codesign verify；在启用 SmartScreen 的 Windows 打开 installer。
- **修复建议**：签名嵌套 OCR binary 和应用，启用 hardened runtime、notarize/staple；Windows installer/executable 使用 Authenticode。完成前明确标记为 unsigned development build。
- **来源**：`11-packaging-runtime.md`

### CODE-05B — 手动发布可把当前 run SHA 的二进制附到任意输入 tag

- **严重度 / 置信度**：中 / 已确认
- **位置**：[.github/workflows/release.yml:7-12](../.github/workflows/release.yml#L7)、[.github/workflows/release.yml:32-35](../.github/workflows/release.yml#L32)、[.github/workflows/release.yml:71-96](../.github/workflows/release.yml#L71)、[package.json:3](../package.json#L3)
- **证据与根因**：`workflow_dispatch` 接收任意 tag，但 build checkout 不设置该 ref；release 再以输入 tag 发布当前 run SHA 的 artifact，也不校验 tag semver 与 package version。
- **用户影响**：二进制可能无法映射到标称源码 commit/版本，用户和事故响应者无法可靠复现或审计发布物。
- **触发/复现**：从 `main` dispatch 一个指向其他 commit、或版本与 package 不同的 tag。
- **修复建议**：build 前解析和验证已存在的不可变 tag，各 matrix job checkout 同一精确 ref；强制 tag semver 等于 package version，并把 resolved commit 贯穿到发布步骤。
- **来源**：`11-packaging-runtime.md`

### CODE-06 — 每个平台包都携带异平台 OCR binary

- **严重度 / 置信度**：中 / 已确认
- **位置**：[package.json:54-59](../package.json#L54)、[vendor/efapiao/0.1.3/darwin-arm64/README.txt](../vendor/efapiao/0.1.3/darwin-arm64/README.txt)、[vendor/efapiao/0.1.3/windows-x86_64/README.txt](../vendor/efapiao/0.1.3/windows-x86_64/README.txt)
- **证据与根因**：top-level `extraResources` 为每个 target 复制整个 vendor tree；mac 包实测同时含约 18MB Mach-O 和 19MB PE，Windows 包同理携带异平台 executable。
- **用户影响**：每个下载多约 18～19MB 无用 executable，增加下载、磁盘、发布上传和杀毒扫描成本。
- **触发/复现**：`electron-builder --dir` 后查看 resources/ASAR。
- **修复建议**：使用平台/架构特定 `extraResources` filter 或 staging，只携带 `${platform}-${arch}` 对应 binary；CI 拒绝每个包中的异平台 executable format。
- **来源**：`09-code-health.md`、`11-packaging-runtime.md`

### CODE-07 — state 按每封邮件同步全量重写，规模增长后呈二次成本

- **严重度 / 置信度**：中 / 已确认
- **位置**：[src/index.ts:358-393](../src/index.ts#L358)、[src/index.ts:498-590](../src/index.ts#L498)、[src/pipeline.ts:297-418](../src/pipeline.ts#L297)、[src/state.ts:43-49](../src/state.ts#L43)
- **证据与根因**：每次保存都把 Set/array 全量复制、用线性 `includes`、pretty-print 并同步改写完整 state；concurrency worker 还反复合并完整数组。
- **用户影响**：邮件历史越大，累计复制/序列化趋近 O(n²)，event loop 花在状态 I/O 而非提取，放大卡顿和竞态窗口。
- **触发/复现**：在大历史上持续 fetch/run 并观察每封 commit 耗时。
- **修复建议**：封装 Set-backed state store，使用 append journal 或有界批量 checkpoint，命令结束/fatal 时显式 flush，并在锁内 compact。
- **来源**：`09-code-health.md`

### CODE-08 — 无效配置字段、空 feature 模块和未发布 LLM scaffold 仍占据生产契约

- **严重度 / 置信度**：中 / 已确认
- **位置**：[src/config.ts:194-203](../src/config.ts#L194)、[src/config.ts:269-274](../src/config.ts#L269)、[src/config.ts:309-311](../src/config.ts#L309)、[src/extract/manual.ts:1](../src/extract/manual.ts#L1)、[src/extract/llm.ts:1](../src/extract/llm.ts#L1)、[src/electron/main.ts:1327-1350](../src/electron/main.ts#L1327)
- **证据与根因**：`output.dir/pendingDir` 已不控制正常输出却仍为必需字段，实际主要出现在 destructive reset；`manual.ts/llm.ts` 只 `export {}` 且未导入；LLM 对象仍为必需并有 UI/脱敏 plumbing，但 loader 明确拒绝 `enabled=true`。
- **用户影响**：升级配置被无用字段卡住，用户编辑不生效路径；源码和 UI 暗示不存在的扩展点，增加维护和误删风险。
- **触发/复现**：删除旧 config 中两个 output 字段；尝试启用 LLM；搜索模块 call site。
- **修复建议**：迁移后移除 legacy output 字段；删除空模块和未发布 schema/UI，或实现真实 provider interface；启用 `noUnusedLocals/noUnusedParameters` 作为 CI 门禁。
- **来源**：`09-code-health.md`、`10-config-reliability.md`

---

## 结论

当前实现具备清晰的本地优先方向，且 TypeScript 能通过编译检查；但“文件落盘、元数据提交、状态提交”和“多个操作/实例之间的互斥”尚未形成可靠边界。最高风险不是单一 UI 瑕疵，而是静默漏票、错误地提交已处理状态、重试产生孤儿/重复文件，以及 UI 对实际运行状态和数据集给出不真实反馈。

建议不要以逐个按钮或逐条异常补丁的方式处理最高优先级问题。先建立三个共享基础设施：**可组合的 artifact 批处理结果、事务化归档/队列 store、带 job ID 的全局操作协调器**。随后统一配置 schema、票据身份和 renderer-safe 事件契约，才能避免同类问题在 CLI、Electron 和 UI 三层反复出现。

本报告仅记录审查发现；除新增本文件外，没有宣称对应用代码实施任何修复。
