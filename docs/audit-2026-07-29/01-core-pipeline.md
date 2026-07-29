# CLI 核心与流水线编排审查报告
审查日期：2026-07-29 ｜ 审查范围：`src/index.ts`、`src/pipeline.ts`、`src/config.ts`、`src/state.ts`、`src/log.ts`、`src/util/dateRange.ts`、`src/util/csv.ts`、`src/util/identity.ts`、`src/util/hash.ts`；为核对调用契约，另读 `src/util/dataDirLock.ts`、`src/mail/fetcher.ts`、`src/download/downloader.ts`、`src/ocr/efapiao.ts`、`src/electron/main.ts`、`gui-design/scripts/shell.js`、`README.md`、`docs/CODE_REVIEW_FINDINGS_2026-07-27.md`

## 摘要

当前核心层较 2026-07-27 基线已有明显改善：归档 journal、状态隔离重建、批量 checkpoint、日期日历边界和 CSV 公式防护均已落地。
但仍有 3 个必须优先处理的 P0：锁身份取自 `--state` 而不是实际写入目标，致命错误不能真正停止已启动的 worker，以及邮件身份会确定性合并重复/缺失 `Message-Id` 的不同邮件。
这三项都直接破坏“同一业务目录只有一个写者”和“每封邮件独立处理”两个核心不变量，可造成 CSV/归档回滚越界或静默漏票。
其次，`run` 会把未落入 pending 的邮件和单封处理异常仍报告为成功；`--only-mail` 找不到目标也返回成功，GUI 因此会向普通用户显示“已重新处理”。
CSV 对“文件已存在但为空”的处理会写出无表头台账；日期校验仍接受并规范化不存在的 timestamp 日历日。
建议先按 CORE-01～CORE-04 修正并发、身份和结果契约，再拆分 `cmdRun` / `processMail`；否则在现有超长函数内继续补分支，容易再次打破事务边界。

## findings 汇总表

| ID | 严重度 | 标题 | 位置 |
|---|---|---|---|
| CORE-01 | P0 | `--state` 可改变锁目录，却不改变实际归档目标，两个 CLI 可同时写同一台账 | `src/index.ts:779`、`src/util/dataDirLock.ts:143-151`、`src/pipeline.ts:570-581` |
| CORE-02 | P0 | worker 出现致命错误后 `Promise.all` 提前返回，其他 worker 仍可继续归档 | `src/index.ts:909-940` |
| CORE-03 | P0 | 重复或缺失 `Message-Id` 的不同邮件会被确定性折叠为同一个 12 位 hash | `src/util/hash.ts:3-10`、`src/index.ts:486-498` |
| CORE-04 | P1 | 未写入 pending 或单封异常仍被计为 processed，整次 `run` 固定退出 0 | `src/pipeline.ts:535-541`、`src/index.ts:886-898`、`src/index.ts:951-958`、`src/electron/main.ts:1821-1827` |
| CORE-05 | P1 | 已存在的空 CSV 会直接追加数据行，首张发票被当成表头 | `src/pipeline.ts:112-123`、`src/util/csv.ts:114-129` |
| CORE-06 | P1 | `fetch --dry-run` 在 state 损坏时仍会移动并重写 `state.json`，且没有持锁 | `src/index.ts:460-472`、`src/state.ts:232-245`、`src/index.ts:678-683` |
| CORE-07 | P1 | timestamp 校验委托给宽松的 `Date.parse`，不存在日期会被静默滚到下月 | `src/util/dateRange.ts:53-55`、`src/util/dateRange.ts:74-82` |
| CORE-08 | P1 | 网络重试把完整签名 URL 写进日志和 pending reason，上一轮 COPY-05 的泄露链仍在 | `src/pipeline.ts:348-405`、`src/pipeline.ts:273-284` |
| CORE-09 | P1 | `--only-mail` 找不到缓存目标时仍退出成功，待确认页会显示“已重新处理” | `src/index.ts:812-840`、`src/index.ts:903-958`、`src/electron/main.ts:1821-1827`、`gui-design/scripts/shell.js:2638-2643` |
| CORE-10 | P2 | 高于当前版本的配置被静默降级为 v3，而不是拒绝由旧程序打开 | `src/config.ts:414-440`、`src/electron/main.ts:366-377` |
| CORE-11 | P2 | `ocr.credentials` 只校验“是对象”，内部非字符串值可绕过正式配置校验 | `src/config.ts:372-380`、`src/config.ts:523` |
| CORE-12 | P2 | `cmdRun` 与 `processMail` 仍是 200 行级编排函数，命令、并发、事务和存储职责纠缠 | `src/index.ts:759-959`、`src/pipeline.ts:502-710` |
| CORE-13 | P2 | logger 不转义换行，不可信邮件字段可破坏按行解析的进度协议 | `src/log.ts:10-12`、`src/index.ts:951-956`、`src/electron/main.ts:880-890` |
| CORE-14 | P3 | `isDateOnly` 是无调用方的残留导出 | `src/util/dateRange.ts:43-46` |

