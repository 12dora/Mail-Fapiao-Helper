import path from 'node:path';
import type { ParsedMail } from 'mailparser';
import type { Browser } from 'playwright';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import type { State } from '../state.js';
import { resolveMailIdentity } from '../util/hash.js';
import { testFaultEnabled } from '../util/testFaults.js';
import type { Ctx } from '../extract/types.js';
import { supportingReason } from '../extract/classify.js';
import { stageDocuments } from '../download/downloader.js';
import {
  ArchiveRecoveryError,
  beginArchiveTransaction,
} from '../download/archiveJournal.js';
import {
  appendCsvBlock,
  assertAppendableCsv,
  assertWritableDir,
  csvLength,
  INVOICE_CSV_HEADER,
  INVOICE_CSV_LEGACY,
  invoiceCsvLine,
  OCR_CSV_HEADER,
  OCR_CSV_LEGACY,
  ocrCsvLine,
  recoverArchiveTransactionsOnce,
} from './csvDurability.js';
import type { AggregatedExtraction } from './extract.js';
import { runExtractors, summarizeIssues, summarizeReasons } from './extract.js';
import {
  ensureInvoiceSchema,
  ensureOcrSchema,
  fillInvoiceRow,
  readArchivedIndex,
  readOcrKeys,
} from './ledger.js';
import { commitProcessed, persistPending } from './pending.js';
import {
  makeRetryingFetch,
  redactErrorDetail,
  sanitizePendingReason,
} from './retryFetch.js';

/**
 * 单封邮件处理终态（簇 C / CORE-04）。
 *
 * - `archived` / `pending_durable` / `skipped`：已处理（handled），可计入成功侧
 * - `retryable_failure`：可重试失败（含 pending 写失败）；不得伪装成 manual
 * - `fatal_failure`：致命失败，由调用方中止整次 run
 *
 * 只有前三类算 handled。`partial` 表示「有票已落盘，但仍有待确认」——可挂在
 * `archived` 或 `retryable_failure`（pending 写失败）上；后者调用方也须计 archived。
 */
export type ProcessMailOutcome =
  | 'archived'
  | 'pending_durable'
  | 'skipped'
  | 'retryable_failure'
  | 'fatal_failure';

export interface ProcessMailResult {
  hash: string;
  messageId: string;
  date: string;
  from: string;
  subject: string;
  outcome: ProcessMailOutcome;
  reason?: string;
  /**
   * 有票已落盘但仍不完整：可挂在 `archived`（pending 也写上了）或
   * `retryable_failure`（pending 写失败）上。调用方对后者也必须计入 archived。
   */
  partial?: boolean;
}

export interface ProcessMailOpts {
  force?: boolean;
  raw?: Buffer;
  /** CORE-02：致命错误后协调者 abort，归档临界区入口必须再检查一次。 */
  signal?: AbortSignal;
  /**
   * 缓存 `.eml` 文件名上的身份（无扩展名）。用于与 fetch 时身份对齐，
   * 并在 state 中登记 legacy/primary 别名。
   */
  fileHash?: string;
}

type MailIdentity = ReturnType<typeof resolveMailIdentity>;
type BaseResult = Omit<ProcessMailResult, 'outcome' | 'reason' | 'partial'>;
type StagedDownloads = ReturnType<ReturnType<typeof stageDocuments>['commit']>;

interface MailContext {
  identity: MailIdentity;
  hash: string;
  messageId: string;
  date: string;
  from: string;
  subject: string;
  baseResult: BaseResult;
}

function buildMailContext(mail: ParsedMail, opts: ProcessMailOpts): MailContext {
  const identity = resolveMailIdentity({
    messageId: mail.messageId ?? undefined,
    from: mail.from?.text ?? '',
    date: mail.date?.toISOString() ?? '',
    subject: mail.subject ?? '',
    raw: opts.raw,
    fileHash: opts.fileHash,
  });
  const hash = identity.primary;
  const messageId = mail.messageId || hash;
  const date = mail.date?.toISOString() || '';
  const from = mail.from?.text || '';
  const subject = mail.subject || '';
  const baseResult = { hash, messageId, date, from, subject };
  return { identity, hash, messageId, date, from, subject, baseResult };
}

