# 实施进度

> 与 `NEXT_STEPS.md` 的阶段对齐。每完成一项打勾,附完成日期与关键产物。

## Phase 0 — 脚手架  [完成 2026-05-20]

- [x] `npm init` / TypeScript 配置 (`package.json`, `tsconfig.json`,strict + noUncheckedIndexedAccess)
- [x] 依赖落定: `imapflow`, `mailparser`, `@types/mailparser`
- [x] 目录骨架按 `DESIGN.md §4` 建好,非本轮范围文件仍为 `export {};`
- [x] `src/config.ts`: 加载 + 字段级校验 (`config.imap.host is required` 风格)
- [x] `src/state.ts`: 唯一 state.json 读写者,`tmp + rename` 原子写
- [x] `src/log.ts`: 三级日志
- [x] CLI 入口 (`src/index.ts`): `mfh --help` / `mfh fetch --help` / 未知命令 exit 2
- [ ] `mfh run` 子命令 (Phase 3 之后才落地)
- [x] `mfh pending list` 子命令 (2026-05-20: 读取 pending.csv,按网络失败/普通 manual 分组展示)
- [x] lint: 跳过 eslint,依赖 `tsc strict` (已与用户对齐)

## Phase 1 — 邮件抓取  [完成 2026-05-20]

- [x] `src/util/hash.ts`: `msgIdHash = sha1(messageId || from|date|subject).slice(0,12)` (架构 §3 / R1)
- [x] `src/mail/fetcher.ts`: IMAP 连接 + SEARCH (SUBJECT/BODY 含关键词,SINCE N 天,多关键词 OR 嵌套) + simpleParser 解析,产出 `RawMail` 异步迭代器
- [x] `mfh fetch` 子命令
  - [x] 命中邮件落到 `samples/raw/<YYYY-MM(UTC)>/<msgIdHash>.eml`
  - [x] `.eml` 通过 `tmp + rename` 原子写;目标存在时跳过
  - [x] `samples/raw/INDEX.csv` 追加 `messageId,date,from,subject,hasAttachment,bodyLinkCount`,首次写 UTF-8 BOM + 表头
  - [x] INDEX.csv 追加前以 messageId 查重 (R3 幂等点)
  - [x] state.json 新增字段 `fetchedHashes: string[]`,每封邮件落盘后立刻 `saveState` (粒度=单封)
  - [x] `--dry-run` 只打印不写盘
  - [x] `--since-days <n>` 覆盖 config
  - [x] `--since <date>` / `--until <date>` 显式日期段 (YYYY-MM-DD / ISO 8601),`--until` 含当日
  - [x] `--config` / `--state` / `--out` 可覆盖默认路径

## Phase 1.1 — 日期段过滤  [完成 2026-05-20]

- [x] `config.filter.since` / `config.filter.until` (可选,字符串或 `null`)
- [x] config 校验: 解析失败报错、`since > until` 报错
- [x] `resolveDateWindow(cfg)` 统一计算 `{ since, before }`;`before = until + 1day` 让 `--until` 包含当日
- [x] CLI: `--since` / `--until` 优先级高于 `--since-days` 与 config 字段
- [x] **服务端只下 `since`,`before` 一律客户端过滤**:实测 QQ IMAP 在 `or:` 与 `before:` 同时出现时静默返回 0;仅 `since` 工作正常。客户端 header 日期二次过滤已覆盖上界
- [x] 修复 imapflow `client.fetch()` 调用参数:`{uid:true}` 必须传第 3 个 `options` 而非合并进 `query`,否则 UID 数组被当作 seq 号,静默命中 0

## Phase 1 端到端验证  [2026-05-20 用真实 QQ 邮箱]

