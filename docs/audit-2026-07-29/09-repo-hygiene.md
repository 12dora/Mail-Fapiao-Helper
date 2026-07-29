# 仓库卫生与死重审查报告
审查日期：2026-07-29 ｜ 审查基线：`504187d`（`main` / `v0.0.5-unsigned.1`）｜审查范围：`.gitignore`、`package.json`、`package-lock.json` 根依赖与锁定版本、`config.example.json`、本机 `config.json`/`state.json` 的权限与键形状（值已脱敏）、`README.md`、`gui-design/README.md`、`docs/{ARCHITECTURE,DESIGN,PROGRESS,NEXT_STEPS,HANDOFF_2026-07-27,CODING_AGENT_PROMPT,QA_DEFECT_REPORT_2026-05-22,SAMPLE_ANALYSIS,EFAPIAO_UPSTREAM_FEEDBACK,CODE_REVIEW_FINDINGS_2026-07-27}.md`、`scripts/*.mjs`、`.github/workflows/{ci,release,dev-build,unsigned-prerelease}.yml`、`.claude/settings.local.json`、`src/{config,index,state,pipeline}.ts`、`src/electron/main.ts`、`src/download/archiveJournal.ts`、`src/extract/{types,registry}.ts`、`src/mail/fetcher.ts`、`src/ocr/efapiao.ts`、`src/sites/common.ts`、`gui-design/tests/{cli-regression,electron-ipc-fixture}.mjs`，以及 Git 跟踪/忽略/历史、GitHub 仓库可见性/分支保护/Ruleset/Actions/Release/Secrets 元数据。按约束只列目录与尺寸，未读取 `node_modules/`、`dist/`、`release/`、`.mfh-cache/`、发票/图片/安装包等二进制内容。

## 摘要

当前仓库的运行产物隔离总体比表象健康：25 张本地发票、OCR CSV、邮箱凭据、状态、1.4 GB 缓存、`dist/` 与 `release/` 均未被 Git 跟踪，且这些路径历史提交数为 0。
最严重的问题反而在已跟踪文本中：公开 GitHub 仓库提交了真实样本的发票号、商户、金额、邮件主题、Message-Id 和本机缓存定位信息，测试里也固化了一行高度具体的真实票面数据；这需要删除当前内容并净化历史。
第二，`.gitignore` 只忽略主配置/状态文件，没有覆盖代码会生成的含凭据临时文件和损坏备份，源代码运行时存在误提交敏感副本的确定路径。
第三，README 仍保证 Releases 页面不会出现未签名包，但当前公开 Release 已由 `unsigned-prerelease.yml` 发布未签名安装包；这会直接误导非技术用户的信任判断。
正式发布 workflow 还有独立的通道漏洞：手动 dispatch 可接受 `vX.Y.Z-beta`/`vX.Y.Z-unsigned.N`，最终却强制发布为 `prerelease: false`。
依赖侧没有可确认的废包；`playwright` 是第三方开票站点的生产运行时依赖，`npm audit --omit=dev` 当前为 0。
建议先做隐私止血与历史净化，再修 `.gitignore` 和发布文案/规则，最后收敛已失真的“权威”架构文档与一次性交接文档。

## findings 汇总表

| ID | 严重度 | 标题 | 位置 |
|---|---|---|---|
| HYG-01 | P0 | 公开 Git 历史提交了真实发票与邮件元数据 | `docs/SAMPLE_ANALYSIS.md:104-105`；`docs/PROGRESS.md:228-233`；`docs/EFAPIAO_UPSTREAM_FEEDBACK.md:7-13`；`gui-design/tests/cli-regression.mjs:323-326` |
| HYG-02 | P1 | `.gitignore` 漏掉含凭据的临时文件/损坏备份及实际本机残留 | `.gitignore:9-18`；`src/electron/main.ts:321-355`；`src/state.ts:136-156`；`.claude/settings.local.json:4-11` |
| HYG-03 | P1 | README 的“Releases 全部签名”保证与现有未签名公开 prerelease 冲突 | `README.md:58-71`；`README.md:263-268`；`.github/workflows/unsigned-prerelease.yml:226-240` |
| HYG-04 | P1 | 正式发布 workflow 接受 prerelease tag，却发布成稳定 Release | `.github/workflows/release.yml:15-25`；`.github/workflows/release.yml:117-120`；`.github/workflows/release.yml:347-355` |
| HYG-05 | P2 | CI 会运行但不保护 `main`，合并/直推没有必过检查 | `.github/workflows/ci.yml:3-16` |
| HYG-06 | P1 | 被标为“上层规约/最终接口”的文档仍描述已删除契约和旧流水线 | `docs/ARCHITECTURE.md:3-4`；`docs/ARCHITECTURE.md:111-136`；`docs/DESIGN.md:9-27`；`docs/DESIGN.md:123-165` |
| HYG-07 | P2 | 顶层 docs 混放已完成路线、过期交接和一次性代理提示，且 README 仍将其当现行文档 | `README.md:305-310`；`docs/NEXT_STEPS.md:87-105`；`docs/HANDOFF_2026-07-27.md:48-71`；`docs/CODING_AGENT_PROMPT.md:1-18` |

