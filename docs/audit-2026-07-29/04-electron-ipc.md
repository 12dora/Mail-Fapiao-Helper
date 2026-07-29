# Electron 主进程与 IPC 审查报告
审查日期：2026-07-29 ｜ 审查范围：`src/electron/main.ts`、`electron/preload.cjs`、`src/electron/sanitize.ts`、`src/electron/lineStream.ts`、`src/electron/devFakeBackend.ts`、`src/electron/manualArchive.ts`、`src/electron/summary.ts`、`src/electron/opCoordinator.ts`、`src/electron/procTree.ts`；为核对调用链和既有修复，另读了 `gui-design/scripts/shell.js`、`gui-design/pages/dashboard.html`、`gui-design/pages/config.html`、`gui-design/pages/library.html`、`gui-design/pages/settings.html`、`gui-design/tests/*.mjs` 的相关片段、`package.json`、`src/config.ts`、`src/index.ts`、`src/pipeline.ts`、`src/log.ts`、`src/pending/summary.ts`、`src/ocr/summary.ts`、`src/ocr/runner.ts`、`src/ocr/efapiao.ts`、`src/download/archiveJournal.ts`、`src/util/csv.ts` 及 `docs/CODE_REVIEW_FINDINGS_2026-07-27.md`

## 摘要

当前 Electron 层比 2026-07-27 基线健康很多：18 个 invoke 通道与 4 个事件通道在 main/preload 间完全对应；`contextIsolation`、`nodeIntegration`、打包态 fake-backend 门禁、Windows `taskkill /T`、UTF-8 跨 chunk 拼行和有界日志 tail 都已落实。

最严重的三个剩余问题是：其一，`developer-reset` 的两次确认只存在于可绕过的 renderer，主进程既不确认也不占操作锁，可直接删除发票原件；其二，“重新识别”在产生任意新结果后被用户停止或致命失败，会删除完整旧结果备份；其三，所谓 POSIX “进程树终止”只向直接 CLI 发信号，强杀升级后 `efapiao serve` 仍可成为孤儿，且退出调用方无条件忽略终止验证结果。

并发协调器本身的四类操作矩阵正确，但它没有覆盖 reset、`pending.csv` 重写和若干锁前配置写入；因此旧 APP-05 不能视为完整关闭。COPY-01 也只部分关闭：URL、路径和 hash 的通用脱敏已有实现，但逐邮件日志仍把发件邮箱和主题送入 IPC/history，摘要返回值还绕过脱敏层。

最先应修复 `ELEC-01`～`ELEC-04`：把破坏性授权和所有数据写入统一放到主进程的操作事务入口；让 OCR 重跑以“完整成功/显式合并”而不是“出现任意输出”为提交条件；最后用可验证的进程组/Job Object 生命周期替代当前 best-effort 信号。

## findings 汇总表

| ID | 严重度 | 标题 | 位置 |
|---|---|---|---|
| ELEC-01 | P0 | 破坏性 reset 的授权只在 renderer，主进程可被直接调用删除财务原件 | `electron/preload.cjs:20`、`src/electron/main.ts:2334-2381` |
| ELEC-02 | P0 | 操作协调器未覆盖 reset、pending 重写和锁前配置写入 | `src/electron/main.ts:1738-1757`、`1786-1805`、`2204-2208`、`2334-2371` |
| ELEC-03 | P0 | 重新识别产生一条新结果后停止/失败会删除整份旧结果备份 | `src/electron/main.ts:1468-1516`、`1944-1951` |
| ELEC-04 | P1 | POSIX 进程树未被终止，退出仍忽略终止失败并释放锁 | `src/electron/procTree.ts:52-68`、`115-131`、`src/electron/main.ts:2443-2450` |
| ELEC-05 | P1 | 打包应用可因 `MFH_DATA_DIR` 跳过单实例锁 | `src/electron/main.ts:2388-2401` |
| ELEC-06 | P1 | `open-path` 的允许根可由 renderer 改写，pending hash 也可路径穿越 | `src/electron/main.ts:1718-1721`、`2047-2074`、`2226-2234` |
| ELEC-07 | P1 | 逐邮件日志和摘要返回值绕过完整脱敏，邮箱、主题、原始错误和绝对路径进入 renderer | `src/electron/main.ts:560-561`、`803-811`、`1297-1305`、`1693-1715` |
| ELEC-08 | P1 | 后处理异常会把已经成功的 CLI 操作伪装成“本地数据没有变化” | `src/electron/main.ts:1816-1833`、`gui-design/scripts/shell.js:2208-2242` |
| ELEC-09 | P1 | 手工归档只对历史数据去重，同一批相同内容会重复归档 | `src/electron/manualArchive.ts:264-298` |
| ELEC-10 | P1 | 手工归档在主进程同步读入全部选中文件，没有累计大小上限 | `src/electron/manualArchive.ts:66-67`、`207-264`、`src/electron/main.ts:2288-2296` |
| ELEC-11 | P2 | 行装配器的 carry 无上限，有界 ring buffer 无法约束超长未换行输出 | `src/electron/lineStream.ts:10-27`、`src/electron/main.ts:942-953` |
| ELEC-12 | P2 | OCR 允许单件失败时仍按 exit code 把运行历史记为“成功” | `src/electron/main.ts:1198-1212`、`1922-1927`、`1954` |
| ELEC-13 | P1 | 2466 行 `main.ts` 混合 13 类责任，安全/事务边界无法集中审查 | `src/electron/main.ts:109-2466` |
| ELEC-14 | P0 | 启动初始化没有错误边界，配置创建失败会留下无窗口应用 | `src/electron/main.ts:164-173`、`2427-2434` |