- `imap.qq.com:993` 登录成功 (`config.json` 不入 git, 已在 `.gitignore`)
- `mfh fetch --since 2026-03-20 --until 2026-05-20` (2 个月窗口)
  - 服务端 SEARCH 命中 ~106,客户端 header 二次过滤剔除 1
  - seen=105, saved=105, 全部落 `samples/raw/<YYYY-MM>/<hash>.eml`
  - 按月分桶:2026-03 = 22, 2026-04 = 61, 2026-05 = 22
  - `samples/raw/INDEX.csv` = 1 header + 105 行
  - `state.json fetchedHashes` 同步增长到 105
- 复跑增量幂等:同窗口第二次执行 seen=105, saved=0, skippedKnown=105

## Phase 1 验证记录  [2026-05-20]

- `npm run typecheck` → 0 errors
- `npm run build` → 0 errors
- `node dist/index.js --help` → exit 0,列出 fetch 子命令
- `node dist/index.js` (无参) → 打印 usage,exit 1
- `node dist/index.js bogus` → "unknown command" + usage,exit 2
- `node dist/index.js fetch --help` → exit 0
- `node dist/index.js fetch --unknown` → 错误提示 + fetch usage,exit 2
- `node dist/index.js fetch --since-days foo` → 错误提示 + fetch usage,exit 2
- `node dist/index.js fetch --since notadate` → `--since="notadate" is not a parseable date`,exit 2
- `node dist/index.js fetch --since 2025-01-01 --until 2024-01-01` → `--since must be <= --until`,exit 2
- `node dist/index.js fetch --until 2025-13-99` → 错误提示,exit 2
- `node dist/index.js fetch --config /tmp/nope.json` → 配置缺失 ENOENT,exit 2
- config 字段级校验负例: `{}` → `config.imap.host is required`;`matchSubject=matchBody=false` → 明确报错
- config since/until 校验: `since="hello"` → 解析报错;`since > until` → 区间报错
- `resolveDateWindow` 单元自测 (now=2026-05-20):
  - `sinceDays=30` → since = 30 天前, before = undefined
  - `since=2026-01-01` → since 精确, before = undefined
  - `since=2026-01-01 until=2026-03-31` → before = 2026-04-01 (含 3-31 当日)
  - `until=2026-04-30` 单独 → since 仍走 sinceDays, before = 2026-05-01
- state 往返: `loadState` → `saveState` → `loadState` 字段完整 (`processedHashes`, `fetchedHashes`)
- 在真实邮箱跑 `mfh fetch`: **待用户执行**

## 未解决 / 待用户确认

1. 月份分桶按 UTC (`getUTCFullYear/getUTCMonth`)。若需本地时区改 `getFullYear/getMonth`。
2. fetcher 向 imapflow 传 `logger: false`。如需 IMAP 协议层调试,改为接入 `log`。
3. `package.json bin.mfh` 指向 `./dist/index.js`,shebang 已写;暂未加 postbuild `chmod +x`,通过 `npm link` / `npx mfh` 触发即可。
4. `docs/CODING_AGENT_PROMPT.md` 在 `git status` 显示已修改(非本轮代码改动,疑似 IDE 保存)。未回滚。

## Phase 2 — 样本聚类  [完成 2026-05-20]

- [x] 读取 `samples/raw/INDEX.csv` (105 封邮件)
- [x] 按发票投递模式分类 (attachment / directLink / thirdParty)
- [x] 统计发件人分布、识别高频 sender
- [x] 产出 `docs/SAMPLE_ANALYSIS.md` 分析报告
- [x] 确定 Phase 3 实施优先级:
  - Priority 1: 附件提取器 (59% 覆盖率)
  - Priority 2: 第三方平台检测 (37% 覆盖率)
  - Priority 3: 直链提取器 (2% 覆盖率)

## Phase 3 — 附件提取器  [完成 2026-05-20]

- [x] `src/extract/types.ts`: 定义 `Extractor` 接口、`ExtractResult` 联合类型、`PdfArtifact` 结构、`Ctx` 上下文
- [x] `src/extract/attachment.ts`: 附件提取器实现
  - [x] 过滤 `contentType === 'application/pdf'` 或 `.pdf` 扩展名
  - [x] ZIP 文件支持: 使用 `adm-zip` 解压并提取内部 PDF
  - [x] 成功提取 62 封邮件 → 127 个 PDF (包含通行费发票 ZIP 场景)
