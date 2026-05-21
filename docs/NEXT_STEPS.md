# 下一步（AI 软件工程视角）

核心原则：**最小可运行 → 真实样本驱动迭代 → 按需扩展**。不要一次性把第三方站点 handler 全写出来——它们必须由真实邮件样本反推。

## Phase 0：脚手架（半天）

- `npm init`、TypeScript 配置、ESLint 关闭装饰性规则
- 建好 §4 的目录骨架，每个文件先写空 export
- 写 `config.ts` + `state.ts`：能加载校验、能读写状态
- CLI 入口：`mfh fetch`、`mfh run`、`mfh pending list`

**验收**：`mfh --help` 能列出子命令，状态文件能读写。

## Phase 1：邮件抓取（独立完成）★先做这个★

**目标**：让 AI / 用户尽快拿到真实邮件做本地分析。本阶段不做任何"识别 / 提取 / 下载 PDF"逻辑。

- `mail/fetcher.ts`：IMAP 连接、按关键词 SEARCH SUBJECT/BODY、SINCE N 天
- mailbox 由用户选择；未选择时扫描全部 IMAP mailbox，逐 mailbox 串行抓取
- `mfh fetch` 子命令：把命中的邮件原文以 `.eml` 落到 `samples/raw/<YYYY-MM>/<messageId>.eml`
  - 同时写 `samples/raw/INDEX.csv`：messageId, date, from, subject, hasAttachment, bodyLinkCount
- `state.json` 记录已 fetch 过的 messageId，重跑只增量拉取
- 不解析、不下载附件 PDF、不访问外链——只落 .eml + 索引

**验收**：在用户真实邮箱跑 `mfh fetch`，`samples/raw/` 下有完整 .eml 文件，INDEX.csv 可用 Excel 打开。**此时 AI 已经能离线分析真实数据**。

## Phase 2：样本分类与路线图 ★关键步骤，不写代码★

基于 Phase 1 落下的 .eml：

- AI 阅读 INDEX.csv + 抽样读 .eml 内容
- 按发件人 / 正文特征聚类：「附件型 / 直链型 / 跳转 vendorA / 跳转 vendorB / 需登录 / 其他」
- 每类挑 1~2 封代表性 .eml 软链或复制到 `samples/by-type/<type>/`
- 产出 `samples/INDEX.md`：每类的判定特征、样本路径、建议处理路线、预计覆盖率

后续每个 Extractor / SiteHandler 都拿 `samples/by-type/<type>/` 做端到端回归。

## Phase 3：附件提取器（半天）

- `extract/attachment.ts`：从已落地的 .eml 或实时邮件中识别 PDF 附件
- `download/downloader.ts`：冲突重命名
- `mfh run` 串起来：fetch → 遍历未处理邮件 → attachment Extractor → 落盘 + CSV

**验收**：「附件型」样本 100% 入盘。

## Phase 4：直链提取器（半天）

- `extract/directLink.ts`：解析正文 href，HEAD 探测，确认 PDF 即下载
- 用「直链型」样本回归

**验收**：直链型样本 100% 通过。

## Phase 5：第三方站点 handler — 迭代式 ★

每次循环只做一个 vendor。**不要并发开 N 个**——每个站点的反爬/弹窗/SPA 行为都不同，必须实测。

针对样本库中**邮件数量最多**的 vendor：

1. Coding agent 读 .eml，定位跳转 URL 模式
2. 跑 Playwright headed 模式录脚本（点击 → 等待 → 下载）
3. 抽出为 `sites/<vendor>.ts`，实现 `match` + `handle`
4. 加进 `sites/registry.ts`
5. 用该 vendor 所有样本回归

完成一个 vendor 才开下一个。覆盖到「样本累计 ≥ 80%」即停手——长尾交给情况 4。

## Phase 6（可选）：LLM 兜底

- 仅当 Phase 4 后仍有显著未识别比例才做
- `extract/llm.ts`：把正文 + 链接列表喂给 LLM，让它输出「PDF 直链 / 需要点击的链接 / 都不是」
- 命中"需要点击" → 再交给一个**通用 SiteHandler**：用 Playwright 打开、找页面上含"下载/发票/PDF"文字的按钮点击
- 这是最后兜底，质量不稳定，结果仍可能 fall through 到 manual

## Phase 7：OCR + 智能重命名

- PDF/OFD 已先接入前置链路：附件或 ZIP 内文档会先归档，并写入 `invoices/ocr/ocr-pending.csv`
- 已接入 `12dora/E-Fapiao-OCR` 的 Release 二进制：`mfh ocr run` 从 `ocr-pending.csv` 读取文档，默认优先启动/复用 `efapiao serve` 本地 HTTP 服务，失败时回退 `efapiao parse - --hint <pdf|ofd> --ocr-mode auto`
- `ocr/efapiao.ts` 返回 `{ seller, amount, date, invoiceNo, documentType, invoiceType }` 及成功/失败状态，并记录 `transport/extractedBy/parserVersion/ocrVendor`
- OCR 结果写入 `config.ocr.resultsCsv`
- `mfh organize` / `rename/rename.ts` 已提供纯离线后处理：按 `config.rename.rule` 模板做可选二次重命名；字段缺失走 fallback；如果 `rename.organizeByType=true`，再按 `rename.typeDirRule` 复制聚类到不同文件夹
- 原始归档文件与 `invoices.csv` 永不因 OCR/二次重命名失败而回滚

**上游 efapiao 待修复**：
- `v0.1.2 darwin-arm64` release 的 `efapiao serve` 会因 `ModuleNotFoundError: No module named 'uvicorn.middleware.wsgi'` 启动失败。原因是上游 `scripts/build_binary.py` 将 `uvicorn.middleware.wsgi` 加入了 PyInstaller exclude，但 `uvicorn.config` 会导入该模块；应从 exclude 移除或改为显式 hidden import。
- Release smoke test 目前只测 `--version` 和 `capabilities`，建议加入 `efapiao serve --host 127.0.0.1 --port <free>` 后请求 `/v1/health`，再 POST 一个最小 PDF 样本到 `/v1/invoices/parse`。

## Phase 8：打包

- `pkg` 产出 mac/win 可执行
- README 写明 `config.json` 模板与权限提醒

---

## 给 Coding Agent 的工作纪律

1. **样本驱动**：没有真实 .eml，不写 SiteHandler。先要样本，再写代码
2. **一次一个 vendor**：不要"顺手把 N 家都写了"——每家行为差异大，必须真跑
3. **回归保护**：每个 SiteHandler 必须有 `samples/<vendor>/*.eml` 做端到端回归
4. **失败即降级**：任何 Extractor 抛错 → 走 manual 队列，绝不阻塞主流程
5. **不预留接口**：注册表就是数组，不要引入插件系统、不要 DI 容器
6. **状态幂等**：所有写操作（下载、CSV、状态）都要在崩溃后能重跑而不出现重复或损坏

## 建议立刻执行的第一条命令

> "按 Phase 0 + Phase 1 实现脚手架与纯邮件抓取功能（`mfh fetch`），把所有命中关键词的邮件以 .eml 形式落到 samples/raw/，并生成 INDEX.csv。完成后我们再一起分析样本。"
