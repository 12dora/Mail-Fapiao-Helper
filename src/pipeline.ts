import fs from 'node:fs';
import path from 'node:path';
import type { ParsedMail } from 'mailparser';
import type { Browser } from 'playwright';
import type { Config } from './config.js';
import type { Logger } from './log.js';
import type { State } from './state.js';
import {
  contentHash as contentHashOf,
  isMailHash,
  msgIdHash as msgIdHashFn,
  resolveMailIdentity,
} from './util/hash.js';
import { csvCell, ensureCsvSchema, parseCsv, readCsvRows, rewriteCsvRows } from './util/csv.js';
import { testFaultEnabled } from './util/testFaults.js';
import {
  attemptDeadlineSignal,
  bufferedResponse,
  isTimeoutError,
  readCappedBuffer,
  safeFetch,
} from './util/net.js';
import { extractors } from './extract/registry.js';
import type { Ctx, ExtractIssue, PdfArtifact } from './extract/types.js';
import { invoiceNoKey, looksLikeOfdItinerary } from './extract/documentIdentity.js';
import { looksLikeOfdItineraryText, supportingReason } from './extract/classify.js';
import { ensureSecureDir, stageDocuments } from './download/downloader.js';
import {
  ArchiveRecoveryError,
  appendCsvBlockDurable,
  beginArchiveTransaction,
  assertArchiveTransactionsRecovered,
} from './download/archiveJournal.js';

interface CsvRow {
  messageId: string;
  date: string;
  from: string;
  subject: string;
  filename: string;
  source: string;
  contentHash: string;
  mailHash: string;
}