## 详细发现

### ELEC-01 破坏性 reset 的授权只在 renderer，主进程可被直接调用删除财务原件

- 严重度：P0
- 位置：`electron/preload.cjs:20`、`src/electron/main.ts:2334-2381`、`gui-design/scripts/shell.js:2596-2616`
- 置信度：CONFIRMED
- 证据：
  ```js
  developerReset: () => ipcRenderer.invoke('mfh:developer-reset'),
  ```
  ```ts
  for (const candidate of candidates) {
    const value = candidate.value;
    if (typeof value !== 'string' || value.length === 0) continue;
    const target = path.resolve(dataDir, value);
    if (target === dataDir) continue;        // never delete the userData root
    if (target === configPath) continue;     // never delete config.json (holds the password)
    if (!isInsideDataDir(target)) {          // strict descendant only, blocks siblings
      if (fs.existsSync(target)) skippedExternal.push(`${candidate.label}：${redactPath(target)}`);
      continue;
    }
    try {
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(path.relative(dataDir, target) || target);
  ```
  ```js
  const first = window.confirm([
      '重置应用数据（将删除所有本机数据）',
      '',
      '以下内容会被永久删除，且不能撤销：',
  ```
  ```js
  const second = window.confirm('再次确认：已归档的发票原件会被删除。请先自行备份需要保留的文件。确定要删除吗？');
  if (!second) return;
  if (!window.mfhBridge?.developerReset) { bridgeUnavailable(); return; }
  const result = await window.mfhBridge.developerReset();
  ```
- 问题：两次确认都在 renderer，主进程看不到也无法证明用户确认过；preload 又直接暴露了无参数的 `developerReset()`。任何运行在当前 renderer 上的脚本都可以跳过两次确认直接调用 handler，主进程随后删除邮件缓存、归档发票、待确认队列、识别结果、状态和历史。所有 `ipcMain.handle` 还都忽略了 `_event`，没有核对 `senderFrame.url`/主窗口身份；`createWindow()` 也没有注册 `will-navigate` 或 `setWindowOpenHandler` 的拒绝策略。因此，破坏性授权实际由不可信边界的一侧自我声明，属于可直接造成财务原件丢失的 IPC 安全缺口。
- 建议修复：不要把 renderer 的 `confirm()` 当授权。将 reset 改为两段式主进程能力：`request-reset` 在主进程用 `dialog.showMessageBox` 显示原生确认并生成一次性、短时、绑定 `webContents.id` 的 nonce；`commit-reset({ nonce })` 再复核 sender、nonce、当前操作状态后执行。为所有 IPC 注册统一的 `assertTrustedSender(event)`，只接受主窗口当前 `file:` 页面；在窗口创建处拒绝非应用页面导航和所有新窗口。reset 还必须进入与 `ELEC-02` 相同的独占操作租约。

### ELEC-02 操作协调器未覆盖 reset、pending 重写和锁前配置写入

- 严重度：P0
- 位置：`src/electron/main.ts:1738-1757`、`1786-1805`、`2204-2208`、`2334-2371`、`src/electron/opCoordinator.ts:47-56`
- 置信度：CONFIRMED
- 证据：
  ```ts
  const saved = saveConfig({ rename: { avoidConflictBeforeOcr: raw.avoidConflictBeforeOcr } });
  ```
  ```ts
  const gate = acquireOperation('pipeline');
  if (!gate.ok) return { ...gate.response, normalizedFilter: normalizedFilterFrom() };
  ```
  ```ts
  ipcMain.handle('mfh:pending-ignore', (_event, payload: unknown) => {
    const raw = asObject(payload);
    const hash = typeof raw.hash === 'string' ? raw.hash : '';
    if (!hash) return { ok: false, code: 'pending_missing_hash', message: '缺少待忽略邮件的标识。' };
    const result = rewritePendingCsv((row) => pendingRowHash(row) !== hash);
  ```
  ```ts
  try {
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(path.relative(dataDir, target) || target);
  } catch {
    skippedExternal.push(`${candidate.label}：删除失败，请手动清理`);
  ```
- 问题：`OperationCoordinator` 的 `fetch/pipeline/ocr/organize` 全互斥矩阵本身正确，但并非所有写操作都经过它。至少有三个确定交错：

  1. pipeline 正在向 `pending.csv` 追加新行时，`pending-ignore` 会“全量读取 → 临时文件 → rename”；若追加发生在读取后、rename 前，新行被旧快照覆盖。
  2. 任一 CLI 正在写 state/CSV/发票时调用 `developer-reset`，目录和文件会被删除；子进程随后仍可继续写回部分 state/CSV，用户得到的既不是完整运行结果，也不是完整 reset。
  3. 第二个 `run-pipeline` 请求会先 `saveConfig()`，之后才因 `operation_busy` 被拒绝；也就是说，一个被拒绝的操作仍然修改了当前/后续任务使用的配置。`start-fetch` 的筛选保存、`test-connection` 和 `list-mailboxes` 也有同类锁外写入。

  renderer 的 `applyOpState()` 只禁用四类运行按钮，并不禁用 reset 或待确认操作，因此第一、二种交错不需要伪造 IPC。旧审计 APP-05 的主操作互斥已修，但这些旁路证明它尚未完整关闭。
