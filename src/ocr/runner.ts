import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import type { DocumentFormat, DocumentType } from '../extract/types.js';
import type { Logger } from '../log.js';
import { getOcrProvider } from './registry.js';
import type { OcrResult } from './types.js';
import { csvCell, parseCsv, readCsvRows } from '../util/csv.js';
import { contentHash as hashBytes } from '../util/hash.js';
import { ArtifactIndex, type ArtifactIdentity } from '../util/identity.js';

interface PendingRow {
  hash: string;
  messageId: string;
  date: string;
  from: string;
  subject: string;
  filename: string;
  source: string;
  format: DocumentFormat;
  documentType: DocumentType;
  status: string;
  reason: string;
  contentHash: string;
}

interface ParseJob {
  row: PendingRow;
  data: Buffer;
}

export interface OcrRunSummary {
  scanned: number;
  parsed: number;
  skipped: number;
  failed: number;
  updated: number;
}

function asFormat(value: string): DocumentFormat {
  if (value === 'image') return 'image';
  return value === 'ofd' ? 'ofd' : 'pdf';
}

function asDocumentType(value: string): DocumentType {
  if (value === 'supporting') return 'supporting';
  return value === 'itinerary' ? 'itinerary' : 'invoice';
}

function pendingRow(raw: Record<string, string>): PendingRow {
  return {
    hash: raw.hash ?? '',
    messageId: raw.messageId ?? '',
    date: raw.date ?? '',
    from: raw.from ?? '',
    subject: raw.subject ?? '',
    filename: raw.filename ?? '',
    source: raw.source ?? '',
    format: asFormat(raw.format ?? ''),
    documentType: asDocumentType(raw.documentType ?? ''),
    status: raw.status ?? '',
    reason: raw.reason ?? '',
    contentHash: raw.contentHash ?? '',
  };
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

interface ResultStatus {
  status: string;
  error: string;
}

/** 待处理行的统一身份（APP-06A）：hash + filename + contentHash。 */
function rowIdentity(row: PendingRow): ArtifactIdentity {
  return {
    hash: row.hash,
    filename: row.filename,
    source: row.source,
    contentHash: row.contentHash,
  };
}

/** 已有 success 结果不被后续 error 覆盖。 */
function keepSuccess(existing: ResultStatus, next: ResultStatus): boolean {
  return !(existing.status === 'success' && next.status !== 'success');
}

function readResultIndex(csvPath: string): ArtifactIndex<ResultStatus> {
  const index = new ArtifactIndex<ResultStatus>();
  for (const row of readCsvRows(csvPath)) {
    // 用统一身份键索引：同一封邮件里两个同名文档不会互相折叠，
    // 没有 contentHash 的历史结果行也仍然能被匹配上。
    index.set({
      hash: row.hash ?? '',
      filename: row.filename ?? '',
      source: row.source ?? '',
      contentHash: row.contentHash ?? '',
    }, {
      status: row.status ?? '',
      error: row.error ?? '',
    }, keepSuccess);
  }
  return index;
}

function pendingLine(row: PendingRow): string {
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

function writePendingCsv(csvPath: string, rows: PendingRow[]): void {
  ensureDir(path.dirname(csvPath));
  const header = 'hash,messageId,date,from,subject,filename,source,format,documentType,status,reason,contentHash\n';
  const tmpPath = `${csvPath}.tmp`;
  fs.writeFileSync(tmpPath, '﻿' + header + rows.map(pendingLine).join(''), 'utf8');
  fs.renameSync(tmpPath, csvPath);
}

function resultLine(row: PendingRow, result: OcrResult): string {
  const fields = result.fields;
  return [
    row.hash,
    row.messageId,
    row.date,
    row.from,
    row.subject,
    row.filename,
    row.source,
    row.format,
    fields.documentType ?? row.documentType,
    fields.invoiceType ?? '',
    fields.seller ?? '',
    fields.amount ?? '',
    fields.date ?? '',
    fields.invoiceNo ?? '',
    result.transport ?? '',
    result.source?.extractedBy ?? '',
    result.source?.parserVersion ?? '',
    result.source?.ocrVendor ?? '',
    result.status,
    result.error,
    // 结果行继续携带 contentHash，供摘要/整理做身份校验（APP-06B）。
    row.contentHash,
  ].map(csvCell).join(',') + '\n';
}

const RESULT_HEADER = [
  'hash',
  'messageId',
  'date',
  'from',
  'subject',
  'filename',
  'source',
  'format',
  'documentType',
  'invoiceType',
  'seller',
  'amount',
  'dateValue',
  'invoiceNo',
  'transport',
  'extractedBy',
  'parserVersion',
  'ocrVendor',
  'status',
  'error',
  'contentHash',
];

function migrateResultCsvIfNeeded(csvPath: string): void {
  if (!fs.existsSync(csvPath)) return;
  const text = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  // Quote-aware parse: a cell whose quoted value contains an embedded newline
  // (e.g. a seller/subject/error string) would otherwise be shredded by a naive
  // newline split, corrupting every row after it in the migrated CSV.
  const records = parseCsv(text);
  const oldHeader = records[0] ?? [];
  if (oldHeader.join('\0') === RESULT_HEADER.join('\0')) return;
  if (!oldHeader.includes('hash') || !oldHeader.includes('status')) return;

  const tmpPath = `${csvPath}.tmp`;
  const out: string[] = ['﻿' + RESULT_HEADER.join(',') + '\n'];
  for (let r = 1; r < records.length; r++) {
    const cols = records[r] ?? [];
    const raw: Record<string, string> = {};
    for (let i = 0; i < oldHeader.length; i++) {
      const key = oldHeader[i];
      if (!key) continue;
      raw[key] = cols[i] ?? '';
    }
    out.push(RESULT_HEADER.map((key) => csvCell(raw[key] ?? '')).join(',') + '\n');
  }
  fs.writeFileSync(tmpPath, out.join(''), 'utf8');
  fs.renameSync(tmpPath, csvPath);
}

/**
 * 命令开始时只迁移/验证 results CSV 一次；后续 append 不再整表重读（OCR-13）。
 * 返回 true 表示调用方已确保 header 就绪，可直接 append。
 */
function ensureResultCsvReady(csvPath: string): void {
  ensureDir(path.dirname(csvPath));
  if (!fs.existsSync(csvPath)) {
    const header = RESULT_HEADER.join(',') + '\n';
    fs.writeFileSync(csvPath, '\uFEFF' + header, 'utf8');
    return;
  }
  migrateResultCsvIfNeeded(csvPath);
}

function appendResult(csvPath: string, row: PendingRow, result: OcrResult): void {
  // 假定 runOcrPending 已在循环前调用 ensureResultCsvReady。
  fs.appendFileSync(csvPath, resultLine(row, result), 'utf8');
}

/**
 * 校验归档字节是否仍与 pending 行记录的 contentHash 一致（APP-06B）。
 * 通过返回空字符串，否则返回 `content_hash_mismatch:...` 原因。
 * 历史行没有 contentHash 时无从比对，只能放行（仍会校验读取期间大小未变）。
 */
function verifyArchivedBytes(row: PendingRow, filePath: string, data: Buffer): string {
  const size = fs.statSync(filePath).size;
  if (size !== data.length) {
    return `content_hash_mismatch:size_changed:${row.filename}:stat=${size}:read=${data.length}`;
  }
  if (!row.contentHash) return '';
  const actual = hashBytes(data);
  if (actual === row.contentHash) return '';
  return `content_hash_mismatch:${row.filename}:expected=${row.contentHash}:actual=${actual}:bytes=${size}`;
}

function applyOcrResult(
  resultCsv: string,
  row: PendingRow,
  result: OcrResult,
  seenResults: ArtifactIndex<ResultStatus>,
  summary: OcrRunSummary,
  log: Logger,
): void {
  appendResult(resultCsv, row, result);
  seenResults.set(rowIdentity(row), { status: result.status, error: result.error }, keepSuccess);
  if (result.status === 'success') {
    row.status = 'recognized';
    row.reason = '';
    summary.parsed++;
    summary.updated++;
    log.info(`OCR parsed ${row.filename}`);
  } else if (result.status === 'partial') {
    // 结构为空/字段不全：保留为待补充，等待人工复核，不计入已识别（APP-14B）。
    row.status = 'partial';
    row.reason = result.error;
    summary.failed++;
    summary.updated++;
    log.warn(`OCR partial ${row.filename}: ${result.error}`);
  } else {
    row.status = 'failed';
    row.reason = result.error;
    summary.failed++;
    summary.updated++;
    log.warn(`OCR failed ${row.filename}: ${result.error}`);
  }
}

export async function runOcrPending(
  cfg: Config,
  log: Logger,
  opts: { force?: boolean; singleItem?: boolean; concurrency?: number } = {},
): Promise<OcrRunSummary> {
  if (!cfg.ocr.enabled) {
    throw new Error('config.ocr.enabled=false; set it to true to run OCR');
  }

  const pendingCsv = path.join(cfg.paths.invoices, 'ocr', 'ocr-pending.csv');
  const resultCsv = cfg.ocr.resultsCsv;
  // 整次 run 只迁移/准备 results CSV 一次，避免每个结果 O(N) 重读（OCR-13）。
  ensureResultCsvReady(resultCsv);
  const rows = readCsvRows(pendingCsv).map(pendingRow);
  const nextRows = rows.map((row) => ({ ...row }));
  const seenResults = opts.force ? new ArtifactIndex<ResultStatus>() : readResultIndex(resultCsv);
  const provider = getOcrProvider(cfg);
  const summary: OcrRunSummary = { scanned: rows.length, parsed: 0, skipped: 0, failed: 0, updated: 0 };
  const batch: ParseJob[] = [];
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
  /**
   * OCR-13 务实改进（单次 run 内去二次方）：
   * - 跳过/状态对齐只标脏，不在循环中反复整表重写；
   * - 全表 checkpoint 仅发生在：每个 OCR 批次边界、致命/失败落盘点、run 结束；
   * - 不引入跨进程 append-only journal（那是更大的持久化 redesign，超出 P2 范围）。
   * 崩溃时未 checkpoint 的 skip 状态会在下次 run 重算，不丢 OCR 结果（results 仍逐条 append）。
   */
  let pendingDirty = false;

  function checkpoint(): void {
    if (!pendingDirty || nextRows.length === 0) return;
    writePendingCsv(pendingCsv, nextRows);
    pendingDirty = false;
  }

  /** 只有真的改了状态/原因才标脏，避免对没有变化的行反复重写 CSV。 */
  function markRow(row: PendingRow, status: string, reason: string): void {
    if (row.status === status && row.reason === reason) return;
    row.status = status;
    row.reason = reason;
    pendingDirty = true;
  }

  function record(row: PendingRow, result: OcrResult): void {
    applyOcrResult(resultCsv, row, result, seenResults, summary, log);
    pendingDirty = true;
  }

  function recordFailure(row: PendingRow, error: string): void {
    record(row, { status: 'error', fields: {}, error, raw: null });
  }

  async function flushBatch(): Promise<void> {
    if (batch.length === 0) return;
    const jobs = batch.splice(0, batch.length);
    try {
      const results = provider.parseBatch && !opts.singleItem
        ? await provider.parseBatch(jobs.map((job) => ({
            data: job.data,
            meta: {
              format: job.row.format,
              documentType: job.row.documentType,
              filename: job.row.filename,
            },
          })))
        : await Promise.all(jobs.map((job) => provider.parse(job.data, {
            format: job.row.format,
            documentType: job.row.documentType,
            filename: job.row.filename,
          })));
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        const result = results[i];
        if (!job) continue;
        if (!result) {
          recordFailure(job.row, `ocr_missing_batch_result:${job.row.filename}`);
          continue;
        }
        record(job.row, result);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      for (const job of jobs) recordFailure(job.row, error);
    }
    // 解析批次结束后强制落盘 pending（APP-14C）。
    checkpoint();
  }

  async function processJob(job: ParseJob): Promise<void> {
    try {
      const result = await provider.parse(job.data, {
        format: job.row.format,
        documentType: job.row.documentType,
        filename: job.row.filename,
      });
      record(job.row, result);
    } catch (err) {
      recordFailure(job.row, err instanceof Error ? err.message : String(err));
    }
  }

  async function flushConcurrent(jobs: ParseJob[]): Promise<void> {
    if (jobs.length === 0) return;
    const settled = await Promise.allSettled(jobs.map((job) => processJob(job)));
    for (let i = 0; i < settled.length; i++) {
      const item = settled[i];
      const job = jobs[i];
      if (!job || item?.status !== 'rejected') continue;
      recordFailure(job.row, item.reason instanceof Error ? item.reason.message : String(item.reason));
    }
    checkpoint();
  }

  for (let i = 0; i < nextRows.length; i++) {
    const row = nextRows[i];
    if (!row) continue;
    if (row.status === 'ignored' || row.documentType === 'supporting') {
      markRow(row, 'ignored', row.reason || 'supporting_document');
      summary.skipped++;
      continue;
    }
    const identity = rowIdentity(row);
    if (seenResults.has(identity)) {
      await flushBatch();
      const existing = seenResults.get(identity);
      if (existing?.status === 'success') {
        markRow(row, 'recognized', 'already_in_results');
      } else if (existing?.status === 'partial') {
        markRow(row, 'partial', existing.error || 'already_partial_in_results');
      } else if (existing?.status === 'error') {
        markRow(row, 'failed', existing.error || 'already_failed_in_results');
      }
      summary.skipped++;
      continue;
    }

    const filePath = path.join(cfg.paths.invoices, row.filename);
    if (!fs.existsSync(filePath)) {
      await flushBatch();
      recordFailure(row, `missing_file:${filePath}`);
      checkpoint();
      continue;
    }

    try {
      const data = fs.readFileSync(filePath);
      // APP-06B：识别前用与归档相同的算法重算内容指纹与大小。文件被替换、
      // 编号复用或 pending 指向了别的文件时，继续识别会把票 B 的字段写在票 A 的身份下。
      const mismatch = verifyArchivedBytes(row, filePath, data);
      if (mismatch) {
        await flushBatch();
        recordFailure(row, mismatch);
        checkpoint();
        continue;
      }
      // 显式迁移（APP-06A）：老 pending 行没有 contentHash，用刚读到的归档字节补齐，
      // 让它升级成强身份行；补不出来的行保持独立，不参与任何折叠。
      if (!row.contentHash) {
        row.contentHash = hashBytes(data);
        pendingDirty = true;
      }
      batch.push({ row, data });
      if (concurrency > 1 && batch.length >= concurrency) {
        const jobs = batch.splice(0, batch.length);
        await flushConcurrent(jobs);
      } else if (batch.length >= (opts.singleItem ? 1 : cfg.ocr.batchSize)) {
        await flushBatch();
      }
    } catch (err) {
      await flushBatch();
      recordFailure(row, err instanceof Error ? err.message : String(err));
      checkpoint();
    }
  }
  if (concurrency > 1 && batch.length > 0) {
    const jobs = batch.splice(0, batch.length);
    await flushConcurrent(jobs);
  }
  await flushBatch();
  // 收尾：整次 run 最多再整表写一次（含 skip 标脏），O(N) 有界（OCR-13）。
  if (nextRows.length > 0) {
    writePendingCsv(pendingCsv, nextRows);
    pendingDirty = false;
  }

  return summary;
}
