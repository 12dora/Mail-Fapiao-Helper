# Mail Fapiao Helper — 架构文档

> 本文是 DESIGN.md 的"上层规约"。冲突时以本文为准。
> 写给 Coding Agent：每节都已压缩到最小必要信息，不要再展开"未来可能"。

## 1. 架构总览

```mermaid
flowchart LR
  CLI[mfh CLI] --> Cfg[config.json]
  CLI --> Fetcher[mail/fetcher\nIMAP+SEARCH]
  Fetcher -->|ParsedMail| Pipe((pipeline\nworker pool 处理邮件))
  Pipe --> Reg["extract/registry\n(普通数组,顺序匹配)"]
  Reg --> A[attachment]
  Reg --> D[directLink]
  Reg --> T[thirdParty]
  Reg --> L[llm?]
  Reg --> M[manual fallback]
  T --> SR["sites/registry (数组)"]
  SR --> SH[SiteHandler*]
  Pipe -->|DocumentArtifact[]| DL[download/downloader\n.staging→final]
  DL --> Out[(invoices/ + invoices.csv)]
  DL --> OcrQ[ocr queue\nall documents pending]
  OcrQ --> Ocr["efapiao HTTP service preferred\nCLI fallback"]
  Ocr --> OcrOut[(ocr-results.csv)]
  Ocr --> Post[mfh organize\ncopy to rename / type folders]
  M --> Pend[(pending/*.eml + pending.csv)]
  Pipe --> S[(state.json)]
```

**边界**：
- `mail/` 只负责 IMAP I/O 与产出 `ParsedMail`，不感知发票语义。
- `mail/` 按用户选择的 mailbox 顺序抓取；`config.imap.mailbox=[]` 表示 IMAP `LIST` 返回的全部 mailbox，旧字符串格式仅兼容读取。
- `extract/` 决策 + 产出 `DocumentArtifact` 或 `manual`，不写盘。
- `download/` 是原始文档唯一落盘者（含 .staging→final、安全文件名、冲突重命名）。
- 首轮归档必须先保存全部已找到文档；OCR、二次重命名、按类型分目录只能在归档后运行，不能阻塞下载。
- `rename/` 只负责 OCR 后的可选二次整理；`mfh organize` 复制原始归档文件到整理目录，不移动/覆盖首轮归档。
- `state.ts` 唯一 state.json 读写者，其他模块不直接 fs。

## 2. 核心抽象（最终接口）

```ts
// 全局上下文：所有 Extractor / SiteHandler 共享
interface Ctx {
  cfg: Config;
  log: Logger;
  browser: () => Promise<Browser>;   // 懒加载 Playwright,首次调用才启动
  http: typeof fetch;
}

// extract/types.ts
interface Extractor {
  name: string;
  canHandle(mail: ParsedMail): boolean;
  extract(mail: ParsedMail, ctx: Ctx): Promise<ExtractResult>;
}
type ExtractResult =
  | { kind: 'pdf'; pdfs: PdfArtifact[] }
  | { kind: 'manual'; reason: string }
  | { kind: 'skip' };

type DocumentFormat = 'pdf' | 'ofd' | 'image';
type DocumentType = 'invoice' | 'itinerary' | 'supporting';
interface DocumentArtifact {
  data: Buffer;
  source: string;          // 附件名或来源 URL,排错用
  suggestedName?: string;  // 提取器若已知则给,否则 rename 阶段决定
  format?: DocumentFormat; // 默认 pdf; OFD/图片必须显式标注
  documentType?: DocumentType; // supporting = 已归档但默认不送 OCR 的支撑材料
  requiresOcr?: boolean;   // 提取器可显式标记；pipeline 会把所有归档文档写入 OCR 队列
}
type PdfArtifact = DocumentArtifact; // 兼容旧命名,后续逐步收敛

// sites/types.ts
interface SiteHandler {
  name: string;
  match(url: string): boolean;
  handle(page: Page, url: string, ctx: Ctx): Promise<PdfArtifact[]>;
}

// ocr/types.ts
interface OcrProvider {
  name: string;
  parse(data: Buffer, meta: { format: DocumentFormat; documentType: DocumentType; filename: string }): Promise<OcrResult>;
}
interface OcrResult {
  status: 'success' | 'error';
  fields: Partial<InvoiceFields>;
  error: string;
  source?: { format: DocumentFormat; parserVersion: string; extractedBy: string; ocrVendor: string | null };
  transport?: 'cli' | 'http';
  raw: unknown;
}
interface InvoiceFields {
  seller: string;
  amount: string;
  date: string;        // YYYY-MM-DD
  invoiceNo: string;
  documentType: DocumentType;
  invoiceType: string;
}
```