- [x] `src/extract/registry.ts`: 提取器注册表,顺序匹配 `canHandle()`
- [x] `src/pipeline.ts`: 主处理流程
  - [x] `processMail()`: 单封邮件处理 (提取 → 下载 → CSV → 状态提交)
  - [x] 幂等性: `state.processedHashes` 去重
  - [x] 失败降级: 无匹配或异常时写入 `pending/` 队列
  - [x] `pending.csv` 记录 reason 字段 (no_extractor / extractor_name:error)
- [x] `src/download/downloader.ts`: PDF 下载与冲突解决
  - [x] Staging 目录: `.staging/<msgIdHash>/`
  - [x] 冲突解决: 文件名重复时追加 `-1`, `-2` 后缀
  - [x] 原子重命名: staging → 最终目录
- [x] `src/index.ts`: 新增 `mfh run` 子命令
  - [x] 递归遍历 `samples/raw/` 所有 `.eml` 文件
  - [x] 调用 `processMail()` 处理每封邮件
  - [x] `--config` / `--state` 参数支持
- [x] `invoices/invoices.csv`: 成功提取记录 (messageId, date, from, subject, filename, source)
- [x] `pending/pending.csv`: 待处理队列 (messageId, date, from, subject, reason)
- [x] 端到端验证: 62/105 邮件成功提取 (59% 覆盖率)

## Phase 4 — 直链提取器  [完成 2026-05-20]

- [x] `src/extract/directLink.ts`: 直链提取器实现
  - [x] `extractLinksFromHtml()`: 从 HTML 提取 `href` 属性
  - [x] `extractLinksFromText()`: 从纯文本提取 URL (正则 `https?://...`)
  - [x] `isPdfUrl()`: 检查 URL 路径是否以 `.pdf` 结尾
  - [x] `probePdfContentType()`: HEAD 请求检查 `Content-Type: application/pdf`
  - [x] `downloadPdf()`: 下载 PDF 二进制数据
  - [x] `suggestFilename()`: 从 URL 路径提取文件名
  - [x] 成功提取 16 封邮件 → 16 个 PDF
- [x] 更新 `src/extract/registry.ts`: 添加 `directLinkExtractor`
- [x] 端到端验证: 16/105 邮件成功提取 (15% 覆盖率)

## Phase 3 & 4 总结  [2026-05-20]

**总体覆盖率**: 78/105 邮件 (74%), 143 个 PDF 成功提取

**提取结果分布**:
- Attachment Extractor: 62 邮件 → 127 PDFs
- Direct Link Extractor: 16 邮件 → 16 PDFs
- Pending Queue: 27 邮件待处理

**Pending 队列分析** (27 封邮件):
1. 诺诺网 (Nuonuo): 12 封 - `directLink:no_pdf_links`
2. 兴业银行信用卡: 2 封 - `directLink:no_pdf_links`
3. 建设银行信用卡: 2 封 - `directLink:no_pdf_links`
4. 百望云 (Baiwang): 2 封 - `directLink:no_pdf_links`
5. 平安产险: 2 封 - `directLink:no_pdf_links`
6. 12306: 2 封 - `directLink:no_pdf_links`
7. JD.com: 2 封 - `directLink:download_failed` (链接过期)
8. 其他: 3 封 (阿里发票平台, no_extractor)

**重要发现**:
- 通行费发票 (service@invoice.txffp.com) 已全部成功提取,通过 attachment extractor 的 ZIP 处理逻辑
- 所有通行费发票在 `invoices.csv` 中,不在 pending 队列

**Git 提交**: 
- Commit: `06ecb3b`
- Message: "feat(extract): Phase 3 & 4 - attachment + directLink extractors"