- 建议修复：把“是否修改受管理数据”而不是“是否会 spawn CLI”作为占锁标准。新增 `withOperation(kind, fn)`，在任何配置/CSV/文件变更之前获取租约，并把 `pending-ignore`、reset、手工归档、所有会持久化配置的运行入口纳入同一兼容矩阵。reset 应先拒绝 busy，而不是主动删除运行中的数据；若需要“停止并重置”，必须是显式的两阶段流程：终止并验证所有 child → 保持租约 → 执行 reset。`pending.csv` 应由单一 store 在锁内按最新内容做 merge-on-commit，不能用无版本的全量快照覆盖。

### ELEC-03 重新识别产生一条新结果后停止/失败会删除整份旧结果备份

- 严重度：P0
- 位置：`src/electron/main.ts:1468-1516`、`1944-1951`
- 置信度：CONFIRMED
- 证据：
  ```ts
  if (fs.existsSync(resultsCsv)) {
    fs.renameSync(resultsCsv, resultsBackup);
    resultsMoved = true;
  }
  ```
  ```ts
  const result = await runCli('ocr', args, { operation: 'ocr', initialTotal: pendingTotal, jobId });
  const stopped = ocrStopRequested.has(jobId) || result.code === 130;

  if (plan) {
    // 子进程成功启动并完成（或至少产出了新结果）才丢弃备份，否则恢复旧结果。
    const producedResults = fs.existsSync(plan.resultsCsv) && fs.statSync(plan.resultsCsv).size > 0;
    if (result.started && (result.code === 0 || producedResults)) plan.discard();
    else plan.restore();
  }
  ```
- 问题：重跑开始前，完整旧 `resultsCsv` 被移动到备份；提交条件却是“exit code 为 0 **或** 新结果文件非空”。用户在第一张新结果写入后点击“停止识别”，或 OCR 在处理中途发生致命错误时，`producedResults` 为 true，主进程会执行 `plan.discard()` 删除旧备份，然后才按 `stopped`/失败返回。未处理票据的旧识别结果因此永久消失。该路径比旧审计 APP-17 更窄，但旧问题仍未真正关闭：现在不会在启动前丢数据，却会在部分产出后丢掉完整基线。
- 建议修复：把重跑输出写入独立 staging CSV，不要复用正式 `resultsCsv`。只有子进程完整成功且 staging 能通过结构/条数校验时，才原子替换正式结果并删除备份。停止或非零退出默认恢复完整旧结果；若产品希望保留部分新结果，应按稳定 artifact identity 与旧结果显式合并，确保“新成功覆盖旧行、未触达行保留旧值”，合并成功后再提交，绝不能用“文件非空”作为事务成功判据。

### ELEC-04 POSIX 进程树未被终止，退出仍忽略终止失败并释放锁

- 严重度：P1
- 位置：`src/electron/procTree.ts:52-68`、`79-90`、`115-131`、`src/electron/main.ts:2443-2450`、`src/ocr/efapiao.ts:336-359`
- 置信度：CONFIRMED
- 证据：
  ```ts
  const signalled = sendSignal(child, 'SIGTERM');
  return { treeTerminated: signalled, signalled };
  ```
  ```ts
  sendSignal(child, 'SIGKILL');
  }
  await Promise.all(stillAlive.map((child) => waitForExit(child, 1000)));

  const remaining = pending.filter(isAlive).length;
  if (remaining > 0) {
    treeIncomplete = true;
    details.push(`仍有 ${remaining} 个后台进程没有在超时内退出`);
  }
  return { remaining, treeIncomplete, details };
  ```
  ```ts
  void terminateChildren(activeChildren).finally(() => {
    activeChildren.clear();
    coordinator.dispose();
    cleanupAllTempDirs();
    app.quit();
  });
  ```
- 问题：Windows 分支现在确实使用 `taskkill /T /F`，旧 APP-16 的主要 Windows 缺陷已修；但 POSIX 分支只给直接 Node CLI 发 `SIGTERM`，只要 `child.kill()` 接受信号就把 `treeTerminated` 标成 true。超时升级也只对直接 child 发 `SIGKILL`。OCR CLI 启动的 `efapiao serve` 明确调用了 `child.unref()`；一旦 Node CLI 来不及执行自己的清理 handler 而被 `SIGKILL`，serve 会成为孤儿并继续占端口、保留旧凭据环境。

  更严重的是，`terminateChildren()` 已经返回 `remaining/treeIncomplete/details`，退出调用方却放在 `.finally()` 中无条件 `activeChildren.clear()`、释放 data-dir lock 并退出。验证失败的信息完全被丢弃；若仍有直接子进程在写数据，新实例可以在旧任务尚未退出时获得锁。