## 详细发现

### HYG-01 公开 Git 历史提交了真实发票与邮件元数据
- 严重度：P0
- 位置：`docs/SAMPLE_ANALYSIS.md:104-105`；`docs/PROGRESS.md:228-233`；`docs/EFAPIAO_UPSTREAM_FEEDBACK.md:7-13`；`gui-design/tests/cli-regression.mjs:323-326`
- 置信度：CONFIRMED
- 证据：
  ```text
  1. **诺诺网** (`invoice@info.nuonuo.com`)
     - Subject: 您收到一张【很久以前餐饮管理（上海）有限公司】开具的发票
  ```
  ```js
  上海德玺楼餐饮有限公司,188.00
  ```
- 说明：以上均为原行的短 verbatim 子串；引用刻意停在完整票号之前，避免本报告再复制一份敏感标识。
- 问题：`git ls-files` 确认上述四个文件均被跟踪；`gh repo view` 确认 `12dora/Mail-Fapiao-Helper` 为 `PUBLIC`。这些不是匿名的通用测试值：文档把真实邮件主题、完整发票号码、商户、金额、邮件日期、Message-Id、样本 hash、本机缓存目录串在一起，测试又固化了完整商户/金额/日期/票号组合。删除当前文件不能清除已有 commit、tag 和 GitHub 自动生成的源码归档。前次 62 项审查未报告此项，这是本次新发现。
- 建议修复：立即暂停继续公开分发，先将仓库临时设为 private 或冻结访问；删除 `docs/SAMPLE_ANALYSIS.md`、`docs/PROGRESS.md` 中的逐票/逐邮件细节，净化 `docs/EFAPIAO_UPSTREAM_FEEDBACK.md`，把测试行替换成明显虚构的商户、金额和票号。随后在一次协调好的维护窗口用 `git filter-repo` 清除这些路径/字符串的全部历史并重写所有公开 tag；通知协作者重新 clone，并检查 fork、Release 源码归档和外部缓存。历史重写命令见文末，必须由人批准。

