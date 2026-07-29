# 测试腐化与 CI 门禁审查报告
审查日期：2026-07-29 ｜ 审查范围：`gui-design/tests/_shared.mjs`、`gui-design/tests/cli-regression.mjs`、`gui-design/tests/cli-integration.mjs`、`gui-design/tests/e2e.mjs`、`gui-design/tests/e2e-fixes.mjs`、`gui-design/tests/electron-ipc-fixture.mjs`、`gui-design/tests/electron-smoke.mjs`、`gui-design/tests/.fault-injection-enabled`、`scripts/check-test-prereqs.mjs`、`package.json`、`.github/workflows/{ci,dev-build,release,unsigned-prerelease}.yml`，以及为核对行为而阅读的 `gui-design/scripts/shell.js`、`src/util/{testFaults,dataDirLock}.ts`、`src/electron/{opCoordinator,main,manualArchive}.ts`、`src/download/{archiveJournal,downloader}.ts`、`src/pipeline.ts`、`src/index.ts`、`.gitignore`、`docs/CODE_REVIEW_FINDINGS_2026-07-27.md` 相关片段

## 摘要

当前测试体系比 2026-07-27 基线健康得多：PR/main 已有 CLI、Electron 和浏览器三类门禁，缺少运行时前置条件会明确失败；旧审计指出的固定日期、Chromium 启动失败泄漏 HTTP server、空断言均已针对性修复。
最严重的剩余问题是测试基础设施本身仍可制造假绿：Electron fixture 的“可见文字”断言会命中折叠内容，清理失败只写 `console.error`，超时 acquisition 之后才成功的资源不会进入清理栈。
发布 workflow 只运行不含 browser suite 的 `npm test`，所以直接 tag / 手动发布路径没有 renderer browser 门禁。
旧 900ms 并发阈值虽已改写，当前仍以 600ms 墙钟差值裁决正确性；这是同一类固有抖动，只是阈值换了形式。
锁与 journal 已有不少高价值回归，但数据目录锁只测了“损坏目录不被删除”，没有验证两个真实进程互斥、父子 token 继承和 `OperationCoordinator` 全互斥矩阵；journal 也没有真实强杀进程后的恢复测试。
建议先修 `_shared.mjs` 和 `electron-ipc-fixture.mjs` 的假绿，再补跨进程锁 / 强杀恢复测试，最后收紧 release gate。
遵守只读约束，本次没有运行测试：CLI/Electron 套件会执行被明确禁止读取的 `dist/`，browser 套件与 prereq 会加载被明确禁止读取的 `node_modules/`；因此没有伪造运行输出。

## findings 汇总表

| ID | 严重度 | 标题 | 位置 |
|---|---|---|---|
| TEST-01 | P1 | “可见文字”助手仍会命中折叠内容，Electron fixture 可假通过 | `gui-design/tests/electron-ipc-fixture.mjs:60-72` |
| TEST-02 | P1 | 清理失败只打印日志，suite 仍报告 passed | `gui-design/tests/_shared.mjs:153-167` |
| TEST-03 | P1 | acquisition 超时不会取消或接管晚到资源 | `gui-design/tests/_shared.mjs:122-150` |
| TEST-04 | P2 | 旧 900ms 问题仍以固定 600ms 节省阈值存在 | `gui-design/tests/cli-regression.mjs:393-421` |
| TEST-05 | P2 | release / prerelease / dev-build 均绕过 browser suite | `package.json:27-28`、`.github/workflows/release.yml:221-225` |
| TEST-06 | P2 | build freshness 只比较“最新输入”和“最新任一输出”，可放过局部 stale dist | `gui-design/tests/_shared.mjs:79-106` |
| TEST-07 | P2 | CLI regression 每次成功运行固定遗留 24 个临时目录 | `gui-design/tests/cli-regression.mjs:153-162` |
| TEST-08 | P1 | 数据目录锁和操作协调器的核心并发契约没有回归门禁 | `gui-design/tests/cli-regression.mjs:425-443` |
| TEST-09 | P2 | IPC 失败结果没有走 UI 点击路径验证 error → toast | `gui-design/tests/electron-ipc-fixture.mjs:498-510` |
| TEST-10 | P1 | journal 恢复只做同进程模拟，没有验证真实强杀后的 durable stage 边界 | `gui-design/tests/cli-regression.mjs:615-643` |