## 详细发现

### CORE-01 `--state` 可改变锁目录，却不改变实际归档目标，两个 CLI 可同时写同一台账
- 严重度：P0
- 位置：`src/index.ts:779`、`src/util/dataDirLock.ts:143-151`、`src/pipeline.ts:570-581`
- 置信度：CONFIRMED
- 证据：
  ```ts
  if (!acquireCommandLock('pipeline', { statePath: opts.statePath, configPath: opts.configPath })) return 2;
  ```
  ```ts
  if (hints.statePath && hints.statePath.length > 0) {
    return normalizeToDataDir(dirname(resolve(hints.statePath)));
  }
  ```
  ```ts
  const csvPath = path.resolve(cfg.output.csv);
  const ocrPendingCsvPath = path.join(cfg.paths.invoices, 'ocr', 'ocr-pending.csv');
  ```
- 问题：锁目录优先由任意可传的 `--state` 父目录决定，而归档文件和两个 CSV 由 config 决定。两个命令只要使用不同目录下的 state、但指向同一 `paths.invoices` / `output.csv`，就会各自成功持有不同锁并同时写同一业务数据。`pipeline.ts` 的 journal 以追加前长度回滚 CSV；双写者下，一个事务可把另一个事务刚追加的有效行截掉，符合本项目严重度定义中的“corruption / data loss”。`fetch` 同样可用不同 state 同时写同一个 `--out/INDEX.csv`。
- 建议修复：锁身份必须从所有实际写目标推导，而不是从 state/config 参数猜测。加载 config 后收集 `statePath`、samples、pending、invoices、output CSV、OCR CSV 的规范绝对路径，计算稳定的 `DataScope`；若目标不在同一受管根目录，应为每个目标获取按绝对路径排序的多锁，或直接拒绝跨根目录配置。至少把 `resolveDataDir` 的结果与全部写目标做 containment 校验，不能让 `--state` 单独决定锁。

### CORE-02 worker 出现致命错误后 `Promise.all` 提前返回，其他 worker 仍可继续归档
- 严重度：P0
- 位置：`src/index.ts:909-940`
- 置信度：CONFIRMED
- 证据：
  ```ts
  if (err instanceof StateWriteError || err instanceof ArchiveRecoveryError) {
    aborted = true;
    throw err;
  }
  ```
  ```ts
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  ```
- 问题：`Promise.all` 在第一个 worker reject 时立即 reject，但不会取消其他 promise。已经从队列取走邮件、正停在网络或浏览器 `await` 的 worker 不会再次检查 `aborted`，恢复后仍可进入 `processMail` 的同步归档区。外层此时已经在 flush state、关闭 browser 并准备释放锁/退出；因此注释所声称的“fatal 后不再发生后续 archive/CSV mutation”并不成立。受控时序下可在 state 写失败或 archive recovery 失败之后继续安装文件和追加 CSV。
- 建议修复：worker 池记录首个 fatal error，但必须 `await Promise.allSettled(workers)` 后再离开锁域；同时向提取器传共享 `AbortSignal`，并在 `processMail` 进入 `recoverArchiveTransactionsOnce` 和 `batch.commit` 前检查 fatal 状态。不要依赖 `Promise.all` 充当取消器。更稳妥的是抽出 `runMailWorkerPool()`，返回 `{results, fatalError}`，由唯一协调者决定 flush、browser close 和退出码。

