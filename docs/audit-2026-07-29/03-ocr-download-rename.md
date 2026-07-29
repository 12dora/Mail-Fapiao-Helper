# OCR / 下载 / 归档 / 重命名 / 工具层审查报告
审查日期：2026-07-29 ｜ 审查范围：完整通读 `src/ocr/efapiao.ts`、`src/ocr/runner.ts`、`src/ocr/summary.ts`、`src/ocr/registry.ts`、`src/ocr/types.ts`、`src/download/downloader.ts`、`src/download/archiveJournal.ts`、`src/rename/rename.ts`、`src/pending/summary.ts`、`src/util/net.ts`、`src/util/url.ts`、`src/util/dataDirLock.ts`、`src/util/testFaults.ts`；为核对调用顺序与生产可达性，另读了 `src/pipeline.ts`、`src/electron/manualArchive.ts`、`src/electron/opCoordinator.ts`、`src/electron/main.ts`、`src/index.ts`、`src/extract/directLink.ts`、`src/sites/common.ts`、`src/config.ts`、`src/util/identity.ts`、`src/util/csv.ts`、`config.example.json`、`gui-design/pages/config.html`、`package.json` 及相关回归测试片段。

## 摘要

当前代码相较 2026-07-27 基线已有明显进步：旧 `APP-13`、`APP-14A/B/C`、下载扩展名冲突、ZIP 防护和故障注入门禁均已实质修复。
但新归档 journal 仍不具备掉电级 durability：CSV 没有 `fsync`，journal 却先持久标记为 `ledger-committed`，可留下“文件存在、台账/OCR 队列缺行”的状态。
跨进程锁还有两个可构造的双持有者窗口：父 Electron 崩溃后，仍运行的继承租约 CLI 不再被视为持有者；陈旧锁 CAS 恢复失败时还会丢弃刚取得的新锁。
SSRF 防护对自动重定向的检查发生在目标请求之后，公网链接跳转到内网时已经完成内网请求；独立 DNS 校验也没有绑定到实际 socket。
手工归档在 `prepared` 阶段没有 staging 身份证明，进程中断后 journal 无法证明文件归属，而且所谓 strict recovery 仍会继续后续写入。
最先应修的是 `OCR-01`～`OCR-04`：统一受控 HTTP transport、把锁 ownership 转交给实际工作进程、修正 stale-lock 恢复协议，并建立“CSV `fsync` 后才能提交 journal”的 durable 顺序。
随后处理手工归档恢复、staging 清理和归档复用校验，再做 OCR CSV 的平方级 I/O 与 `efapiao.ts` 拆分。

## findings 汇总表

| ID | 严重度 | 标题 | 位置 |
|---|---|---|---|
| OCR-01 | P0 | SSRF 的重定向校验发生在内网请求之后，DNS 校验也未绑定到连接 | `src/util/net.ts:143-189` |
| OCR-02 | P0 | 父进程崩溃会让仍运行的继承租约 CLI 与新实例并发写同一数据目录 | `src/util/dataDirLock.ts:222-241,429-440` |
| OCR-03 | P0 | CSV 未 `fsync` 就把 journal 标成 `ledger-committed` | `src/pipeline.ts:112-123,668-675` |
| OCR-04 | P0 | stale-lock CAS 在恢复失败时会永久剥掉一个刚取得的新锁 | `src/util/dataDirLock.ts:331-367` |
| OCR-05 | P1 | 手工归档中断会产生不可恢复的 `prepared` 事务，strict recovery 仍放行写入 | `src/electron/manualArchive.ts:332-352` |
| OCR-06 | P1 | 锁与归档 journal 仅凭 PID 判活，PID 复用会长期阻塞业务 | `src/util/dataDirLock.ts:155-163,222-241` |
| OCR-07 | P1 | 崩溃遗留的 `.staging` 文件没有任何启动恢复路径 | `src/download/downloader.ts:198-240` |
| OCR-08 | P1 | 幂等复用只检查旧文件存在，不核对它仍匹配 `contentHash` | `src/download/downloader.ts:218-236` |
| OCR-09 | P1 | 默认重命名模板会把 OFD/图片副本写成 `.pdf` | `src/rename/rename.ts:126-131` |
| OCR-10 | P1 | organize 审计 CSV 写失败会在文件已复制后再次抛错并中止整批 | `src/rename/rename.ts:241-258` |
| OCR-11 | P1 | 固定假数据的 `mock` OCR provider 可由生产配置直接启用 | `src/ocr/registry.ts:5-51` |
| OCR-12 | P1 | `efapiao parse` 超时后不等待/升级终止，stdout/stderr 也无上限 | `src/ocr/efapiao.ts:454-498` |
| OCR-13 | P2 | OCR 每追加一个结果都重读完整 CSV，checkpoint 也可逐行重写全表 | `src/ocr/runner.ts:186-223,378-400` |
| OCR-14 | P2 | 编号归档和重命名冲突都从头同步扫描，长期累计为平方级 I/O | `src/download/downloader.ts:110-121` |
| OCR-15 | P2 | `efapiao.ts` 是 682 行 god-module，五类变化共用模块级状态 | `src/ocr/efapiao.ts:49-130,306-354,532-680` |