## 详细发现

### TEST-01 “可见文字”助手仍会命中折叠内容，Electron fixture 可假通过
- 严重度：P1
- 位置：`gui-design/tests/electron-ipc-fixture.mjs:60-72`、`gui-design/tests/electron-ipc-fixture.mjs:539-555`
- 置信度：CONFIRMED
- 证据：
  ```js
  return Array.from(main.querySelectorAll('*')).some((el) => visible(el) && el.textContent?.includes(needle));
  ```
  ```js
  await expectText(page, '{seller}');
  await expectText(page, '{invoiceNo}');
  // ...
  await activeMain(page, 'details.card summary').first().click();
  ```
- 问题：`visible(el)` 只检查被遍历的祖先元素本身；`textContent` 仍包含其 `display:none` 后代和关闭的 `<details>` 内容。可见的 `.page` 容器因此足以让隐藏文字通过。第二段证据在打开“高级设置”之前就断言其中的 `{seller}` / `{invoiceNo}`，直接证明断言没有验证用户能否看到文字。这是旧审计 CODE-02 在已改名 fixture 中仍然存在的假阳性；`e2e.mjs` 已正确改用 `innerText`，本文件没有。
- 建议修复：复用 `e2e.mjs:99-105` 的 `innerText` 方案，或让 Playwright locator 以 `{ state: 'visible' }` 等待包含目标文本的最小节点；给 helper 自身加一个关闭 `<details>` 的负向自测，打开前必须失败、打开后必须通过。

### TEST-02 清理失败只打印日志，suite 仍报告 passed
- 严重度：P1
- 位置：`gui-design/tests/_shared.mjs:153-167`、`gui-design/tests/_shared.mjs:254-259`
- 置信度：CONFIRMED
- 证据：
  ```js
  } catch (err) {
    errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // ...
  if (errors.length > 0) {
    console.error(`[cleanup] 以下资源没有干净释放：\n  - ${errors.join('\n  - ')}`);
  }
  ```
  ```js
  await Promise.race([main(), timeout]);
  console.log(`${name} passed`);
  ```
- 问题：当 `browser.close()`、`closeElectronApp()`、HTTP server close 或临时目录删除失败时，`withCleanup()` 正常 resolve，随后 `runSuite()` 明确输出 `passed` 且退出码仍为 0。资源泄漏回归因此不会阻断 CI；这些失败路径会把残留进程、端口或含测试票据的目录留给后续运行。
- 建议修复：清理完所有栈项后抛出 `AggregateError`。若 body 已失败，要同时保留 body error 与 cleanup errors，而不是覆盖其中一方；可用捕获变量后统一 `throw new AggregateError([...])`。新增一个 helper 自测：body 成功、release 抛错时进程必须非 0。

### TEST-03 acquisition 超时不会取消或接管晚到资源
- 严重度：P1
- 位置：`gui-design/tests/_shared.mjs:122-150`、`gui-design/tests/e2e.mjs:141-148`、`gui-design/tests/electron-ipc-fixture.mjs:162-173`
- 置信度：CONFIRMED
- 证据：
  ```js
  return Promise.race([Promise.resolve(promise), deadline]).finally(() => clearTimeout(timer));
  // ...
  const resource = await withDeadline(acquire(), timeoutMs, `获取资源「${label}」`);
  stack.push({ label, releaseTimeoutMs, release: () => release(resource) });
  ```
- 问题：`Promise.race` 只能停止等待，不能取消 `chromium.launch()` / `electron.launch()`。若 launch 在 deadline 后才 resolve，`scope.use()` 已抛错，资源也从未执行 `stack.push`，随后成功启动的 Chromium/Electron 没有任何 owner 会关闭。旧审计中的“launch 失败前 server 泄漏”已修，但“launch 超时后晚到资源泄漏”是共享 helper 引入的新失败路径。
- 建议修复：让 acquisition 接受 `AbortSignal` 并在超时时 abort；对不支持取消的 acquire，保留原 promise，并在超时后附加 `then(resource => release(resource))` 的 late-cleanup，再等待/记录其结果。Chromium/Electron 还应在超时路径按已知 PID 做兜底进程树清理。