**为什么没有更多方法（拒绝列表）**：
- 无 `priority()`：数组顺序即优先级。
- 无 `init()/dispose()`：Playwright 由 Ctx 懒启动并由 CLI 在退出时统一关；其他模块无状态。
- `SiteHandler` 无 `login()`：需要登录的站点一律走 manual，不引入凭证管理。
- `OcrProvider` 无 `cost()/limits()`：config 里只配一个 provider，无运行时选择逻辑。
- `Extractor` 无 `priority/version/schema`：YAGNI。

## 3. 数据流与状态机

单封邮件的处理是一次"伪事务"，提交点是 **state.json 写回**。

```
DISCOVERED                  // 来自 fetcher
  └─> MATCHED(extractorName) // registry 顺序首个 canHandle
        ├─> DOCUMENT_READY   // ExtractResult.kind=='pdf'，可含 PDF 发票 + OFD 行程单
        │     └─> STAGED     // 写入 .staging/<msgIdHash>/<i>.<pdf|ofd>
        │           └─> FINALIZED   // 移到 invoices/ + 安全文件名 + 冲突后缀
        │                 └─> CSV_APPENDED
        │                       └─> OCR_PENDING // 全部归档文档写 invoices/ocr/ocr-pending.csv
        │                             └─> COMMITTED  // state.json processedIds += msgId
        ├─> MANUAL           // kind=='manual' 或任意上游抛错
        │     └─> PENDING_WRITTEN   // pending/<msgIdHash>.eml + pending.csv 行
        │           └─> COMMITTED
        └─> SKIP             // kind=='skip',直接 COMMITTED
```

**幂等点（必须能安全重跑）**：
- `STAGED`：staging 文件以 `<msgIdHash>/<index>.<pdf|ofd>` 命名，重写覆盖即可。
- `FINALIZED`：原子 `rename`；目标存在则追加 `-1/-2`；建议文件名会先做 basename 与非法字符清理。
- `CSV_APPENDED`：以 `messageId + source` 为去重键，允许同一封邮件登记 PDF 发票与独立行程单。
- `COMMITTED`：state.json 走 "tmp + rename" 原子写。

**msgIdHash**：取 `sha1(messageId || from+date+subject).slice(0,12)`。Message-Id 可能缺失，必须有 fallback。

## 4. 错误与降级策略

| 失败层 | 行为 |
|---|---|
| IMAP 连接 / SEARCH | 整轮终止；下次 `mfh run` 重试，state 不变 |
| 单封 mail 解析 | 该封 → manual(reason="parse_error")；继续下一封 |
| `Extractor.extract` 抛错 | 该封 → manual(reason=`<extractor>:<err.message>`) |
| `SiteHandler.handle` 抛错或超时 | 视同 thirdParty Extractor 失败 → manual |
| 下载 HTTP / SiteHandler 网络抖动 / Playwright 超时 | 按 `config.network.retries` 自动重试；仍失败 → manual(reason 含 `network_retry_failed`) |
| PDF/OFD 成对发票 | 附件提取阶段优先保留 PDF，过滤同一封邮件里的重复 OFD 发票副本；只有文件名/来源明确含 `行程单`、`航空运输电子客票`、`itinerary` 等信号时才保留 OFD 行程单；普通“报销凭证”有 PDF 副本时只保留 PDF |
| OFD 行程单 | 照常归档 `.ofd`，并写 `invoices/ocr/ocr-pending.csv`；后续 OCR 引擎负责识别，不阻塞同封邮件中的 PDF 发票 |
| 非发票支撑 PDF | 通行费汇总单、订单/运单明细、结账单/账单、堂食明细、PDF 行程/行程报销单仍归档并写队列，但 `documentType=supporting,status=ignored`，默认不送 OCR |
| OCR 失败或字段缺失 | **不影响首轮归档**：识别结果留空或标记失败，原文件与 `invoices.csv` 不回滚 |
| 二次 rename 模板渲染失败 | 保留首轮归档文件名；记录失败原因，不影响原文件 |
| CSV 追加失败 | 整封回滚（不 COMMIT），下次重跑 |
| state.json 写失败 | fatal，进程退出；本封下次会被重新处理（幂等保证不重复） |

