import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type * as ElectronAPI from 'electron';
import type { AppSummary, RunHistoryEntry } from '../summary.js';
import {
  deriveRunStatus,
  emptyRunCounts,
  parseFetchDoneCounts,
  parseMailHash,
  parseOcrCompleteCounts,
  parseOrganizeCompleteCounts,
  parseRunCompleteCounts,
  type RunTerminalCounts,
} from '../cliProtocol.js';
import type { RunCliResult } from '../cliRunner.js';
import type { OcrRerunPlan } from '../ocrRerun.js';
import type { OpenLocationKey } from '../pathPolicy.js';
import type { OpKind, OpLease, RunningOp } from '../opCoordinator.js';
import type { BusyResponse, NormalizedFilter, RunBatch } from '../operationSupport.js';
import { asDateRange, asObject, type DateRangePayload } from '../payload.js';
import type { CliReport } from '../runSupport.js';
import type { ProcessRegistries } from '../runtime.js';
import { redactPath, sanitizeText, type UiError } from '../sanitize.js';

// ---------------------------------------------------------------------------
// IPC（全部经 handleTrusted 中央校验，ELEC-01）
// ---------------------------------------------------------------------------
import type { SummaryPageOptions } from '../summaryFacade.js';

type TrustedHandler = (
  event: ElectronAPI.IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown | Promise<unknown>;

interface OpenPolicyResult {
  ok: boolean;
  code?: string;
  error?: string;
  message?: string;
  revealed?: boolean;
}

interface SaveConfigResult {
  ok: boolean;
  fieldErrors?: { path: string; message: string }[];
  configError?: { message: string; detail?: string; backupPath?: string; backupCreated?: boolean };
}

interface DevBackend {
  recordTestGlobal(window: ElectronAPI.BrowserWindow | undefined, name: string, value: unknown): void;
}

interface RunCliOptions {
  progress?: boolean;
  operation?: 'ocr' | 'files';
  initialTotal?: number;
  jobId?: string;
}

interface TrySummaryResult {
  summary?: AppSummary;
  summaryUnavailable?: boolean;
  warning?: string;
}

export interface OperationHandlerDependencies {
  app: Pick<typeof ElectronAPI.app, 'getVersion' | 'isPackaged'>;
  clipboard: Pick<typeof ElectronAPI.clipboard, 'writeText'>;
  handleTrusted(channel: string, handler: TrustedHandler): void;
  coordinator: {
    state(): { running: RunningOp | null };
    begin(kind: OpKind, opts?: { silent?: boolean }):
      | { ok: true; lease: OpLease }
      | { ok: false; code: string; message: string; detail?: string; running: RunningOp | null };
  };
  processRegistries: ProcessRegistries;
  getMainWindow(): ElectronAPI.BrowserWindow | undefined;
  getDevBackend(): DevBackend | undefined;
  configPath: string;
  statePath: string;
  bundledConfigPath: string;
  dataDir: string;
  loadGuiConfig(configPath: string, bundledConfigPath: string): { cfg: unknown; error?: string };
  redactConfig(config: Record<string, unknown>): Record<string, unknown>;
  saveConfig(payload: unknown, opts?: { repairCorrupt?: boolean }): SaveConfigResult;
  looksLikeRedactedPathDisplay(value: string): boolean;
  appSummary(options?: SummaryPageOptions): AppSummary;
  asSummaryOptions(payload: unknown): SummaryPageOptions | undefined;
  resolveExternalFileHandle(id: string): string | undefined;
  sanitizeOpState(state: { running: RunningOp | null }): { running: RunningOp | null };
  acquireOperation(kind: OpKind): { ok: true; lease: OpLease } | { ok: false; response: BusyResponse };
  normalizedFilterFrom(range?: DateRangePayload): NormalizedFilter;
  batchFromHashes(hashes: string[]): RunBatch;
  fetchArgs(payload: DateRangePayload): string[];
  runCli(command: string, args: string[], opts?: RunCliOptions): Promise<RunCliResult>;
  reportFor(
    action: string,
    jobId: string,
    result: RunCliResult,
    codes: { ok: string; failed: string; partial?: string },
    status?: RunHistoryEntry['status'],
  ): CliReport;
  recordHistory(
    action: string,
    title: string,
    startedAt: number,
    result: { code: number | null; stdout: string; stderr: string; started?: boolean },
    status: RunHistoryEntry['status'],
    message?: string,
  ): string | undefined;
  tryAppSummary(appSummary: () => AppSummary): TrySummaryResult;
  ocrRunMessage(result: RunCliResult): string;
  pipelineRunMessage(
    counts: RunTerminalCounts,
    status: RunHistoryEntry['status'],
    onlyMail: boolean,
    mailNotFound: boolean,
  ): string;
  ocrPendingCsvPath(): string;
  readCsvRows(file: string): Record<string, string>[];
  ensureArchiveRecoveryReady(): UiError | undefined;
  prepareOcrRerun(): { ok: true; plan: OcrRerunPlan } | { ok: false; error: UiError };
  writeOcrRunConfig(concurrency: number): { dir: string; file: string };
  removeTempDir(dir: string): void;
  sendOperationProgress(payload: Record<string, unknown>): void;
  killProcessTree(child: ChildProcess): { treeSignalled: boolean; detail?: string };
  resolvedPath(section: 'paths' | 'ocr' | 'rename' | 'output', key: string, fallback: string): string;
  pendingDirPath(): string;
  invoicesDirPath(): string;
  samplesDirPath(): string;
  ledgerCsvPath(): string;
  realDataDir(): string | undefined;
  resolveCanonicalPath(target: string): string | undefined;
  isPathSegmentInside(candidate: string, root: string): boolean;
  isInsideOpenPathAllowedRoots(target: string): boolean;
  openPathAllowedRoots(): string[];
  resolveSymbolicLocation(location: OpenLocationKey): string | undefined;
  openOrRevealByPolicy(
    target: string,
    opts: { forceReveal?: boolean; allowDirectoryOpen?: boolean; allowFileOpen?: boolean },
  ): Promise<OpenPolicyResult>;
}

interface FetchExecutionContext {
  range: DateRangePayload;
  lease: OpLease;
  startedAt: number;
}

interface PipelineExecutionContext {
  raw: Record<string, unknown>;
  concurrency: number;
  onlyHash: string | undefined;
  lease: OpLease;
  startedAt: number;
}

interface PreparedOcrOperation {
  raw: Record<string, unknown>;
  pendingTotal: number;
  jobId: string;
  concurrency: number;
  plan: OcrRerunPlan | undefined;
  ocrTemp: { dir: string; file: string };
  args: string[];
}

interface ExecutedOcrOperation extends PreparedOcrOperation {
  startedAt: number;
  result: RunCliResult;
  stopped: boolean;
  ocrCompletedCleanly: boolean;
}

type PrepareOcrResult =
  | { ok: true; operation: PreparedOcrOperation }
  | { ok: false; response: Record<string, unknown> };

export function registerOperationHandlers(deps: OperationHandlerDependencies): {
  resolveOpenTarget(target: string): { ok: true; path: string } | { ok: false; code: string; message: string };
} {
  const {
    app,
    clipboard,
    handleTrusted,
    coordinator,
    processRegistries,
    getMainWindow,
    getDevBackend,
    configPath,
    statePath,
    bundledConfigPath,
    dataDir,
    loadGuiConfig,
    redactConfig,
    saveConfig,
    looksLikeRedactedPathDisplay,
    appSummary,
    asSummaryOptions,
    resolveExternalFileHandle,
    sanitizeOpState,
    acquireOperation,
    normalizedFilterFrom,
    batchFromHashes,
    fetchArgs,
    runCli,
    reportFor,
    recordHistory,
    tryAppSummary,
    ocrRunMessage,
    pipelineRunMessage,
    ocrPendingCsvPath,
    readCsvRows,
    ensureArchiveRecoveryReady,
    prepareOcrRerun,
    writeOcrRunConfig,
    removeTempDir,
    sendOperationProgress,
    killProcessTree,
    resolvedPath,
    pendingDirPath,
    invoicesDirPath,
    samplesDirPath,
    ledgerCsvPath,
    realDataDir,
    resolveCanonicalPath,
    isPathSegmentInside,
    isInsideOpenPathAllowedRoots,
    openPathAllowedRoots,
    resolveSymbolicLocation,
    openOrRevealByPolicy,
  } = deps;
  const { ocrProcesses, ocrStopRequested } = processRegistries;

  async function executeFetch(context: FetchExecutionContext): Promise<Record<string, unknown>> {
    const { range, lease, startedAt } = context;
    if (typeof range.matchSubject === 'boolean' || typeof range.matchBody === 'boolean') {
      const filterPatch: Record<string, boolean> = {};
      if (typeof range.matchSubject === 'boolean') filterPatch.matchSubject = range.matchSubject;
      if (typeof range.matchBody === 'boolean') filterPatch.matchBody = range.matchBody;
      const saved = saveConfig({ filter: filterPatch });
      if (!saved.ok) {
        return {
          ok: false,
          code: 'config_invalid',
          message: '筛选条件没有保存成功，请先在设置页修正配置。',
          fieldErrors: saved.fieldErrors,
          configError: saved.configError,
          normalizedFilter: normalizedFilterFrom(range),
          summary: appSummary(),
        };
      }
    }

    const args = fetchArgs(range);
    getDevBackend()?.recordTestGlobal(getMainWindow(), '__mfhLastFetchArgs', args);
    const result = await runCli('fetch', args, { progress: true, jobId: lease.jobId });
    // ELEC-08：以 done: 计数为准，裸 exit code 不能把部分成功报成全失败。
    // dry-run 的「未保存」是预期行为，不得计为 failed。
    const fetchCounts = parseFetchDoneCounts(`${result.stdout}\n${result.stderr}`);
    const isDryRun = range.dryRun === true || fetchCounts?.dryRun === true;
    const fetchSucceeded = fetchCounts
      ? (isDryRun
        ? Math.max(fetchCounts.seen, fetchCounts.saved + fetchCounts.skippedKnown + fetchCounts.repaired)
        : fetchCounts.saved + fetchCounts.skippedKnown + fetchCounts.repaired)
      : (result.code === 0 ? 1 : 0);
    // 非 dry-run 下，seen 多于 saved+skipped 时可能表示中途异常；exit≠0 时至少记 1 失败。
    const remainder = fetchCounts
      ? Math.max(0, fetchCounts.seen - fetchCounts.saved - fetchCounts.skippedKnown)
      : 0;
    const fetchFailed = isDryRun
      ? 0
      : result.code !== 0
        ? Math.max(remainder, fetchSucceeded > 0 ? 1 : 1)
        : 0;
    const status = deriveRunStatus({
      code: result.code,
      started: result.started,
      succeeded: fetchSucceeded > 0 || result.code === 0 ? Math.max(fetchSucceeded, result.code === 0 ? 1 : 0) : 0,
      failed: fetchFailed,
    });
    const ok = status === 'success';
    const message = status === 'success'
      ? (isDryRun ? '预览完成。' : '获取邮件完成。')
      : status === 'partial'
        ? '获取邮件部分完成：部分邮件已保存，请检查后重试失败项。'
        : '获取邮件失败，请检查邮箱设置后重试。';
    const historyWarning = recordHistory(
      'fetch',
      range.dryRun ? '预览邮件' : '获取邮件',
      startedAt,
      result,
      status,
      status === 'success' ? '已完成' : status === 'partial' ? '部分完成' : '运行失败',
    );
    let batch: RunBatch | undefined;
    let enrichWarning: string | undefined;
    if (!range.dryRun) {
      try {
        batch = batchFromHashes(result.mails.saved);
      } catch {
        enrichWarning = '邮件已保存，但本次列表明细暂时无法展示。请到「邮件记录」查看。';
      }
    }
    const report = reportFor(
      'fetch',
      lease.jobId,
      result,
      { ok: 'fetch_done', failed: 'fetch_failed', partial: 'fetch_partial' },
      status,
    );
    const summaryPart = tryAppSummary(appSummary);
    const warning = [historyWarning, enrichWarning, summaryPart.warning].filter(Boolean).join(' ') || undefined;
    return {
      ok,
      status,
      started: result.started,
      ...report,
      message,
      jobId: lease.jobId,
      normalizedFilter: normalizedFilterFrom(range),
      ...(batch ? { batch } : {}),
      ...(warning ? { warning } : {}),
      ...(summaryPart.summary ? { summary: summaryPart.summary } : {}),
      ...(summaryPart.summaryUnavailable ? { summaryUnavailable: true } : {}),
    };
  }

  async function executePipeline(context: PipelineExecutionContext): Promise<Record<string, unknown>> {
    const { raw, concurrency, onlyHash, lease, startedAt } = context;
    if (typeof raw.avoidConflictBeforeOcr === 'boolean') {
      const saved = saveConfig({ rename: { avoidConflictBeforeOcr: raw.avoidConflictBeforeOcr } });
      if (!saved.ok) {
        return {
          ok: false,
          code: 'config_invalid',
          message: '命名设置没有保存成功，请先在设置页修正配置。',
          fieldErrors: saved.fieldErrors,
          configError: saved.configError,
          normalizedFilter: normalizedFilterFrom(),
          summary: appSummary(),
        };
      }
    }

    const recoveryError = ensureArchiveRecoveryReady();
    if (recoveryError) {
      return { ok: false, ...recoveryError, normalizedFilter: normalizedFilterFrom(), summary: appSummary() };
    }
    const args = ['--config', configPath, '--state', statePath, '--concurrency', String(concurrency)];
    if (onlyHash) args.push('--only-mail', onlyHash);
    if (raw.force === true) args.push('--force');
    const result = await runCli('run', args, { operation: 'files', jobId: lease.jobId });

    // ELEC-08 / 簇 C：以结构化终态计数为准，不用裸 exit code 单独判定成功。
    // runCounts / terminalMailNotFound 优先取流式捕获值（ring 挤出后仍权威）。
    const counts = result.runCounts
      ?? parseRunCompleteCounts(`${result.stdout}\n${result.stderr}`)
      ?? emptyRunCounts();
    const mailNotFound = result.terminalMailNotFound === true
      || /mail_not_found/.test(`${result.stdout}\n${result.stderr}`)
      || (Boolean(onlyHash) && counts.archived + counts.pending + counts.skipped + counts.failed === 0 && result.code !== 0);
    const status = deriveRunStatus({
      code: result.code,
      started: result.started,
      succeeded: counts.archived + counts.pending + counts.skipped,
      failed: counts.failed + (mailNotFound ? 1 : 0),
      partial: counts.partial,
      mailNotFound,
    });
    const message = pipelineRunMessage(counts, status, Boolean(onlyHash), mailNotFound);
    // 操作结果在 runCli 返回时即最终；history / batch / summary 均为 best-effort。
    const historyWarning = recordHistory(
      'pipeline',
      onlyHash ? '重新处理单封邮件' : '处理缓存邮件',
      startedAt,
      result,
      status,
      status === 'success' ? '已完成' : status === 'partial' ? '部分完成' : '运行失败',
    );
    let batch: RunBatch = { rows: [], total: counts.archived + counts.pending };
    let enrichWarning: string | undefined;
    try {
      batch = batchFromHashes([...result.mails.processed, ...result.mails.manual]);
    } catch {
      enrichWarning = '邮件已处理，但本次列表明细暂时无法展示。请刷新列表。';
    }
    const report = reportFor(
      'pipeline',
      lease.jobId,
      result,
      { ok: 'pipeline_done', failed: 'pipeline_failed', partial: 'pipeline_partial' },
      status,
    );
    const summaryPart = tryAppSummary(appSummary);
    const warning = [historyWarning, enrichWarning, summaryPart.warning].filter(Boolean).join(' ') || undefined;
    return {
      ok: status === 'success',
      status,
      started: result.started,
      ...report,
      message,
      counts: {
        archived: counts.archived,
        pending: counts.pending,
        skipped: counts.skipped,
        failed: counts.failed,
        partial: counts.partial,
      },
      jobId: lease.jobId,
      normalizedFilter: normalizedFilterFrom(),
      batch,
      ...(warning ? { warning } : {}),
      ...(summaryPart.summary ? { summary: summaryPart.summary } : {}),
      ...(summaryPart.summaryUnavailable ? { summaryUnavailable: true } : {}),
    };
  }

  function pendingOcrWorkCount(summary = appSummary()): number {
    const rows = readCsvRows(ocrPendingCsvPath());
    if (rows.length === 0) return 0;
    if (summary.library.total > 0) return summary.library.total;
    return rows.filter((row) => row.status !== 'ignored' && row.documentType !== 'supporting').length;
  }

  function prepareOcrOperation(
    raw: Record<string, unknown>,
    pendingTotal: number,
    jobId: string,
  ): PrepareOcrResult {
    const concurrency = Math.max(1, Math.floor(Number(raw.concurrency ?? 1) || 1));
    let plan: OcrRerunPlan | undefined;

    const recoveryError = ensureArchiveRecoveryReady();
    if (recoveryError) {
      sendOperationProgress({ operation: 'ocr', phase: '识别失败', percent: 100, ...recoveryError, kind: 'err', done: true });
      return { ok: false, response: { ok: false, ...recoveryError, summary: appSummary() } };
    }
    if (raw.resetResults === true || raw.force === true) {
      const prepared = prepareOcrRerun();
      if (!prepared.ok) {
        sendOperationProgress({
          operation: 'ocr',
          phase: '识别失败',
          percent: 100,
          total: pendingTotal,
          processed: 0,
          parsed: 0,
          skipped: 0,
          failed: 0,
          ...prepared.error,
          kind: 'err',
          done: true,
        });
        return { ok: false, response: { ok: false, ...prepared.error, summary: appSummary() } };
      }
      plan = prepared.plan;
    }

    let ocrTemp: { dir: string; file: string };
    try {
      ocrTemp = writeOcrRunConfig(concurrency);
    } catch (err) {
      try {
        plan?.restore();
      } catch (restoreErr) {
        const error: UiError = {
          code: 'ocr_rerun_restore_failed',
          message: '无法开始识别，且原有识别结果未能自动恢复。请重新打开应用后再试。',
          detail: sanitizeText(restoreErr instanceof Error ? restoreErr.message : String(restoreErr)),
        };
        sendOperationProgress({ operation: 'ocr', phase: '识别失败', percent: 100, ...error, kind: 'err', done: true });
        return { ok: false, response: { ok: false, ...error, summary: appSummary() } };
      }
      const error: UiError = {
        code: 'ocr_config_write_failed',
        // COPY-10：配置写失败不一定是磁盘问题。
        message: '无法开始识别。请稍后重试；若仍失败，请到「设置」检查识别选项。',
        detail: sanitizeText(err instanceof Error ? err.message : String(err)),
      };
      sendOperationProgress({ operation: 'ocr', phase: '识别失败', percent: 100, ...error, kind: 'err', done: true });
      return { ok: false, response: { ok: false, ...error, summary: appSummary() } };
    }

    const args = ['run', '--config', ocrTemp.file, '--allow-parse-failures'];
    if (raw.force === true) args.push('--force');
    if (concurrency > 1) {
      args.push('--concurrency', String(concurrency));
    } else {
      args.push('--single-item');
    }
    return { ok: true, operation: { raw, pendingTotal, jobId, concurrency, plan, ocrTemp, args } };
  }

  async function executeOcr(operation: PreparedOcrOperation): Promise<ExecutedOcrOperation> {
    const { raw, pendingTotal, jobId, concurrency, args } = operation;
    const startedAt = Date.now();
    getDevBackend()?.recordTestGlobal(getMainWindow(), '__mfhLastOcrArgs', args);
    sendOperationProgress({
      operation: 'ocr',
      phase: '开始识别',
      ...(pendingTotal > 0 ? { percent: 5, total: pendingTotal } : { total: 0 }),
      processed: 0,
      parsed: 0,
      skipped: 0,
      failed: 0,
      code: 'ocr_start',
      message: `发现 ${pendingTotal} 个待识别文件，正在启动识别。当前并行数：${concurrency}。`,
    });

    const result = await runCli('ocr', args, { operation: 'ocr', initialTotal: pendingTotal, jobId });
    const stopped = ocrStopRequested.has(jobId) || result.code === 130;
    // ELEC-03：`--allow-parse-failures` 可在部分解析失败时仍 exit 0。
    // 只有「已启动 + exit 0 + 未停止 + 输出含 OCR complete 终态」才提交丢弃备份。
    const ocrCompletedCleanly = result.started
      && result.code === 0
      && !stopped
      && Boolean(parseOcrCompleteCounts(`${result.stdout}\n${result.stderr}`));
    return { ...operation, raw, startedAt, result, stopped, ocrCompletedCleanly };
  }

  function settleOcrRerun(operation: ExecutedOcrOperation): Record<string, unknown> | undefined {
    const { plan, ocrCompletedCleanly, jobId } = operation;
    if (!plan) return undefined;
    try {
      if (ocrCompletedCleanly) plan.discard();
      else plan.restore();
    } catch (txErr) {
      const error: UiError = {
        code: 'ocr_rerun_restore_failed',
        message: '识别结束后无法可靠处理备份。请重新打开应用；若识别结果异常，请勿继续操作。',
        detail: sanitizeText(txErr instanceof Error ? txErr.message : String(txErr)),
      };
      return { ok: false, ...error, jobId, summary: appSummary() };
    }
    return undefined;
  }

  function buildOcrResponse(operation: ExecutedOcrOperation): Record<string, unknown> {
    const { raw, jobId, startedAt, result, stopped, ocrCompletedCleanly } = operation;
    // ELEC-12：历史状态看结构化 OCR 计数；skipped 计入成功侧，避免
    // parsed=0/skipped>0/failed>0 被误判为全失败。
    const ocrCounts = result.ocrCounts
      ?? parseOcrCompleteCounts(`${result.stdout}\n${result.stderr}`);
    const statusWithParseFails: RunHistoryEntry['status'] = stopped
      ? 'failed'
      : deriveRunStatus({
        code: result.code,
        started: result.started,
        succeeded: (ocrCounts?.parsed ?? 0) + (ocrCounts?.skipped ?? 0),
        failed: (ocrCounts?.failed ?? 0) + (ocrCompletedCleanly || ocrCounts ? 0 : 1),
      });
    const historyWarning = recordHistory(
      'ocr',
      raw.force === true ? '开始识别文件' : '识别文件',
      startedAt,
      result,
      statusWithParseFails,
      statusWithParseFails === 'success'
        ? '已完成'
        : statusWithParseFails === 'partial'
          ? '部分完成'
          : stopped
            ? '已停止'
            : '运行失败',
    );
    if (stopped) {
      const summaryPart = tryAppSummary(appSummary);
      return {
        ok: false,
        status: 'failed' as const,
        started: result.started,
        stopped: true,
        code: 'ocr_stopped',
        exitCode: result.code,
        jobId,
        message: '识别已停止。',
        ...(historyWarning ? { warning: historyWarning } : {}),
        ...(summaryPart.summary ? { summary: summaryPart.summary } : {}),
        ...(summaryPart.summaryUnavailable ? { summaryUnavailable: true } : {}),
        ...(summaryPart.warning && !historyWarning ? { warning: summaryPart.warning } : {}),
      };
    }
    const report = reportFor(
      'ocr',
      jobId,
      result,
      { ok: 'ocr_done', failed: 'ocr_failed', partial: 'ocr_partial' },
      statusWithParseFails,
    );
    const ok = statusWithParseFails === 'success';
    const message = statusWithParseFails === 'success' || statusWithParseFails === 'partial'
      ? ocrRunMessage(result)
      : '无法完成识别。请稍后重试；若仍失败，请到「设置」检查识别选项并查看技术详情。';
    const summaryPart = tryAppSummary(appSummary);
    const warning = [historyWarning, summaryPart.warning].filter(Boolean).join(' ') || undefined;
    return {
      ok,
      status: statusWithParseFails,
      started: result.started,
      ...report,
      code: statusWithParseFails === 'success'
        ? report.code
        : statusWithParseFails === 'partial'
          ? 'ocr_partial'
          : (result.code === 0 ? 'ocr_incomplete' : report.code),
      jobId,
      message,
      ...(ocrCounts
        ? {
          counts: {
            scanned: ocrCounts.scanned,
            parsed: ocrCounts.parsed,
            skipped: ocrCounts.skipped,
            failed: ocrCounts.failed,
          },
        }
        : {}),
      ...(warning ? { warning } : {}),
      ...(summaryPart.summary ? { summary: summaryPart.summary } : {}),
      ...(summaryPart.summaryUnavailable ? { summaryUnavailable: true } : {}),
    };
  }

  /**
   * 将 get-config 发出的脱敏展示串（或相对路径）映射回主进程已知的符号位置。
   * 只匹配当前磁盘配置算出的根，攻击者无法用伪造展示串打开系统目录。
   */
  function resolveDisplayOrRelativeToKnownRoot(display: string): string | undefined {
    const trimmed = display.trim();
    if (!trimmed) return undefined;
    const known: string[] = [
      invoicesDirPath(),
      pendingDirPath(),
      samplesDirPath(),
      resolvedPath('rename', 'organizedDir', './invoices/organized'),
      dataDir,
    ];
    try {
      known.push(path.dirname(ledgerCsvPath()));
    } catch {
      // skip
    }
    const base = realDataDir();
    for (const raw of known) {
      const canon = resolveCanonicalPath(raw);
      if (!canon || !isInsideOpenPathAllowedRoots(canon)) continue;
      if (trimmed === redactPath(raw) || trimmed === redactPath(canon)) return canon;
      if (base && isPathSegmentInside(canon, base)) {
        const rel = path.relative(base, canon).split(path.sep).join('/');
        if (trimmed === rel || trimmed === `./${rel}` || trimmed === rel.replace(/^\.\//, '')) return canon;
      }
      // 相对配置值（磁盘上的 paths.invoices 本身就是 ./invoices 时）
      if (!path.isAbsolute(trimmed) && !trimmed.startsWith('…') && !trimmed.includes('<')) {
        const resolved = resolveCanonicalPath(path.resolve(dataDir, trimmed));
        if (resolved && isPathSegmentInside(resolved, canon) && isInsideOpenPathAllowedRoots(resolved)) {
          return resolved;
        }
      }
    }
    return undefined;
  }

  /**
   * ELEC-06：解析 open-path 目标。
   *
   * 优先：`location` 符号键（invoices/pending/samples/organized/…）由主进程映射；
   * 其次：主进程签发的 opaque `ext:…` 句柄（赎回时重验当前允许根）；
   * 最后：遗留 `{ path }`——仅当目标落在当前磁盘配置允许根内才放行
   * （含 get-config 脱敏展示串→已知根的兼容映射）。
   * 绝不采信 IPC 额外 root；规范化失败一律拒绝（fail closed）。
   */
  function resolveOpenTarget(target: string): { ok: true; path: string } | { ok: false; code: string; message: string } {
    if (!target || target.includes('\0')) {
      return { ok: false, code: 'path_invalid', message: '路径无效。' };
    }
    // 主进程签发的 opaque 外部句柄（赎回时 resolveExternalFileHandle 已重验允许根）
    if (target.startsWith('ext:')) {
      const external = resolveExternalFileHandle(target);
      if (!external) {
        return { ok: false, code: 'path_handle_unknown', message: '文件引用已失效，请刷新列表后重试。' };
      }
      return { ok: true, path: external };
    }

    const allowed = openPathAllowedRoots();
    if (allowed.length === 0) {
      return { ok: false, code: 'path_canonicalization_failed', message: '无法确认数据目录，已拒绝打开。' };
    }

    // 脱敏展示串 / 相对配置值：只映射到主进程已知根
    if (looksLikeRedactedPathDisplay(target) || target.includes('<') || target.startsWith('…')) {
      const mapped = resolveDisplayOrRelativeToKnownRoot(target);
      if (mapped) return { ok: true, path: mapped };
      return { ok: false, code: 'path_invalid', message: '路径无效。请使用位置标识打开目录。' };
    }

    // 相对路径锚定到 dataDir（若 dataDir 规范化失败则用模块级 dataDir 词法路径）
    const base = realDataDir() ?? dataDir;
    const abs = path.isAbsolute(target) || /^[A-Za-z]:[\\/]/.test(target) || target.startsWith('\\\\') || target.startsWith('//')
      ? path.resolve(target)
      : path.resolve(base, target);
    const canon = resolveCanonicalPath(abs);
    if (!canon) {
      return { ok: false, code: 'path_canonicalization_failed', message: '无法确认文件位置，已拒绝打开。' };
    }

    // 目标与每一个允许根都已经过同一套 canonical 化；用路径段前缀比较。
    if (isInsideOpenPathAllowedRoots(canon)) {
      return { ok: true, path: canon };
    }

    // 相对/展示兼容：例如配置里写 ./invoices 而 dataDir 与归档目录分家
    const known = resolveDisplayOrRelativeToKnownRoot(target);
    if (known) return { ok: true, path: known };

    return { ok: false, code: 'path_outside_data_dir', message: '路径不在允许的目录范围内。' };
  }

  handleTrusted('mfh:get-summary', (_event, payload: unknown) => appSummary(asSummaryOptions(payload)));

  handleTrusted('mfh:get-op-state', () => sanitizeOpState(coordinator.state()));

  /**
   * About 页的版本与发布通道（COPY-07B）。全部由运行时真实数据推导：`app.getVersion()`
   * 取的是安装包/package.json 的版本，channel 由「是否已打包」和版本号里的预发布
   * 标识判定，不再是写死的「本地预览版 / v0.1.0」。
   */
  handleTrusted('mfh:get-app-info', () => {
    const version = app.getVersion();
    const prerelease = /^\d+\.\d+\.\d+-([0-9A-Za-z.-]+)$/.exec(version)?.[1];
    const major = Number(version.split('.')[0]);
    const channel = !app.isPackaged
      ? '开发版（未打包）'
      : prerelease
        ? `预览版（${prerelease}）`
        : Number.isFinite(major) && major === 0
          ? '预览版'
          : '正式版';
    return {
      version,
      channel,
      packaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron ?? '',
    };
  });

  handleTrusted('mfh:get-config', () => {
    const { cfg, error } = loadGuiConfig(configPath, bundledConfigPath);
    const typedCfg = cfg as Record<string, unknown> & { imap?: { pass?: string } };
    // Redact secrets so they never reach the renderer process. We still report whether each
    // secret is populated so the UI can show "已保存（留空则不修改）" placeholders.
    const ocrSrc = (typedCfg as { ocr?: Record<string, unknown> }).ocr ?? {};
    const credsSrc = asObject((ocrSrc as Record<string, unknown>).credentials);
    const redactedConfig = redactConfig(typedCfg as unknown as Record<string, unknown>);
    const secrets = {
      imapPass: Boolean(typedCfg.imap?.pass),
      tencentSecretId: Boolean(credsSrc.tencentSecretId || credsSrc.secretId),
      tencentSecretKey: Boolean(credsSrc.tencentSecretKey || credsSrc.secretKey),
      ocrApiKey: Boolean(credsSrc.apiKey),
    };
    return {
      // ELEC-07：绝对路径不进 renderer；仅提供脱敏展示串。
      configPath: redactPath(configPath),
      configExists: fs.existsSync(configPath),
      // 保留原字段名（renderer 已在读取），同时新增结构化版本。
      configError: error ? sanitizeText(error) : '',
      configErrorInfo: error ? { message: sanitizeText(error) } : undefined,
      config: redactedConfig,
      secrets,
      dataDir: redactPath(dataDir),
    };
  });

  handleTrusted('mfh:save-config', (_event, payload: unknown) => {
    // ELEC-02：配置写入与 CLI 任务互斥，避免运行中改写 paths/ocr 造成交错。
    const begin = coordinator.begin('pipeline', { silent: true });
    if (!begin.ok) {
      return {
        ok: false,
        configPath: redactPath(configPath),
        configError: { message: begin.message },
      };
    }
    try {
      const raw = asObject(payload);
      return saveConfig(payload, { repairCorrupt: raw.repairCorrupt === true });
    } finally {
      begin.lease.release();
    }
  });

  handleTrusted('mfh:start-fetch', async (_event, payload: unknown) => {
    const range = asDateRange(payload);

    // APP-20：不再悄悄把 matchSubject 恢复为 true；两个条件都关掉时如实拒绝。
    if (range.matchSubject === false && range.matchBody === false) {
      return {
        ok: false,
        code: 'filter_no_match_target',
        message: '请至少选择「匹配主题」或「匹配正文」中的一项。',
        normalizedFilter: normalizedFilterFrom(range),
        summary: appSummary(),
      };
    }

    // ELEC-02：先占锁再写配置，避免被拒绝的请求仍改写后续任务使用的筛选条件。
    const gate = acquireOperation('fetch');
    if (!gate.ok) return { ...gate.response, normalizedFilter: normalizedFilterFrom(range) };

    const startedAt = Date.now();
    try {
      return await executeFetch({ range, lease: gate.lease, startedAt });
    } finally {
      gate.lease.release();
    }
  });

  handleTrusted('mfh:run-pipeline', async (_event, payload: unknown) => {
    const raw = asObject(payload);
    const concurrency = Number(raw.concurrency ?? 4);

    // NEW-DEFECT 3：非空但非法的 onlyMail 必须拒绝，绝不能静默变成全量管线。
    let onlyHash: string | undefined;
    if (raw.onlyMail !== undefined && raw.onlyMail !== null && raw.onlyMail !== '') {
      if (typeof raw.onlyMail !== 'string') {
        return {
          ok: false,
          code: 'invalid_only_mail',
          message: '单封邮件标识无效，请从待确认列表重新选择。',
          normalizedFilter: normalizedFilterFrom(),
          summary: appSummary(),
        };
      }
      onlyHash = parseMailHash(raw.onlyMail);
      if (!onlyHash) {
        return {
          ok: false,
          code: 'invalid_only_mail',
          message: '单封邮件标识无效，请从待确认列表重新选择。',
          normalizedFilter: normalizedFilterFrom(),
          summary: appSummary(),
        };
      }
    }

    // ELEC-02：先占锁再写配置。
    const gate = acquireOperation('pipeline');
    if (!gate.ok) return { ...gate.response, normalizedFilter: normalizedFilterFrom() };

    const startedAt = Date.now();
    try {
      return await executePipeline({ raw, concurrency, onlyHash, lease: gate.lease, startedAt });
    } finally {
      gate.lease.release();
    }
  });

  handleTrusted('mfh:run-ocr', async (_event, payload: unknown) => {
    const raw = asObject(payload);
    const summary = appSummary();
    const pendingTotal = pendingOcrWorkCount(summary);
    if (pendingTotal === 0) {
      sendOperationProgress({
        operation: 'ocr',
        phase: '没有文件',
        percent: 100,
        total: 0,
        processed: 0,
        parsed: 0,
        skipped: 0,
        failed: 0,
        code: 'ocr_no_work',
        message: '没有等待识别的文件。请到「开始处理」，先完成「获取邮件」和「获取发票文件」，再开始识别。',
        kind: 'warn',
        done: true,
      });
      return {
        ok: false,
        code: 'ocr_no_work',
        exitCode: 0,
        message: '没有等待识别的文件。请到「开始处理」，先完成「获取邮件」和「获取发票文件」，再开始识别。',
        summary,
      };
    }

    const gate = acquireOperation('ocr');
    if (!gate.ok) return gate.response;
    const jobId = gate.lease.jobId;
    let ocrTemp: { dir: string; file: string } | undefined;

    try {
      const prepared = prepareOcrOperation(raw, pendingTotal, jobId);
      if (!prepared.ok) return prepared.response;
      ocrTemp = prepared.operation.ocrTemp;
      const executed = await executeOcr(prepared.operation);
      const settlementError = settleOcrRerun(executed);
      if (settlementError) return settlementError;
      return buildOcrResponse(executed);
    } finally {
      // 临时 run config 是明文；无论正常结束还是异常路径都必须删除。
      if (ocrTemp) removeTempDir(ocrTemp.dir);
      ocrStopRequested.delete(jobId);
      ocrProcesses.delete(jobId);
      gate.lease.release();
    }
  });

  handleTrusted('mfh:organize', async (_event, payload: unknown) => {
    const raw = asObject(payload);
    const applyRename = raw.applyRename === true;
    const gate = acquireOperation('organize');
    if (!gate.ok) return gate.response;

    const startedAt = Date.now();
    try {
      const recoveryError = ensureArchiveRecoveryReady();
      if (recoveryError) {
        return { ok: false, ...recoveryError, summary: appSummary() };
      }
      const cliArgs = ['--config', configPath];
      if (applyRename) cliArgs.push('--apply-rename');
      const result = await runCli('organize', cliArgs, { jobId: gate.lease.jobId });
      const output = `${result.stdout}\n${result.stderr}`;
      const orgCounts = parseOrganizeCompleteCounts(output);
      const status = deriveRunStatus({
        code: result.code,
        started: result.started,
        succeeded: orgCounts
          ? orgCounts.copied + orgCounts.skipped
          : (result.code === 0 ? 1 : 0),
        failed: orgCounts
          ? orgCounts.failed
          : (result.code === 0 ? 0 : 1),
      });
      const historyWarning = recordHistory(
        'organize',
        applyRename ? '一键改名整理' : '整理输出文件',
        startedAt,
        result,
        status,
        status === 'success' ? '已完成' : status === 'partial' ? '部分完成' : '运行失败',
      );
      const scanned = orgCounts?.scanned;
      const baseLabel = applyRename ? '改名' : '整理';
      const message = status === 'partial'
        ? `${baseLabel}部分完成：成功 ${orgCounts?.copied ?? 0}，跳过 ${orgCounts?.skipped ?? 0}，失败 ${orgCounts?.failed ?? 0}。`
        : status !== 'success'
          ? `${baseLabel}没有完成，请查看诊断信息了解详情。`
          : scanned === 0
            ? '目前没有可整理的识别结果。请先抓取邮件并完成识别后再试。'
            : typeof scanned === 'number'
              ? `${baseLabel}完成，处理 ${scanned} 条识别结果。`
              : `${baseLabel}完成。`;
      const report = reportFor(
        'organize',
        gate.lease.jobId,
        result,
        { ok: 'organize_done', failed: 'organize_failed', partial: 'organize_partial' },
        status,
      );
      const summaryPart = tryAppSummary(appSummary);
      const warning = [historyWarning, summaryPart.warning].filter(Boolean).join(' ') || undefined;
      return {
        ok: status === 'success',
        status,
        started: result.started,
        ...report,
        jobId: gate.lease.jobId,
        message,
        ...(typeof scanned === 'number' ? { scanned } : {}),
        ...(orgCounts
          ? {
            counts: {
              scanned: orgCounts.scanned,
              copied: orgCounts.copied,
              skipped: orgCounts.skipped,
              failed: orgCounts.failed,
            },
          }
          : {}),
        ...(warning ? { warning } : {}),
        ...(summaryPart.summary ? { summary: summaryPart.summary } : {}),
        ...(summaryPart.summaryUnavailable ? { summaryUnavailable: true } : {}),
      };
    } finally {
      gate.lease.release();
    }
  });

  handleTrusted('mfh:stop-ocr', () => {
    if (ocrProcesses.size === 0) return { ok: false, code: 'ocr_not_running', message: '当前没有正在运行的识别任务。' };
    const details: string[] = [];
    let treeIncomplete = false;
    for (const [jobId, child] of ocrProcesses) {
      ocrStopRequested.add(jobId);
      // Windows 上必须终止整棵进程树，否则 efapiao serve 会继续占用端口（APP-16）。
      const outcome = killProcessTree(child);
      if (!outcome.treeSignalled) treeIncomplete = true;
      if (outcome.detail) details.push(outcome.detail);
    }
    if (treeIncomplete) {
      return {
        ok: true,
        code: 'ocr_stopping_partial',
        message: '正在停止识别。本机识别服务可能需要多等几秒才会完全退出。',
        detail: sanitizeText(details.join('；'), { maxLength: 200 }),
      };
    }
    return { ok: true, code: 'ocr_stopping', message: '正在停止识别。' };
  });

  handleTrusted('mfh:open-path', async (_event, payload: unknown) => {
    const raw = asObject(payload);
    const reveal = raw.reveal === true;

    // 优先符号位置（renderer 无需真路径）——目录目标；仍走类型策略作防御深度
    if (typeof raw.location === 'string' && raw.location.trim()) {
      const loc = raw.location.trim() as OpenLocationKey;
      const mapped = resolveSymbolicLocation(loc);
      if (!mapped) {
        return {
          ok: false,
          code: 'path_location_unknown',
          error: '未知的位置标识。',
          message: '未知的位置标识。',
        };
      }
      const canon = resolveCanonicalPath(mapped);
      if (!canon || !isInsideOpenPathAllowedRoots(canon)) {
        return {
          ok: false,
          code: 'path_outside_data_dir',
          error: '该位置当前不在允许打开的范围内。',
          message: '该位置当前不在允许打开的范围内。',
        };
      }
      // 符号 location：允许打开普通目录；文件 open 不经 location；bundle-like 仍由策略拒绝。
      const result = await openOrRevealByPolicy(canon, {
        forceReveal: reveal,
        allowDirectoryOpen: true,
        allowFileOpen: false,
      });
      if (!result.ok && result.code === 'path_open_failed') {
        return {
          ...result,
          location: loc,
          message: result.message ?? '无法打开该位置，请确认它仍然存在。',
        };
      }
      return { ...result, location: loc };
    }

    // 句柄或遗留 path（均经 resolveOpenTarget 严格校验 + 文件类型策略）
    const target = typeof raw.path === 'string' && raw.path.length > 0
      ? raw.path
      : typeof raw.handle === 'string' && raw.handle.length > 0
        ? raw.handle
        : '';
    if (!target) {
      return {
        ok: false,
        code: 'path_invalid',
        error: '请提供 location、handle 或 path。',
        message: '请提供 location、handle 或 path。',
      };
    }
    const resolved = resolveOpenTarget(target);
    if (!resolved.ok) {
      return { ok: false, code: resolved.code, error: resolved.message, message: resolved.message };
    }
    // 文件/目录 open 仅主进程签发的 opaque `ext:` 句柄；renderer 提供的 path（含配置派生）
    // 最多 reveal，绝不 shell.openPath——缩小 pathname TOCTOU 可达面。
    const isMainIssuedHandle = target.startsWith('ext:');
    if (reveal) {
      return openOrRevealByPolicy(resolved.path, {
        forceReveal: true,
        allowDirectoryOpen: isMainIssuedHandle,
        allowFileOpen: false,
      });
    }
    // S2：允许根校验之后，再按扩展名 / 目录来源 / 句柄来源约束可 open 的目标
    return openOrRevealByPolicy(resolved.path, {
      allowDirectoryOpen: isMainIssuedHandle,
      allowFileOpen: isMainIssuedHandle,
    });
  });

  handleTrusted('mfh:copy-text', (_event, payload: unknown) => {
    const raw = asObject(payload);
    clipboard.writeText(typeof raw.text === 'string' ? raw.text : '');
    return { ok: true };
  });

  return { resolveOpenTarget };
}
