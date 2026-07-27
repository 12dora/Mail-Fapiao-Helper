import fs from 'node:fs';
import path from 'node:path';
import type { ParsedMail } from 'mailparser';
import type { Browser } from 'playwright';
import type { Config } from './config.js';
import type { Logger } from './log.js';
import type { State } from './state.js';
import { contentHash as contentHashOf, msgIdHash as msgIdHashFn } from './util/hash.js';
import { csvCell, parseCsv } from './util/csv.js';
import { attemptDeadlineSignal, isTimeoutError } from './util/net.js';
import { extractors } from './extract/registry.js';
import type { Ctx, ExtractIssue, PdfArtifact } from './extract/types.js';
import { ensureSecureDir, stageDocuments } from './download/downloader.js';
import { supportingReason } from './extract/classify.js';

interface CsvRow {
  messageId: string;
  date: string;
  from: string;
  subject: string;
  filename: string;
  source: string;
  contentHash: string;
}

interface OcrPendingRow extends CsvRow {
  hash: string;
  format: string;
  documentType: string;
  reason: string;
  status: string;
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

export interface ProcessMailResult {
  hash: string;
  messageId: string;
  date: string;
  from: string;
  subject: string;
  outcome: 'pdf' | 'manual' | 'skip';
  reason?: string;
  /** true 表示归档了部分文档，但同一封邮件仍有候选失败并写入了待确认记录。 */
  partial?: boolean;
}

export interface ProcessMailOpts {
  force?: boolean;
  raw?: Buffer;
}

const INVOICE_CSV_HEADER = 'messageId,date,from,subject,filename,source,contentHash\n';
const OCR_CSV_HEADER = 'hash,messageId,date,from,subject,filename,source,format,documentType,status,reason,contentHash\n';
const PENDING_CSV_HEADER = 'messageId,date,from,subject,reason\n';

function ensureDir(dir: string): void {
  ensureSecureDir(dir);
}

/** POSIX 下把敏感文件收紧到 0600；Windows 上 chmod 语义不同，直接跳过（APP-22）。 */
function hardenFile(target: string): void {
  if (process.platform === 'win32') return;
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // 网络盘 / 非 POSIX 文件系统不支持 chmod，忽略。
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Retry a synchronous CSV write when the file is transiently locked (Windows /
 * Excel keeps it open): EBUSY / EPERM / EACCES. Backs off 100ms -> 1s. Any
 * other error, or exhausted retries, is rethrown so the caller can degrade.
 */
function withCsvRetry(fn: () => void): void {
  const delays = [100, 300, 1000];
  for (let attempt = 0; ; attempt++) {
    try {
      fn();
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
      if (!retryable || attempt >= delays.length) throw err;
      sleepSync(delays[attempt] ?? 1000);
    }
  }
}

// ---------------------------------------------------------------------------
// CSV 事务原语（APP-03）
// ---------------------------------------------------------------------------

/** 文件本次由我们新建时的回滚标记：回滚等于整个删除。 */
const CSV_CREATED = -1;

/**
 * 一次性追加整批 CSV 行，并返回追加前的文件大小作为回滚标记。整批只做一次
 * `appendFileSync`，避免逐行追加在中途失败留下“半个批次”。
 */
function appendCsvBlock(csvPath: string, header: string, lines: string[]): number {
  if (lines.length === 0) return fs.existsSync(csvPath) ? fs.statSync(csvPath).size : CSV_CREATED;
  ensureDir(path.dirname(csvPath));
  const body = lines.join('');
  if (!fs.existsSync(csvPath)) {
    withCsvRetry(() => fs.writeFileSync(csvPath, '﻿' + header + body, 'utf8'));
    hardenFile(csvPath);
    return CSV_CREATED;
  }
  const previousSize = fs.statSync(csvPath).size;
  withCsvRetry(() => fs.appendFileSync(csvPath, body, 'utf8'));
  hardenFile(csvPath);
  return previousSize;
}

/** 把 CSV 回滚到 `appendCsvBlock` 之前的状态。 */
function rollbackCsvBlock(csvPath: string, marker: number, log: Logger): void {
  try {
    if (marker === CSV_CREATED) {
      fs.rmSync(csvPath, { force: true });
    } else {
      fs.truncateSync(csvPath, marker);
    }
  } catch (err) {
    log.warn(`CSV rollback failed for ${csvPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 预校验：目录存在且可写。 */
function assertWritableDir(dir: string): void {
  ensureDir(dir);
  fs.accessSync(dir, fs.constants.W_OK);
}

/** 预校验：CSV 可追加（不存在时校验其父目录可写）。 */
function assertAppendableCsv(csvPath: string): void {
  ensureDir(path.dirname(csvPath));
  if (fs.existsSync(csvPath)) {
    const fd = fs.openSync(csvPath, 'a');
    fs.closeSync(fd);
    return;
  }
  fs.accessSync(path.dirname(csvPath), fs.constants.W_OK);
}

function invoiceCsvLine(row: CsvRow): string {
  return [
    row.messageId,
    row.date,
    row.from,
    row.subject,
    row.filename,
    row.source,
    row.contentHash,
  ].map(csvCell).join(',') + '\n';
}

function ocrCsvLine(row: OcrPendingRow): string {
  return [
    row.hash,
    row.messageId,
    row.date,
    row.from,
    row.subject,
    row.filename,
    row.source,
    row.format,
    row.documentType,
    row.status,
    row.reason,
    row.contentHash,
  ].map(csvCell).join(',') + '\n';
}

interface ArchivedIndex {
  /** `${messageId}\0${contentHash}` -> 已归档文件名。 */
  byKey: Map<string, string>;
  /** 本邮件已归档的 contentHash -> 文件名，用于归档前的幂等协调。 */
  byContentHash: Map<string, string>;
}

/**
 * 读取 invoices.csv，建立 `(messageId, source, contentHash)` 维度的已归档索引。
 * `--force` / `--only-mail` 重跑靠它复用既有文件，而不是新建 `-1/-2` 碰撞副本（APP-03）。
 */
function readArchivedIndex(csvPath: string, messageId: string): ArchivedIndex {
  const byKey = new Map<string, string>();
  const byContentHash = new Map<string, string>();
  if (!fs.existsSync(csvPath)) return { byKey, byContentHash };
  const content = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  const records = parseCsv(content);
  for (let i = 1; i < records.length; i++) {
    const cols = records[i] ?? [];
    const rowMessageId = cols[0] ?? '';
    const filename = cols[4] ?? '';
    const source = cols[5] ?? '';
    const hash = cols[6] ?? '';
    if (hash.length === 0) continue;
    byKey.set(`${rowMessageId}\0${source}\0${hash}`, filename);
    if (rowMessageId === messageId && filename.length > 0) {
      byContentHash.set(hash, filename);
    }
  }
  return { byKey, byContentHash };
}

/** 读取 OCR 队列里已存在的 `${hash}\0${contentHash}`，用于追加去重。 */
function readOcrKeys(csvPath: string): Set<string> {
  const keys = new Set<string>();
  if (!fs.existsSync(csvPath)) return keys;
  const content = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  const records = parseCsv(content);
  for (let i = 1; i < records.length; i++) {
    const cols = records[i] ?? [];
    keys.add(`${cols[0] ?? ''}\0${cols[11] ?? ''}`);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// 待确认队列
// ---------------------------------------------------------------------------

function writePendingEml(raw: Buffer | undefined, pendingDir: string, hash: string): void {
  ensureDir(pendingDir);
  const emlPath = path.join(pendingDir, `${hash}.eml`);
  const tmpPath = `${emlPath}.tmp`;

  if (fs.existsSync(emlPath) && fs.statSync(emlPath).size > 0) return;

  fs.writeFileSync(tmpPath, raw ?? Buffer.from(''), { mode: process.platform === 'win32' ? undefined : 0o600 });
  hardenFile(tmpPath);
  fs.renameSync(tmpPath, emlPath);
  hardenFile(emlPath);
}

function pendingCsvContainsRow(csvPath: string, row: { messageId: string; date: string; from: string; subject: string }): boolean {
  if (!fs.existsSync(csvPath)) return false;
  const content = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  const records = parseCsv(content);
  for (let i = 1; i < records.length; i++) {
    const cols = records[i] ?? [];
    if (
      (cols[0] ?? '') === row.messageId
      && (cols[1] ?? '') === row.date
      && (cols[2] ?? '') === row.from
      && (cols[3] ?? '') === row.subject
    ) {
      return true;
    }
  }
  return false;
}

function appendPendingCsv(csvPath: string, mail: ParsedMail, reason: string): void {
  const messageId = mail.messageId || '';
  const date = mail.date?.toISOString() || '';
  // Store from/subject verbatim (csvCell quotes embedded newlines, parseCsv reads
  // them back): stripping \r\n here would make the hash that pending/summary
  // recomputes from these columns diverge from the pipeline's <hash>.eml filename
  // for Message-Id-less mails, so their cached .eml could never be found again.
  const from = mail.from?.text || '';
  const subject = mail.subject || '';
  if (pendingCsvContainsRow(csvPath, { messageId, date, from, subject })) return;
  const line = [messageId, date, from, subject, reason].map(csvCell).join(',') + '\n';
  appendCsvBlock(csvPath, PENDING_CSV_HEADER, [line]);
}

/**
 * 写入待确认记录。返回 true 表示 `.eml` 与 `pending.csv` 都已落盘。
 * 只有在「完整归档成功」或「pending 记录确实落盘」之后才允许提交
 * `processedHashes`，否则这封邮件既没有归档也没有待确认记录却不再重试（APP-03）。
 */
function persistPending(
  mail: ParsedMail,
  cfg: Config,
  hash: string,
  reason: string,
  log: Logger,
  raw: Buffer | undefined,
): boolean {
  try {
    writePendingEml(raw, cfg.paths.pending, hash);
    appendPendingCsv(path.join(cfg.paths.pending, 'pending.csv'), mail, reason);
    return true;
  } catch (err) {
    log.warn(`Pending write failed for ${hash}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function commitProcessed(state: State, hash: string, saveState: () => void): void {
  if (!state.processedHashes.includes(hash)) state.processedHashes.push(hash);
  saveState();
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function requestUrl(input: FetchInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestMethod(init: FetchInit): string {
  return (init?.method ?? 'GET').toUpperCase();
}

function makeRetryingFetch(cfg: Config, log: Logger): typeof fetch {
  return (async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const attempts = cfg.network.retries + 1;
    const url = requestUrl(input);
    const method = requestMethod(init);
    const timeoutMs = cfg.network.timeoutMs;
    let lastError = '';

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        // per-attempt deadline：signal 同时约束 header 与 body，接受连接后不发完
        // 响应头、或持续滴流的服务器不会再永久占住一个 worker（APP-13）。
        const attemptInit = {
          ...(init ?? {}),
          signal: attemptDeadlineSignal(init?.signal, timeoutMs),
        } as FetchInit;
        const response = await fetch(input, attemptInit);
        if (!isRetryableStatus(response.status)) {
          return response;
        }
        lastError = `http_${response.status}`;
        // Drain the discarded error body so undici can release the socket back to
        // the pool instead of leaking a connection on every retry.
        await response.body?.cancel().catch(() => {});
        if (attempt === attempts) {
          throw new Error(`network_retry_failed:${method}:${url}:${lastError}`);
        }
        log.warn(`network retry ${attempt}/${cfg.network.retries} ${method} ${url}: ${lastError}`);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('network_retry_failed:')) {
          throw err;
        }
        // 超时属于可重试失败；fetch 在 abort 时已经取消底层 body。
        lastError = isTimeoutError(err)
          ? `timeout_${timeoutMs}ms`
          : (err instanceof Error ? err.message : String(err));
        if (attempt === attempts) {
          throw new Error(`network_retry_failed:${method}:${url}:${lastError}`);
        }
        log.warn(`network retry ${attempt}/${cfg.network.retries} ${method} ${url}: ${lastError}`);
      }

      if (cfg.network.retryDelayMs > 0) {
        await sleep(cfg.network.retryDelayMs * attempt);
      }
    }

    throw new Error(`network_retry_failed:${method}:${url}:${lastError || 'unknown'}`);
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// 可组合的提取协议（APP-01）
// ---------------------------------------------------------------------------

interface AggregatedExtraction {
  /** 按内容身份去重后的候选文档。 */
  artifacts: PdfArtifact[];
  /** 所有候选来源的失败记录，含被跳过的附件、失败的链接和抛异常的提取器。 */
  issues: ExtractIssue[];
  /** 参与提取的提取器名。 */
  matched: string[];
  /** 返回 `skip` 的提取器数量。 */
  skipped: number;
}

/**
 * 依次运行所有 `canHandle()` 为真的提取器并汇总结果。
 *
 * 此前 pipeline 在第一个匹配处 `break`，附件、普通直链和站点链接无法共同贡献
 * artifact，混合邮件会静默漏票；现在改为逐来源汇总、以 contentHash 去重，并把
 * 每个来源的失败逐条留存，交给调用方形成“部分成功 + 待确认”的最终状态（APP-01）。
 */
async function runExtractors(mail: ParsedMail, ctx: Ctx, hash: string): Promise<AggregatedExtraction> {
  const artifacts: PdfArtifact[] = [];
  const issues: ExtractIssue[] = [];
  const matched: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (const extractor of extractors) {
    let claims = false;
    try {
      claims = extractor.canHandle(mail);
    } catch (err) {
      issues.push({ reason: `${extractor.name}:canHandle_failed:${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    if (!claims) continue;
    matched.push(extractor.name);

    let result;
    try {
      result = await extractor.extract(mail, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log.warn(`Extractor ${extractor.name} failed for ${hash}: ${msg}`);
      issues.push({ reason: `${extractor.name}:${msg}`, retryable: msg.includes('network_retry_failed') });
      continue;
    }

    if (result.kind === 'skip') {
      skipped++;
      continue;
    }
    if (result.kind === 'manual') {
      issues.push({ reason: result.reason, retryable: result.reason.includes('network_retry_failed') });
      continue;
    }

    for (const issue of result.issues ?? []) issues.push(issue);
    for (const artifact of result.pdfs) {
      const key = contentHashOf(artifact.data);
      if (seen.has(key)) continue;
      seen.add(key);
      artifacts.push(artifact);
    }
  }

  return { artifacts, issues, matched, skipped };
}

function summarizeIssues(issues: ExtractIssue[]): string {
  const reasons = issues.map((issue) => issue.reason);
  const head = reasons[0] ?? 'unknown';
  return reasons.length > 1 ? `${head} (+${reasons.length - 1})` : head;
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
  const hash = msgIdHashFn(
    mail.messageId ?? undefined,
    mail.from?.text ?? '',
    mail.date?.toISOString() ?? '',
    mail.subject ?? '',
  );
  const messageId = mail.messageId || hash;
  const date = mail.date?.toISOString() || '';
  const from = mail.from?.text || '';
  const subject = mail.subject || '';
  const baseResult = { hash, messageId, date, from, subject };

  if (!opts.force && state.processedHashes.includes(hash)) {
    log.debug(`Skip already processed ${hash}`);
    return { ...baseResult, outcome: 'skip', reason: 'already_processed' };
  }

  const ctx: Ctx = {
    cfg,
    log,
    browser,
    http: makeRetryingFetch(cfg, log),
  };

  /** 统一的降级出口：pending 写不进去就不提交 processed state。 */
  const degradeToManual = (reason: string): ProcessMailResult => {
    if (!persistPending(mail, cfg, hash, reason, log, opts.raw)) {
      return { ...baseResult, outcome: 'manual', reason: `${reason}|pending_write_failed` };
    }
    commitProcessed(state, hash, saveState);
    return { ...baseResult, outcome: 'manual', reason };
  };

  const extraction = await runExtractors(mail, ctx, hash);

  if (extraction.matched.length === 0) {
    log.info(`No extractor matched ${hash}, -> manual`);
    return degradeToManual('no_extractor');
  }
  log.info(`Matched extractors: ${extraction.matched.join('+')} for ${hash}`);

  if (extraction.artifacts.length === 0) {
    if (extraction.issues.length === 0) {
      // 所有匹配的提取器都明确返回 skip：这封邮件无需归档。
      log.info(`Skipped ${hash}`);
      commitProcessed(state, hash, saveState);
      return { ...baseResult, outcome: 'skip' };
    }
    const reason = summarizeIssues(extraction.issues);
    log.info(`Manual ${hash}: ${reason}`);
    return degradeToManual(reason);
  }

  const csvPath = path.resolve(cfg.output.csv);
  const ocrPendingCsvPath = path.join(cfg.paths.invoices, 'ocr', 'ocr-pending.csv');

  let downloadsCount = 0;
  try {
    // 1) 预校验所有写入目标：先确认目录可写、两个 CSV 都能追加，再动任何文件。
    assertWritableDir(cfg.paths.invoices);
    assertAppendableCsv(csvPath);
    assertAppendableCsv(ocrPendingCsvPath);

    // 2) 幂等协调：`(messageId, source, contentHash)` 已归档且文件仍在则直接复用。
    const archived = readArchivedIndex(csvPath, messageId);
    const ocrKeys = readOcrKeys(ocrPendingCsvPath);

    // 3) 在唯一事务目录暂存完整批次。
    const batch = stageDocuments(extraction.artifacts, hash, cfg.paths.invoices, log, {
      avoidConflictBeforeOcr: cfg.rename.avoidConflictBeforeOcr,
      alreadyArchived: archived.byContentHash,
    });

    // 4) 原子提交文件（中途失败由 batch 自行整批回滚）。
    const downloads = batch.commit();
    downloadsCount = downloads.length;

    // 5) 提交元数据：整批各写一次，失败则回滚 CSV 与本批次文件。
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

    let invoiceMarker: number | undefined;
    try {
      invoiceMarker = appendCsvBlock(csvPath, INVOICE_CSV_HEADER, invoiceLines);
      appendCsvBlock(ocrPendingCsvPath, OCR_CSV_HEADER, ocrLines);
    } catch (err) {
      if (invoiceMarker !== undefined && invoiceLines.length > 0) {
        rollbackCsvBlock(csvPath, invoiceMarker, log);
      }
      batch.rollback();
      throw err;
    }
  } catch (err) {
    // Iron rule: a filesystem / CSV-lock failure during download or archive must
    // NOT abort the run. Degrade this email to the manual queue and continue.
    const errMsg = err instanceof Error ? err.message : String(err);
    const reason = `download_or_csv:${errMsg}`;
    log.warn(`Archive failed for ${hash}: ${reason}`);
    return degradeToManual(reason);
  }

  // 部分成功：已归档的票必须保留，同时留下可见的待确认记录，不得当作完整成功。
  if (extraction.issues.length > 0) {
    const reason = `partial_extract:${summarizeIssues(extraction.issues)}`;
    log.warn(`Partial extraction for ${hash}: ${reason}`);
    const durable = persistPending(mail, cfg, hash, reason, log, opts.raw);
    if (durable) commitProcessed(state, hash, saveState);
    return {
      ...baseResult,
      outcome: 'pdf',
      partial: true,
      reason: durable ? reason : `${reason}|pending_write_failed`,
    };
  }

  log.info(`Processed ${hash}: ${downloadsCount} documents`);
  commitProcessed(state, hash, saveState);
  return { ...baseResult, outcome: 'pdf' };
}