### TEST-04 旧 900ms 问题仍以固定 600ms 节省阈值存在
- 严重度：P2
- 位置：`gui-design/tests/cli-regression.mjs:393-421`
- 置信度：CONFIRMED
- 证据：
  ```js
  const elapsed = Date.now() - started;
  // ...
  const theoreticalSaving = (ITEMS - 1) * DELAY_MS;
  const observedSaving = serialMs - parallelMs;
  if (observedSaving < theoreticalSaving / 2) {
  ```
- 问题：当前参数为 4 项 × 400ms，条件等价于要求两次独立进程运行的墙钟差至少 600ms。串行和并行是先后运行，不共享调度负载；CI 上任一次 CPU steal、杀毒扫描或 I/O 抖动都能改变差值。相较旧 `<900ms` 绝对总时长，这个版本确实更好，也修复了没有走单项路径的问题，但仍用绝对毫秒差判断逻辑正确性，因此旧 CODE-03 的固有抖动没有完全消失。
- 建议修复：给 mock provider 增加测试专用 barrier/counter：所有并发任务进入后才统一释放，断言峰值 `active >= 2`；串行路径断言峰值为 1。这样直接测并行重叠，不测机器速度。

### TEST-05 release / prerelease / dev-build 均绕过 browser suite
- 严重度：P2
- 位置：`package.json:27-28`、`.github/workflows/release.yml:221-225`、`.github/workflows/unsigned-prerelease.yml:127-134`、`.github/workflows/dev-build.yml:85-92`
- 置信度：CONFIRMED
- 证据：
  ```json
  "test:browser": "node gui-design/tests/e2e-fixes.mjs && node gui-design/tests/e2e.mjs",
  "test": "npm run build && npm run typecheck && npm run test:cli && npm run test:electron"
  ```
  ```yaml
  # `npm test` = build + typecheck + test:cli +
  # test:electron
  - name: Test
    run: npm test
  ```
- 问题：普通 PR/main 的 `ci.yml:55-78` 确实另有 browser job，不是假门禁；但 stable release、unsigned prerelease 和手动 dev build 都只调用聚合脚本，而聚合脚本明确不含 browser suite。workflow_dispatch 可以针对已有 tag/ref 直接构建，因此不能证明该精确 SHA 曾通过 renderer browser tests。大量只存在于 `e2e*.mjs` 的筛选、自动保存、toast、无障碍和敏感信息展示回归可在发布门禁中缺席。
- 建议修复：增加 `test:all`，或在 release resolve 后增加 Ubuntu + Chromium 的 browser job并让 build `needs` 它；也可查询并强制要求同一 SHA 的 CI browser check 成功。保留 `npm test` 作为不下载浏览器的 core suite 时，应把名字改成 `test:core`，避免“全部测试”的错误语义。

### TEST-06 build freshness 只比较“最新输入”和“最新任一输出”，可放过局部 stale dist
- 严重度：P2
- 位置：`gui-design/tests/_shared.mjs:79-106`
- 置信度：CONFIRMED
- 证据：
  ```js
  const newestOutput = await newestMtimeMs(join(repoRoot, BUILD_OUTPUT_DIR), { extensions: ['.js'] });
  if (newestSource > newestOutput) {
  ```
- 问题：只要 `dist/` 里任意一个 `.js` 比所有 `src/` 更新，检查就通过；它不验证当前测试实际执行的 `dist/index.js`、`dist/download/archiveJournal.js`、`dist/util/dataDirLock.js` 等是否分别对应源码。`npm test` 先 build，CI 主入口不受影响；但直接运行 suite 或 `npm run test:cli/test:electron` 时，局部旧输出仍能假绿，这与 helper 注释承诺的“拒绝 stale dist”不一致。
- 建议修复：构建时写入包含所有输入内容 hash / 编译器配置 hash 的 manifest，preflight 比较 manifest；最小修复是逐个映射被测试 import/entry 的 `.ts → .js` mtime，并拒绝缺失输出，不能用整个 `dist` 的最大 mtime代表全部产物。

### TEST-07 CLI regression 每次成功运行固定遗留 24 个临时目录
- 严重度：P2
- 位置：`gui-design/tests/cli-regression.mjs:153-162`、`gui-design/tests/cli-regression.mjs:373-410`、`gui-design/tests/cli-regression.mjs:1162-1188`
- 置信度：CONFIRMED
- 证据：
  ```js
  const tmp = await mkdtemp(join(tmpdir(), 'mfh-cli-regression-'));
  // ...
  await runMfh([...]);
  ```
  ```js
  await testOutputCsvAndPendingRaw();
  // ... 23 个其他 mkdtemp 路径
  await testLivePidJournalBlocksStrictMutationAndRetriesAfterExit();
  ```