## Phase 5 — 第三方站点处理器: 诺诺网  [完成 2026-05-20]

- [x] `src/sites/types.ts`: `SiteHandler` 签名对齐架构 (`Page`, `url`, `ctx`)
- [x] `src/sites/nuonuo.ts`: 诺诺网 handler
  - [x] 匹配 `nnfp.jss.com.cn` / `nnfp.nuonuo.com`
  - [x] 短链解析到 `scan-invoice/printQrcode`
  - [x] 调用 `/scan2/getIvcDetailShow.do` 获取 PDF URL
  - [x] 下载 PDF,按发票号码建议文件名
- [x] `src/sites/registry.ts`: 站点注册表,数组 `push`
- [x] `src/extract/thirdParty.ts`: 第三方链接调度 SiteHandler
- [x] `src/extract/directLink.ts`: 已知 SiteHandler 链接让位给 thirdParty
- [x] `src/index.ts` / `src/pipeline.ts`: `ctx.browser()` 懒启动,CLI 退出统一关闭
- [x] `mfh run --only-mail <msgIdHash>`: 支持对已处理样本定向回归
- [x] 代表样本验证:
  - `samples/by-type/nuonuo/nuonuo-01.eml` → `26312000001898721121.pdf`
  - `samples/by-type/nuonuo/nuonuo-02.eml` → `26312000001833364216.pdf`

## Phase 5 验证记录  [2026-05-20]

- `npm run typecheck` → 0 errors
- `npm run build` → 0 errors
- `node dist/index.js --help` → exit 0
- `node dist/index.js run --help` → exit 0,列出 `--only-mail`
- `node dist/index.js run --config /tmp/mfh-nuonuo-config.json --state /tmp/mfh-nuonuo-state.json --only-mail 53a93fd33bea`
  - Matched extractor: `thirdParty`
  - 输出 `/tmp/mfh-nuonuo-invoices/26312000001898721121.pdf`
  - `invoices.csv` 写入 1 行

## Phase 5 — 第三方站点处理器: 淘宝 / 京东 / 客如云  [完成 2026-05-20]

- [x] `src/sites/common.ts`: 站点 handler 共享的链接清理、HTTP 下载、ZIP 取 PDF、文件名清理
- [x] `src/sites/taobao.ts`: 阿里发票平台邮件下载 ZIP 并提取 PDF
- [x] `src/sites/jd.ts`: 京东邮件中的 jdcloud-oss PDF 下载
- [x] `src/sites/keruyun.ts`: 客如云短链跳转 PDF 下载
- [x] `src/sites/registry.ts`: 追加 3 个 handler,继续数组 `push`
- [x] `src/extract/directLink.ts` / `src/extract/thirdParty.ts`: 链接归一化 (`&amp;`, `&nbsp;`) 并支持 HTML 正文里的裸 URL

## Phase 5 三站点验证记录  [2026-05-20]

- `npm run typecheck` → 0 errors
- `npm run build` → 0 errors
- `node dist/index.js run --config /tmp/mfh-three-sites-config.json --state /tmp/mfh-three-sites-state.json --only-mail c596dd61ac4e`
  - Matched extractor: `thirdParty`
  - 输出 `_26322000001682871661_洛洛小仙2018.pdf`
- `node dist/index.js run --config /tmp/mfh-three-sites-config.json --state /tmp/mfh-three-sites-state.json --only-mail c5775ba27e3b`
  - Matched extractor: `thirdParty`
  - 输出 `digital_26317000001678029323.pdf`
- `node dist/index.js run --config /tmp/mfh-three-sites-config.json --state /tmp/mfh-three-sites-state.json --only-mail c62f80fa6cd5`
  - Matched extractor: `thirdParty`
  - 输出 `keruyun-invoice.pdf`
- `file /tmp/mfh-three-sites-invoices/*.pdf` → 3 个文件均为 `PDF document, version 1.7, 1 pages`