function degradeToPending(
  reason: string,
  mail: ParsedMail,
  cfg: Config,
  log: Logger,
  state: State,
  saveState: () => void,
  opts: ProcessMailOpts,
  context: MailContext,
): ProcessMailResult {
  const { hash, baseResult } = context;
  const safe = sanitizePendingReason(reason);
  if (!persistPending(mail, cfg, hash, safe, log, opts.raw)) {
    return {
      ...baseResult,
      outcome: 'retryable_failure',
      reason: `${safe}|pending_write_failed`,
    };
  }
  // CORE-03 非对称写：只记 primary；读侧用 aliases 覆盖旧 12 位 state。
  commitProcessed(state, hash, () => {});
  saveState();
  log.info(`Manual ${hash}: ${safe}`);
  return { ...baseResult, outcome: 'pending_durable', reason: safe };
}

function appendArchiveLedgers(
  downloads: StagedDownloads,
  extraction: AggregatedExtraction,
  context: MailContext,
  cfg: Config,
  csvPath: string,
  ocrPendingCsvPath: string,
  archived: ReturnType<typeof readArchivedIndex>,
  ocrKeys: Set<string>,
  tx: ReturnType<typeof beginArchiveTransaction>,
  batch: ReturnType<typeof stageDocuments>,
): void {
  const { hash, messageId, date, from, subject } = context;

  // 6) 提交元数据：整批各写一次，失败则由 journal 回滚 CSV 与本批次文件。
  const invoiceLines: string[] = [];
  const ocrLines: string[] = [];
  for (const dl of downloads) {
    const pdf = extraction.artifacts[dl.sourceIndex];
    if (!pdf) continue;

    const invoiceKey = `${messageId}\0${pdf.source}\0${dl.contentHash}`;
    if (!archived.byKey.has(invoiceKey)) {
      archived.byKey.set(invoiceKey, dl.filename);
      invoiceLines.push(invoiceCsvLine({
        messageId,
        date,
        from,
        subject,
        filename: dl.filename,
        source: pdf.source,
        contentHash: dl.contentHash,
        mailHash: hash,
      }));
    }

    const ocrKey = `${hash}\0${dl.contentHash}`;
    if (!ocrKeys.has(ocrKey)) {
      ocrKeys.add(ocrKey);
      ocrLines.push(ocrCsvLine({
        hash,
        messageId,
        date,
        from,
        subject,
        filename: dl.filename,
        source: pdf.source,
        format: dl.format,
        documentType: dl.documentType,
        status: dl.requiresOcr ? 'pending' : 'ignored',
        reason: dl.requiresOcr
          ? (dl.format === 'ofd' ? 'ofd_itinerary_requires_ocr' : 'document_requires_ocr')
          : supportingReason({ ...pdf, format: dl.format, documentType: dl.documentType }),
        contentHash: dl.contentHash,
      }));
    }
  }

  try {
    // OCR-03 / WIRE-02：fsync 之后才能标 ledger-committed。
    appendCsvBlock(csvPath, INVOICE_CSV_HEADER, invoiceLines, {
      upgradeFrom: INVOICE_CSV_LEGACY,
      upgradeRow: (row) => fillInvoiceRow(row, cfg.paths.invoices),
    });
    if (testFaultEnabled('MFH_TEST_FAIL_AFTER_INVOICE_CSV')) {
      throw new Error('forced_after_invoice_csv_failure');
    }
    appendCsvBlock(ocrPendingCsvPath, OCR_CSV_HEADER, ocrLines, {
      upgradeFrom: OCR_CSV_LEGACY,
      upgradeRow: (row) => ({ ...row, contentHash: row.contentHash ?? '' }),
    });
    // 两个 CSV 均已 durable：即使这之后被强杀，恢复也只会清理 journal 本身。
    tx.markStage('ledger-committed');
  } catch (err) {
    // journal 同时负责删除本批次文件并把两个 CSV 截回追加前的长度。
    tx.rollback();
    batch.dispose();
    throw err;
  }
}