### HYG-02 `.gitignore` 漏掉含凭据的临时文件/损坏备份及实际本机残留
- 严重度：P1
- 位置：`.gitignore:9-18`；`src/electron/main.ts:321-355`；`src/state.ts:136-156`；`.claude/settings.local.json:4-11`
- 置信度：CONFIRMED
- 证据：
  ```gitignore
  config.json
  state.json
  state*.json
  samples/
  invoices/
  invoices.csv
  pending/
  pending.csv
  .mfh-cache/
  ```
  ```ts
  const tmpPath = `${configPath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 });
  // ...
  const backup = `${configPath}.corrupt-${Date.now()}.json`;
  if (fs.existsSync(configPath)) fs.copyFileSync(configPath, backup);
  ```
  ```ts
  const backupPath = `${path}.corrupt-${stamp}.bak`;
  renameSync(path, backupPath);
  ```
- 问题：当前规则只匹配主文件，不匹配 `config.json.tmp-*`、`config.json.corrupt-*.json`、`state.json.<pid>.<rand>.tmp`、`state.json.corrupt-*.bak`。配置临时文件和损坏副本含完整 IMAP 授权码，代码明确会生成它们；一旦出现在仓库工作目录，`git status` 会把它们当普通未跟踪文件。另有实际存在的 `.claude/settings.local.json`，内含 `/Users/konata/...` 绝对路径和 `Bash(git commit *)` 本机授权；它仅被 `/Users/konata/.config/git/ignore` 全局规则遮住，换一台机器就失去保护。空的 `tmp/pdfs/` 也既未跟踪又未忽略。`scripts/compose-release-notes.mjs:24-29` 默认还会在根目录生成未忽略的 `release-artifacts/` 与 `release-notes.md`。
- 建议修复：在仓库自身 `.gitignore` 精确加入：
  ```gitignore
  # local scratch / agent state
  tmp/
  .claude/settings.local.json

  # sensitive atomic-write / corruption sidecars
  config.json.tmp-*
  config.json.corrupt-*.json
  state*.json.*.tmp
  state*.json.corrupt-*.bak

  # generated release-note workspace
  release-artifacts/
  release-notes.md
  ```
  同时删除当前空 `tmp/` 和本机 `.claude/settings.local.json`，或将后者留在仓库外。不要用 `config*.json` 这类过宽规则，否则会把应跟踪的 `config.example.json` 一起遮蔽。

### HYG-03 README 的“Releases 全部签名”保证与现有未签名公开 prerelease 冲突
- 严重度：P1
- 位置：`README.md:58-71`；`README.md:263-268`；`.github/workflows/unsigned-prerelease.yml:226-240`
- 置信度：CONFIRMED
- 证据：
  ```md
  [Releases](../../releases) 页面上的安装包由发布流水线签名
  ```
  ```md
  > **未签名的开发构建不会出现在 Releases 页面。**
  ```
  ```yaml
  - name: Publish GitHub prerelease
    uses: softprops/action-gh-release@v2
    with:
      prerelease: true
      files: |
        release-artifacts/*-unsigned.dmg
        release-artifacts/*-unsigned.zip
        release-artifacts/*-unsigned.exe
  ```
- 问题：workflow 明确把未签名安装包发布到 GitHub Releases；`gh release view v0.0.5-unsigned.1` 又确认公开 prerelease 已存在，包含 `*-unsigned.dmg/.zip/.exe`。README 不仅漏写了这个新通道，还在下载入口和信任说明中作出相反的绝对保证；`README.md:267` 进一步声称 development 通道“永远不会变成 Release”。目标用户不会区分 workflow artifact、prerelease 和 stable release，这会让他们把操作系统的 Gatekeeper/SmartScreen 警告误判为异常，或错误相信未签名包已有开发者身份背书。
- 建议修复：把“Releases”拆成“稳定 Release”和“未签名 prerelease”两个清晰入口；下载表默认只链接 GitHub 标记的 latest stable，并在 prerelease 行直接写“未签名、未公证、公司电脑不建议安装”。将第 64、267、279-285 行同步到 `unsigned-prerelease.yml` 的真实行为，并把第 60 行限定为“稳定通道安装包”。不要只在 release notes 内警告，因为用户可能从资产列表直接下载。

### HYG-04 正式发布 workflow 接受 prerelease tag，却发布成稳定 Release
- 严重度：P1
- 位置：`.github/workflows/release.yml:15-25`；`.github/workflows/release.yml:117-120`；`.github/workflows/release.yml:347-355`
- 置信度：CONFIRMED
- 证据：
  ```yaml
  workflow_dispatch:
    inputs:
      tag:
        description: '已存在的发布 tag，例如 v0.1.0（必须已推送，且 semver 与 package.json 一致）'
  ```
  ```bash
  if ! printf '%s' "${TAG}" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$'; then
  ```
  ```yaml
  draft: false
  prerelease: false
  ```
- 问题：tag push 只排除了名称含 `-unsigned` 的自动触发；`workflow_dispatch` 没有对应排除。resolve 正则又明确接受任意 prerelease 后缀，因此 `v1.2.3-beta`，甚至手动输入 `v0.0.5-unsigned.1`，只要与 `package.json` 一致，就会进入 `channel=stable` 并发布为 `prerelease: false`。这破坏了刚建立的稳定/未签名双通道边界，也可能让 GitHub 把测试版本当稳定更新来源。前次 CODE-05B 的“tag 与构建 SHA 对齐”已修复；这是修复后新增的版本通道漏洞。
- 建议修复：正式 workflow 的 resolver 只接受无后缀 `vMAJOR.MINOR.PATCH`：
  ```bash
  '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
  ```
  并在 `build-release.mjs` 的 `channel === 'stable'` 分支再做一次 `pkg.version` 不含 prerelease 后缀的 fail-closed 校验，避免 workflow 被改坏后绕过。所有带后缀 tag 只能交给显式 prerelease workflow，发布标记必须由 tag/version 推导而不是手写常量。

### HYG-05 CI 会运行但不保护 `main`，合并/直推没有必过检查
- 严重度：P2
- 位置：`.github/workflows/ci.yml:3-16`
- 置信度：CONFIRMED
- 证据：
  ```yaml
  on:
    push:
      branches:
        - main
    pull_request:

  concurrency:
    group: ci-${{ github.workflow }}-${{ github.ref }}
    cancel-in-progress: true
  ```
- 问题：workflow 本身覆盖 macOS/Windows 的 `npm test` 和独立 Chromium E2E，内容是有效的；但 GitHub API 返回 `Branch not protected`，仓库 Ruleset 列表为空。因此它对 `main` 只是 PR/直推后的状态报告，不能阻止失败代码合并或直接 push。正式/未签名发布 workflow 会重新跑测试，所以当前发布物仍有独立门禁；缺口集中在主分支集成质量。此项与前次 CODE-01 相关，但不是重报：测试和 CI 已接好，尚缺的是仓库级 required checks。
- 建议修复：为 `main` 启用 branch protection 或 repository ruleset，至少要求 `Typecheck + tests (macOS arm64)`、`Typecheck + tests (Windows x64)`、`Browser E2E (Chromium)` 成功，要求 PR、阻止 force-push，并让管理员也受规则约束。若仍允许维护者紧急直推，应使用有审计记录的 bypass，而不是保持整条分支无保护。

### HYG-06 被标为“上层规约/最终接口”的文档仍描述已删除契约和旧流水线
- 严重度：P1
- 位置：`docs/ARCHITECTURE.md:3-4`；`docs/ARCHITECTURE.md:111-136`；`docs/ARCHITECTURE.md:239-264`；`docs/DESIGN.md:9-27`；`docs/DESIGN.md:123-165`
- 置信度：CONFIRMED
- 证据：
  ```md
  > 本文是 DESIGN.md 的"上层规约"。冲突时以本文为准。
  ```
  ```md
  单封邮件的处理是一次"伪事务"，提交点是 **state.json 写回**。
  ```
  ```json
  "output": {
    "dir": "./invoices",
    "pendingDir": "./pending",
    "csv": "./invoices.csv"
  },
  "llm": {
    "enabled": false
  }
  ```
- 问题：生产代码已经变为“运行所有匹配 extractor 并组合结果”（`src/pipeline.ts:430-488`）、持久化 archive journal 事务（`src/download/archiveJournal.ts:6-21`）、以 `(messageId, source, contentHash)` 协调归档（`src/pipeline.ts:200-220`），而架构文档仍写“首个匹配”“伪事务”“messageId + source”。`src/config.ts:8-27` 明确在 schema v3 删除 `output.dir`、`output.pendingDir`、`llm` 和 `playwright.browserManagement`，DESIGN 的配置示例仍教人填写它们。文档还写“v1 不做 GUI”和用 `pkg/node --sea` 打包，当前实际是 Electron + electron-builder；ARCHITECTURE 风险表又承诺桌面版“随应用准备浏览器”，与 `src/index.ts:57-92` 的“不会自动准备浏览器”相反。由于 `docs/CODING_AGENT_PROMPT.md:3-4` 把这些文档指定为规约，维护者照文档实现会重新引入前次已修复的问题。前次 CODE-08 的生产 schema 已修好，但文档契约没有闭环。
- 建议修复：不要继续局部补丁；以当前 `src/extract/types.ts`、`runExtractors()`、archive journal、data-dir lock、schema v3、Electron IPC 和发布双通道为事实源重写 ARCHITECTURE/DESIGN。配置示例只引用 `config.example.json`，不复制第二份 JSON。将“历史决策”移入有日期的 ADR，ARCHITECTURE 只保留当前不变量，并加一次文档契约测试（至少校验示例配置可通过 `validateConfigCandidate()`）。

### HYG-07 顶层 docs 混放已完成路线、过期交接和一次性代理提示，且 README 仍将其当现行文档
- 严重度：P2
- 位置：`README.md:305-310`；`docs/NEXT_STEPS.md:87-105`；`docs/HANDOFF_2026-07-27.md:48-71`；`docs/CODING_AGENT_PROMPT.md:1-18`；`docs/QA_DEFECT_REPORT_2026-05-22.md:50-58`
- 置信度：CONFIRMED
- 证据：
  ```md
  - [docs/PROGRESS.md](docs/PROGRESS.md) — 各阶段实现进度
  ```
  ```md
  ## 建议立刻执行的第一条命令

  > "按 Phase 0 + Phase 1 实现脚手架与纯邮件抓取功能
  ```
  ```md
  ## 未完成：codex 第二轮复核 + push
  ```
- 问题：`NEXT_STEPS.md` 仍让代理从 Phase 0 开始并计划用 `pkg` 打包；`HANDOFF_2026-07-27.md` 仍说尚未 push，但 Git 元数据确认 `origin/main`、HEAD 和 `v0.0.5-unsigned.1` 已在同一 commit；它还硬编码 `/Users/konata/code/...`。`CODING_AGENT_PROMPT.md` 引用大小写错误且不存在的 `docs/progress.md`，并包含已经完成的阶段限制。QA 报告仍引用已重命名的 `electron-full-flow.mjs`。这些文件不是当前产品文档，而是一次性过程记录；继续放在顶层并由 README 推荐，会让新维护者选错任务、命令和架构。
- 建议修复：按文末“文档处置矩阵”执行。当前状态只保留一份短 `STATUS.md` 或 issue/milestone；一次性审查、QA、交接移到 `docs/archive/<date>/` 并从 README 的“当前文档”中移除；包含敏感元数据的文件不能仅移动，必须先净化历史。

## 仓库产物盘点

以下状态来自 `git ls-files`、`git check-ignore -v --no-index` 和 `git log --all -- <path>`；未打印任何凭据或票据正文。

| 项目 | 当前状态 | Git 历史 | 体积/内容观察 | 处置结论 |
|---|---|---|---|---|
| `.DS_Store`（根、`src/`、`gui-design/`、`invoices/`、`samples/`、`vendor/`） | 未跟踪；由 `.gitignore:21` 忽略 | 0 次提交 | 多个 Finder 元数据文件 | 本机删除；现有 ignore 足够 |
| `invoices/`、`invoices.csv`、`invoices/ocr/*.csv` | 未跟踪；由 `.gitignore:14-15` 忽略 | 0 次提交 | 25 个 PDF，约 2.6 MB，另有 OCR/台账 CSV | 属于真实用户数据；保留或迁出仓库，未经用户确认不要删除；无需 `git rm --cached` |
| `config.json` | 未跟踪；由 `.gitignore:10` 忽略 | 0 次提交 | `0600`；`imap.host/user/pass` 均为非空真实值，值未输出；本地文件仍是旧 schema 形状 | 可供 CLI 本地使用，最好迁到仓库外；主文件保护正确，sidecar 缺口见 HYG-02 |
| `state.json` | 未跟踪；由 `.gitignore:11-12` 忽略 | 0 次提交 | `0644`，894 B | 派生状态，可保留；下次由当前代码写回会收紧权限；sidecar 缺口见 HYG-02 |
| `.mfh-cache/` | 未跟踪；由 `.gitignore:18` 忽略 | 0 次提交 | 14 个顶层 run 目录，约 1.4 GB，含真实邮件/下载 PDF | 若仍用于回归则迁到加密/受控位置；不再需要时经人工确认后删除 |
| `samples/` | 未跟踪；由 `.gitignore:13` 忽略 | 0 次提交 | 约 3.7 MB，真实邮件样本 | 与 `.mfh-cache/` 同级敏感；不要公开提交 |
| `tmp/` | 未跟踪、未忽略 | 0 次提交 | 仅空 `tmp/pdfs/` | 删除并加入 `tmp/` ignore |
| `dist/` | 未跟踪；由 `.gitignore:5` 忽略 | 0 次提交 | 约 1.1 MB | 可随时删除重建，不入库 |
| `release/` | 未跟踪；由 `.gitignore:6` 忽略 | 0 次提交 | 约 572 MB；文件名为 `0.0.5-unsigned.1` 的 dmg/zip，与当前版本一致 | 验证/上传完成后可删除，本地不入库 |
| `node_modules/` | 未跟踪；由 `.gitignore:2` 忽略 | 0 次提交 | 约 436 MB | 标准依赖缓存；需要回收空间时可删除，之后用 lockfile 重装 |
| `vendor/` | 6 个文件被跟踪；未忽略 | 持续跟踪 | 约 36 MB，含 macOS arm64/Windows x64 `efapiao` 0.1.3 | 保留；`package.json:77-84,109-113` 明确按平台打包，属于产品运行时而非垃圾 |
| `docs/screenshots/*.png` | 6 个文件被跟踪 | 持续跟踪 | README 每张均有引用 | 保留；由 `scripts/take-screenshots.mjs` 生成 |
| `.claude/settings.local.json` | 未跟踪；仅被用户全局 ignore | 0 次提交 | 本机命令授权和绝对路径 | 删除或加仓库级 ignore，不能依赖个人全局配置 |

## 依赖、脚本、配置与工作流结论

### 依赖

| 依赖 | 真实用途 | 结论 |
|---|---|---|
| `adm-zip` / `@types/adm-zip` | `src/sites/common.ts:1` 导入并受条目数/尺寸保护 | 保留 |
| `imapflow` | `src/mail/fetcher.ts:1` 与 `src/electron/main.ts:10` 的 IMAP 连接 | 保留 |
| `mailparser` / `@types/mailparser` | `src/mail/fetcher.ts:2` 实际解析邮件，多个 extractor 使用类型 | 保留 |
| `playwright` | `src/index.ts:4,64-92` 在生产 CLI 启动浏览器；各站点 handler 使用 `Page` | 必须留在 `dependencies`；不是仅测试依赖 |
| `electron`、`electron-builder`、`typescript`、`@types/node` | Electron 开发/测试、打包脚本、编译与类型 | 均有项目入口，保留在 devDependencies |

没有确认可 `npm uninstall` 的包。当前锁定版本为 `adm-zip 0.6.0`、`linkify-it 5.0.2`、`nodemailer 9.0.3`；`npm audit --omit=dev` 返回 0，因此前次 `adm-zip`/`linkify-it` 生产 advisory 已消失。完整 audit 仍有 16 个 high，全部位于 `electron-builder` 的开发依赖树，npm 当前报告 `electron-builder` 无可用修复；这与 `docs/HANDOFF_2026-07-27.md:97` 一致，不在本报告伪装成可一键修复的生产漏洞。

`package.json:47-50` 的 `linkify-it`/`nodemailer` overrides 对当前解析结果没有作用：上游已经分别要求/解析为 5.0.2 和 9.0.3。可在一次专门的 lockfile 更新中删除并重新跑 audit；它们不值得单独作为缺陷，但若保留，应记录要防止回退的具体 advisory，而不是永久保留无说明的范围覆盖。

### 脚本

| 脚本 | 入口/调用者 | 结论 |
|---|---|---|
| `build-release.mjs` | `package.json:13-16`，release/dev workflows | 使用中，保留 |
| `verify-release-artifacts.mjs` | `package.json:17`，三个 build/release workflow | 使用中，保留 |
| `check-test-prereqs.mjs` | `package.json:22-27` 的 pretest hooks | 使用中，保留 |
| `compose-release-notes.mjs` | stable/unsigned 发布 workflow | 使用中，保留 |
| `take-screenshots.mjs` | 生成 README 引用的 6 张截图；没有 package/workflow/README 命令入口 | 不是死代码；补 `"screenshots"` npm script 和启动 5175 预览服务器的说明，或在不再维护截图时连同图片一起删除 |

### 配置与 CLI 文档

- `config.example.json` 已是 schema v3，键集合与 `src/config.ts:52-118,460-542` 一致；`_readme` 是有意被忽略的说明字段，credentials 子键由 `src/ocr/efapiao.ts:111-130` 实际消费。
- 本机 `config.json` 缺少 `schemaVersion` 且含 v3 已删除字段，但 `migrateRawConfig()` 会按 v1 迁移并丢弃这些字段；它是未跟踪的本机旧配置，不是仓库示例回归。
- README 列出的 `fetch`、`run`、`ocr run`、`organize` 命令均存在于 `src/index.ts:38-55,1167-1193`。README 没有声称一份完整 flag reference，因此未把“未列 `rebuild-state`/详细 flags”报成错误；真正过期的是 DESIGN/ARCHITECTURE 中的配置与流水线契约。

### 工作流与版本

- `ci.yml` 确实执行 macOS/Windows 测试和 Chromium E2E；缺口是仓库没有 required checks（HYG-05）。
- `dev-build.yml` 只上传 14 天 workflow artifact，`contents: read`，没有发布能力；隔离合理。
- `unsigned-prerelease.yml` 严格要求 `vX.Y.Z-unsigned.N`，构建 development channel 并发布 prerelease；代码与实际 Release 一致，README 未同步（HYG-03）。
- `release.yml` 重复执行测试、签名、公证/时间戳和产物验证，发布本身有门禁；但正式 tag 正则错误（HYG-04）。`gh secret list` 当前为空，所以 stable workflow 现状必然在 cheap resolve gate 失败；2026-07-27 的 `v0.0.4` run 实际失败与此一致。若项目暂无签名资质，应明确把 stable 通道标记为“未启用”，而不是让 README 暗示当前随时可发布正式包。
- 当前版本链路本身一致：`package.json`、lockfile、HEAD tag、`git describe` 和本机 artifact 都是 `0.0.5-unsigned.1`；HEAD 为“add unsigned prerelease channel”。`v0.0.4` 是前一正式候选 tag，因签名链缺失没有 GitHub Release；公开的 `v0.0.5-unsigned.1` 是 prerelease。版本号不是问题，文案和 stable tag 验证才是问题。

## 文档处置矩阵

| 文件 | 结论 | 一句话理由 |
|---|---|---|
| `README.md` | 保留并立即修订 | 用户入口有效，但发布信任说明与 unsigned prerelease 冲突 |
| `docs/ARCHITECTURE.md` | 保留文件名、整篇重写 | 被声明为上层规约，却落后于组合 extractor、archive journal、schema v3、Electron 与浏览器策略 |
| `docs/DESIGN.md` | 保留产品目标、重写技术/配置章节 | “不做 GUI”、`pkg`、`output.dir`/`llm` 已失效 |
| `docs/PROGRESS.md` | 删除公开版并净化历史；需要时重建匿名 `STATUS.md` | 既是完成于 5 月的流水账，又含大量真实票号、样本 hash、缓存规模与路径 |
| `docs/NEXT_STEPS.md` | 删除或移入 `docs/archive/2026-05/` | 路线已完成，却仍让代理从 Phase 0 开始并选择旧打包方案 |
| `docs/HANDOFF_2026-07-27.md` | 移入 archive，先去掉绝对路径和已完成待办 | “未 push/待二审”已经过期，含个人本机路径 |
| `docs/CODING_AGENT_PROMPT.md` | 删除；需要规则则改为仓库根 `AGENTS.md` | 一次性提示、错误大小写路径、旧阶段约束，不应伪装成长期规约 |
| `docs/QA_DEFECT_REPORT_2026-05-22.md` | 移入 `docs/archive/audits/` | 有历史价值，但测试文件名和当时运行状态已过期 |
| `docs/SAMPLE_ANALYSIS.md` | 从当前树与历史删除；仅保留彻底匿名的统计摘要 | 当前内容公开真实邮件主题、票号与 Message-Id |
| `docs/EFAPIAO_UPSTREAM_FEEDBACK.md` | 净化后保留或迁移到私有 issue；原版本净化历史 | 上游问题有价值，但无需公开真实票号、hash、发件人、日期和本机路径 |
| `docs/CODE_REVIEW_FINDINGS_2026-07-27.md` | 移入 `docs/archive/audits/`，标注“历史基线/多数已修复” | 仍有审计追溯价值，但不应与当前缺陷清单并列 |

## 明确排除的项（我检查过但认为不是问题）

1. **25 张本地发票及 OCR CSV 没有被提交。** `invoices/`、`invoices.csv` 当前被忽略，所有 ref 的历史提交数为 0；真正的隐私问题是已跟踪文本中的样本元数据（HYG-01）。
2. **`config.json` 没有泄漏到 Git。** 它未跟踪、历史为 0、POSIX mode 为 `0600`；只确认其 host/user/pass 是非空 live 值，全程未打印值。问题仅在未覆盖的 sidecar 文件名。
3. **`playwright` 不是可移到 devDependencies 的测试包。** `mfh run` 会在生产第三方站点处理路径实际调用 `chromium.launch()`；移走会直接破坏诺诺/淘宝/JD 等网页下载。
4. **`vendor/` 不是 36 MB 的无主垃圾。** 两个平台 `efapiao` 二进制被 `extraResources` 精确引用，源码解析器也按平台寻找它们；应保留并继续做 checksum/平台隔离。
5. **当前 `0.0.5-unsigned.1` 的 package/tag/artifact 命名是连贯的。** 不需要回退版本或重打 tag；需要修的是 README 和 stable workflow 对 prerelease 的边界。
6. **没有发现真实 TODO/FIXME/XXX/HACK、`debugger`、备份残文件或注释掉的大段代码。** 命中的 `TODO` 只是 renderer 用于清除内部文案的正则；`console.log` 均位于 CLI 脚本/测试成功输出，不是生产 renderer 调试残留。
7. **四个主要 release/test 脚本不是死代码。** 唯一没有正式入口的 `take-screenshots.mjs` 有明确产物和 README 消费方，因此建议接线而不是直接删除。

## 可执行清理计划（本报告未执行）

1. **立即止血隐私暴露。**
   - **[DESTRUCTIVE / EXTERNAL / HUMAN APPROVAL REQUIRED]** 在协调历史重写前，可先临时把公开仓库设为 private：
     ```bash
     gh repo edit 12dora/Mail-Fapiao-Helper \
       --visibility private \
       --accept-visibility-change-consequences
     ```
   - 冻结写入，不要先手工改掉 `gui-design/tests/cli-regression.mjs` 的原值：下一步需要从当前行生成不回显敏感值的历史替换表。三份敏感文档会由路径过滤删除；之后如需恢复，只能新建彻底匿名的版本。

2. **净化 Git 历史和 tag。**
   - **[HIGHLY DESTRUCTIVE / HISTORY-REWRITING / HUMAN APPROVAL REQUIRED]** 先备份所有 refs、通知协作者，并在一次性 fresh clone 中从测试 CSV 行生成 replacement file；脚本不向终端打印原值：
     ```bash
     node - <<'NODE'
     const fs = require('node:fs');
     const line = fs.readFileSync('gui-design/tests/cli-regression.mjs', 'utf8')
       .split('\n')
       .find((value) => value.includes("'same-hash") && value.includes(',success,'));
     if (!line) throw new Error('sensitive OCR fixture row not found');
     const row = line.trim().replace(/^'/, '').replace(/',$/, '').split(',');
     if (!row[10] || !row[13]) throw new Error('sensitive OCR fixture fields not found');
     fs.writeFileSync(
       '/private/tmp/mfh-history-redactions.txt',
       `literal:${row[10]}==>示例销售方有限公司\nliteral:${row[13]}==>00000000000000000000\n`,
       { mode: 0o600 },
     );
     NODE
     ```
   - 清除三份敏感过程文档的全部历史，同时替换测试中的票面字符串：
     ```bash
     git filter-repo --force \
       --path docs/SAMPLE_ANALYSIS.md \
       --path docs/PROGRESS.md \
       --path docs/EFAPIAO_UPSTREAM_FEEDBACK.md \
       --invert-paths \
       --replace-text /private/tmp/mfh-history-redactions.txt
     ```
   - `git filter-repo` 通常会移除 `origin` 以防误推；审查 rewritten refs 后重新添加远端，再执行经批准的强制推送：
     ```bash
     git remote add origin https://github.com/12dora/Mail-Fapiao-Helper.git
     git push --force origin --all
     git push --force origin --tags
     ```
   - 这会改变 release provenance SHA；必须同步重建/更正 Release 说明，要求协作者重新 clone，并检查 GitHub fork、缓存和自动源码归档。仅删除当前文件或 `git rm --cached` **不能**完成历史净化。

3. **补 `.gitignore`，再清本机无价值残留。**
   - 按 HYG-02 的精确 block 编辑 `.gitignore`；提交前用：
     ```bash
     git check-ignore -v --no-index \
       config.json.tmp-1234-deadbeef \
       config.json.corrupt-1234.json \
       state.json.1234.deadbeef.tmp \
       state.json.corrupt-2026-07-29.bak \
       .claude/settings.local.json \
       tmp/pdfs \
       release-artifacts \
       release-notes.md
     ```
   - **[DESTRUCTIVE / LOCAL / RECOVERABLE BUILD CACHE]** 人工确认后删除 Finder/构建/依赖缓存：
     ```bash
     find /Users/konata/code/Mail-Fapiao-Helper -name .DS_Store -type f -delete
     rm -rf \
       /Users/konata/code/Mail-Fapiao-Helper/dist \
       /Users/konata/code/Mail-Fapiao-Helper/release \
       /Users/konata/code/Mail-Fapiao-Helper/node_modules \
       /Users/konata/code/Mail-Fapiao-Helper/tmp
     ```
   - 不把 `.mfh-cache/`、`samples/`、`invoices/`、`invoices.csv`、`config.json` 纳入这条删除命令；它们含用户数据，先由用户决定迁移/备份/删除。

4. **修发布边界与用户文案。**
   - 将 `release.yml` stable tag 正则改为只接受 `vMAJOR.MINOR.PATCH`，并在 `build-release.mjs` stable 分支重复校验无 prerelease 后缀。
   - 重写 README 的下载、首次打开、打包通道、CI/发布章节，显式列出 `unsigned-prerelease.yml`；稳定和未签名资产不可共用“Releases 全部签名”的描述。
   - 若近期不配置签名 secrets，在 README/项目状态中写明“正式 stable 发布通道尚未启用”；配置后再用真实 macOS/Windows run 验证。

5. **让 CI 真正成为集成门禁。**
   - 在 GitHub Settings → Rules → Rulesets 为 `main` 创建 active ruleset，要求 PR 和三个当前 check 名通过，阻止 force-push/deletion，并限制 bypass。
   - 配置后用只读命令复核：
     ```bash
     gh api repos/12dora/Mail-Fapiao-Helper/rulesets
     gh api repos/12dora/Mail-Fapiao-Helper/branches/main/protection
     ```

6. **收敛文档和脚本入口。**
   - 按“文档处置矩阵”重写/归档；敏感文件必须先完成第 2 步，不能仅 `git mv`。
   - 在 `package.json` 增加：
     ```json
     "screenshots": "node scripts/take-screenshots.mjs"
     ```
     并在 `gui-design/README.md` 写明先启动 `python3 -m http.server 5175` 再执行该命令。
   - 在单独 PR 中删除当前无效 overrides，刷新 lockfile并复核；没有依赖需要卸载：
     ```bash
     npm pkg delete overrides.linkify-it overrides.nodemailer
     npm install --package-lock-only
     npm audit --omit=dev
     ```
     只有 audit 仍为 0、锁定版本未回退且测试通过时才合并。