## Phase 5 — 剩余第三方站点处理器  [完成 2026-05-20]

- [x] `src/sites/baiwang.ts`: 百望云 `previewInvoiceAllEle` 链接转 PDF 下载接口
- [x] `src/sites/pingan.ts`: 平安产险邮件入口解析 `invoiceUrl` / `q` token 后下载 PDF
- [x] `src/sites/taxPreview.ts`: `fp.zjaphp.com` 税控预览页转下载 PDF
- [x] `src/sites/nuonuo.ts`: 修正二维码图片辅助链接误命中,所有诺诺样本恢复自动下载
- [x] `src/extract/directLink.ts` / `src/extract/thirdParty.ts`: 单封邮件内按 PDF 内容去重;正文裸链接不把单引号当作 URL 一部分
- [x] `src/sites/registry.ts`: 继续显式 import + `handlers.push(...)`,无自动发现

## Phase 5 剩余站点验证记录  [2026-05-20]

- `npm run typecheck` → 0 errors
- `npm run build` → 0 errors
- `node dist/index.js --help` → exit 0
- `node dist/index.js run --help` → exit 0,列出 `--only-mail`
- 代表样本验证:
  - 百望云 `175ea52ebc88` → `dzfp_26317000000960428781_浙江捷发科技股份有限公司_20260411213227.pdf`
  - 百望云 `78797027a322` → `dzfp_26332000003640263706_浙江捷发科技股份有限公司_20260501192129.pdf`
  - 平安产险 `35ab84975a48` → `26337000000454161517.pdf` (去重后 1 PDF)
  - 平安产险 `891b3e1bc8e8` → `26337000000454161518.pdf` (去重后 1 PDF)
  - 税控预览 `f3c5191f7657` → `26932000000654893236.pdf`
  - 诺诺网 `53a93fd33bea` → `26312000001898721121.pdf`
- 全量样本回归: `node dist/index.js run --config /tmp/mfh-final-pass-config.json --state /tmp/mfh-final-pass-state.json`
  - `Run complete: processed=105, skipped=0`
  - 输出 PDF: 166 个
  - Pending: 6 封,均为兴业/建行信用卡账单或 12306 支付/改签通知,无可样本驱动开发的发票第三方站点

## Phase 5.1 — 非发票邮件排除  [完成 2026-05-20]

- [x] `src/mail/exclude.ts`: 识别并排除非发票邮件
  - [x] 信用卡电子账单: 标题同时包含 `信用卡` 和 `电子账单`
  - [x] 12306 支付通知: `网上购票系统-用户支付通知`
  - [x] 12306 改签通知: `网上购票系统-用户改签通知`
- [x] `src/mail/fetcher.ts`: fetch 阶段不再保存上述非发票邮件到 `samples/raw`
- [x] `src/index.ts`: run 阶段对既有样本同样排除,标记 processed,不写 pending
- [x] 12306 `网上购票系统-电子发票通知` 明确不在排除规则内;当前样本库没有该类型真实 `.eml`,等待样本后按架构新增支持

## Phase 5 当前结论

- 第三方站点样本已全部完成自动处理。
- 信用卡账单与 12306 支付/改签通知已从 fetch/run 排除,不再进入 manual。
- 全量样本回归: `Run complete: processed=105, skipped=0`,输出 PDF 166 个,`pending/` 为空。

## Phase 5.2 — mailbox 选择与全邮箱抓取  [完成 2026-05-20]

- [x] 除错发现: 网页端“主题或内容包含发票”约 323 封包含多个 mailbox;原 CLI 只查 `INBOX`,半年窗口 SEARCH 为 233
- [x] IMAP 复核:
  - `INBOX`: SEARCH 233,可 fetch 232,排除非发票 17,保留 215
  - `其他文件夹/已处理 2025发票`: SEARCH 92,可 fetch 86
  - `其他文件夹/已处理 2026发票`: SEARCH 1,可 fetch 1