- 问题：文件内共有 24 次 `mkdtemp()`，没有任何一次删除 temp root；仅两处 `rm()` 删除测试场景中的单个 lock/file。成功路径每跑一次就向系统 temp 留 24 棵包含 PDF、EML、CSV、journal、state/config 的目录，失败路径同样遗留。CI runner 短命会掩盖问题，本地反复运行会持续占盘并保存测试邮件数据。
- 建议修复：把每个 case 改为 `withCleanup/useTempDir`，或给 case runner 统一创建 temp 并在 `finally` 递归删除；若失败时希望保留现场，应通过显式 `MFH_KEEP_TEST_TMP=1` opt-in，并打印路径，默认仍清理。

### TEST-08 数据目录锁和操作协调器的核心并发契约没有回归门禁
- 严重度：P1
- 位置：`gui-design/tests/cli-regression.mjs:425-443`、`src/util/dataDirLock.ts:19-38`、`src/electron/opCoordinator.ts:47-56`
- 置信度：CONFIRMED
- 证据：
  ```js
  await mkdir(lockPath, { recursive: true });
  // ...
  const acquired = acquireDataDirLock(tmp, 'pipeline', 'test-job');
  if (acquired.ok) {
  ```
  ```ts
  const COMPATIBLE_WITH: Record<OpKind, OpKind[]> = {
    fetch: [],
    pipeline: [],
    ocr: [],
    organize: [],
  };
  ```
- 问题：唯一 lock test 只验证“一个陈旧、不可解析的目录不能被错误删除”。测试树中没有 `OperationCoordinator`、`leaseEnv`、`MFH_LOCK_TOKEN`、`operation_busy` 或两个真实竞争进程的引用。因而没有门禁证明：两个 CLI 只能有一个 owner；GUI 锁能挡住外部 CLI；GUI spawn 的 CLI 可凭 token 继承同一租约；fetch/pipeline/ocr/organize 任意组合互斥；异常释放后下一任务可继续。源码注释明确说明双持有者会让 CSV rollback 截掉另一进程的有效行，这是具体的数据损坏风险。
- 建议修复：用两个 `child_process` 和 barrier 同时竞争同一 temp data dir，断言恰好一个成功、另一个 exit 2 且无写入；再覆盖正确/错误 token 继承。对 `OperationCoordinator` 做 4×4 参数化测试，验证第二次 `begin` 返回 `operation_busy`、broadcast 状态、release/dispose 后可重入。

### TEST-09 IPC 失败结果没有走 UI 点击路径验证 error → toast
- 严重度：P2
- 位置：`gui-design/tests/electron-ipc-fixture.mjs:498-510`、`gui-design/scripts/shell.js:2208-2272`
- 置信度：CONFIRMED
- 证据：
  ```js
  const manualBlocked = await page.evaluate(async (hash) => window.mfhBridge.pendingManualArchive({ hash }), pendingHash);
  if (manualBlocked?.ok !== false || manualBlocked?.code !== 'archive_recovery_blocked') {
  ```
  ```js
  showToast(
    result?.ok ? okTitle : '运行失败',
    result?.ok ? (readable || okMessage) : (readable || '操作没有完成。展开诊断信息可以查看技术细节。'),
  ```
- 问题：fixture 直接调用 bridge 并检查返回对象，绕过了 `handleAction` / `runBridgeAction`；browser synthetic bridge 又几乎只返回 `{ok:true}`。所以现有测试证明了主进程会返回脱敏错误，却没有证明普通用户点击按钮后能看到 `role=alert` 的错误 toast、可操作中文信息和脱敏 detail，也没有覆盖 IPC Promise reject 的全局 catch。renderer 的这一段若回归为静默失败，当前门禁仍可全绿。
- 建议修复：让一次 `runPipeline`、`organize`、`pendingManualArchive` fixture 从 UI 点击触发 `{ok:false, code, message, detail}`，断言 toast 标题、正文、`role="alert"`、detail 已脱敏且按钮恢复；另加一次 bridge reject，断言“运行失败”而非 unhandled rejection。