### CORE-03 重复或缺失 `Message-Id` 的不同邮件会被确定性折叠为同一个 12 位 hash
- 严重度：P0
- 位置：`src/util/hash.ts:3-10`、`src/index.ts:486-498`
- 置信度：CONFIRMED
- 证据：
  ```ts
  const key = messageId && messageId.length > 0 ? messageId : `${from}|${date}|${subject}`;
  return createHash('sha1').update(key).digest('hex').slice(0, 12);
  ```
  ```ts
  if (store.hasFetched(hash) && cached) {
    skippedKnown++;
    continue;
  }
  ```
- 问题：有 `Message-Id` 时，身份完全忽略邮件内容、邮箱文件夹、日期和发件人；两个不同邮件复用同一个 header 时必然覆盖/跳过。没有 `Message-Id` 时，只要发件人、日期和主题相同也必然相同，代码没有第四个判别量。第二封邮件会命中同一个 `.eml` 路径和 fetched/processed state，被静默跳过。除此之外，SHA-1 再截成 48 bit 没有必要地扩大了大邮箱中的随机碰撞面。
- 建议修复：以原始 `.eml` 字节的 SHA-256 作为区分重复 header 的强判别量，例如 `mailKey = sha256(normalizedMessageId + "\0" + sha256(raw))`，保留至少 128 bit；真正字节完全相同的副本才可折叠。把 `mailHash` 作为 invoices/pending/INDEX 的显式列，不要依赖从展示字段重算。升级时读取旧 12 位键但新写强键，并提供一次性 state/ledger 迁移。

### CORE-04 未写入 pending 或单封异常仍被计为 processed，整次 `run` 固定退出 0
- 严重度：P1
- 位置：`src/pipeline.ts:535-541`、`src/index.ts:886-898`、`src/index.ts:951-958`、`src/electron/main.ts:1821-1827`
- 置信度：CONFIRMED
- 证据：
  ```ts
  if (!persistPending(mail, cfg, hash, reason, log, opts.raw)) {
    return { ...baseResult, outcome: 'manual', reason: `${reason}|pending_write_failed` };
  }
  ```
  ```ts
  if (result.partial === true) partial++;
  processed++;
  ```
  ```ts
  log.info(`Run complete: processed=${processed}, partial=${partial}, skipped=${skipped}, failed=${failed}`);
  return 0;
  ```
  ```ts
  return {
    ok: result.code === 0,
  ```
- 问题：pending 写失败时，邮件既没有完整归档，也没有用户可见的待确认记录，state 也故意不提交；但调用方仍把它计入 `processed`。普通单封异常会增加 `failed`，最终退出码仍固定为 0。Electron 明确以 `result.code === 0` 显示成功，因此非技术用户会看到“处理完成”，却不知道有邮件必须重试。当前 `ProcessMailResult` 的 `manual` 同时表示“已可靠进入人工队列”和“人工队列也写失败”，结果类型本身无法表达真实状态。
- 建议修复：把结果改成判别联合：`archived | pending_durable | skipped | retryable_failure | fatal_failure`；只有前 3 类计入 handled。`pending_write_failed` 必须是 `retryable_failure`。命令只要 `failed > 0` 或存在 retryable failure 就返回非 0，并通过结构化终态事件把“已成功 N、需重试 M”传给 GUI；如产品希望部分成功退出 0，也必须新增明确的 partial exit/status，而不能显示全成功。