## 详细发现

### OCR-01 SSRF 的重定向校验发生在内网请求之后，DNS 校验也未绑定到连接
- 严重度：P0
- 位置：`src/util/net.ts:143-189`、`src/sites/common.ts:96-107`、`src/pipeline.ts:356-380`
- 置信度：CONFIRMED
- 证据：
  ```ts
  addrs = await lookup(host, { all: true });
  // ...
  export async function assertPublicResponse(response: Response): Promise<Response> {
    const finalUrl = response.url;
    if (finalUrl) {
      try {
        await assertPublicUrl(finalUrl);
  ```
  ```ts
  const response = await assertPublicResponse(await ctx.http(url, {
    redirect: 'follow',
  ```
- 问题：`assertPublicResponse()` 收到的是已经完成请求后的 `Response`。当邮件中的公网 URL 返回 `302 Location: http://127.0.0.1:...` 时，`redirect: 'follow'` 已经向内网地址发出 GET，之后的检查只能拒绝读取结果，不能撤销请求。原始 URL 的 `lookup()` 与后续 `fetch()` 也各自解析 DNS，没有把已验证的公网 IP 固定到实际连接，因此 DNS rebinding 同样绕过前置检查。这是可由邮件内容触发的真实 SSRF，不需要控制本机文件。
- 建议修复：建立唯一的受控 HTTP transport：关闭自动 redirect，逐跳解析 `Location`，在发送下一跳请求前校验 scheme/host/IP，并限制跳数；连接时把校验得到的 IP 绑定到 dispatcher/自定义 lookup，同时正确保留 TLS SNI 与 `Host`。已知第三方处理器再叠加精确 host allowlist。`assertPublicResponse()` 只能保留为事后防线，不能作为 SSRF 主防线。

### OCR-02 父进程崩溃会让仍运行的继承租约 CLI 与新实例并发写同一数据目录
- 严重度：P0
- 位置：`src/util/dataDirLock.ts:222-241`、`src/util/dataDirLock.ts:429-440`、`src/electron/opCoordinator.ts:82-95`
- 置信度：CONFIRMED
- 证据：
  ```ts
  if (isProcessAlive(holder.pid)) return false;
  // 进程确已死亡。
  // ...
  return true;
  ```
  ```ts
  function makeInheritedLease(lockPath: string, holder: DataDirLockPayload): DataDirLease {
    return {
      // ...
      // 锁属于父进程，子进程不得删除。
      release: () => {},
    };
  }
  ```
