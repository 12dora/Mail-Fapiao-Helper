# Mail Fapiao Helper — 设计文档

> 与 `ARCHITECTURE.md` 冲突时以架构文档为准。本文保留产品视角的需求与对照表。
> 配置示例以仓库根 `config.example.json` 为唯一权威，不在此复制第二份 JSON。

## 1. 目标

从用户邮箱中抓取含“发票”等关键词的邮件，先最大化下载并归档 PDF/OFD 等文档（安全命名、冲突处理），再可选 OCR 识别、保存识别结果，并按用户规则二次重命名或按类型整理。无法自动处理的邮件进入待确认队列。提供 **CLI + Electron 桌面应用**；Windows / macOS。

## 2. 非目标（明确不做）

- 不做账号体系、不做云同步、不做多用户
- 不做数据库（文件存状态与台账）
- 不做发票真伪校验、不做财务报表
- 不抽象“将来可能用到”的空接口

> 历史说明：早期 v1 曾规划“仅 CLI + pkg/SEA 打包”。当前产品形态为 Electron + electron-builder，并保留完整 CLI。

## 3. 技术栈

| 项 | 选择 | 理由 |
|---|---|---|
| 语言/运行时 | Node.js ≥20 + TypeScript | IMAP/HTTP/Playwright 生态；与 Electron 同语言 |
| 桌面壳 | Electron | 本机配置、摘要、操作互斥、无头测试契约 |
| 打包 | electron-builder | 双通道：stable 签名 / development 未签名 |
| IMAP | `imapflow` | 现代 async API |
| 邮件解析 | `mailparser` | 与 imapflow 配套 |
| 浏览器自动化 | `playwright` | 第三方开票站点下载（生产依赖，非仅测试） |
| OCR | 捆绑 `efapiao` + 可选腾讯云 | 默认本机离线 |
| 配置 | 单文件 `config.json`（schema v3） | 见 `config.example.json` |

## 4. 四类邮件处理对照

| 类型 | 典型来源 | 自动路径 | 失败时 |
|---|---|---|---|
| 直接附件 | 邮件 PDF/OFD 附件 | attachment extractor → 归档 | pending |
| 直链 | 邮件内直接下载 URL | directLink → 下载归档 | pending / 刷新链接 |
| 第三方站点 | 诺诺/百望/淘宝/JD 等 | site handler + Playwright | pending |
| 仅通知 | 无文件、仅入口 | — | pending（手动归档/忽略） |

## 5. 配置

- **权威示例**：[`config.example.json`](../config.example.json)
- schema v3：`output` 仅 `csv`；`paths` 提供 samples/invoices/pending
- 已移除：`llm`、`output.dir`、`output.pendingDir`、`playwright.browserManagement`
- 敏感字段：`imap.pass`、OCR 云凭据；POSIX 写盘 `0600`；原子写会产生 `.tmp-*` / `.corrupt-*` sidecar（已 gitignore）

## 6. 用户可见产品面

桌面端是一个五页的单窗口应用（React + Ant Design，hash 路由）。

| 入口 | 说明 |
|---|---|
| 开始处理 | 一次点击跑完抓取 → 取件 → 识别；时间范围、匹配范围、试运行、实时日志、本次结果 |
| 邮件记录 | 邮件清单与详情抽屉（附件、正文链接、归档文件、处理记录） |
| 发票库 | 归档文件总表与详情抽屉；默认「仅发票」，附属材料另有筛选；导出 CSV、清理重复、整理、识别 |
| 待确认 | 未走完的邮件队列：原因、下一步，逐封重试 / 手动归档 / 忽略，或整队重试 |
| 设置 | 邮箱 / 保存 / 识别 / 关于 四个标签页 |
| CLI | `mfh fetch` / `run` / `ocr run` / `organize` / `pending` / `dedupe` 等 |

## 7. 信任与发布（产品承诺）

- **稳定 Release**：签名 +（macOS）公证；仅 `vMAJOR.MINOR.PATCH`
- **未签名 prerelease**：明确标记、文件名含 `-unsigned`，不保证 Gatekeeper/SmartScreen 静默通过
- **开发 artifact**：workflow 上传，默认不进 Releases

详见 README 下载与发布章节。