### CORE-05 已存在的空 CSV 会直接追加数据行，首张发票被当成表头
- 严重度：P1
- 位置：`src/pipeline.ts:112-123`、`src/util/csv.ts:114-129`
- 置信度：CONFIRMED
- 证据：
  ```ts
  if (!fs.existsSync(csvPath)) {
    withCsvRetry(() => fs.writeFileSync(csvPath, '﻿' + header + body, 'utf8'));
    return;
  }
  withCsvRetry(() => fs.appendFileSync(csvPath, body, 'utf8'));
  ```
  ```ts
  const header = records[0] ?? [];
  for (let i = 1; i < records.length; i++) {
  ```
- 问题：零字节文件“存在”，所以 `appendCsvBlock` 不写 BOM/表头，第一条发票或 OCR 记录直接成为第一行；`readCsvRows` 以后无条件把第一行当 header，并从第二行开始读。结果是首张票在摘要、已归档索引、状态重建和 OCR 队列读取中消失；重跑该邮件时已归档索引仍看不到首行，因而会再建碰撞副本。`ensureIndexCsv()` 也采用同样的“只看 exists”判断。
- 建议修复：建立共享 `ensureCsvSchema(path, expectedHeader)`：不存在或 size=0 时原子写 BOM+header；非空时解析并严格比对 header，不匹配就停止写入并给出可操作错误，不能向未知 schema 盲目追加。INDEX、invoices、pending、OCR 全部复用同一实现。

### CORE-06 `fetch --dry-run` 在 state 损坏时仍会移动并重写 `state.json`，且没有持锁
- 严重度：P1
- 位置：`src/index.ts:460-472`、`src/state.ts:232-245`、`src/index.ts:678-683`
- 置信度：CONFIRMED
- 证据：
  ```ts
  // --dry-run 不写数据目录，因此不占锁。
  if (!opts.dryRun && !acquireCommandLock('fetch', { statePath: opts.statePath, configPath: opts.configPath })) return 2;
  ```
  ```ts
  if (!(e instanceof StateCorruptionError)) throw e;
  const quarantine = quarantineCorruptState(path, e.message);
  ```
  ```ts
  store.replaceAll(rebuilt);
  ```
- 问题：dry-run 仍调用 `StateStore.open()`；损坏 state 会被 `rename` 成备份，随后 `recoverQuarantinedState()` 立即重建并写回。它既违反帮助中的“Do not write files”，也因为前面特意不拿锁，能与真实 fetch/run 并发修改 state。用户选择“只预览”仍发生持久化变更。
- 建议修复：dry-run 使用只读 `inspectState()`，内容损坏只报告“正式运行时将隔离并重建”，绝不 quarantine/replace。或者让 `StateStore.open` 接受明确的 `mode: "read-only" | "repair"`，在 read-only 下禁止一切文件系统写入；不要通过“调用方应该不会弄脏”来隐式约束。

### CORE-07 timestamp 校验委托给宽松的 `Date.parse`，不存在日期会被静默滚到下月
- 严重度：P1
- 位置：`src/util/dateRange.ts:53-55`、`src/util/dateRange.ts:74-82`
- 置信度：CONFIRMED
- 证据：
  ```ts
  if (looksDateOnly(value)) return parseDateOnlyParts(value) !== undefined;
  return Number.isFinite(Date.parse(value));
  ```
  ```ts
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t + 1) : undefined;
  ```
- 问题：严格日历校验只覆盖纯 `YYYY-MM-DD`；带时间的输入全部交给宽松解析器。当前运行时中，`2026-02-31T00:00:00Z` 被接受并解析为 `2026-03-03T00:00:00Z`，`07/29/2026` 这类非文档约定格式也被接受。日期输错后不会提示，而是抓取错误窗口，产生真实的漏取/多取结果。
- 建议修复：先用明确的 ISO 8601 timestamp 正则提取年月日、时间、offset，再独立校验月日和时分秒范围，最后构造 instant 并做 round-trip 验证；拒绝所有未声明格式。`isValidDateBound`、`resolveSinceBound`、`resolveUntilExclusiveBound` 应共享一个返回解析结果的 `parseDateBound()`，避免“校验通过、解析语义另走一遍”。

