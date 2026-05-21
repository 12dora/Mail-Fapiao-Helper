# Mail Fapiao Helper — 设计文档

> 与 `ARCHITECTURE.md` 冲突时以架构文档为准。本文保留产品视角的需求与对照表。

## 1. 目标

从用户邮箱中抓取含"发票"关键词的邮件，自动识别并下载 PDF 发票，按规则重命名归档；对无法自动处理的邮件留给用户手工处理。Windows / macOS 通用。

## 2. 非目标（明确不做）

- 不做账号体系、不做云同步、不做多用户
- 不做 GUI（v1 仅 CLI；如后续需要再用 Electron 包一层）
- 不做数据库（用文件存状态）
- 不做发票真伪校验、不做财务报表
- 不抽象任何"将来可能用到"的接口

## 3. 技术栈

| 项 | 选择 | 理由 |
|---|---|---|
| 语言/运行时 | Node.js 20 + TypeScript | IMAP/HTTP/Playwright/PDF 生态齐全；后续若要 Electron GUI 同语言无桥接 |
| IMAP | `imapflow` | 现代 async API |
| 邮件解析 | `mailparser` | 与 imapflow 配套 |
| 浏览器自动化 | `playwright` | 第三方站点跳转下载场景必需 |
| HTTP | 内置 `fetch` | 无需额外依赖 |
| 配置 | 单个 `config.json` | 用户要求单文件 |
| 打包 | `pkg` 或 `node --sea` | 产出 macOS / Windows 单文件可执行 |

## 4. 模块划分

```
src/
  index.ts              # CLI 入口，编排主流程
  config.ts             # 加载/校验 config.json
  state.ts              # 已处理 message-id、待人工队列（JSON 文件）
  mail/
    fetcher.ts          # IMAP 拉取 + 关键词过滤
  extract/
    types.ts            # Extractor 接口与 ExtractResult
    registry.ts         # Extractor 注册与按优先级匹配
    attachment.ts       # 情况 1：附件
    directLink.ts       # 情况 2：正文直链
    thirdParty.ts       # 情况 3：调度 SiteHandler
    llm.ts              # 情况 6（可选）：LLM 兜底
    manual.ts           # 情况 4：未识别 → 写入待人工队列
  sites/
    types.ts            # SiteHandler 接口（match(url) / handle(page)）
    registry.ts         # SiteHandler 注册表
    <vendor>.ts         # 每个第三方站点一个文件（按需新增）
  download/
    downloader.ts       # 下载 PDF；冲突时追加 -1 -2 后缀
  ocr/
    types.ts            # OcrProvider 接口
    registry.ts         # Provider 注册
    <vendor>.ts         # 每家 OCR 一个文件（按需新增）
  rename/
    rename.ts           # 按 config.renameRule 渲染文件名
  log.ts                # 简单分级日志
```

### 4.1 关键接口（最小化）

完整接口见 `ARCHITECTURE.md §2`。要点：

```ts
type ExtractResult =
  | { kind: 'pdf'; pdfs: PdfArtifact[] }    // 改：buffers → pdfs(含 source)
  | { kind: 'manual'; reason: string }
  | { kind: 'skip' };

interface SiteHandler {
  name: string;
  match(url: string): boolean;
  handle(page: Page, url: string, ctx: Ctx): Promise<PdfArtifact[]>;  // 改:加 ctx
}
```

注册表只是 `[].push()` + 按顺序匹配，不引入 DI 框架。

### 4.2 主流程（伪代码）

```
loadConfig() → connectImap() → searchByKeyword("发票")
for each mail not in state.processed:
  for each Extractor in registry (按优先级: attachment > directLink > thirdParty > llm > manual):
    if canHandle: result = extract(mail); break
  if result.kind == 'pdf':
    for each pdf: save → (optional ocr) → rename → append csv
  if result.kind == 'manual': enqueue to state.pending with raw .eml
  mark message-id processed
disconnect
```

## 5. 四类邮件处理对照

