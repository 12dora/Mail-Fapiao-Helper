import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../log.js';
import { csvCell, ensureCsvSchema } from '../util/csv.js';
import { ensureSecureDir } from '../download/downloader.js';
import {
  appendCsvBlockDurable,
  assertArchiveTransactionsRecovered,
} from '../download/archiveJournal.js';

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

// CORE-03：mailHash 显式列；升级路径见 ensure*Schema 的 upgradeFrom。
export const INVOICE_CSV_HEADER = 'messageId,date,from,subject,filename,source,contentHash,mailHash\n';
export const INVOICE_CSV_LEGACY = [
  'messageId,date,from,subject,filename,source,contentHash',
  'messageId,date,from,subject,filename,source',
];
export const OCR_CSV_HEADER = 'hash,messageId,date,from,subject,filename,source,format,documentType,status,reason,contentHash\n';
export const OCR_CSV_LEGACY = [
  'hash,messageId,date,from,subject,filename,source,format,documentType,status,reason',
];
export const PENDING_CSV_HEADER = 'mailHash,messageId,date,from,subject,reason\n';
export const PENDING_CSV_LEGACY = [
  'messageId,date,from,subject,reason',
];

export function ensureDir(dir: string): void {
  ensureSecureDir(dir);
}

/** POSIX 下把敏感文件收紧到 0600；Windows 上 chmod 语义不同，直接跳过（APP-22）。 */
export function hardenFile(target: string): void {
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
export function withCsvRetry(fn: () => void): void {
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
export function appendCsvBlock(
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
export function csvLength(csvPath: string): number {
  try {
    return fs.statSync(csvPath).size;
  } catch {
    return 0;
  }
}

export function recoverArchiveTransactionsOnce(invoicesDir: string, log: Logger): void {
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
export function assertWritableDir(dir: string): void {
  ensureDir(dir);
  fs.accessSync(dir, fs.constants.W_OK);
}

/** 预校验：CSV 可追加（不存在时校验其父目录可写）。 */
export function assertAppendableCsv(csvPath: string): void {
  ensureDir(path.dirname(csvPath));
  if (fs.existsSync(csvPath)) {
    const fd = fs.openSync(csvPath, 'a');
    fs.closeSync(fd);
    return;
  }
  fs.accessSync(path.dirname(csvPath), fs.constants.W_OK);
}

export function invoiceCsvLine(row: CsvRow): string {
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

export function ocrCsvLine(row: OcrPendingRow): string {
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
