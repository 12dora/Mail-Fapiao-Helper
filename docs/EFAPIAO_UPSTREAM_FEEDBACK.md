# efapiao 上游反馈清单

本文只记录可复现线索，不提交真实 PDF、邮件或发票内容。真实样本仍保留在本机 `.mfh-cache/`，该目录必须保持忽略。

## 2026-05-21: 小米之家 PDF rule_unhandled

- 本地样本文件: `.mfh-cache/run-year-plan1-6-final-20260521-151750/invoices/26317000000010839783.pdf`
- 队列 hash: `0995e04aa528`
- 邮件来源: `noreply@xiaomi.com`
- 邮件主题: `小米之家发票开具成功`
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
  --config .mfh-cache/run-year-plan1-6-final-20260521-151750/config.json \
  --force \
  --allow-parse-failures

node dist/index.js ocr summary \
  --config .mfh-cache/run-year-plan1-6-final-20260521-151750/config.json
```

预期：`OCR 失败` 从 1 降到 0，或错误原因从 `rule_unhandled` 收敛为更明确的 OCR vendor/渲染失败。

## 2026-05-22: v0.1.3 API 复核结论

- 最新稳定 release: `v0.1.3`，发布时间 `2026-05-22T04:36:16Z`。
- 新 API 能力: `hint_type=image`，支持 JPEG / PNG / GIF / WEBP / BMP；图片发票和图片航空行程单需要配置 OCR vendor。
- 新分流字段: 错误和成功响应都可能携带 `engine.ocr_required`、`engine.ocr_enabled`、`engine.ocr_vendor`，下游可据此区分“需要 OCR”、“未配置 OCR”与“规则无法覆盖”。
- 批量接口语义: `/v1/invoices/parse-batch` 对单个文件失败仍返回 HTTP 200，由 `items[].status/code/message` 判断逐项结果；本项目现有批量适配保持兼容。
- Release 资产: 上游发布 `darwin-arm64`、`linux-arm64`、`linux-x86_64`、`windows-x86_64` 的 `lite` 与 `with-model` 包；没有 `darwin-x86_64` release 资产。
- 本项目策略: 桌面版默认内置 macOS arm64 和 Windows x64 的 `lite` 包；用户可替换为同架构 `with-model` 包，程序自动探测二进制旁 `models/` 并启用 `cnocr`。Linux 暂不作为桌面安装包目标。
