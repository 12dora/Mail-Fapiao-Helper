# Coding Agent 启动提示词

> 复制 ↓ 下面整段（含分隔线之间）给 Coding Agent。
> 第一次只跑 Phase 0 + Phase 1，不要让它一口气写到 Phase 5。

---

你是这个仓库的实现者。先做三件事再动手：

1. 完整读 `docs/ARCHITECTURE.md`（规约，冲突以它为准）
2. 读 `docs/DESIGN.md`（产品视角与对照表）
3. 读 `docs/NEXT_STEPS.md`（分阶段路线）

## 硬约束（违反即返工，不要争辩）

- 不引入 DI 容器、插件框架、装饰器注册、自动发现
- 注册表就是 `const handlers: SiteHandler[] = []; handlers.push(x)`，顺序匹配
- 不引入数据库，状态只用 `state.json` + `invoices.csv` + `pending.csv`
- 单一配置文件 `config.json`，禁止拆分成多文件
- LLM / OCR 默认关闭，是可选模块，不写就是不写
- 接口字段严格按 `ARCHITECTURE.md §2`，不要加 `priority/init/dispose/login/version`
- 不预留"将来可能"的接口；YAGNI 是硬性的
- 单封邮件**串行**处理，不要写 `p-limit` / `Promise.all` 批处理
- 不写多余注释、不写中文文档块、不写 README 章节，除非我让你写
- 任何 Extractor / SiteHandler / OCR 抛错 → 当前邮件走 manual，主循环继续

## 本轮任务范围

**只做 `docs/NEXT_STEPS.md` 的 Phase 0 + Phase 1**。

完成定义：
- `npm`/`tsconfig`/最小 lint 配置就位
- 目录骨架按 `DESIGN.md §4` 建好，空文件用空 `export {}` 占位
- `src/config.ts`：加载 + 校验 `config.json`（缺字段直接抛，错误信息要具体到字段）
- `src/state.ts`：唯一 state.json 读写者，`tmp + rename` 原子写
- `src/mail/fetcher.ts`：IMAP 连接、SEARCH（SUBJECT/BODY 含关键词、SINCE N 天）、产出 `.eml` 原文
- `mfh fetch` 子命令：命中邮件落到 `samples/raw/<YYYY-MM>/<msgIdHash>.eml`，同时追加 `samples/raw/INDEX.csv`（messageId,date,from,subject,hasAttachment,bodyLinkCount）
- `state.json` 记 `processedHashes`，重跑只增量拉
- `mfh --help` / `mfh fetch --help` 能跑

**本轮不要写**：任何 Extractor、SiteHandler、download、rename、ocr、llm、playwright 相关代码。文件占位即可。

## 工作纪律

1. **先列计划，等我确认再动键盘**。计划要包含：依赖清单、`mfh` CLI 的命令解析方案（建议 `commander` 或手写，挑一个说理由）、msgIdHash 实现位置。
2. **样本驱动**：没有真实 .eml 不写任何 Extractor / SiteHandler。本轮不到这一步。
3. **幂等点遵守 `ARCHITECTURE.md §5`**：所有写操作崩溃后能重跑。
4. **遇到 ARCHITECTURE.md 没写清楚的地方就问我，不要自己发明**。
5. 完成后跑一遍：`mfh --help`、`mfh fetch --dry-run`（若你设计了该 flag），把实际输出贴给我。

## 完成回执格式

只要这三段，不要总结、不要"未来展望"：

```
[变更文件]
- path/to/x.ts (新增 / 修改: 行数)
...

[如何验证]
- 命令 1
- 命令 2

[未解决的问题 / 需要我确认的]
- 1.
- 2.
```

现在开始：先输出你的"计划"，等我回复 "go" 再写代码。

---