### CORE-08 网络重试把完整签名 URL 写进日志和 pending reason，上一轮 COPY-05 的泄露链仍在
- 严重度：P1
- 位置：`src/pipeline.ts:348-405`、`src/pipeline.ts:273-284`
- 置信度：CONFIRMED
- 证据：
  ```ts
  throw new Error(`network_retry_failed:${method}:${url}:${lastError}`);
  ```
  ```ts
  const line = [messageId, date, from, subject, reason].map(csvCell).join(',') + '\n';
  ```
- 问题：重试器不区分 URL 的公开部分与凭据部分，query、fragment、userinfo 都会原样进入异常和 warn 日志；异常又进入 extractor issue、manual reason，最终持久化到 `pending.csv` 并由 GUI 展示/复制。只要下载 URL 在 query 或 userinfo 中携带授权信息，该信息就沿这条固定链路落盘。上一轮 COPY-05 已指出机器 reason/URL 的泄露风险；当前树仍保留完整链路，因此这是“仍然存在”的重报，不是已修项。
- 建议修复：错误对象只携带 typed code、HTTP status、attempt count 和脱敏 origin；日志 URL 至多保留 `protocol + host + redacted pathname`，必须删除 query、fragment、userinfo。pending 只存稳定枚举（如 `network_retry_failed`）和用户动作元数据；详细诊断放权限收紧、自动脱敏且有生命周期的诊断记录。

### CORE-09 `--only-mail` 找不到缓存目标时仍退出成功，待确认页会显示“已重新处理”
- 严重度：P1
- 位置：`src/index.ts:812-840`、`src/index.ts:903-958`、`src/electron/main.ts:1821-1827`、`gui-design/scripts/shell.js:2638-2643`
- 置信度：CONFIRMED
- 证据：
  ```ts
  const rawDir = cfg.paths.samples;
  ```
  ```ts
  if (opts.onlyMail !== undefined && hash !== opts.onlyMail) {
    return;
  }
  ```
  ```ts
  return 0;
  ```
  ```js
  await runBridgeAction('runPipeline', { onlyMail: hash }, '已重新尝试', '这封邮件已重新处理。');
  ```
  ```ts
  ok: result.code === 0,
  ```
- 问题：`--only-mail` 没有“命中过目标”的计数或最终断言。目标 hash 写错、缓存 `.eml` 被移动/删除，或只剩 `pending/<hash>.eml` 时，命令扫描完 `paths.samples` 后仍返回 0；GUI 随即显示“已重新处理”。这条 flag 虽然被解析和传递，但其成功契约没有实现。
- 建议修复：增加 `matchedOnlyMail` / `attemptedOnlyMail`，未命中时返回明确非 0 和 `mail_not_found`。待确认重试应优先使用已持久化的 `pending/<hash>.eml`，或在索引中保存源缓存路径；成功提示必须以目标确实产生 `archived` / `pending_durable` / `skipped` 结果为条件。

### CORE-10 高于当前版本的配置被静默降级为 v3，而不是拒绝由旧程序打开
- 严重度：P2
- 位置：`src/config.ts:414-440`、`src/electron/main.ts:366-377`
- 置信度：CONFIRMED
- 证据：
  ```ts
  const declared = typeof out.schemaVersion === 'number' && Number.isFinite(out.schemaVersion)
    ? out.schemaVersion
    : 1;
  ```
  ```ts
  out.schemaVersion = CONFIG_SCHEMA_VERSION;
  ```
  ```ts
  const candidate = migrateRawConfig(merged).raw;
  ```
  ```ts
  writeConfigAtomic(candidate);
  ```