**铁律**：除"IMAP 连接失败"和"state.json 写失败"外，任何错误都不允许中断主循环。

## 5. 幂等性与崩溃恢复

| 操作 | 幂等手段 |
|---|---|
| IMAP fetch | 每封拉完即可重复 SEARCH；以 messageId 去重 |
| PDF/OFD 落盘 | 先写 `.staging/<msgIdHash>/`,目标已存在则跳过下载;`rename` 是原子的 |
| 命名冲突 | `name.pdf` 存在 → `name-1.pdf`、`name-2.pdf`。**重跑产生重复的窗口**：FINALIZED 完成但 COMMITTED 前崩溃 → 重跑会再生成一个 `-N`。缓解：CSV 追加前用 messageId 查重；若 CSV 已有该 messageId 行，跳过整封 |
| CSV 追加 | 写之前检查 `messageId + source`；追加用 `fs.appendFileSync`,单行原子 |
| state.json | `state.json.tmp` → `rename`,POSIX 原子 |
| pending 写入 | `pending/<msgIdHash>.eml` 覆盖式写；pending.csv 同样以 messageId 查重 |
| OCR 待识别队列 | `invoices/ocr/ocr-pending.csv` 以 hash/source 记录全部已归档文档；发票/行程单状态初始为 `pending`，明确支撑材料状态为 `ignored` |
| OCR 结果 | `mfh ocr run` 默认优先使用 `efapiao serve` 本地 HTTP 服务，失败再回退 `efapiao parse - --hint <pdf|ofd> --ocr-mode auto`；`config.ocr.resultsCsv` 保存识别字段、状态、错误、transport 与 extractedBy；`mfh organize` 以结果 CSV 为输入，复制到 `rename.organizedDir` 并写 `organize-results.csv` 审计 |

**启动时自愈**：读 state.json 后，扫一遍 `invoices.csv` 的 messageId 列做 union，弥补"FINALIZED 后未 COMMIT"的小窗口。CSV 即真实归档证据。

## 6. 并发模型

`mfh run` 使用受控 worker pool 处理本地 `.eml` 缓存，默认 `--concurrency 4`，可按机器与网络情况调高或调低。`--only-mail <hash>` 仍用于单封定向回归。

边界：
- IMAP `fetch` 阶段仍逐 mailbox 串行抓取，避免邮箱服务端限流和状态复杂度。
- 本地 `.eml` 解析、附件/ZIP 提取、直链下载、第三方站点处理可以多封并发。
- 同一轮内用 `processedHashes` + `inFlight` 防止同一 hash 被重复处理。
- Playwright Browser 采用懒加载单例；多个 worker 共享同一个 browser，但各 SiteHandler 仍自行创建/关闭 page。
- 单封失败只记 `failed` 或进入 pending，不终止整轮 worker pool。

`directLink` Extractor 内部仍会对单封邮件中的多个候选链接用 `Promise.all` 并发 HEAD 探测，这是单封内部的局部并发。

## 7. 扩展点契约

只有两个扩展点。**步数固定**，多一步算违反约定。

**新增 SiteHandler**：
1. `samples/by-type/<vendor>/` 至少 1 封 .eml（前置硬性条件）。
2. 新建 `src/sites/<vendor>.ts`，导出 `default: SiteHandler`。
3. `src/sites/registry.ts`：`import x from './<vendor>'; handlers.push(x);`
4. 跑 `mfh run --only-mail <msgIdHash>` 对样本回归。

**新增 OcrProvider**：
1. 新建 `src/ocr/<vendor>.ts`，导出 `default: OcrProvider`。
2. `src/ocr/registry.ts`：同上 push。
3. config.json `ocr.provider = "<vendor>"`。