- [x] `src/config.ts`: `imap.mailbox` 支持字符串或字符串数组;空数组表示全部 mailbox
- [x] `src/mail/fetcher.ts`: 未选择 mailbox 时 `LIST` 全部 mailbox,逐 mailbox 串行 SEARCH/FETCH
- [x] `src/index.ts`: `samples/raw/INDEX.csv` 增加 `mailbox` 列,便于追溯样本来源
- [x] `gui-design/pages/config.html`: 配置页改为 mailbox 多选,提示空选扫描全部
- [x] `config.example.json` / 架构与设计文档同步 mailbox 规则

## Phase 5.3 — 网络重试与失败汇总  [完成 2026-05-20]

- [x] `config.network.retries` / `config.network.retryDelayMs`: 单一 `config.json` 内配置网络重试
- [x] `src/pipeline.ts`: `Ctx.http` 统一包装重试逻辑,覆盖 directLink 与 SiteHandler HTTP 请求
- [x] 重试耗尽后抛出 `network_retry_failed`,当前邮件写入 `pending/` 与 `pending.csv`,主循环继续
- [x] `src/index.ts`: `mfh run` 结束时汇总本轮网络重试失败的邮件 hash/date/from/subject/reason
- [x] `gui-design/pages/config.html`: 配置页增加网络重试次数与基础间隔
- [x] `gui-design/pages/pending.html`: 待处理队列增加 `network_retry_failed` 分组,显示失败邮件 hash/subject/reason
- [x] `gui-design/pages/dashboard.html`: 运行控制台展示网络重试日志与最终失败汇总

## Phase 5.4 — 半年全 mailbox 样本回归  [完成 2026-05-20]

- [x] 对 `samples/raw` 302 封 `.eml` 使用临时 state/invoices/pending 全量跑 `mfh run`
- [x] `src/extract/directLink.ts`: 修复正文 URL 边界,中文说明不再黏进 URL;单封邮件已有 PDF 候选时,无关坏链接失败不再让整封进 pending
- [x] `src/extract/directLink.ts`: 跳过 `inv-veri.chinatax.gov.cn` 查验说明链接,避免无效 HEAD 重试拖慢
- [x] 全量结果: `Run complete: processed=302, skipped=0`,输出 PDF 560 个
- [x] Pending 2 封:
  - 淘宝闪购 1 封仅含 OSS `.jpg` 图片链接,无 PDF/ZIP,按当前 PDF-only 架构留 manual
  - 个人转发 1 封仅含税务 App 截图附件,无平台 vendor,留 manual
- [x] 结论: 本轮未发现需要新增的发票 SiteHandler vendor

## Phase 5.5 — 待人工队列查看  [完成 2026-05-20]

- [x] `mfh pending list`: 读取 `pending/pending.csv`,输出 hash/date/from/subject/reason
- [x] 按 `network_retry_failed` 与普通 manual 分组,方便区分网络抖动与真实不支持的样本

## Phase 5.6 — 半年到一年前样本回归  [完成 2026-05-21]

- [x] 清空 `samples/raw` 后抓取 `2025-05-20..2025-11-20` 全 mailbox 邮件: SEARCH/FETCH 275 封 `.eml`
- [x] `src/extract/directLink.ts`: 税局 `exportDzfpwjEwm` 链接从 OFD/XML 自动切到 PDF,并按发票号去重同一邮件里的重复税局链接
- [x] `src/extract/directLink.ts`: 支持无 `.pdf` 后缀但实际返回 PDF 的亚朵 OSS `inv-file` 链接
- [x] `src/sites/baiwang.ts`: 支持云票/旧百望短链与 `i.baiwang.com` 预览接口转 PDF
- [x] `src/sites/huaweiTravel.ts`: 新增慧通差旅 `invoiceViewDownload` token 链接处理器
- [x] 全量结果: `Run complete: processed=275, skipped=0`,输出 PDF 524 个
- [x] Pending 11 封,无新增可适配 vendor:
  - 飞猪接送机 7 封: 历史 OSS 签名 PDF 链接返回 403,留 manual
  - 通行费授权自动开票 2 封: 邮件仅含二维码/授权入口,无 PDF 链接,留 manual
  - 慧通差旅 1 封: 平台返回 `130071003` 发票链接超过有效期,留 manual
  - 飞猪旅行报销凭证 1 封: 仅 OFD 附件,当前阶段不做 OFD/OCR,留 manual