function archiveExtraction(
  extraction: AggregatedExtraction,
  context: MailContext,
  cfg: Config,
  log: Logger,
  csvPath: string,
  ocrPendingCsvPath: string,
): number {
  const { hash, messageId } = context;

  // 0) 崩溃恢复：先把上次强杀留下的半成品事务清掉，再开始本次归档。
  recoverArchiveTransactionsOnce(cfg.paths.invoices, log);

  // 1) 预校验所有写入目标：先确认目录可写、两个 CSV 都能追加，再动任何文件。
  assertWritableDir(cfg.paths.invoices);
  assertAppendableCsv(csvPath);
  assertAppendableCsv(ocrPendingCsvPath);
  // CORE-05：空/缺失 CSV 先落好表头；旧 schema 幂等升级补 mailHash + contentHash。
  ensureInvoiceSchema(csvPath, cfg.paths.invoices);
  ensureOcrSchema(ocrPendingCsvPath);

  // 2) 幂等协调：`(messageId, source, contentHash)` 已归档且文件仍在则直接复用。
  //    六列 legacy / blank contentHash 时对磁盘文件现算 hash（BLOCKING 14）。
  const archived = readArchivedIndex(csvPath, messageId, cfg.paths.invoices);
  const ocrKeys = readOcrKeys(ocrPendingCsvPath);

  // 3) 在唯一事务目录暂存完整批次。
  const batch = stageDocuments(extraction.artifacts, hash, cfg.paths.invoices, log, {
    avoidConflictBeforeOcr: cfg.rename.avoidConflictBeforeOcr,
    alreadyArchived: archived.byContentHash,
  });

  // 从这里到 tx.commit() 之间没有任何 await：同进程的其他 worker 不会插进来
  // 追加 CSV，因此 journal 里记录的 baseLength 在提交前始终有效。
  // 4) 规划最终路径并写出持久化 journal：journal 落盘（fsync）之后才安装文件，
  //    进程被强杀也能由下一次 recoverArchiveTransactions() 清掉半成品（APP-03）。
  const plannedFiles = batch.plan();
  let tx;
  try {
    tx = beginArchiveTransaction(cfg.paths.invoices, {
      files: plannedFiles,
      csv: [
        { path: csvPath, baseLength: csvLength(csvPath) },
        { path: ocrPendingCsvPath, baseLength: csvLength(ocrPendingCsvPath) },
      ],
    });
  } catch (err) {
    batch.dispose();
    throw err;
  }

  let downloads;
  try {
    // 5) 在 active journal 下独占创建最终文件。
    downloads = batch.commit();
    tx.markStage('files-installed');
    batch.dispose();
  } catch (err) {
    tx.rollback();
    batch.dispose();
    throw err;
  }
  const downloadsCount = downloads.length;

  appendArchiveLedgers(
    downloads,
    extraction,
    context,
    cfg,
    csvPath,
    ocrPendingCsvPath,
    archived,
    ocrKeys,
    tx,
    batch,
  );
  tx.commit();
  return downloadsCount;
}

function finishPartial(
  extraction: AggregatedExtraction,
  downloadsCount: number,
  mail: ParsedMail,
  cfg: Config,
  log: Logger,
  state: State,
  saveState: () => void,
  opts: ProcessMailOpts,
  context: MailContext,
): ProcessMailResult {
  const { hash, baseResult } = context;
  const reason = `partial_extract:${summarizeIssues(extraction.issues)}`;
  log.warn(`Partial extraction for ${hash}: ${reason}`);
  const safe = sanitizePendingReason(reason);
  const durable = persistPending(mail, cfg, hash, safe, log, opts.raw);
  if (!durable) {
    // 文件已落盘，但待确认写失败：仍须非 0 退出并允许重试（幂等跳过已归档件）。
    // partial:true → 调用方须把 archived 计入终态（BLOCKING 2）。
    return {
      ...baseResult,
      outcome: 'retryable_failure',
      partial: true,
      reason: `${safe}|pending_write_failed`,
    };
  }
  commitProcessed(state, hash, () => {});
  saveState();
  log.info(`Processed ${hash}: ${downloadsCount} documents (partial)`);
  return {
    ...baseResult,
    outcome: 'archived',
    partial: true,
    reason: safe,
  };
}