**当前默认 OCR Provider**：
- `provider="efapiao"`，通过 `config.ocr.binaryPath` 寻找 `12dora/E-Fapiao-OCR` 发布的 `efapiao` 二进制。
- `binaryPath="auto"` 时按 `process.platform/process.arch` 优先寻找 `vendor/efapiao/0.1.3/<platform-arch>/efapiao`；桌面版当前只内置 macOS arm64 和 Windows x64 的 upstream `lite` 包。上游未发布 `darwin-x86_64` 资产，Intel Mac 走 PATH 或自行构建；Linux 暂不作为桌面安装包目标。
- 默认集成 `lite` 包，不附带 CnOCR 模型；用户可将同架构目录替换为 upstream `with-model` 包，或把 `models/` 放到二进制旁。程序会自动探测 `models/` 并设置 `EFAPIAO_OCR_VENDOR=cnocr`；显式 `EFAPIAO_OCR_VENDOR` 或 `ocr.credentials.ocrVendor` 优先级更高。
- `ocr.executionMode="auto"` 默认优先探活/启动本地 HTTP 服务：`efapiao serve --host <serviceHost> --port <servicePort> --workers <serviceWorkers>`，健康检查通过后按 `ocr.batchSize` 对 `/v1/invoices/parse-batch` 发送 multipart(`files[]`,`hint_type=auto`,`ocr_mode=auto`)；服务不可用时回退 CLI。若 `ocr.credentials.apiKey` 或 `EFAPIAO_API_KEY` 存在，会对解析请求发送 `X-API-Key`。
- `ocr.executionMode="serve"` 强制 HTTP 服务模式，不回退 CLI；`ocr.executionMode="cli"` 强制逐张 `efapiao parse - --hint <pdf|ofd> --ocr-mode auto`。
- `ocr-results.csv` 保存 `transport/extractedBy/parserVersion/ocrVendor`，用于判断识别是否走了 `text_layer`、`qrcode` 或 OCR 兜底；旧版结果 CSV 会自动补空列后继续追加。
- `efapiao v0.1.3` 新增图片输入（JPEG/PNG/GIF/WEBP/BMP）和 `engine.ocr_required/ocr_enabled/ocr_vendor` 分流信息；本项目会把图片附件/ZIP 内图片写入 OCR 队列，并在结果 CSV 中保留 `ocrVendor`、`extractedBy`、`parserVersion`。
- `mfh ocr run --allow-parse-failures` 会在 OCR 服务/程序完成且单行失败已写入结果时返回 0；默认仍在存在单行业务失败时返回 1，便于交互式发现问题。
- `mfh ocr summary [--json]` 是 GUI 和人工排障入口：读取 `ocr-pending.csv` 与 `ocr-results.csv`，输出 `recognized / failed / ignored / pending`、文档类型、支撑材料原因和失败原因示例。
- `mfh pending list [--json]` 是 GUI 手工队列入口：读取 `pending.csv`，把原始 reason 归并为 `retry / refresh_link / manual_archive / ignore`，并保留每封邮件的 hash、主题、发件人和日期。

**禁止**：写"自动发现/插件加载/装饰器注册"。一律手动 import + push。

## 8. 测试策略

样本驱动，分两层。

**真实邮件缓存**：
- 为避免开发过程中反复调用 IMAP，可先运行 `mfh fetch` 把真实邮件缓存为 `.eml`。当前本机一年样本缓存位于 `.mfh-cache/year-2025-05-21_2026-05-21/raw/`，时间窗为 2025-05-21 至 2026-05-21。
- `.mfh-cache/` 必须保持在 `.gitignore` 中；其中包含真实邮件内容、发票信息和可能的个人/企业敏感数据，禁止提交或上传。
- 后续开发和回归优先读取本地缓存目录：`node dist/index.js run --config <temp-config> --state <temp-state>`，其中临时配置的 `paths.samples` 指向上述 `raw/` 目录。

**单元层（mock IMAP，不 mock 解析）**：
- 给 `extract/*` 直接喂 `mailparser.simpleParser(fs.readFileSync('samples/by-type/.../x.eml'))` 产出的 `ParsedMail`，断言 `ExtractResult`。
- 不 mock `mailparser`；mock `fetch` 与 `SiteHandler.handle`（返回固定 Buffer）。