## Phase 5.7 — OFD 行程单前置支持  [完成 2026-05-21]

- [x] `src/extract/types.ts`: `PdfArtifact` 扩展为兼容旧名的 `DocumentArtifact`,新增 `format` / `documentType` / `requiresOcr`
- [x] `src/extract/attachment.ts`: 识别附件与 ZIP 内 `.ofd`,将 OFD 标记为 `documentType=itinerary` 且 `requiresOcr=true`
- [x] `src/download/downloader.ts`: staging 与最终归档保留 `.ofd` 扩展名,PDF 路径保持兼容
- [x] `src/pipeline.ts`: OFD 与 PDF 可在同一封邮件中共同归档;`invoices.csv` 去重粒度改为 `messageId + source`
- [x] `src/pipeline.ts`: OFD 行程单写入 `invoices/ocr/ocr-pending.csv`,等待后续 OCR 识别引擎集成
- [x] 代表样本验证: `84bda1cccdc2` 同时输出 `.ofd` 与 `.pdf`,并生成 1 行 `ocr-pending.csv`

## Phase 5.8 — 下载优先与 OCR 后处理契约  [完成 2026-05-21]

- [x] 明确主流程先最大化下载并安全归档 PDF/OFD,OCR 与二次整理不得阻塞首轮归档
- [x] `src/download/downloader.ts`: 对提取器建议文件名做 basename/非法字符清理,并继续用 `-1/-2` 防冲突
- [x] `src/pipeline.ts`: 所有已归档文档都写入 `invoices/ocr/ocr-pending.csv`,不仅限 OFD
- [x] `src/config.ts` / `config.example.json`: 增加 `ocr.resultsCsv` 与 OCR 后二次重命名/按类型分目录配置契约
- [x] `src/ocr/types.ts`: OCR Provider 接口扩展为带文档格式/类型 meta,识别结果可返回 `documentType` 与 `invoiceType`
- [x] 文档同步: `ARCHITECTURE.md` / `DESIGN.md` / `NEXT_STEPS.md` 明确 `invoices.csv` 是原始归档事实,`ocr-results.csv` 是识别事实

## Phase 5.9 — 非 OCR/LLM 的离线整理闭环  [完成 2026-05-21]

- [x] `src/rename/rename.ts`: 实现纯 CSV 驱动后处理,读取 `ocr-results.csv`,按模板二次命名或按类型分目录
- [x] `mfh organize`: 新增 CLI 子命令,只复制原始归档文件到 `rename.organizedDir`,不移动/覆盖 `invoices/` 原件
- [x] `organize-results.csv`: 写入复制/跳过/失败审计记录,便于后续 GUI 展示
- [x] `src/config.ts` / `config.example.json`: 增加 `rename.organizedDir`

## Phase 6.0 — 接入 E-Fapiao-OCR 二进制  [完成 2026-05-21]

- [x] `src/ocr/efapiao.ts`: 接入 `12dora/E-Fapiao-OCR` 发布的 `efapiao` 二进制,通过 stdin 传入 PDF/OFD 字节并解析 JSON 输出
- [x] `src/ocr/runner.ts`: 新增 OCR 队列执行器,读取 `invoices/ocr/ocr-pending.csv`,写入 `ocr.resultsCsv`
- [x] `src/index.ts`: 新增 `mfh ocr run [--force]`
- [x] `src/config.ts` / `config.example.json`: `ocr.provider=efapiao`,增加 `ocr.binaryPath` 与 `ocr.timeoutMs`,允许 `ocr.enabled=true`
- [x] 本地回归: 使用模拟 `efapiao` 二进制验证 `mfh ocr run` 可写出 seller/amount/date/invoiceNo/status