- 建议修复：POSIX 启动 CLI 时创建独立进程组，并对经过验证的负 PGID 发 `SIGTERM`/`SIGKILL`；或者显式追踪 CLI 与 serve PID 并逐个等待。Windows 保留 `/T`，长期方案用 kill-on-close Job Object。`before-quit` 必须读取 `TerminateSummary`：`remaining > 0` 时不得释放数据锁并伪装成清理成功；应重试、显示可操作错误，或进入明确记录 orphan PID 的故障退出流程。`treeTerminated` 只应在等待后验证整棵树退出时为 true。

### ELEC-05 打包应用可因 `MFH_DATA_DIR` 跳过单实例锁

- 严重度：P1
- 位置：`src/electron/main.ts:110-119`、`2388-2401`
- 置信度：CONFIRMED
- 证据：
  ```ts
  const dataDir = process.env.MFH_DATA_DIR
    ? path.resolve(process.env.MFH_DATA_DIR)
    : app.getPath('userData');
  ```
  ```ts
  const hasSingleInstanceLock = process.env.MFH_DATA_DIR ? true : app.requestSingleInstanceLock();
  ```
- 问题：注释说 `MFH_DATA_DIR` 是自动化测试隔离，但条件没有 `!app.isPackaged`。正式安装包只要继承该环境变量，就完全跳过 Electron 单实例锁；两个实例可同时打开同一 dataDir。四类主操作仍会被磁盘锁挡住，但 `ELEC-02` 中未占锁的配置保存、pending 重写和 reset 可以跨实例并发，因此这不是无害的“多配置档”能力。
- 建议修复：测试豁免必须同时要求 `!app.isPackaged` 和显式测试模式，例如 `const isolatedTest = !app.isPackaged && process.env.MFH_E2E_NO_GUI === '1' && Boolean(process.env.MFH_DATA_DIR)`；打包态始终调用 `requestSingleInstanceLock()`。如果未来正式支持多数据目录，应把 profile identity 设计成受验证的启动参数，并为每个数据目录建立独立、覆盖所有写操作的实例/租约协议，而不是见到环境变量就跳过锁。

### ELEC-06 `open-path` 的允许根可由 renderer 改写，pending hash 也可路径穿越

- 严重度：P1
- 位置：`src/electron/main.ts:1718-1721`、`2047-2074`、`2226-2234`、`src/config.ts:480-484`
- 置信度：CONFIRMED
- 证据：
  ```ts
  ipcMain.handle('mfh:save-config', (_event, payload: unknown) => {
    const raw = asObject(payload);
    const outcome = saveConfig(payload, { repairCorrupt: raw.repairCorrupt === true });
    return outcome;
  });
  ```
  ```ts
  const allowedBases = [dataDir, invoicesDirPath(), pendingDirPath(), samplesDirPath()];
  if (!isContainedPath(resolved, allowedBases)) {
    return { ok: false, code: 'path_outside_data_dir', error: '路径不在允许的目录范围内。', message: '路径不在允许的目录范围内。' };
  }
  ```
  ```ts
  const error = await openPathForUser(resolved);
  ```
  ```ts
  const hash = typeof raw.hash === 'string' ? raw.hash : '';
  if (!hash) return { ok: false, code: 'pending_missing_hash', message: '缺少邮件标识。' };
  const row = findPendingRow(hash);
  const emlPath = path.join(pendingDirPath(), `${hash}.eml`);
  ```
- 问题：`open-path` 看似有包含性检查，但三个额外 allow root 来自 renderer 可写的配置；配置 schema 只要求路径是非空字符串。renderer 可先把 `paths.invoices` 保存为 `/`（Windows 可保存为盘符根），再调用 `openPath({path: 任意绝对路径})`，此时 `/` 自然包含所有路径。`shell.openPath()` 会按系统关联打开文件/应用，这把本应受限的能力扩展成了任意系统路径打开。

  `pending-refresh-link` 还有独立入口：hash 只检查非空，`../../...` 会经过 `path.join()` 逃出 pending 目录，再尝试打开对应 `.eml`。两个问题都说明 IPC payload 只有“取字符串”而没有按领域格式验证。
- 建议修复：不要从可变配置重新构造安全 allowlist。为 renderer 返回 opaque file ID/diagnostics ID，主进程在内部映射到已知文件；目录按钮使用枚举 `{kind: 'invoices'|'pending'|'samples'}`，不要接收路径。确需打开外部配置目录时，保存配置阶段把 canonical realpath 与用户授权记录绑定，打开时再次 realpath 校验。hash 必须匹配 `^[0-9a-f]{12}$`，拼接后再做 canonical containment。所有调用同时执行 `ELEC-01` 的 trusted-sender 校验。

### ELEC-07 逐邮件日志和摘要返回值绕过完整脱敏，邮箱、主题、原始错误和绝对路径进入 renderer