- 问题：磁盘 payload 的 `pid` 始终是 Electron 父进程；继承租约的 CLI 不刷新 payload、不把 ownership 转成自己的 PID，`release()` 也是空操作。Electron 异常退出而 CLI 仍在处理时，新实例看到父 PID 已死就立即回收锁；旧 CLI 仍继续写 state/CSV/journal，新任务也同时写。归档回滚按旧 `baseLength` 做 `truncate`，因此该双持有者路径可以截掉另一个任务已经提交的有效行，直接造成数据损坏。代码注释声称 token 解决了“父进程异常退出后子进程仍工作”的问题，但 token 只影响继承判定，没有进入 stale 判定。
- 建议修复：spawn 成功后做显式 lease handoff，把 payload 原子更新为实际 worker PID/进程出生标识并由 worker负责 heartbeat；父进程仅保留 supervisor 身份。或让父进程持锁但用 OS 级 job/process-group 保证父进程死亡时 worker 必然同步死亡。无论采用哪种方案，工作进程必须在每次事务提交前验证 lease generation；发现丢锁立即停止后续 mutation。

### OCR-03 CSV 未 `fsync` 就把 journal 标成 `ledger-committed`
- 严重度：P0
- 位置：`src/pipeline.ts:112-123`、`src/pipeline.ts:668-675`、`src/download/archiveJournal.ts:93-116,258-270`
- 置信度：CONFIRMED
- 证据：
  ```ts
  withCsvRetry(() => fs.appendFileSync(csvPath, body, 'utf8'));
  // ...
  appendCsvBlock(csvPath, INVOICE_CSV_HEADER, invoiceLines);
  appendCsvBlock(ocrPendingCsvPath, OCR_CSV_HEADER, ocrLines);
  tx.markStage('ledger-committed');
  ```
  ```ts
  fs.writeFileSync(fd, JSON.stringify(record));
  fs.fsyncSync(fd);
  // ...
  fs.renameSync(tmpPath, recordPath);
  ```
- 问题：两个 CSV 只完成了同步系统调用，没有对文件或其目录做 `fsync`；紧接着 `markStage()` 却 `fsync` journal 和 journal 目录。系统掉电或内核崩溃时，允许出现 durable journal 已是 `ledger-committed`、CSV 追加仍未落盘的顺序。恢复代码会把该 stage 当作完成并只删 journal，最终形成“归档文件存在，但 invoices.csv/OCR queue 缺行”；随后 processed state 仍可让正常重跑跳过邮件。这是旧 `APP-03` 事务化修复留下的 durable-ordering 缺口。
- 建议修复：用打开的 fd 写每个 CSV block，`fsync(fd)` 后关闭；新建 CSV 时还要 `fsync` 父目录。只有两个 CSV 都 durable 后才能写 `ledger-committed`。更稳妥的方案是把本批 ledger/queue delta 先写为 journal payload，恢复时对每个 delta 做幂等 roll-forward，而不是依赖截断补偿。

### OCR-04 stale-lock CAS 在恢复失败时会永久剥掉一个刚取得的新锁
- 严重度：P0
- 位置：`src/util/dataDirLock.ts:331-367`
- 置信度：CONFIRMED
- 证据：
  ```ts
  renameSync(lockPath, graveyard);
  // ...
  if (!sameObservedLock(observed, moved)) {
    if (moved.raw !== undefined) {
      createLockExclusive(lockPath, moved.raw, `restore-${token}`);
    }
    // ...
    rmSync(graveyard, { force: true });
    return false;
  }
  ```
- 问题：这里的“CAS”不是 compare-and-swap：比较发生在 `renameSync()` 已把当前锁搬走之后。可构造顺序为：A 观察旧 stale lock；B 先回收并成功取得新锁；A 把 B 的新锁 rename 到墓碑；C 在空出来的 `lockPath` 成功取得锁；A 发现内容不符，但恢复 B 时命中 C 的 `EEXIST`，随后仍删除墓碑。此后 B 与 C 都已经从 `acquireDataDirLock()` 得到成功结果，而磁盘只剩 C 的 token。B 最多在 30 秒后把内部 `held` 置为 false，仓库中没有调用 `isHeld()` 来中止 B 的写入，因此形成双持有者。
- 建议修复：增加所有 acquire/reclaim 都必须先持有的独立 recovery mutex，拿到 mutex 后重新读取并确认 stale，再搬移和创建；普通创建也必须尊重该 mutex，消除 rename 后的空窗。若搬到墓碑后发现身份不符，恢复失败时不得删除墓碑并静默返回；必须让所有相关 acquisition 失败并保留可诊断状态。为三竞争者交错写一个确定性进程测试。