## Phase 6.1 — OCR 工作队列状态回写  [完成 2026-05-21]

- [x] `mfh ocr run`: 识别成功后将 `ocr-pending.csv` 对应行标记为 `recognized`,失败标记为 `failed`,但保留原始队列行
- [x] 复跑幂等: 已存在 `ocr-results.csv` 结果时跳过重复识别,不追加重复结果行,并保持队列状态可读
- [x] 本地回归: 模拟 `efapiao` 二进制验证 `pending -> recognized`,复跑 `skipped=1`

## Phase 6.2 — 内置 E-Fapiao-OCR Release 二进制  [完成 2026-05-21]

- [x] 下载 `12dora/E-Fapiao-OCR v0.1.2` 的 `efapiao-0.1.2-darwin-arm64.tar.gz`
- [x] 放置到 `vendor/efapiao/0.1.2/darwin-arm64/efapiao`,并验证 `efapiao --version`
- [x] `ocr.binaryPath="auto"`: 当前平台优先使用 `vendor/efapiao/0.1.2/<platform-arch>/efapiao`,缺失时回退 PATH 中的 `efapiao`
- [x] 多架构目录约定: `darwin-arm64`, `darwin-x86_64`, `linux-x86_64`, `linux-arm64`, `windows-x86_64`

## Phase 6.3 — OCR HTTP 服务模式与真实样本诊断  [完成 2026-05-21]

- [x] `src/ocr/efapiao.ts`: `ocr.executionMode=auto` 时优先探活/启动 `efapiao serve`,通过 `/v1/invoices/parse` 批量 POST 文件;服务不可用时回退 CLI
- [x] `src/ocr/runner.ts`: `ocr-results.csv` 增加 `transport/extractedBy/parserVersion/ocrVendor`,旧结果 CSV 自动补空列后继续追加
- [x] 真实样本链路: 清空本地运行缓存后抓取 2026-02-21 至 2026-05-21 邮件,保存 138 封候选邮件;归档 372 个文档(PDF 246,OFD 126),归档阶段 skipped=0
- [x] 真实 OCR 观察: `efapiao v0.1.2` PDF 文本层可识别;OFD 发票返回 `not_implemented`;通行费汇总/行程 PDF 返回 `parse_failed`
- [x] 上游问题定位: `v0.1.2 darwin-arm64` 的 `efapiao serve` 因 PyInstaller exclude `uvicorn.middleware.wsgi` 启动失败;本项目 `auto` 模式会回退 CLI,待上游 release 修复后自动走 HTTP

## Phase 6.4 — PDF/OFD 成对发票过滤  [完成 2026-05-21]

- [x] `src/extract/attachment.ts`: 同邮件附件或 ZIP 内 PDF/OFD 成对发票优先保留 PDF,过滤重复 OFD 发票副本
- [x] 行程单例外: OFD 文件名/来源含 `行程单`、`行程报销`、`客票`、`机票`、`itinerary` 等信号时继续保留并送 OCR
- [x] 真实样本回归: 扫描 2026-02-21 至 2026-05-21 的 138 封样本邮件,过滤 48 份重复 OFD,普通混合附件不再残留 OFD 发票副本

## Phase 6.5 — 一年真实邮件本地缓存  [完成 2026-05-21]

- [x] 使用 `mfh fetch` 抓取 2025-05-21 至 2026-05-21 全 mailbox 候选发票邮件
- [x] 缓存到 `.mfh-cache/year-2025-05-21_2026-05-21/raw/`,保存 577 封 `.eml`,目录约 252MB,`INDEX.csv` 578 行(含表头)
- [x] `.gitignore` 增加 `.mfh-cache/`;文档明确真实邮件缓存只用于本地开发,禁止提交或上传
