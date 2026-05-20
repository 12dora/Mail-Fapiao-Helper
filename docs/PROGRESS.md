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
- [ ] `mfh pending list` 子命令 (Phase 3 之后才落地)
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

## 下一步入口 (Phase 3)

附件提取器实现:
- 读取 `docs/SAMPLE_ANALYSIS.md` 了解附件型邮件特征
- 实现 `src/extract/attachment.ts`: 从 .eml 提取 PDF 附件
- 实现 `src/cmd/run.ts`: `mfh run` 子命令,遍历 `samples/raw/` 调用提取器
- 产出 `invoices/<YYYY-MM>/<seller>-<amount>.pdf`
- 更新 `invoices.csv` 记录提取结果