### OCR-05 手工归档中断会产生不可恢复的 `prepared` 事务，strict recovery 仍放行写入
- 严重度：P1
- 位置：`src/electron/manualArchive.ts:332-352`、`src/download/archiveJournal.ts:126-128,175-181,362-366,387-392`
- 置信度：CONFIRMED
- 证据：
  ```ts
  const tx = beginArchiveTransaction(input.invoicesDir, {
    files: plannedPaths,
    // ...
  });
  // ...
  fs.writeFileSync(target, item.data, { flag: 'wx', mode: 0o600 });
  // ...
  tx.markStage('files-installed');
  ```
  ```ts
  if (cleanup.unresolved > 0) {
    disableCsvRollback(recordPath, record);
    skipped++;
    continue;
  }
  ```
- 问题：`plannedPaths` 是字符串，journal 会把它标成 `legacy`，没有 `stagingPath`。如果进程在某次 `writeFileSync()` 后、`markStage('files-installed')` 前中断，恢复时既没有 staging inode，也没有 installed fingerprint；非空 PDF 又不满足“0 字节 legacy placeholder”规则，所以永远是 `unresolved`。恢复仅持久化 `csvRollbackDisabled` 并返回 `skipped`；`assertArchiveTransactionsRecovered()` 对该 skipped 不抛错，后续手工/自动归档继续写并生成重复文件，残留 journal 也无法自行清除。
- 建议修复：手工归档也使用 `stageDocuments()` 的同卷 staging + hard-link 安装，或在安装每个文件后立即 durable 记录 inode/contentHash。`strict` 模式只要存在损坏、invalid 或 unresolved journal 就必须阻断所有 mutation，并向 GUI 提供具体恢复入口；不能把 `skipped` 当成功。

### OCR-06 锁与归档 journal 仅凭 PID 判活，PID 复用会长期阻塞业务
- 严重度：P1
- 位置：`src/util/dataDirLock.ts:155-163,222-241`、`src/download/archiveJournal.ts:66-76,300-307,348-353`
- 置信度：CONFIRMED
- 证据：
  ```ts
  function isProcessAlive(pid: number): boolean {
    // ...
    process.kill(pid, 0);
    return true;
  }
  ```
  ```ts
  if (record.pid !== process.pid && isProcessAlive(record.pid)) {
    if (opts.strict) throw new ArchiveRecoveryError(new Error('archive_recovery_live_pid_journal'));
  ```
- 问题：两套恢复都保存了 `startedAt`/`startedAtMs`，却没有核对 OS 进程出生时间或其他不可复用身份。持有者崩溃后，只要 PID 被无关进程复用，data-dir lock 会一直报告“另一个任务占用”；archive strict recovery 则直接阻断 OCR、organize 和归档，直到那个无关进程退出。该结论不依赖时间猜测：给残留记录写入任一当前存活的无关 PID 即可稳定触发。
- 建议修复：记录并核对平台进程出生标识（Linux `/proc/<pid>/stat` starttime，macOS/Windows 对应 API），或使用带 generation 的本地守护锁/OS handle。无法取得出生标识时，至少把 PID、host、start identity、token 组合判定；journal 还应支持由用户确认的安全恢复流程。

### OCR-07 崩溃遗留的 `.staging` 文件没有任何启动恢复路径
- 严重度：P1
- 位置：`src/download/downloader.ts:198-240`、`src/download/archiveJournal.ts:315-384`
- 置信度：CONFIRMED
- 证据：
  ```ts
  const stagingDir = path.join(
    invoicesDir,
    '.staging',
    `${msgIdHash}-${process.pid.toString(36)}-${randomBytes(4).toString('hex')}`,
  );
  // ...
  fs.writeFileSync(stagingPath, pdf.data, { mode: isPosix() ? FILE_MODE : undefined });
  ```
  ```ts
  const cleanup = removePlannedFiles(record, invoicesDir);
  // ...
  removeJournalOrThrow(recordPath);
  ```