### TEST-10 journal 恢复只做同进程模拟，没有验证真实强杀后的 durable stage 边界
- 严重度：P1
- 位置：`gui-design/tests/cli-regression.mjs:615-643`、`src/download/archiveJournal.ts:7-20`、`src/download/archiveJournal.ts:93-115`
- 置信度：CONFIRMED
- 证据：
  ```js
  beginArchiveTransaction(cfg.paths.invoices, {
    files: planned,
    csv: [/* ... */],
  });
  batch.commit();
  const recovered = recoverArchiveTransactions(cfg.paths.invoices);
  ```
  ```ts
  fs.writeFileSync(fd, JSON.stringify(record));
  fs.fsyncSync(fd);
  // ...
  fs.renameSync(tmpPath, recordPath);
  ```
- 问题：现有 journal 用例很多且应保留；它们对冲突、rollback、unresolved file、CSV truncate failure 和 live PID 均有实质断言。但“崩溃恢复”核心用例是在同一进程内手动调用 `begin → batch.commit → recover`，Electron fixture 也手写 journal JSON；没有一个 archive writer 在 `prepared`、`files-installed`、`ledger-committed` 三个真实 checkpoint 被 SIGKILL 后由新进程恢复。于是 `fsync` / rename 顺序、真实 PID 死亡识别、CLI 启动恢复入口和最终文件+双 CSV 的组合状态没有端到端门禁，正是源码注释要防止的孤儿文件/重复归档风险。
- 建议修复：加入只在测试 token+sentinel 下启用的 stage barrier（不是 throw；要让父测试在收到 checkpoint 后 SIGKILL 子进程），分别强杀三次，再启动全新 CLI：`prepared` / `files-installed` 必须回到旧文件与旧 CSV，`ledger-committed` 必须保留文件和两份 CSV且只清 journal；每种情况再 rerun，断言无重复文件/行。

## VERDICT LIST

没有建议直接 DELETE 的文件或 case；当前重复主要是“synthetic renderer”与“真实 Electron IPC”两个不同边界，合并会丢失故障定位能力。以下 verdict 把共享基础设施问题与 case 本身分开判断。

| 文件 / notable case | Verdict | 结论 |
|---|---|---|
| `gui-design/tests/_shared.mjs`：freshness、cleanup、timeout | **FIX** | 修 TEST-02/03/06，并为 helper 加自测；所有 suite 都依赖它。 |
| `cli-regression.mjs`：output CSV / raw pending / no Message-ID / CSV-state recovery | **KEEP** | 断言具体文件、字节与行身份，能抓真实漏票/重复归档。 |
| `cli-regression.mjs`：OCR resume、success-over-error、filename fallback | **KEEP** | 覆盖 checkpoint 与 legacy identity，断言有判别力。 |
| `cli-regression.mjs`：OCR concurrency | **FIX** | 保留目标，改为 barrier/峰值并发断言，删除墙钟裁决。 |
| `cli-regression.mjs`：data-dir lock | **FIX** | 当前 narrow case 保留，再补真实竞争、token 继承和协调器矩阵。 |
| `cli-regression.mjs`：archive collision / rollback / recovery / fault injection | **KEEP** | 现有细粒度状态断言价值高；另补真实进程强杀，不替代这些 case。 |
| `cli-regression.mjs`：temp 生命周期 | **FIX** | 24 个 case 全部纳入统一 cleanup。 |
| `cli-integration.mjs`：run → rerun → OCR → organize | **KEEP** | 使用真实 compiled CLI 和隔离目录，验证用户依赖的组合产物；明确不冒充 IMAP E2E。 |
| `e2e.mjs`：主 renderer 流程、筛选、配置、toast、无障碍 | **KEEP** | `innerText` 可见性、固定时钟与事件条件等待均合理。 |
| `e2e-fixes.mjs`：H1/H3/H4/H6/H7/M1/M2/M3/M5/L5 | **KEEP** | 多数是主 suite 未覆盖的窄回归；H1/M5 有真实调用次数与 busy-state 断言。 |
| `electron-ipc-fixture.mjs`：`expectText` 相关 UI 文案 case | **FIX** | 改可见性 helper 后重新确认；当前可假通过。 |
| `electron-ipc-fixture.mjs`：真实 IPC shape、fake CLI 流程、recovery error 脱敏 | **KEEP** | 边界清晰，且已明确声明不覆盖 CLI；应补 UI error toast 点击路径。 |
| `electron-smoke.mjs`：启动、preload、no-GUI、空 OCR、真实自动保存 | **KEEP** | 小而真实，未与 fake flow 混淆。 |
| `.fault-injection-enabled` | **KEEP** | 是 `src/util/testFaults.ts:4-10` 的第二道开关；fault env 还必须带固定 token。`package.json:58-65` 排除整个 `gui-design/tests/**`，不会进入安装包。 |
| `scripts/check-test-prereqs.mjs` | **FIX** | fail-closed 方向正确；替换 `_shared` 的全局 max-mtime freshness 判定。 |
| `.github/workflows/ci.yml` | **KEEP** | PR/main 的 core matrix 与独立 Chromium job 都是硬失败，没有 `--if-present`、`|| true`、ignored exit code。 |
| `package.json` + release/dev workflows | **FIX** | core/browser 命名与发布门禁对齐，确保精确发布 SHA 通过 browser suite。 |