// ---------------------------------------------------------------------------

export async function processMail(
  mail: ParsedMail,
  cfg: Config,
  log: Logger,
  state: State,
  saveState: () => void,
  browser: () => Promise<Browser>,
  opts: ProcessMailOpts = {},
): Promise<ProcessMailResult> {
  const context = buildMailContext(mail, opts);
  const { identity, hash, baseResult } = context;

  // 仅用 evidence 判定已处理：Message-Id legacy 不得折叠另一封内容不同的邮件（CORE-03）。
  if (!opts.force && identity.evidence.some((a) => state.processedHashes.includes(a))) {
    log.debug(`Skip already processed ${hash}`);
    return { ...baseResult, outcome: 'skipped', reason: 'already_processed' };
  }

  if (opts.signal?.aborted) {
    return { ...baseResult, outcome: 'skipped', reason: 'aborted' };
  }

  const ctx: Ctx = {
    cfg,
    log,
    browser,
    http: makeRetryingFetch(cfg, log),
  };

  /**
   * 统一的待确认出口：pending 写不进去 = retryable_failure，绝不当成 pending_durable。
   * 只有 .eml + pending.csv 都落盘后才提交 processed（CORE-04）。
   */
  const pending = (reason: string): ProcessMailResult => degradeToPending(
    reason,
    mail,
    cfg,
    log,
    state,
    saveState,
    opts,
    context,
  );

  const extraction = await runExtractors(mail, ctx, hash);

  if (extraction.matched.length === 0) {
    log.info(`No extractor matched ${hash}, -> pending`);
    return pending('no_extractor');
  }
  // 提取器名只进诊断日志，不进面向用户的进度文案（COPY-06）。
  log.info(`Matched extractors: ${extraction.matched.join('+')} for ${hash}`);

  if (extraction.artifacts.length === 0) {
    if (extraction.issues.length > 0) {
      const reason = summarizeIssues(extraction.issues);
      return pending(reason);
    }
    if (extraction.notApplicable.length > 0) {
      // 没有任何提取器适用，且整封邮件零产出：仍然入待确认，让用户能补票。
      const reason = summarizeReasons(extraction.notApplicable);
      return pending(reason);
    }
    // 所有匹配的提取器都明确返回 skip：这封邮件无需归档。
    log.info(`Skipped ${hash}`);
    commitProcessed(state, hash, () => {});
    saveState();
    return { ...baseResult, outcome: 'skipped' };
  }

  const csvPath = path.resolve(cfg.output.csv);
  const ocrPendingCsvPath = path.join(cfg.paths.invoices, 'ocr', 'ocr-pending.csv');

  let downloadsCount = 0;
  try {
    // CORE-02：网络/提取 await 返回后、进入同步归档区之前，再检查一次致命中止。
    if (opts.signal?.aborted) {
      return { ...baseResult, outcome: 'skipped', reason: 'aborted' };
    }

    downloadsCount = archiveExtraction(extraction, context, cfg, log, csvPath, ocrPendingCsvPath);
  } catch (err) {
    if (err instanceof ArchiveRecoveryError) throw err;
    // Iron rule: a filesystem / CSV-lock failure during download or archive must
    // NOT abort the run. Degrade this email to the pending queue and continue.
    const errMsg = err instanceof Error ? err.message : String(err);
    const reason = `download_or_csv:${redactErrorDetail(errMsg)}`;
    log.warn(`Archive failed for ${hash}: ${reason}`);
    return pending(reason);
  }

  // 部分成功：已归档的票必须保留，同时留下可见的待确认记录，不得当作完整成功。
  // partial 可挂在 archived 或 retryable_failure 上：后者表示票已落盘但 pending 未写上。
  if (extraction.issues.length > 0) {
    return finishPartial(
      extraction,
      downloadsCount,
      mail,
      cfg,
      log,
      state,
      saveState,
      opts,
      context,
    );
  }

  log.info(`Processed ${hash}: ${downloadsCount} documents`);
  commitProcessed(state, hash, () => {});
  saveState();
  return { ...baseResult, outcome: 'archived' };
}