- 严重度：P1
- 位置：`src/electron/sanitize.ts:20-31`、`src/electron/main.ts:560-561`、`803-811`、`1198-1212`、`1297-1305`、`1693-1715`、`src/index.ts:950-956`、`src/electron/summary.ts:238-255`
- 置信度：CONFIRMED
- 证据：
  ```ts
  text = text.replace(URL_IN_TEXT, (match) => keep(redactUrl(match)));
  text = text.replace(WINDOWS_PATH, (match) => keep(redactPath(match)));
  text = text.replace(POSIX_PATH, (match) => keep(redactPath(match)));
  text = text.replace(SECRET_ASSIGN, (_m, key: string, sep: string) => `${key}${sep}***`);
  text = text.replace(LONG_HEX, (match) => shortId(match));
  ```
  ```ts
  emit({
    operation: 'files',
    phase: text.includes('[warn]') ? '需要确认' : '获取日志',
    processed: current.processed,
    skipped: current.skipped,
    failed: current.failed,
    code: 'files_log',
    message: logText(text),
    kind: text.includes('[error]') ? 'err' : text.includes('[warn]') ? 'warn' : '',
  });
  ```
  ```ts
  log.warn(`pending ${failure.hash} date=${failure.date} from="${failure.from}" subject="${failure.subject}" reason=${failure.reason}`);
  ```
  ```ts
  return {
    configPath,
    configExists: fs.existsSync(configPath),
    // 保留原字段名（renderer 已在读取），同时新增结构化版本。
    configError: error ? sanitizeText(error) : '',
    configErrorInfo: error ? { message: sanitizeText(error) } : undefined,
    config: redactedConfig,
    secrets,
    dataDir,
  };
  ```
- 问题：`sanitizeText()` 会处理 URL query、绝对路径、常见 secret assignment 和长 hash，但没有邮箱地址或邮件主题规则。pipeline 明确把 `from` 和 `subject` 写入逐邮件 warning；`parseFileLine()` 随后把这行经 `logText()` 直接广播到 `mfh:file-progress`，`recordHistory()` 也把同一输出写入 GUI history。屏幕共享、复制运行日志或读取 history payload 时会暴露员工/供应商邮箱与报销主题。

  另一个旁路是 `appSummary()`：它没有经过 `sanitizeText()`，会返回 OCR CSV 中原始 `error/reason`、`filePath`、`pendingCsv/resultsCsv/indexCsv`；`get-config` 还直接返回 `configPath`、`dataDir` 和可能为绝对路径的配置。旧审计 COPY-01 的 URL/token 主路径已明显改善，但“所有进入 renderer 的技术信息统一脱敏”仍未成立。
- 建议修复：区分业务展示数据与诊断数据。邮件列表可以保留用户主动查看所需的发件人/主题，但 progress/history 只发送稳定 code、计数和短 support reference，禁止复用 raw CLI 行。为 `AppSummary` 建立 renderer DTO：删除内部 CSV/path 字段，文件操作改用 opaque ID；所有 `error/reason` 在 DTO 边界统一脱敏和分类。邮箱地址在诊断文本中按 `a***@domain` 或 `<邮箱已隐藏>` 处理，不能依赖 renderer 再清洗。

### ELEC-08 后处理异常会把已经成功的 CLI 操作伪装成“本地数据没有变化”

- 严重度：P1
- 位置：`src/electron/main.ts:1763-1780`、`1816-1833`、`1999-2019`、`src/electron/summary.ts:173-175`、`238-240`、`gui-design/scripts/shell.js:2208-2242`
- 置信度：CONFIRMED
- 证据：
  ```ts
  const result = await runCli('run', args, { operation: 'files', jobId: gate.lease.jobId });
  const warning = recordHistory('pipeline', raw.onlyMail ? '重新处理单封邮件' : '处理缓存邮件', startedAt, result);
  ```
  ```ts
  const batch = batchFromHashes([...result.mails.processed, ...result.mails.manual]);
  const report = reportFor('pipeline', gate.lease.jobId, result, { ok: 'pipeline_done', failed: 'pipeline_failed' });
  ```
  ```ts
  ...(warning ? { warning } : {}),
  summary: appSummary(),
  };
  ```
  ```js
  } catch (err) {
      const failMessage = '操作没有完成，本地数据没有变化。';
  ```
  ```js
      showToast('运行失败', failMessage, 'err', { detail: err?.message, scope: 'global' });
      return;
  ```
- 问题：CLI 的真实写操作已经完成后，handler 仍同步执行 batch 还原和全量摘要读取。`readCsvRows()` 对已存在但不可读的 CSV 会直接抛错；当配置或 CSV 在后处理阶段不可读/损坏时，`appSummary()` 也会抛出。这些辅助读取不在错误边界内，于是整个 `ipcMain.handle` 以 rejection 结束。在该触发路径上，CLI 已经返回，发票、state、CSV 的真实提交先于 rejection；renderer 的统一 catch 却明确告诉用户“本地数据没有变化”。用户按提示重试会造成重复处理或触发强制重跑。旧 APP-18B 的 history 写失败已经改成 best-effort；同一根因仍存在于 batch/summary 后处理。
- 建议修复：在 `runCli()` 返回后立即固化不可被辅助失败覆盖的 operation result。`batchFromHashes`、history、summary 分别放入独立 best-effort enrichment，失败只附加 `warning`/`summaryUnavailable`，绝不 reject 已完成操作。renderer catch 文案不能断言“数据没有变化”；只有主进程返回明确的 `started:false` 或事务回滚确认后才能使用该说法。

### ELEC-09 手工归档只对历史数据去重，同一批相同内容会重复归档