## 建议新增的回归测试（按优先级）

1. **跨进程 data-dir lock + token 继承**：两个 CLI barrier 同时抢锁只能一胜一败；正确父 token 可继承，错误/缺失 token 必须被挡住且不能写 CSV/state。
2. **真实 SIGKILL journal matrix**：在 `prepared`、`files-installed`、`ledger-committed` checkpoint 强杀 writer，新进程恢复后分别断言文件、`invoices.csv`、`ocr-pending.csv` 和 journal 的完整组合状态。
3. **OperationCoordinator 4×4 互斥矩阵**：任一 operation 持有时其余四类都返回 `operation_busy`，release/dispose 后可再次获取，并验证广播先 running 后 null。
4. **resolved error / rejected IPC → toast**：从真实按钮触发两类失败，断言错误 toast 可见、`role=alert`、中文行动建议、脱敏 detail、按钮/进度恢复。
5. **cleanup helper 自测**：release throw 必须使 suite 非 0；acquire deadline 后晚到的 fake resource 必须恰好 release 一次。
6. **build manifest freshness**：只触碰一个无关输出不能让旧 `dist/index.js` / `dist/download/archiveJournal.js` 通过 preflight；缺任一被 import 的输出也必须失败。

## 明确排除的项（我检查过但认为不是问题）

- 旧审计 CODE-01“没有测试门禁”已修复：`ci.yml:41-53` 在 macOS/Windows 上执行 `npm ci` 后硬跑 `npm test`，`ci.yml:70-78` 另跑 Chromium；没有 `--if-present`、`|| true`、`continue-on-error` 或被忽略退出码。
- `scripts/check-test-prereqs.mjs:107-120` 对未知 suite 返回 2、前置缺失返回 1，不会把缺 Electron/Chromium/display 当成功；问题仅是 dist freshness 粒度不足。
- 旧固定日期问题已修复：`e2e.mjs:32-47,151-153` 与 `electron-ipc-fixture.mjs:33-51,183-186` 冻结时钟并从同一常量推导预期日期，不再依赖审查当天。
- 旧“Chromium launch 失败泄漏 HTTP server”已修复：两个 browser suite 都先把 server 注册进 cleanup 栈，再 acquire browser；本报告 TEST-03 是不同的“launch 超时后晚到资源”路径。
- `e2e-fixes.mjs:290-299` 两个强制 double-click 的 `.catch(() => {})` 不是吞断言：点击失败本身不重要，随后严格断言 `__testConnectionCount === 1`，能检测重复 IPC。
- `.fault-injection-enabled` 不是运行状态文件：内容明确是 test sentinel，读取方仅 `src/util/testFaults.ts:4-10`；`.gitignore` 没有忽略它，且打包规则排除 tests。受“不读取 `.git/`”硬规则限制，本次不能用 git index 断言它是否 tracked，但从当前 checkout、引用关系和打包排除看，它是有意保留的测试源文件，不应删除。
- `cli-integration.mjs` 没有真实 IMAP/第三方网络访问，并在文件头明确排除 IMAP；其 `mock` 只替代 OCR provider，archive/queue/results/state/organize 仍走真实 compiled CLI，因此不属于夸大命名。
- `e2e.mjs` 与 `electron-ipc-fixture.mjs` 的流程重叠不是纯重复：前者隔离 renderer、覆盖大量 UI 状态，后者验证 Electron main/preload/IPC 与磁盘副作用；应共享 fixture/helper，但不应删除任一层。