| 情况 | Extractor | 实现要点 |
|---|---|---|
| 1. 附件含 PDF/OFD | `attachment.ts` | 遍历 mail.attachments，contentType 含 pdf/ofd 或文件名 .pdf/.ofd；OFD 行程单归档后进入 OCR 待识别队列 |
| 2. 正文直链 | `directLink.ts` | 提取 `<a href>`，HEAD 探测 Content-Type=application/pdf 或 .pdf 后缀，命中即下载 |
| 3. 第三方站点 | `thirdParty.ts` + `sites/*` | 遍历正文链接，按 SiteHandler.match 命中后用 Playwright 跑脚本 |
| 4. 未识别 | `manual.ts` | 把 .eml 原文写入 `pending/<messageId>.eml`，写一行索引到 `pending.csv` |

## 6. 配置文件（`config.json` 示例）

```json
{
  "imap": {
    "host": "imap.example.com",
    "port": 993,
    "user": "me@example.com",
    "pass": "***",
    "tls": true,
    "mailbox": []
  },
  "filter": {
    "keywords": ["发票"],
    "matchSubject": true,
    "matchBody": true,
    "sinceDays": 30
  },
  "output": {
    "dir": "./invoices",
    "pendingDir": "./pending",
    "csv": "./invoices.csv"
  },
  "rename": {
    "rule": "{seller}-{amount}.pdf",
    "fallback": "{date}-{messageId}.pdf"
  },
  "ocr": {
    "enabled": false,
    "provider": "baidu",
    "credentials": { "apiKey": "", "secretKey": "" }
  },
  "llm": {
    "enabled": false,
    "provider": "anthropic",
    "model": "claude-haiku-4-5-20251001",
    "apiKey": ""
  },
  "playwright": {
    "headless": true,
    "timeoutMs": 30000
  },
  "network": {
    "retries": 3,
    "retryDelayMs": 1000
  }
}
```

`imap.mailbox` 可填字符串数组；空数组表示扫描 IMAP `LIST` 返回的全部 mailbox。旧格式 `"INBOX"` 仍兼容，会被当作 `["INBOX"]`。

## 7. 状态与防重

- `state.json`：`{ processedHashes: string[] }`，键为 `msgIdHash = sha1(messageId || from+date+subject).slice(0,12)`（Message-Id 可能缺失）
- 启动时与 `invoices.csv` 的 messageId 列求并集自愈，CSV 才是归档真相（详见 `ARCHITECTURE.md §5`）
- 同一封邮件可包含 PDF 发票和 OFD 行程单；`invoices.csv` 以 `messageId + source` 去重，OFD 另写 `invoices/ocr/ocr-pending.csv` 等待后续 OCR 识别引擎
- `pending.csv`：未识别邮件清单（messageId, subject, from, date, reason）
- 网络抖动：直链与第三方站点 HTTP 请求按 `network.retries` 重试；仍失败会写入 `pending.csv`，reason 含 `network_retry_failed`，并在 `mfh run` 结束时列出失败邮件
- GUI 待处理队列按 `network_retry_failed` 单独分组，运行控制台展示重试日志与最终失败汇总
- 命名冲突：`name-1.pdf`、`name-2.pdf` 递增；CSV 追加前以 messageId 查重，避免 FINALIZED→COMMIT 窗口产生重复行
- 并发：单封邮件串行处理，无并发池（详见 `ARCHITECTURE.md §6`）

## 8. 可扩展性（仅这两个扩展点）

1. **新第三方站点** → 在 `sites/` 加一个文件，导出 SiteHandler，registry 里追加一行
2. **新 OCR 厂商** → 在 `ocr/` 加一个文件，导出 OcrProvider，registry 里追加一行

不预留其他扩展点。

## 9. 跨平台

- 全部 I/O 用 `path.join`、`os.homedir()`
- Playwright 自带 Chromium 跨平台
- 用 `pkg` 或 `node --sea` 产出 `mfh-macos`、`mfh-win.exe`

## 10. 安全

- `config.json` 含密码：建议 `chmod 600`，README 提醒；不入库
- IMAP 仅使用 TLS
- Playwright 沙箱默认开启