- 严重度：P1
- 位置：`src/electron/manualArchive.ts:221-264`、`269-298`
- 置信度：CONFIRMED
- 证据：
  ```ts
  staged.push({ source, data, format: detected.format, ext: detected.ext, hash: contentHash(data) });
  ```
  ```ts
  for (const item of staged) {
    if (queueSeen.has(`${input.hash}${SEP}${item.hash}`)) {
      duplicates.push(path.basename(item.source));
      continue;
    }
    const ledgerFilename = ledgerFilenameByKey.get(`${messageId}${SEP}${item.hash}`);
    if (ledgerFilename && fs.existsSync(path.join(input.invoicesDir, ledgerFilename))) {
      toReuse.push({ item, filename: ledgerFilename });
      continue;
    }
    toInstall.push(item);
  }
  ```
- 问题：`queueSeen` 和 `ledgerFilenameByKey` 只来自归档前的 CSV；循环把第一个新文件放入 `toInstall` 后，没有把它的 contentHash 加入本批 seen 集合。用户一次选择两个内容完全相同但文件名不同的副本时，两者都会分配编号、写入归档目录、台账和 OCR 队列。现有“已归档文件”去重提示不会触发，后续 OCR 和报销清单出现重复票。
- 建议修复：在 staging 完成后先按 `${input.hash}\0${contentHash}` 做本批稳定去重，保留第一个来源并把后续来源加入 `duplicates`；随后再与已有 queue/ledger 合并。事务计划和返回值都应基于去重后的集合，并增加“同批不同文件名、相同字节”回归用例。

### ELEC-10 手工归档在主进程同步读入全部选中文件，没有累计大小上限

- 严重度：P1
- 位置：`src/electron/manualArchive.ts:66-67`、`207-264`、`src/electron/main.ts:2288-2296`
- 置信度：CONFIRMED
- 证据：
  ```ts
  const MAX_FILE_BYTES = 64 * 1024 * 1024;
  ```
  ```ts
  interface StagedSource {
    source: string;
    data: Buffer;
    format: ArchiveFormat;
    ext: string;
    hash: string;
  }
  ```
  ```ts
  data = fs.readFileSync(source);
  ```
  ```ts
  staged.push({ source, data, format: detected.format, ext: detected.ext, hash: contentHash(data) });
  ```
- 问题：限制只作用于单个文件，选择数量和累计字节没有上限；所有 Buffer 一直保存在 `staged`，直到整批事务完成。handler 又直接在 Electron main thread 调用 `runManualArchive()`。例如选择 20 个接近 64 MB 的扫描件会同步分配约 1.25 GB Buffer，并在读取、hash、写入期间冻结窗口；更大批次可使主进程被系统终止，用户只看到应用消失。单文件上限不能防止这个确定的累计资源路径。
- 建议修复：在读取前先 stat 全部来源，限制文件数和累计字节，并返回用户可理解的批次错误。归档实现应移出 Electron main thread；采用 worker/受控子进程，逐文件流式 hash 到事务 staging 文件，不在内存同时保留全批字节。主进程只负责对话框、操作租约和结构化进度。

### ELEC-11 行装配器的 carry 无上限，有界 ring buffer 无法约束超长未换行输出

- 严重度：P2
- 位置：`src/electron/lineStream.ts:10-27`、`34-56`、`src/electron/main.ts:942-953`
- 置信度：CONFIRMED
- 证据：
  ```ts
  push(chunk: Buffer): string[] {
    const text = this.carry + this.decoder.write(chunk);
    const parts = text.split(/\r?\n/);
    this.carry = parts.pop() ?? '';
    return parts;
  }
  ```
  ```ts
  for (const line of stdoutLines.push(chunk)) {
    stdoutTail.push(line);
    handleLine(line);
  }
  ```
- 问题：旧 APP-23 的 UTF-8 解码、跨 chunk carry、close flush 和 500 行 ring buffer 已正确修复；但 ring buffer 只接收“已经结束的行”。如果 CLI/第三方错误输出持续写入一条没有换行的超长行，全部内容会累积在 `LineAssembler.carry`，完全绕过 500 行上限；每次 `this.carry + ...` 还会重复复制已有字符串。CLI 会记录用户控制的邮件主题和外部工具错误，因此 oversized line 不是被类型系统排除的输入。
- 建议修复：给每个 assembler 设置字节/字符上限（例如 64 KiB）。超限后输出一次带 `truncated:true` 的截断行，随后进入“丢弃至下一个换行”状态；不要继续拼接整条内容。ring buffer 同时增加累计字节上限，而不仅是行数。

### ELEC-12 OCR 允许单件失败时仍按 exit code 把运行历史记为“成功”

- 严重度：P2
- 位置：`src/electron/main.ts:1198-1212`、`1922-1927`、`1954`、`src/index.ts:1147-1156`
- 置信度：CONFIRMED
- 证据：
  ```ts
  const status: RunHistoryEntry['status'] = result.code === 0 ? 'success' : 'failed';
  return appendHistory({
    action,
    title,
    status,
    message: status === 'success' ? '已完成' : '运行失败',
    detail: output || (status === 'success' ? '命令已完成。' : '没有收到错误详情。'),
    durationMs: Date.now() - startedAt,
  ```
  ```ts
  const args = ['run', '--config', ocrTemp.file, '--allow-parse-failures'];
  ```