- 问题：`schemaVersion: 4`、`999` 甚至小数都会进入同一迁移路径并被改写成 3。旧版程序无法知道未来字段的语义，却会宣称配置已经是 v3；GUI 下次保存还会把这个降级后的版本写回，破坏前向兼容和后续迁移判断。
- 建议修复：版本必须是正整数；`declared > CONFIG_SCHEMA_VERSION` 时返回专门的 `config_version_too_new`，阻止所有写操作并提示升级应用。迁移采用显式 `switch` / 逐版本函数，只允许已知的 `v1→v2→v3`，不能把任意版本统一“盖章”为当前版本。

### CORE-11 `ocr.credentials` 只校验“是对象”，内部非字符串值可绕过正式配置校验
- 严重度：P2
- 位置：`src/config.ts:372-380`、`src/config.ts:523`
- 置信度：CONFIRMED
- 证据：
  ```ts
  if (typeof value !== 'object' || Array.isArray(value)) {
    c.add(path, `config.${path} 必须是「键: 字符串」形式的对象`);
    return {};
  }
  return value as Record<string, string>;
  ```
- 问题：错误文案承诺每个值是字符串，代码却只做 TypeScript cast；`{"apiKey":123,"tencentSecretId":true}` 会通过完整配置校验。下游把这些值放进 HTTP header 和子进程环境，运行行为取决于隐式强制转换，而 GUI 会认为配置已经正式验证成功。
- 建议修复：遍历 `Object.entries`，逐项要求 key 非空、value 为 string，并以 `ocr.credentials.<key>` 收集字段错误；如只支持固定凭据，进一步使用 allowlist schema，拒绝对象/数组/数字。不要用类型断言替代运行时验证。

### CORE-12 `cmdRun` 与 `processMail` 仍是 200 行级编排函数，命令、并发、事务和存储职责纠缠
- 严重度：P2
- 位置：`src/index.ts:759-959`、`src/pipeline.ts:502-710`
- 置信度：CONFIRMED
- 证据：
  ```ts
  const handleEml = async (emlPath: string): Promise<void> => {
    const raw = readFileSync(emlPath);
    const mail = await parseMailWithGuards(raw);
  ```
  ```ts
  const extraction = await runExtractors(mail, ctx, hash);
  ```
  ```ts
  tx = beginArchiveTransaction(cfg.paths.invoices, {
  ```
- 问题：`cmdRun` 跨 201 行，内部再定义 `getBrowser`、`handleEml`、`worker`，同时负责 CLI 生命周期、身份、自愈、过滤、并发、计数、错误等级和资源关闭。`processMail` 跨 209 行，同时负责结果分类、HTTP context、提取器调度、pending 持久化、归档事务、两个 CSV schema 和 state commit。CORE-02、CORE-04 正发生在这些职责交界处，说明这不是行数偏好，而是错误边界无法被类型和模块边界约束。`index.ts` 还为六个命令重复 `loadConfig(resolve(...))` 的 try/catch，参数循环也各自复制。
- 建议修复：具体拆分如下：
  1. `src/cli/args.ts`：声明式 command schema、usage、`requireValue`；`src/cli/loadCommandConfig.ts`：统一配置加载、override 应用和 exit error。
  2. `src/cli/commands/run.ts`：只做 command 生命周期；`src/run/mailWorkerPool.ts`：队列、取消、fatal 收敛和统计；`src/run/browserProvider.ts`：浏览器单例生命周期。
  3. `src/pipeline/extractionService.ts`：`runExtractors` 与 typed issue；`src/pipeline/archiveRepository.ts`：journal、文件与 invoices/OCR CSV 的一个事务；`src/pipeline/pendingRepository.ts`：pending EML/CSV；`src/pipeline/processMail.ts`：只组合上述服务并返回判别联合结果。
  4. 把 `makeRetryingFetch` 移到 `src/net/retryingFetch.ts`，错误改为 typed code，避免 pipeline 同时承担网络策略。