interface OcrPendingRow {
  hash: string;
  messageId: string;
  date: string;
  from: string;
  subject: string;
  filename: string;
  source: string;
  format: string;
  documentType: string;
  status: string;
  reason: string;
  contentHash: string;
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

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

// CORE-03：mailHash 显式列；升级路径见 ensure*Schema 的 upgradeFrom。
const INVOICE_CSV_HEADER = 'messageId,date,from,subject,filename,source,contentHash,mailHash\n';
const INVOICE_CSV_LEGACY = [
  'messageId,date,from,subject,filename,source,contentHash',
  'messageId,date,from,subject,filename,source',
];
const OCR_CSV_HEADER = 'hash,messageId,date,from,subject,filename,source,format,documentType,status,reason,contentHash\n';
const OCR_CSV_LEGACY = [
  'hash,messageId,date,from,subject,filename,source,format,documentType,status,reason',
];
const PENDING_CSV_HEADER = 'mailHash,messageId,date,from,subject,reason\n';
const PENDING_CSV_LEGACY = [
  'messageId,date,from,subject,reason',
];

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

/**
 * 一次性追加整批 CSV 行。CORE-05：先 ensure schema（空文件写表头）；
 * OCR-03 / WIRE-02：走 durable 原语（write + fsync，新建时 fsync 父目录）。
 *
 * `schema` 必须带上与 ensure*Schema 相同的 upgradeRow，禁止「只升表头、不补列值」
 * ——否则旧 pending 行会永久 blank mailHash，重试时 append 出重复行（BLOCKING 12）。
 */
function appendCsvBlock(
  csvPath: string,
  header: string,
  lines: string[],
  schema?: { upgradeFrom?: string[]; upgradeRow?: (row: Record<string, string>) => Record<string, string> },
): void {
  if (lines.length === 0) return;
  ensureDir(path.dirname(csvPath));
  withCsvRetry(() => {
    ensureCsvSchema(csvPath, header, schema ?? {});
    appendCsvBlockDurable(csvPath, header, lines);
  });
  hardenFile(csvPath);
}

/** CSV 当前字节长度；文件不存在时为 0（journal 回滚的基准）。 */
function csvLength(csvPath: string): number {
  try {
    return fs.statSync(csvPath).size;
  } catch {
    return 0;
  }
}

function recoverArchiveTransactionsOnce(invoicesDir: string, log: Logger): void {
  const key = path.resolve(invoicesDir);
  try {
    const { rolledBack, skipped } = assertArchiveTransactionsRecovered(key);
    if (rolledBack > 0 || skipped > 0) {
      log.warn(`Archive journal recovery: rolledBack=${rolledBack}, skipped=${skipped}`);
    }
  } catch (err) {
    log.warn('Archive journal recovery failed; archive writes are blocked until recovery succeeds.');
    throw err;
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
    row.mailHash,
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
 * 从已归档文件回填 contentHash（六列表头升级后列为空时）。
 * 只接受 invoices 目录下的 basename，拒绝路径穿越。
 */
function hashArchivedFile(invoicesDir: string, filename: string): string {
  // 只认 basename，杜绝台账 filename 路径穿越。
  const leaf = path.basename(filename);
  if (!leaf || leaf === '.' || leaf === '..') return '';
  try {
    const resolved = path.resolve(invoicesDir, leaf);
    const root = path.resolve(invoicesDir);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return '';
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return '';
    return contentHashOf(fs.readFileSync(resolved));
  } catch {
    return '';
  }
}

/**
 * 读取 invoices.csv，建立 `(messageId, source, contentHash)` 维度的已归档索引。
 * `--force` / `--only-mail` 重跑靠它复用既有文件，而不是新建 `-1/-2` 碰撞副本（APP-03）。
 *
 * 六列 legacy 升级后 contentHash 可能为空：此时对磁盘上的归档文件现算 hash，
 * 保证升级用户 force-rerun 不会装出碰撞后缀副本（BLOCKING 14）。
 */
function readArchivedIndex(csvPath: string, messageId: string, invoicesDir: string): ArchivedIndex {
  const byKey = new Map<string, string>();
  const byContentHash = new Map<string, string>();
  if (!fs.existsSync(csvPath)) return { byKey, byContentHash };
  const content = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  const records = parseCsv(content);
  const header = records[0] ?? [];
  const idx = (name: string): number => header.indexOf(name);
  const iMessageId = idx('messageId') >= 0 ? idx('messageId') : 0;
  const iFilename = idx('filename') >= 0 ? idx('filename') : 4;
  const iSource = idx('source') >= 0 ? idx('source') : 5;
  const iHash = idx('contentHash') >= 0 ? idx('contentHash') : 6;
  for (let i = 1; i < records.length; i++) {
    const cols = records[i] ?? [];
    const rowMessageId = cols[iMessageId] ?? '';
    const filename = cols[iFilename] ?? '';
    const source = cols[iSource] ?? '';
    let hash = (cols[iHash] ?? '').trim();
    if (hash.length === 0 && filename.length > 0) {
      hash = hashArchivedFile(invoicesDir, filename);
    }
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
  const header = records[0] ?? [];
  const iHash = header.indexOf('hash') >= 0 ? header.indexOf('hash') : 0;
  const iContent = header.indexOf('contentHash') >= 0 ? header.indexOf('contentHash') : 11;
  for (let i = 1; i < records.length; i++) {
    const cols = records[i] ?? [];
    keys.add(`${cols[iHash] ?? ''}\0${cols[iContent] ?? ''}`);
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

/** CORE-03d：按显式 mailHash 去重，禁止仅靠 messageId/date/from/subject 折叠。 */
function pendingCsvContainsHash(csvPath: string, mailHash: string): boolean {
  if (!fs.existsSync(csvPath) || mailHash.length === 0) return false;
  const content = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  const records = parseCsv(content);
  if (records.length === 0) return false;
  const header = records[0] ?? [];
  const iMailHash = header.indexOf('mailHash');
  for (let i = 1; i < records.length; i++) {
    const cols = records[i] ?? [];
    if (iMailHash >= 0) {
      if ((cols[iMailHash] ?? '') === mailHash) return true;
    } else {
      // 旧 schema：无 mailHash 列时无法可靠去重；不按 envelope 折叠。
    }
  }
  return false;
}

function fillPendingMailHash(row: Record<string, string>): Record<string, string> {
  if (row.mailHash && row.mailHash.length > 0) return row;
  const messageId = row.messageId ?? '';
  // 超大邮件路径曾把 hash 写在 messageId 位。
  if (isMailHash(messageId)) {
    return { ...row, mailHash: messageId.toLowerCase() };
  }
  const legacy = msgIdHashFn(
    messageId.length > 0 ? messageId : undefined,
    row.from ?? '',
    row.date ?? '',
    row.subject ?? '',
  );
  return { ...row, mailHash: legacy };
}

/**
 * 升级/修复 invoices 行：补 mailHash；contentHash 为空时对归档文件现算回填
 * （BLOCKING 14：六列 legacy 不得留下空 contentHash 导致 force-rerun 装副本）。
 */
function fillInvoiceRow(row: Record<string, string>, invoicesDir: string): Record<string, string> {
  let contentHash = (row.contentHash ?? '').trim();
  const filename = row.filename ?? '';
  if (!contentHash && filename.length > 0) {
    contentHash = hashArchivedFile(invoicesDir, filename);
  }
  let mailHash = (row.mailHash ?? '').trim();
  if (!mailHash) {
    const messageId = row.messageId ?? '';
    if (isMailHash(messageId)) {
      mailHash = messageId.toLowerCase();
    } else {
      mailHash = msgIdHashFn(
        messageId.length > 0 ? messageId : undefined,
        row.from ?? '',
        row.date ?? '',
        row.subject ?? '',
      );
    }
  }
  return { ...row, mailHash, contentHash };
}

/** 当前 schema 下 blank mailHash 行补齐（append 升级漏填时的语义幂等修复）。 */
function repairBlankPendingMailHashes(csvPath: string): void {
  if (!fs.existsSync(csvPath)) return;
  try {
    if (fs.statSync(csvPath).size === 0) return;
  } catch {
    return;
  }
  const rows = readCsvRows(csvPath);
  if (rows.length === 0) return;
  let dirty = false;
  const fixed = rows.map((row) => {
    if ((row.mailHash ?? '').trim().length > 0) return row;
    dirty = true;
    return fillPendingMailHash(row);
  });
  if (!dirty) return;
  withCsvRetry(() => rewriteCsvRows(csvPath, PENDING_CSV_HEADER, fixed));
  hardenFile(csvPath);
}

/** 当前 schema 下 blank contentHash/mailHash 回填（已升表头但列值为空的升级残骸）。 */
function repairInvoiceLedgerRows(csvPath: string, invoicesDir: string): void {
  if (!fs.existsSync(csvPath)) return;
  try {
    if (fs.statSync(csvPath).size === 0) return;
  } catch {
    return;
  }
  const rows = readCsvRows(csvPath);
  if (rows.length === 0) return;
  let dirty = false;
  const fixed = rows.map((row) => {
    const needHash = !(row.contentHash ?? '').trim();
    const needMail = !(row.mailHash ?? '').trim();
    if (!needHash && !needMail) return row;
    dirty = true;
    return fillInvoiceRow(row, invoicesDir);
  });
  if (!dirty) return;
  withCsvRetry(() => rewriteCsvRows(csvPath, INVOICE_CSV_HEADER, fixed));
  hardenFile(csvPath);
}

function ensurePendingSchema(csvPath: string): void {
  ensureCsvSchema(csvPath, PENDING_CSV_HEADER, {
    upgradeFrom: PENDING_CSV_LEGACY,
    upgradeRow: fillPendingMailHash,
  });
  // 若此前经无 upgradeRow 的路径「只升了表头」，此处把 blank mailHash 补上。
  repairBlankPendingMailHashes(csvPath);
}

function ensureInvoiceSchema(csvPath: string, invoicesDir: string): void {
  ensureCsvSchema(csvPath, INVOICE_CSV_HEADER, {
    upgradeFrom: INVOICE_CSV_LEGACY,
    upgradeRow: (row) => fillInvoiceRow(row, invoicesDir),
  });
  repairInvoiceLedgerRows(csvPath, invoicesDir);
}

function ensureOcrSchema(csvPath: string): void {
  ensureCsvSchema(csvPath, OCR_CSV_HEADER, {
    upgradeFrom: OCR_CSV_LEGACY,
    upgradeRow: (row) => ({ ...row, contentHash: row.contentHash ?? '' }),
  });
}

function appendPendingCsv(
  csvPath: string,
  mail: { messageId: string; date: string; from: string; subject: string },
  reason: string,
  mailHash: string,
): void {
  // 先 ensure+repair，再按 mailHash 去重，保证重试旧 pending 不会 append 重复行。
  ensurePendingSchema(csvPath);
  if (pendingCsvContainsHash(csvPath, mailHash)) return;
  const line = [mailHash, mail.messageId, mail.date, mail.from, mail.subject, reason].map(csvCell).join(',') + '\n';
  appendCsvBlock(csvPath, PENDING_CSV_HEADER, [line], {
    upgradeFrom: PENDING_CSV_LEGACY,
    upgradeRow: fillPendingMailHash,
  });
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
    const safeReason = sanitizePendingReason(reason);
    writePendingEml(raw, cfg.paths.pending, hash);
    appendPendingCsv(
      path.join(cfg.paths.pending, 'pending.csv'),
      {
        messageId: mail.messageId || '',
        date: mail.date?.toISOString() || '',
        from: mail.from?.text || '',
        subject: mail.subject || '',
      },
      safeReason,
      hash,
    );
    return true;
  } catch (err) {
    log.warn(`Pending write failed for ${hash}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * EXT-05 / CORE-03e：超大邮件等无法 parse 的路径写入 durable pending。
 * 必须使用 fetch 时的 fileHash 身份，不得重算成另一把键。
 * 失败抛错，由调用方计 failed 并返回非 0。
 */
export function persistPendingDurable(opts: {
  cfg: Config;
  mailHash: string;
  reason: string;
  raw: Buffer;
  messageId?: string;
  date?: string;
  from?: string;
  subject?: string;
}): void {
  const { cfg, mailHash, raw } = opts;
  const safeReason = sanitizePendingReason(opts.reason);
  writePendingEml(raw, cfg.paths.pending, mailHash);
  const csvPath = path.join(cfg.paths.pending, 'pending.csv');
  ensureDir(path.dirname(csvPath));
  withCsvRetry(() => {
    ensurePendingSchema(csvPath);
    if (pendingCsvContainsHash(csvPath, mailHash)) return;
    const line = [
      mailHash,
      opts.messageId ?? '',
      opts.date ?? '',
      opts.from ?? '',
      opts.subject ?? '',
      safeReason,
    ].map(csvCell).join(',') + '\n';
    appendCsvBlockDurable(csvPath, PENDING_CSV_HEADER, [line]);
  });
  hardenFile(csvPath);
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

/**
 * CORE-08：日志与 pending reason 只保留 protocol + host + 截断 pathname，
 * 删除 query / fragment / userinfo，避免签名 URL 落盘泄露。
 */
export function redactUrlForLog(url: string): string {
  try {
    const u = new URL(url);
    const pathPart = u.pathname.length > 96 ? `${u.pathname.slice(0, 96)}…` : u.pathname;
    return `${u.protocol}//${u.host}${pathPart}`;
  } catch {
    return '[invalid-url]';
  }
}

/** 错误串里若夹带 URL，同样脱敏后再写入日志 / pending。 */
function redactErrorDetail(detail: string): string {
  return detail.replace(/https?:\/\/[^\s"'<>\\]+/gi, (m) => redactUrlForLog(m));
}

/**
 * CORE-08：pending / 日志只保留稳定枚举与脱敏片段，不落签名 URL。
 */
function sanitizePendingReason(reason: string): string {
  const redacted = redactErrorDetail(reason);
  // 压缩过长诊断，避免台账膨胀；保留类型前缀。
  return redacted.length > 400 ? `${redacted.slice(0, 400)}…` : redacted;
}

/**
 * 这些失败与网络抖动无关，重试只会放大伤害/浪费时间，必须原样上抛：
 * - `blocked_url:` SSRF 判定（调用方按前缀区分并降级）
 * - `response_too_large:` 超出 50MB 硬上限
 *
 * CORE-08：上抛前仍须脱敏——signed URL 可能出现在 redirect / invalid 细节里。
 */
function isNonRetryableFetchError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.startsWith('blocked_url:') || msg.startsWith('response_too_large:');
}

/** 把非重试传输错误收成带类型码、已脱敏的 Error。 */
function typedNonRetryableError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.startsWith('blocked_url:')) {
    // 保留 blocked_url:<kind> 前缀；其余 URL/细节脱敏。
    const rest = msg.slice('blocked_url:'.length);
    const kind = rest.split(':')[0] ?? 'unknown';
    const detail = rest.includes(':') ? rest.slice(kind.length + 1) : '';
    const safeDetail = detail ? redactErrorDetail(detail) : '';
    return new Error(safeDetail ? `blocked_url:${kind}:${safeDetail}` : `blocked_url:${kind}`);
  }
  if (msg.startsWith('response_too_large:')) {
    // 仅尺寸信息，无直接保留。
    return new Error(msg);
  }
  return new Error(redactErrorDetail(msg));
}

/** 导出仅用于测试：构造带 per-attempt deadline 与重试的 fetch。 */
export function makeRetryingFetch(cfg: Config, log: Logger): typeof fetch {
  return (async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const attempts = cfg.network.retries + 1;
    const url = requestUrl(input);
    const safeUrl = redactUrlForLog(url);
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
        // WIRE-01 / OCR-01：用 safeFetch 替代裸 fetch——逐跳校验 redirect 并 pin DNS。
        const response = await safeFetch(input as string | URL | Request, attemptInit);
        if (isRetryableStatus(response.status)) {
          lastError = `http_${response.status}`;
          // Drain the discarded error body so undici can release the socket back to
          // the pool instead of leaking a connection on every retry.
          await response.body?.cancel().catch(() => {});
          if (attempt === attempts) {
            throw new Error(`network_retry_failed:${method}:${safeUrl}:${lastError}`);
          }
          log.warn(`network retry ${attempt}/${cfg.network.retries} ${method} ${safeUrl}: ${lastError}`);
        } else {
          // safeFetch 已在每跳发出前校验；body 仍须在同一 attempt 内读完（APP-13）。
          const data = await readCappedBuffer(response);
          return bufferedResponse(response, data);
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('network_retry_failed:')) {
          throw err;
        }
        if (isNonRetryableFetchError(err)) {
          // CORE-08：非重试错误也不得携带签名 URL。
          throw typedNonRetryableError(err);
        }
        // 超时属于可重试失败：header 阶段由 fetch 抛出，body 阶段由
        // readCappedBuffer 转成 `response_timeout:*`，两者现在走同一条重试路径。
        lastError = isTimeoutError(err)
          ? `timeout_${timeoutMs}ms`
          : redactErrorDetail(err instanceof Error ? err.message : String(err));
        if (attempt === attempts) {
          throw new Error(`network_retry_failed:${method}:${safeUrl}:${lastError}`);
        }
        log.warn(`network retry ${attempt}/${cfg.network.retries} ${method} ${safeUrl}: ${lastError}`);
      }

      if (cfg.network.retryDelayMs > 0) {
        await sleep(cfg.network.retryDelayMs * attempt);
      }
    }

    throw new Error(`network_retry_failed:${method}:${safeUrl}:${lastError || 'unknown'}`);
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
  /** `canHandle()` 为真、因而实际运行过的提取器名。 */
  matched: string[];
  /**
   * 判定为“与本邮件无关”的提取器原因。它们只在整封邮件零产出时用于 pending
   * 说明，**绝不**参与部分成功判定：常见的「有效附件 + 退订/隐私政策链接」邮件
   * 不能因为 directLink 找不到 PDF 就整封变成待确认（APP-01）。
   */
  notApplicable: string[];
  /** 返回 `skip` 的提取器数量。 */
  skipped: number;
}

/**
 * EXT-07：跨来源 PDF/OFD 去重只认**强发票身份**（20 位发票号一致）。
 * 文件名相等绝不足以删除另一来源的 OFD——附件 PDF 与站点 OFD 常撞名。
 */
function preferPdfOverStrongIdentityOfd(
  artifacts: PdfArtifact[],
  log: Logger,
  subject?: string,
): PdfArtifact[] {
  const pdfs = artifacts.filter((item) => (item.format ?? 'pdf') === 'pdf');
  const subjectIsItinerary = looksLikeOfdItineraryText(subject);
  const out: PdfArtifact[] = [];

  for (const artifact of artifacts) {
    if (artifact.format !== 'ofd') {
      out.push(artifact);
      continue;
    }

    if (subjectIsItinerary || looksLikeOfdItinerary(artifact)) {
      out.push({ ...artifact, documentType: artifact.documentType ?? 'itinerary', requiresOcr: true });
      continue;
    }

    const ofdNo = invoiceNoKey(artifact);
    if (!ofdNo) {
      // 无强身份：保留 OFD，交给 OCR 后再合并。
      out.push({ ...artifact, documentType: artifact.documentType ?? 'invoice', requiresOcr: true });
      continue;
    }
    const duplicatePdf = pdfs.find((pdf) => {
      const pdfNo = invoiceNoKey(pdf);
      return Boolean(pdfNo && pdfNo === ofdNo);
    });
    if (duplicatePdf) {
      log.debug(`Filtered duplicate OFD invoice ${artifact.source}; keeping PDF ${duplicatePdf.source} (invoiceNo=${ofdNo})`);
      continue;
    }

    out.push({ ...artifact, documentType: artifact.documentType ?? 'invoice', requiresOcr: true });
  }

  return out;
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
  const notApplicable: string[] = [];
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
      // CORE-08：提取器异常可能夹带签名 URL。
      const safeMsg = redactErrorDetail(msg);
      ctx.log.warn(`Extractor ${extractor.name} failed for ${hash}: ${safeMsg}`);
      issues.push({ reason: `${extractor.name}:${safeMsg}`, retryable: safeMsg.includes('network_retry_failed') });
      continue;
    }

    if (result.kind === 'skip') {
      skipped++;
      continue;
    }
    if (result.kind === 'not_applicable') {
      notApplicable.push(result.reason ?? `${extractor.name}:not_applicable`);
      continue;
    }
    if (result.kind === 'manual') {
      const safeReason = sanitizePendingReason(result.reason);
      issues.push({ reason: safeReason, retryable: safeReason.includes('network_retry_failed') });
      continue;
    }

    for (const issue of result.issues ?? []) {
      issues.push({
        ...issue,
        reason: sanitizePendingReason(issue.reason),
      });
    }
    for (const artifact of result.pdfs) {
      const key = contentHashOf(artifact.data);
      if (seen.has(key)) continue;
      seen.add(key);
      artifacts.push(artifact);
    }
  }

  // EXT-07：跨来源仅按强发票号去重；文件名撞名不得删票。
  const deduped = preferPdfOverStrongIdentityOfd(artifacts, ctx.log, mail.subject ?? undefined);
  return { artifacts: deduped, issues, matched, notApplicable, skipped };
}

function summarizeReasons(reasons: string[]): string {
  const head = reasons[0] ?? 'unknown';
  return reasons.length > 1 ? `${head} (+${reasons.length - 1})` : head;
}

function summarizeIssues(issues: ExtractIssue[]): string {
  return summarizeReasons(issues.map((issue) => issue.reason));
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
  const degradeToPending = (reason: string): ProcessMailResult => {
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
  };

  const extraction = await runExtractors(mail, ctx, hash);

  if (extraction.matched.length === 0) {
    log.info(`No extractor matched ${hash}, -> pending`);
    return degradeToPending('no_extractor');
  }
  // 提取器名只进诊断日志，不进面向用户的进度文案（COPY-06）。
  log.info(`Matched extractors: ${extraction.matched.join('+')} for ${hash}`);

  if (extraction.artifacts.length === 0) {
    if (extraction.issues.length > 0) {
      const reason = summarizeIssues(extraction.issues);
      return degradeToPending(reason);
    }
    if (extraction.notApplicable.length > 0) {
      // 没有任何提取器适用，且整封邮件零产出：仍然入待确认，让用户能补票。
      const reason = summarizeReasons(extraction.notApplicable);
      return degradeToPending(reason);
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
    downloadsCount = downloads.length;

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
    tx.commit();
  } catch (err) {
    if (err instanceof ArchiveRecoveryError) throw err;
    // Iron rule: a filesystem / CSV-lock failure during download or archive must
    // NOT abort the run. Degrade this email to the pending queue and continue.
    const errMsg = err instanceof Error ? err.message : String(err);
    const reason = `download_or_csv:${redactErrorDetail(errMsg)}`;
    log.warn(`Archive failed for ${hash}: ${reason}`);
    return degradeToPending(reason);
  }

  // 部分成功：已归档的票必须保留，同时留下可见的待确认记录，不得当作完整成功。
  // partial 可挂在 archived 或 retryable_failure 上：后者表示票已落盘但 pending 未写上。
  if (extraction.issues.length > 0) {
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

  log.info(`Processed ${hash}: ${downloadsCount} documents`);
  commitProcessed(state, hash, () => {});
  saveState();
  return { ...baseResult, outcome: 'archived' };
}