- 问题：进程可能在 staging 写完、`beginArchiveTransaction()` 前退出，此时根本没有 journal；即使 journal 已存在，启动恢复也只删除 final path、截断 CSV、删除 journal，从不删除 `stagingPath` 或事务目录。正常 `dispose()`/`rollback()` 只存在于原进程内存中，重启无法调用。每次强退都可永久留下最高 50MB/文档的完整发票副本，持续占用磁盘并额外扩大敏感数据暴露面。
- 建议修复：把 staging 目录本身写进 journal；恢复完成后按 containment + transaction ID 删除它。启动时在持有 data-dir lock 的前提下扫描 `.staging`，仅清理能证明 PID/事务已死亡且超过创建宽限期的目录。创建 journal 前的窗口可通过“先建立空事务 journal，再写 staging manifest”消除。

### OCR-08 幂等复用只检查旧文件存在，不核对它仍匹配 `contentHash`
- 严重度：P1
- 位置：`src/download/downloader.ts:218-236`、`src/ocr/runner.ts:411-420`
- 置信度：CONFIRMED
- 证据：
  ```ts
  const existing = opts.alreadyArchived?.get(hash);
  if (existing) {
    const existingPath = path.join(invoicesDir, existing);
    if (fs.existsSync(existingPath)) {
      // ...
      contentHash: hash,
      reused: true,
  ```
- 问题：`hash` 来自本次刚提取的正确字节，但复用只根据旧 CSV 映射和 `existsSync()`；旧文件被替换、截断或变成目录时仍被当成相同 artifact。OCR 侧现在会重算 hash 并报 `content_hash_mismatch`，所以不会静默套用错误字段，但这也证明复用阶段已经选错：用户重新处理原邮件仍不会用邮件中的正确字节修复归档，只会反复得到 OCR 失败。旧 `APP-06B` 的“识别前检测”已修，归档复用的自愈仍缺失。
- 建议修复：复用前要求 `stat.isFile()`、大小合理，并流式计算现存文件的 `contentHash`；不匹配就把旧 ledger 映射标为损坏，按本次 artifact 重新 staging/归档，并记录可见的 repair 事件。`existing` 还必须先 `basename`/containment 校验。

### OCR-09 默认重命名模板会把 OFD/图片副本写成 `.pdf`
- 严重度：P1
- 位置：`src/rename/rename.ts:88-93,126-131`、`config.example.json:28-35`、`gui-design/pages/config.html:221-229`
- 置信度：CONFIRMED
- 证据：
  ```ts
  const ext = extFor(row);
  const withExt = path.extname(rendered).length > 0 ? rendered : `${rendered}${ext}`;
  return safePathSegment(withExt, /* ... */);
  ```
  ```json
  "rule": "{seller}-{amount}.pdf",
  "fallback": "{date}-{messageId}.pdf",
  ```
- 问题：只要模板已经带扩展名，代码就完全信任模板，不使用源文件的真实扩展名。仓库提供的默认/GUI placeholder 恰好固定为 `.pdf`，所以启用“识别成功后整理”时，OFD 和图片会被复制成 `.pdf`；系统和办公软件会用 PDF 解析器打开真实 OFD/图片并报损坏。这不是旧 `APP-12` 的 downloader 原问题（后者已修），而是下游 rename 再次引入同类错误。
- 建议修复：模板只生成 stem；最终扩展名必须始终来自 `extFor(row)`。若为兼容允许模板写扩展名，则只接受与真实扩展名大小写等价的值，其他值替换并记录 warning。同步把默认模板改成 `{seller}-{amount}` / `{date}-{messageId}`。