### CORE-13 logger 不转义换行，不可信邮件字段可破坏按行解析的进度协议
- 严重度：P2
- 位置：`src/log.ts:10-12`、`src/index.ts:951-956`、`src/electron/main.ts:880-890`
- 置信度：CONFIRMED
- 证据：
  ```ts
  stream.write(`[${level}] ${new Date().toISOString()} ${msg}\n`);
  ```
  ```ts
  log.warn(`pending ${failure.hash} date=${failure.date} from="${failure.from}" subject="${failure.subject}" reason=${failure.reason}`);
  ```
  ```ts
  const handleLine = (line: string): void => {
    if (!line.trim()) return;
    const saved = SAVED_MAIL_RE.exec(line);
  ```
- 问题：邮件的 from/subject 和 extractor reason 是不可信文本，CSV 代码本身也明确支持其中包含换行。logger 原样插入后，一个逻辑事件会变成多条物理行；Electron 又逐行用正则识别 saved/processed/manual 进度。普通换行会截断诊断，构造出的第二行还能伪造进度标记，污染“本次处理”集合和 UI 计数。
- 建议修复：人类日志至少把 `\r`、`\n`、其他控制字符转义为可见序列并限制长度；更可靠的是 stdout 只输出固定 schema 的 NDJSON（字段由 `JSON.stringify` 编码），人类诊断走 stderr，Electron 按 JSON event type 消费，不再从自由文本正则猜状态。

### CORE-14 `isDateOnly` 是无调用方的残留导出
- 严重度：P3
- 位置：`src/util/dateRange.ts:43-46`
- 置信度：CONFIRMED
- 证据：
  ```ts
  export function isDateOnly(value: string): boolean {
    return parseDateOnlyParts(value) !== undefined;
  }
  ```
- 问题：当前 `src/` 和 GUI tests 中没有任何调用方；模块内部也直接调用 `looksDateOnly` / `parseDateOnlyParts`。这个导出扩大了日期模块的表面 API，却没有参与统一解析契约。
- 建议修复：删除该导出；后续严格 timestamp 解析需要公开分类时，只导出一个 `parseDateBound()` 的判别联合结果，避免同时暴露多个会产生不一致判断的 helper。

## 明确排除的项（我检查过但认为不是问题）

- 上一轮 APP-07 的核心 date-only / `until` 问题已修复：`YYYY-MM-DD` 现在按本地日历构造，结束日通过“日历加一天”得到半开上界，DST 日不会再固定加 86,400,000ms；本报告 CORE-07 是另一个仍存在的 timestamp 严格校验问题。
- CSV 公式注入已有实质防护：`csvCell()` 对 `= + @`、控制字符和非纯数字的 `-` 前缀加文本 guard；`parseCsv()` 也能跨物理行读取 quoted newline。未把这两项重复报告为旧问题。
- 默认 GUI/CLI 路径下，`StateStore` 已改为 Set + 有界 checkpoint，正常结束、fatal 和 signal 路径均有 flush；上一轮 CODE-07 的逐封全量同步重写问题不再成立。
- `saveState()` 已采用唯一临时文件加 rename，内容损坏与 I/O 错误也被区分；在同一正确数据锁覆盖范围内，没有发现普通并发写 state 的第二条确定性竞态。CORE-01 报告的是锁覆盖范围本身可被 `--state` 拆开。
- `processMail` 从进入 archive journal 到 `tx.commit()` 之间没有 `await`，所以同一进程的正常 worker 不会在这段同步临界区内交错；CORE-02 是 fatal 后未等待其他已启动 worker，CORE-01 是两个不同锁持有者，均不是对此临界区的误报。
- `ArtifactIndex` 对强 identity、legacy fallback 和歧义 alias 的处理经过调用方交叉检查，未发现不同 `contentHash` 被该类直接合并；CORE-03 是更上游的“邮件级 `msgIdHash`”问题。
- `fetch`、`run`、`ocr`、`pending`、`organize`、`rebuild-state` 当前解析的所有 flags 都能追到实际使用点；Electron 生成的 `--since/--until/--dry-run/--force/--only-mail/--concurrency/--allow-parse-failures/--apply-rename` 也都与 CLI parser 对齐。README 只列开发常用命令，没有宣称不存在的 flag。