- 问题：Electron 每次 OCR 都传 `--allow-parse-failures`。CLI 在该模式下即使 `summary.failed > 0` 也返回 0；实时终态会正确显示“失败 N 个”，但 `recordHistory()` 只看 exit code，于是历史卡片记成 `success / 已完成`，`RunHistoryEntry` 已定义却从未使用 `partial`。非技术用户回看历史时会误以为该批全部识别成功。
- 建议修复：`runCli` 应返回结构化终态计数，或从稳定的 `OCR complete` 行解析出 `failed`；`failed > 0 && parsed/updated > 0` 记 `partial`，全部失败记 `failed`，全部成功才记 `success`。历史 message 使用同一份用户态结果，不再把进程 exit code 当业务结果。

### ELEC-13 2466 行 `main.ts` 混合 13 类责任，安全/事务边界无法集中审查

- 严重度：P1
- 位置：`src/electron/main.ts:109-2466`
- 置信度：CONFIRMED
- 证据：
  ```ts
  const activeChildren = new Set<ChildProcess>();
  ```
  ```ts
  const ocrProcesses = new Map<string, ChildProcess>();
  const ocrStopRequested = new Set<string>();
  ```
  ```ts
  const activeTempDirs = new Set<string>();
  ```
  ```ts
  const coordinator = new OperationCoordinator(dataDir);
  ```
  ```ts
  ipcMain.handle('mfh:start-fetch', async (_event, payload: unknown) => {
  ```
  ```ts
  ipcMain.handle('mfh:developer-reset', () => {
  ```
- 问题：这不是单纯“文件太长”的风格意见。`ELEC-01`、`ELEC-02`、`ELEC-07` 和 `ELEC-08` 都由同一个结构性事实放大：sender 校验、payload 校验、操作租约、错误归一化、摘要 enrichment 分散在每个 handler 中，没有强制入口。当前顶层责任图如下：

  | 行范围 | 顶层责任 |
  |---|---|
  | `109-158` | app/data/config/state 路径、全局进程/临时目录/协调器状态、dev fake 门禁 |
  | `160-207` | UI 路径、BrowserWindow 创建、窗口安全参数、系统打开/定位文件 |
  | `209-402` | payload 基础转换、配置读取/迁移/校验/原子写、secret redaction |
  | `404-523` | 临时目录生命周期、OCR 最小运行配置 |
  | `525-827` | renderer 广播、fetch/OCR/file 文本协议与进度状态机 |
  | `829-1061` | CLI spawn、stdio drain、行解析、child/OCR PID 跟踪、终止状态 |
  | `1063-1151` | 诊断日志落盘/清理、IPC CLI report |
  | `1153-1214` | GUI history 读取、隔离、原子写和状态映射 |
  | `1216-1378` | 配置路径解析、摘要、pending CSV 重写、目录创建 |
  | `1380-1536` | OCR 重跑备份/恢复事务 |
  | `1538-1657` | operation lease、筛选规范化、本次运行批次还原 |
  | `1659-2382` | 18 个 IPC handler：读信息、配置、fetch、pipeline、OCR、organize、系统文件、IMAP、pending、reset |
  | `2384-2466` | 单实例、归档恢复、ready/quit/activate 生命周期 |

  文件对话框嵌在 `pending-manual-archive`（`2257-2271`）；日志职责是 diagnostics/history，而不是独立 logger。当前没有菜单和自动更新实现，这两项不应虚构进拆分计划。
- 建议修复：采用下面的具体模块边界，最终让 `main.ts` 只做约 100～150 行 composition root：

  1. `appContext.ts`：构造只读 `rootDir/dataDir/configPath/statePath`，注册 managed roots。
  2. `windowManager.ts`：`createWindow`、trusted sender/navigation/window-open policy、`sendToRenderer`。
  3. `configStore.ts`：`readConfigStrict/normalizeSavePayload/saveConfig/redactConfig`；唯一配置写入口。
  4. `dataPaths.ts`：所有解析路径和 opaque file handle 映射；禁止 handler 自行 `path.resolve`。
  5. `tempOcrConfig.ts` 与 `ocrRerunTransaction.ts`：临时凭据文件和重跑 staging/commit/restore。
  6. `progressProtocol.ts`：`parseFetchLine/parseOcrLine/parseFileLine`、terminal guard、renderer-safe DTO。
  7. `cliSupervisor.ts`：`runCli`、active children/OCR jobs、stdio、stop/quit 验证；不读取 GUI DOM/summary。
  8. `diagnosticsStore.ts`、`historyStore.ts`：各自 best-effort，不允许覆盖 operation result。
  9. `summaryGateway.ts`：只读 enrichment 与 renderer DTO，内部异常转换为 warning。
  10. `ipc/readHandlers.ts`：`get-summary`、`get-op-state`、`get-app-info`。
  11. `ipc/configHandlers.ts`：`get-config`、`save-config`；`ipc/imapHandlers.ts`：`test-connection`、`list-mailboxes`。
  12. `ipc/runHandlers.ts`：`start-fetch`、`run-pipeline`、`run-ocr`、`stop-ocr`、`organize`。
  13. `ipc/pendingHandlers.ts`：`pending-ignore`、`pending-refresh-link`、`pending-manual-archive`。
  14. `ipc/systemHandlers.ts`：`open-path`、`copy-text`、`developer-reset`，其中 destructive handler 强制 native confirmation + lease。

  非平凡耦合不能靠机械搬文件解决：`runCli` 必须拿 coordinator 的 lease token；OCR 同时依赖 job map、temp config、rerun transaction、progress、history；手工归档同时依赖 dialog、路径授权、pipeline lease、archive journal、pending store；几乎所有写 handler 都想附带 summary。应先定义一个显式 `OperationContext { coordinator, cliSupervisor, configStore, paths, progressBus, summaryGateway }` 并通过构造注入，再移动 handler。否则只会把当前全局变量变成跨模块单例，安全边界仍然不存在。