### OCR-10 organize 审计 CSV 写失败会在文件已复制后再次抛错并中止整批
- 严重度：P1
- 位置：`src/rename/rename.ts:241-258`
- 置信度：CONFIRMED
- 证据：
  ```ts
  const result = copyFileConflictSafe(src, path.join(targetDir, filename));
  if (result.copied) {
    summary.copied++;
    writeOrganizeAudit(auditCsv, row, result.finalPath, 'copied', '');
  }
  // ...
  } catch (err) {
    summary.failed++;
    const reason = err instanceof Error ? err.message : String(err);
    writeOrganizeAudit(auditCsv, row, '', 'failed', reason);
  ```
- 问题：文件复制和审计追加不在同一可恢复边界。若 `organize-results.csv` 不可写，目标文件先复制成功，第一次 audit 抛错；catch 又对同一个不可写 CSV 调用 `writeOrganizeAudit()`，第二次异常逃出整个函数，剩余票据不再处理。重跑会把已复制文件判作 same-content skip，但仍在 audit 处再次中止。Windows 上用户用 Excel 打开该 CSV 就是稳定触发条件之一。
- 建议修复：先预检 audit sink；把 audit 写入放进独立的 nested try，绝不能让错误报告自身再次抛出。更稳妥的是先写事务 audit intent，再原子复制/链接，最后提交；若审计失败，删除本次新副本或写入独立 recovery journal，保证 summary 与磁盘一致。

### OCR-11 固定假数据的 `mock` OCR provider 可由生产配置直接启用
- 严重度：P1
- 位置：`src/ocr/registry.ts:5-51`、`src/config.ts:497-500`、`package.json:58-64`
- 置信度：CONFIRMED
- 证据：
  ```ts
  function mockResult(meta: Parameters<OcrProvider['parse']>[1]) {
    return {
      status: 'success' as const,
      fields: {
        seller: meta.documentType === 'itinerary' ? '差旅平台' : '国家电网有限公司',
        amount: meta.documentType === 'itinerary' ? '88.00' : '318.42',
  ```
  ```ts
  if (cfg.ocr.provider === 'mock') {
    return {
      name: 'mock',
  ```
- 问题：配置加载器把 `ocr.provider` 当任意 string，正式包又包含除 `devFakeBackend` 外的全部 `dist/**/*`；`mock` 分支没有 `!app.isPackaged`、测试 token 或 sentinel。把一个语法完全合法的配置设为 `"provider":"mock"` 后，真实发票会被写入固定销售方、金额、日期和票号，并标成 `success`，下游整理和汇总都会把假结果当真。相比之下 `testFaults.ts` 已正确三重门控，这个 mock provider 仍是生产可达的测试后门。
- 建议修复：把 mock provider 移到测试专用入口，通过依赖注入传给 runner；生产 registry 只接受编译期枚举中的真实 provider。配置 schema 对 `ocr.provider` 使用 enum，并在 production build/verify 脚本中断言产物不含 `mockResult` 与 `MFH_MOCK_OCR_*`。

### OCR-12 `efapiao parse` 超时后不等待/升级终止，stdout/stderr 也无上限
- 严重度：P1
- 位置：`src/ocr/efapiao.ts:454-498`、`src/ocr/efapiao.ts:356-373`
- 置信度：NEEDS-RUNTIME-CHECK
- 证据：
  ```ts
  const timer = setTimeout(() => {
    child.kill('SIGTERM');
    reject(new Error(`efapiao timeout after ${cfg.ocr.timeoutMs}ms`));
  }, cfg.ocr.timeoutMs);

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  ```
- 问题：timeout 分支不检查 `kill()` 返回值，不等待 `close`，没有 grace period 后的 `SIGKILL`/Windows process-tree kill，也没有移除/封顶输出 buffer；Promise 已 reject 后，未退出的子进程和监听器仍可继续运行与积累内存。`stopEfapiaoServices()` 同样只发一次 `SIGTERM` 后立即清空 registry。当前代码缺少生命周期保证是确定的；实际 bundled `efapiao 0.1.3` 在 macOS/Windows 是否总能及时退出，需要运行时验证后才能确认最终影响。
- 建议修复：抽出统一 `terminateChildTree()`：先关闭 stdin，发温和终止，等待有界 grace，仍未 close 就强杀整棵树并再次等待；最终只在 `close` 后 settle。stdout/stderr 改为有界 ring buffer（例如各 64KB）并在超限时记录 truncation。确认方式：用替身 executable 忽略 SIGTERM、持续输出并派生子进程，验证 timeout 后进程树归零、RSS 有界；再对两个随包 binary 做同样测试。

