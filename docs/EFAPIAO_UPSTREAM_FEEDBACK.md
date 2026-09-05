# efapiao 上游反馈清单

本文只记录可复现线索，不提交真实 PDF、邮件或发票内容。真实样本仍保留在本机 `.mfh-cache/`，该目录必须保持忽略。

## 2026-05-21: 示例商户 PDF rule_unhandled

- 本地样本文件: `.mfh-cache/run-example-20260521/invoices/00000000000000000007.pdf`
- 队列 hash: `samplehash0001`
- 邮件来源: `noreply@example-merchant.test`
- 邮件主题: `示例商户发票开具成功`
- 邮件日期: `2026-03-09T13:00:34.000Z`
- 当前 efapiao 返回: `rule_unhandled`
- 完整错误: `规则引擎无法解析该 PDF：文本层不可用或版式未覆盖且未找到二维码；当前未配置 OCR vendor`

建议上游处理：

1. 将该 PDF 作为 efapiao 私有 fixture 回归，不要提交到公开仓库。
2. 先确认文本层是否为空；若为空，继续确认渲染后二维码扫描路径是否覆盖该版式。
3. 如果确无二维码，给该版式补 OCR fallback 策略，并在启用 OCR vendor 后验证 `source.extracted_by` 是否能落到 `ocr`。
4. 修复后用本项目命令回归：

```bash
node dist/index.js ocr run \
  --config .mfh-cache/run-example-20260521/config.json \
  --force \
  --allow-parse-failures

node dist/index.js ocr summary \
  --config .mfh-cache/run-example-20260521/config.json
```

预期：`OCR 失败` 从 1 降到 0，或错误原因从 `rule_unhandled` 收敛为更明确的 OCR vendor/渲染失败。

## 2026-05-22: v0.1.3 API 复核结论

- 最新稳定 release: `v0.1.3`，发布时间 `2026-05-22T04:36:16Z`。
- 新 API 能力: `hint_type=image`，支持 JPEG / PNG / GIF / WEBP / BMP；图片发票和图片航空行程单需要配置 OCR vendor。
- 新分流字段: 错误和成功响应都可能携带 `engine.ocr_required`、`engine.ocr_enabled`、`engine.ocr_vendor`，下游可据此区分“需要 OCR”、“未配置 OCR”与“规则无法覆盖”。
- 批量接口语义: `/v1/invoices/parse-batch` 对单个文件失败仍返回 HTTP 200，由 `items[].status/code/message` 判断逐项结果；本项目现有批量适配保持兼容。
- Release 资产: 上游发布 `darwin-arm64`、`linux-arm64`、`linux-x86_64`、`windows-x86_64` 的 `lite` 与 `with-model` 包；没有 `darwin-x86_64` release 资产。
- 本项目策略: 桌面版默认内置 macOS arm64 和 Windows x64 的 `lite` 包；用户可替换为同架构 `with-model` 包，程序自动探测二进制旁 `models/` 并启用 `cnocr`。Linux 暂不作为桌面安装包目标。

## 2026-09-05: v0.1.4 桌面接入

- macOS arm64 已接入本地构建的 v0.1.4 lite；支持 supporting 文档分类、OFD 发票解析与 items v2。
- capabilities 报告 PDF `supported`、OFD `partial_supported`、image `not_implemented`；列出 `pdf-supporting`、`ofd-supporting`、`image-supporting` 与 `ofd-fapiao`，不能把类别声明理解为所有版式均可解析。
- CSV 继续直接使用引擎响应中的 `source.parser_version` 和 `source.ocr_vendor`；items v2 不改变现有汇总字段映射。
- Windows v0.1.4 资产尚未发布，桌面 Windows 仍打包 v0.1.3 lite；待用户推送上游 tag、release 工作流完成后，通过 `scripts/fetch-efapiao.mjs` 校验下载并按 vendor README 升级打包配置。
- 本地真实文件临时副本回归：数电普票 PDF、收费公路通行费电子票据汇总单 PDF、OFD 均为 `success`；汇总单映射为 `supporting`，OFD 票号/销售方/金额齐全。普票 PDF 的 `parser_version` 为 `0.1.0`，汇总单与 OFD 为 `0.1.4`，三者 `ocr_vendor` 均为空；保留引擎原始报告值。临时目录已删除，真实数据目录未写入。
