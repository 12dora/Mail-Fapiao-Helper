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