**端到端层（mock IMAP + 真 Playwright）**：
- 用 `samples/by-type/<vendor>/` 跑完整 pipeline，落盘到临时目录。
- 断言：`invoices/` 下文件数、`invoices.csv` 行数、`pending/` 为空（对该 vendor 而言）。
- SiteHandler 测试**不 mock Playwright**——它就是被测对象。允许 hit 真网络；若 CI 网络受限，标 `@network` 跳过。

**永远不 mock**：mailparser、文件系统、rename 模板。
**永远 mock**：IMAP 服务器（用 .eml 文件代替）、OCR provider（除非有专门 OCR 回归套件）、LLM provider。

## 9. 风险登记表

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | Message-Id 缺失或重复（部分国内邮件服务器） | 幂等失效、重复下载 | 用 `sha1(messageId || from+date+subject)` 做 msgIdHash；以此为状态键 |
| R2 | Playwright 在打包后找不到 Chromium | 第三方站点全部失败 | 桌面版随应用准备浏览器或使用系统浏览器；缺失时给出应用级修复提示，不要求用户安装开发工具 |
| R3 | SiteHandler 长尾无止境，开发者持续往里塞 | 代码腐烂 | 硬性门槛：vendor 邮件数 ≥ 累计 5% 才写 handler；否则进 manual。覆盖到 80% 就停手（NEXT_STEPS Phase 5 已规约） |
| R4 | 大附件 PDF/OFD 全部驻留内存（`DocumentArtifact.data: Buffer`） | OOM 风险 | v1 接受；约束单封邮件文档总大小上限 50MB，超过则 manual。**不引入流式接口** |
| R5 | CSV 在 Excel 打开时被锁（Windows） | 追加失败导致整封回滚 | 追加失败重试 3 次（指数退避 100ms→1s），仍失败 → manual(reason="csv_locked")，邮件不丢 |

---

## 10. 对 DESIGN.md 的偏离（已同步修订）

| 变更 | 原文 | 新规约 | 原因 |
|---|---|---|---|
| C1 | `ExtractResult.pdf.buffers: {filename,data}[]` | `pdfs: DocumentArtifact[]`（兼容旧名 `PdfArtifact`，含 `source`、`suggestedName?`、`format?`） | 排错需要来源；filename 字段语义模糊（建议名 vs 最终名）；OFD 行程单也要进入同一封邮件的归档链路 |
| C2 | `state.json = { processedMessageIds: string[] }` | 仍是数组，但**键改为 msgIdHash**；启动时与 invoices.csv 求并集 | 应对 Message-Id 缺失/重复 |
| C3 | 命名冲突直接 `-1/-2` | 保留 `-1/-2`，但 CSV 追加前用 `messageId + source` 查重 | 关闭 FINALIZED→COMMIT 间的重复窗口，同时允许一封邮件多文档 |
| C4 | 主流程未说明并发 | `mfh run --concurrency <n>` 使用受控 worker pool，默认 4；同 hash 防重，单封失败不终止整轮 | 兼顾真实使用速度与状态复杂度 |
| C5 | OCR/LLM 失败行为未定义 | OCR 失败 → fallback 模板，不阻塞 | "绝不阻塞主流程"硬约束的具体化 |
| C6 | `SiteHandler.handle` 签名缺 `ctx` | 加 `ctx: Ctx` | logger / config 必须可注入 |
| C7 | 未明确 Playwright 生命周期 | `ctx.browser()` 懒启动，CLI 退出统一关 | 避免 SiteHandler 各自管理 |

---

## 三句话总结

1. **固定顺序 + 受控并发就是架构**：多封邮件由 worker pool 并发处理；每封邮件内部仍按固定顺序的 Extractor 数组匹配，无 DI、无插件、无热插拔；这是为了把 v1 的复杂度锁死在"读得懂一晚上"的量级。
2. **CSV 是归档真相，state.json 是缓存**：所有幂等都围绕 messageId（缺失则用 hash 兜底），COMMIT 顺序固定为 staging→final→CSV→state，启动时用 CSV 自愈未提交窗口。
3. **失败永远降级为 manual**：除 IMAP 连接和 state 写盘两个底线外，任何层抛错都把当前邮件丢进 pending 队列继续下一封，保证一次 `mfh run` 永远能跑完。

`mfh run` 会在结束时汇总本轮因 `network_retry_failed` 进入 pending 的邮件（hash/date/from/subject/reason），方便用户区分网络抖动与真实不支持的 vendor。
