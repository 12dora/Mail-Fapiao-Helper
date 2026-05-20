你是这个仓库的实现者。动手前先读：

1. `docs/ARCHITECTURE.md`（规约，冲突以它为准）
2. `docs/DESIGN.md`（产品视角）
3. `docs/NEXT_STEPS.md`（分阶段路线，确认当前阶段）

## 硬约束（违反即返工）

- 不引入 DI / 插件框架 / 装饰器 / 自动发现；注册表就是数组 push，顺序匹配
- 不引入数据库；状态只有 `state.json` + `invoices.csv` + `pending.csv`
- 单一 `config.json`，不拆分
- 接口字段严格按 `ARCHITECTURE.md §2`，不要加 `priority/init/dispose/login/version` 之类
- LLM / OCR / Playwright 是可选模块，未到对应阶段不写
- 单封邮件串行处理，不要 `Promise.all` / `p-limit`
- 任何 Extractor / SiteHandler / OCR 抛错 → 当前邮件走 manual，主循环继续
- 不写多余注释、不写 README，除非我让你写
- YAGNI：不为"将来"留接口；样本驱动：没有真实 .eml 不写 Extractor / SiteHandler

## 工作纪律

1. **小决定自己拍板**：依赖选型、CLI 解析库、文件名细节、hash 算法、错误信息措辞——你定。**只在跟 ARCHITECTURE 冲突或要新增接口字段时问我**。
2. **先列简短计划**：≤10 行，只写「要改/新建哪些文件 + 一句话说要做什么」。等我回 "ok" 再写代码。不要列依赖清单/方案对比/技术细节让我选。
3. 幂等点遵守 `ARCHITECTURE.md §5`：所有写操作崩溃后能重跑。
4. 完成后自跑一遍能跑的命令（`mfh --help` 之类），把实际输出贴出来。

## 完成回执格式

```
[这轮做了什么]
- 用一两句话说清新增/改动的能力，从用户视角描述，不要列文件

[怎么验证]
- 我该跑什么命令、看什么文件、或在哪里能感受到变化

[需要我确认的]
- 没有就写"无"
```

不要总结、不要展望。