### ELEC-14 启动初始化没有错误边界，配置创建失败会留下无窗口应用

- 严重度：P0
- 位置：`src/electron/main.ts:164-173`、`2427-2434`
- 置信度：CONFIRMED
- 证据：
  ```ts
  function ensureUserDataConfig(): void {
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(configPath)) return;
    fs.copyFileSync(bundledConfigPath, configPath);
    try {
      fs.chmodSync(configPath, 0o600);
    } catch {
      // Best-effort on platforms that do not preserve POSIX file modes.
    }
  }
  ```
  ```ts
  app.whenReady().then(async () => {
    if (!hasSingleInstanceLock) return;
    ensureUserDataConfig();
    cleanupStaleTempDirs();
    recoverPendingArchives();
    await loadDevFakeBackend();
    createWindow();
  });
  ```
- 问题：`mkdirSync` 和 `copyFileSync` 可抛出，但 `whenReady().then(...)` 没有 `.catch()`，窗口又只在它们之后创建。首次启动时若 userData 不可写、磁盘已满、内置示例缺失或 `MFH_CONFIG_PATH` 指向不可创建位置，ready promise 以未处理 rejection 结束；`createWindow()` 不会执行，也没有错误提示或修复入口。对目标用户表现为“点了应用没反应”，是完整的启动阻断。
- 建议修复：为 bootstrap 建立顶层错误边界。创建配置失败时调用 `dialog.showErrorBox`/`showMessageBox` 给出中文原因和数据目录位置的脱敏引用，提供“重试”或“退出”；只有初始化成功后才注册可写 handler/创建主窗口。顶层 `void bootstrap().catch(fatalStartupError)`，并确保 fatal path 清理 coordinator、临时目录和已启动 child。

## 明确排除的项（我检查过但认为不是问题）

1. **main/preload/renderer 通道没有缺失或孤儿。** 当前 18 个 `ipcMain.handle` 与 18 个 `ipcRenderer.invoke` 一一对应；`mfh:fetch-progress`、`mfh:operation-progress`、`mfh:file-progress`、`op-state` 四个发送/订阅通道也完全对应。没有 `ipcMain.on` 通道。
2. **打包态 fake backend 已正确隔离。** `src/electron/main.ts:143-155` 同时要求 `!app.isPackaged` 和 `MFH_E2E_FAKE_CLI=1` 才动态 import；`package.json:58-64` 又排除了 `dist/electron/devFakeBackend.js` 和 GUI tests。旧 CODE-04 在当前发布配置下不再可达。
3. **窗口的基础隔离参数正确。** `src/electron/main.ts:186-190` 显式设置 `contextIsolation:true`、`nodeIntegration:false`；项目使用 Electron 42（`package.json:43`），其 `sandbox` 与 `webSecurity` 默认均为 true（[Electron BrowserWindow 官方文档](https://www.electronjs.org/docs/latest/api/browser-window)）。未显式写出这两个默认值本身不构成 finding；真正缺口是 `ELEC-01` 的 sender/navigation/能力校验。
4. **没有 `shell.openExternal` 调用，也没有把 renderer 字符串直接拼成 shell 命令。** CLI 使用 `spawn(process.execPath, [固定入口, 固定 command, ...args])`（`src/electron/main.ts:917-920`），参数数组不会发生 shell 元字符注入。路径权限问题已单独精确收敛为 `ELEC-06`。
5. **旧 APP-23 的 chunk/UTF-8 主缺陷已修。** `LineAssembler` 使用独立 `StringDecoder`、跨 chunk carry、close flush；`LineRingBuffer` 只保留 500 行，终态还有 `terminalGuard`。本报告只保留未解决的 oversized-line 上限问题（ELEC-11）。
6. **Windows 终止主路径已不再只杀直接 child。** `src/electron/procTree.ts:25-36` 检查 `taskkill /T /F` 的 error/signal/status，并把“进程不存在”视为成功；本报告 ELEC-04 针对的是 POSIX 分支和调用方忽略验证结果，不重复旧 APP-16 的原始 Windows 结论。
7. **macOS 关闭最后一个窗口后任务继续运行不是孤儿进程。** `window-all-closed` 只在非 macOS 退出（`src/electron/main.ts:2459-2461`），进程和 coordinator 仍存活；Dock 重开窗口会补发当前 op state，`sendToRenderer` 也跳过已销毁窗口。真正的 orphan 风险发生在 app quit/强杀升级，已列 ELEC-04。
8. **手工归档已具备持久事务和格式 magic 校验。** `src/electron/manualArchive.ts:267-381` 通过 archive journal 保护“文件 + OCR 队列 + 台账”，用 `wx` 防覆盖，并区分普通 ZIP 与 OFD；旧 APP-04 的主问题已关闭。本报告 ELEC-09/10 是同批去重和资源上限两个独立剩余问题。