### OCR-13 OCR 每追加一个结果都重读完整 CSV，checkpoint 也可逐行重写全表
- 严重度：P2
- 位置：`src/ocr/runner.ts:186-223`、`src/ocr/runner.ts:295-299`、`src/ocr/runner.ts:378-400`
- 置信度：CONFIRMED
- 证据：
  ```ts
  function migrateResultCsvIfNeeded(csvPath: string): void {
    if (!fs.existsSync(csvPath)) return;
    const text = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
    const records = parseCsv(text);
    // ...
  }
  // ...
  migrateResultCsvIfNeeded(csvPath);
  fs.appendFileSync(csvPath, resultLine(row, result), 'utf8');
  ```
- 问题：已有 results CSV 时，每个 OCR 结果 append 前都会完整读取并解析整张结果表，只为比较一次 header；N 个结果累计为 O(N²) 读取/解析。已有结果的逐行 skip 路径又在每行调用 `checkpoint()`；状态/原因发生变化时，每次都通过 tmp 重写完整 pending CSV。全部是同步 I/O，会直接阻塞 CLI event loop，历史越长，新增一批越慢。
- 建议修复：命令开始时只迁移/验证 results CSV 一次；随后持有 append fd 或批量追加结果。pending 状态采用批次 checkpoint 或 append-only status journal，结束时再 compact；保持 `APP-14C` 的可恢复性，但不要用“每行重写全表”换 durability。

### OCR-14 编号归档和重命名冲突都从头同步扫描，长期累计为平方级 I/O
- 严重度：P2
- 位置：`src/download/downloader.ts:110-121,283-293`、`src/rename/rename.ts:140-165`
- 置信度：CONFIRMED
- 证据：
  ```ts
  function nextNumberedPath(dir: string, ext: ArtifactExt, reserved: Set<string>): string {
    let counter = 1;
    while (true) {
      // ...
      if (!reserved.has(key) && !fs.existsSync(candidatePath)) {
        return candidatePath;
      }
      counter++;
    }
  }
  ```
  ```ts
  for (let counter = 0; ; counter++) {
    // ...
    if (sameFileContent(src, candidate)) {
  ```
- 问题：每新增一张票都从 `0001` 开始同步 `existsSync`；累计归档 N 张票需要约 N²/2 次路径检查。重命名冲突也从 base、`-1`、`-2` 逐个扫描，并为每个已存在候选完整读取两份文件比较内容；大量同销售方/同金额命名冲突时同样是平方级字节 I/O。两个循环都位于主处理线程。
- 建议修复：在锁内维护按扩展名的 durable next-number/high-water mark，碰到洞或冲突时向前校正；整理输出维护 `contentHash -> outputPath` 索引，先 O(1) 判断幂等，再用独占创建解决极少数竞争。不要为冲突比较重复读取整份票据。

### OCR-15 `efapiao.ts` 是 682 行 god-module，五类变化共用模块级状态
- 严重度：P2
- 位置：`src/ocr/efapiao.ts:49-130`、`src/ocr/efapiao.ts:167-230`、`src/ocr/efapiao.ts:236-407`、`src/ocr/efapiao.ts:409-499`、`src/ocr/efapiao.ts:501-680`
- 置信度：CONFIRMED
- 证据：
  ```ts
  const serviceStates = new Map<string, ServiceState>();
  // ...
  function bundledBinaryPath(): string | undefined {
  // ...
  async function ensureService(cfg: Config): Promise<void> {
  // ...
  function runBinary(
  // ...
  function okResult(payload: EfapiaoPayload, /* ... */): OcrResult {
  ```
- 问题：没有一个单独的 600 行 god-function；真正的问题是 god-module。它同时承担平台/资源路径解析、凭证环境拼装、托管服务 registry 与生命周期、HTTP 单项/批量 transport、CLI spawn/timeout/output、provider 错误/fallback 策略、payload schema 解析和业务结果归一化。模块级 `serviceStates` 让 transport 测试互相污染，也迫使生命周期修改接触结果映射代码；`OCR-12` 这类问题正跨越其中多项职责。
- 建议修复：按以下边界拆分，并用显式依赖组合：
  1. `efapiao/binary.ts`：platform/resource resolution、env、argv；
  2. `efapiao/processTransport.ts`：单项 spawn、输出上限、timeout、进程树终止；
  3. `efapiao/serviceManager.ts`：可注入的 service registry、health、start/stop；
  4. `efapiao/httpTransport.ts`：单项/批量 request 与 response size/error；
  5. `efapiao/normalize.ts`：payload schema validation、`okResult`/`errorResult`；
  6. `efapiao/provider.ts`：仅保留 executionMode 与 fallback 编排。
  `ServiceManager` 应由 CLI command 创建并在 finally `await dispose()`，不要保留进程级全局 map。

## 明确排除的项（我检查过但认为不是问题）

1. **旧 `APP-13`（下载无限等待）已修复。** `src/util/net.ts:17-25,197-235` 用 `AbortSignal.timeout()` 覆盖 header/body，并在超时或超限时 cancel reader；`src/pipeline.ts:356-397` 把 body 消费放回同一 retry attempt。这里不重报“没有 deadline”。
2. **旧 `APP-14A/B/C` 已实质修复。** `src/ocr/efapiao.ts:236-280` 保留持久 exit/close listener 并 drain 管道；`src/ocr/efapiao.ts:505-560` 把空/缺字段 `ok` 降为 `partial`；`src/ocr/summary.ts:110-143` 用结果表覆盖 pending 状态。
3. **下载最终落盘不会静默覆盖同名文件。** `src/download/downloader.ts:296-331` 用 hard-link 的独占创建语义，冲突时整批 rollback；`src/rename/rename.ts:147-165` 使用 `COPYFILE_EXCL` 并对相同内容做幂等 skip。`OCR-10` 是 audit 边界问题，不是覆盖问题。
4. **远端文件名和 ZIP entry 没有形成 path traversal/zip-slip。** `src/download/downloader.ts:98-108` 先 `path.basename` 再清洗；`src/sites/common.ts:154-223` 只把 entry 解压到内存并取 leaf name，不调用 `extractAllTo`/`extractEntryTo`，且有 entry/单项/总量/压缩比上限。
5. **旧 `APP-12` 在 downloader 内已修复。** `src/download/downloader.ts:68-107` 以 magic bytes 决定规范扩展名并替换已知错误扩展；本报告 `OCR-09` 是 rename 模块用固定 `.pdf` 模板重新引入的下游问题。
6. **`testFaults.ts` 的正式包故障注入门禁目前成立。** `src/util/testFaults.ts:7-10` 同时要求固定 token、具体 fault env 和 sentinel；`package.json:58-64` 明确排除 `gui-design/tests/**`，因此随包没有 `.fault-injection-enabled`。这与 `OCR-11` 无门禁的 mock provider 不同。
7. **binary 路径包含空格/CJK 不会被 shell 拆词。** `src/ocr/efapiao.ts:336-347,460-470` 使用 `spawn(binaryPath, argsArray, { shell: false(默认) })` 的参数数组；缺失 binary 的 `error` 也会被 `parseViaCli()` 转为单项 error，而不是让整批 Promise reject。
8. **`downloadPdfs()` 是当前仓库内无调用的兼容导出。** 它确实绕过 journal 直接 commit（`src/download/downloader.ts:346-359`），但 `rg` 证明生产调用方只使用 `stageDocuments()`，因此本轮不把不可达路径算成功能 finding；建议后续删除或改成必须显式传入 transaction。
