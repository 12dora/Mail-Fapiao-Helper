import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import type { DocumentFormat, DocumentType } from '../extract/types.js';
import type { Logger } from '../log.js';
import { getOcrProvider } from './registry.js';
import type { OcrResult } from './types.js';

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
}

interface ParseJob {
  row: PendingRow;
  key: string;
  data: Buffer;
}

export interface OcrRunSummary {
  scanned: number;
  parsed: number;
  skipped: number;
  failed: number;
  updated: number;
}

function csvCell(v: string): string {
  if (/[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function readCsv(csvPath: string): Record<string, string>[] {
  if (!fs.existsSync(csvPath)) return [];
  const text = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  const header = parseCsvLine(lines[0] ?? '');
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i] ?? '');
    const row: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) {
      const key = header[c];
      if (!key) continue;
      row[key] = cols[c] ?? '';
    }
    rows.push(row);
  }
  return rows;
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
  };
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

interface ResultStatus {
  status: string;
  error: string;
}

function readResultIndex(csvPath: string): Map<string, ResultStatus> {
  const index = new Map<string, ResultStatus>();
  for (const row of readCsv(csvPath)) {
    const key = `${row.hash ?? ''}\0${row.source ?? row.filename ?? ''}`;
    const existing = index.get(key);
    const status = row.status ?? '';
    if (existing?.status === 'success' && status !== 'success') continue;
    index.set(key, {
      status: row.status ?? '',
      error: row.error ?? '',
    });
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
  ].map(csvCell).join(',') + '\n';
}

function writePendingCsv(csvPath: string, rows: PendingRow[]): void {
  ensureDir(path.dirname(csvPath));
  const header = 'hash,messageId,date,from,subject,filename,source,format,documentType,status,reason\n';
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
];

function migrateResultCsvIfNeeded(csvPath: string): void {
  if (!fs.existsSync(csvPath)) return;
  const text = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  const oldHeader = parseCsvLine(lines[0] ?? '');
  if (oldHeader.join('\0') === RESULT_HEADER.join('\0')) return;
  if (!oldHeader.includes('hash') || !oldHeader.includes('status')) return;

  const tmpPath = `${csvPath}.tmp`;
  const out: string[] = ['﻿' + RESULT_HEADER.join(',') + '\n'];
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const cols = parseCsvLine(line);
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

function appendResult(csvPath: string, row: PendingRow, result: OcrResult): void {
  const exists = fs.existsSync(csvPath);
  ensureDir(path.dirname(csvPath));
  const header = RESULT_HEADER.join(',') + '\n';
  if (!exists) {
    fs.writeFileSync(csvPath, '﻿' + header + resultLine(row, result), 'utf8');
  } else {
    migrateResultCsvIfNeeded(csvPath);
    fs.appendFileSync(csvPath, resultLine(row, result), 'utf8');
  }
}

function applyOcrResult(
  resultCsv: string,
  row: PendingRow,
  key: string,
  result: OcrResult,
  seenResults: Map<string, ResultStatus>,
  summary: OcrRunSummary,
  log: Logger,
): void {
  appendResult(resultCsv, row, result);
  seenResults.set(key, { status: result.status, error: result.error });
  if (result.status === 'success') {
    row.status = 'recognized';
    row.reason = '';
    summary.parsed++;
    summary.updated++;
    log.info(`OCR parsed ${row.filename}`);
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
  const rows = readCsv(pendingCsv).map(pendingRow);
  const nextRows = rows.map((row) => ({ ...row }));
  const seenResults = opts.force ? new Map<string, ResultStatus>() : readResultIndex(resultCsv);
  const provider = getOcrProvider(cfg);
  const summary: OcrRunSummary = { scanned: rows.length, parsed: 0, skipped: 0, failed: 0, updated: 0 };
  const batch: ParseJob[] = [];
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));

  function checkpoint(): void {
    if ((opts.singleItem || concurrency > 1) && nextRows.length > 0) writePendingCsv(pendingCsv, nextRows);
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
          const error = `ocr_missing_batch_result:${job.row.filename}`;
          appendResult(resultCsv, job.row, { status: 'error', fields: {}, error, raw: null });
          seenResults.set(job.key, { status: 'error', error });
          job.row.status = 'failed';
          job.row.reason = error;
          summary.failed++;
          summary.updated++;
          log.warn(`OCR failed ${job.row.filename}: ${error}`);
          continue;
        }
        applyOcrResult(resultCsv, job.row, job.key, result, seenResults, summary, log);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      for (const job of jobs) {
        appendResult(resultCsv, job.row, { status: 'error', fields: {}, error, raw: null });
        seenResults.set(job.key, { status: 'error', error });
        job.row.status = 'failed';
        job.row.reason = error;
        summary.failed++;
        summary.updated++;
        log.warn(`OCR failed ${job.row.filename}: ${error}`);
      }
    }
  }

  async function processJob(job: ParseJob): Promise<void> {
    try {
      const result = await provider.parse(job.data, {
        format: job.row.format,
        documentType: job.row.documentType,
        filename: job.row.filename,
      });
      applyOcrResult(resultCsv, job.row, job.key, result, seenResults, summary, log);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      appendResult(resultCsv, job.row, { status: 'error', fields: {}, error, raw: null });
      seenResults.set(job.key, { status: 'error', error });
      job.row.status = 'failed';
      job.row.reason = error;
      summary.failed++;
      summary.updated++;
      log.warn(`OCR failed ${job.row.filename}: ${error}`);
    }
  }

  async function flushConcurrent(jobs: ParseJob[]): Promise<void> {
    if (jobs.length === 0) return;
    const settled = await Promise.allSettled(jobs.map((job) => processJob(job)));
    for (let i = 0; i < settled.length; i++) {
      const item = settled[i];
      const job = jobs[i];
      if (!job || item?.status !== 'rejected') continue;
      const error = item.reason instanceof Error ? item.reason.message : String(item.reason);
      appendResult(resultCsv, job.row, { status: 'error', fields: {}, error, raw: null });
      seenResults.set(job.key, { status: 'error', error });
      job.row.status = 'failed';
      job.row.reason = error;
      summary.failed++;
      summary.updated++;
      log.warn(`OCR failed ${job.row.filename}: ${error}`);
    }
  }

  for (let i = 0; i < nextRows.length; i++) {
    const row = nextRows[i];
    if (!row) continue;
    if (row.status === 'ignored' || row.documentType === 'supporting') {
      row.status = 'ignored';
      row.reason ||= 'supporting_document';
      summary.skipped++;
      checkpoint();
      continue;
    }
    const key = `${row.hash}\0${row.source}`;
    if (seenResults.has(key)) {
      await flushBatch();
      const existing = seenResults.get(key);
      if (existing?.status === 'success') {
        row.status = 'recognized';
        row.reason = 'already_in_results';
      } else if (existing?.status === 'error') {
        row.status = 'failed';
        row.reason = existing.error || 'already_failed_in_results';
      }
      summary.skipped++;
      checkpoint();
      continue;
    }

    const filePath = path.join(cfg.paths.invoices, row.filename);
    if (!fs.existsSync(filePath)) {
      await flushBatch();
      const error = `missing_file:${filePath}`;
      appendResult(resultCsv, row, { status: 'error', fields: {}, error, raw: null });
      row.status = 'failed';
      row.reason = error;
      seenResults.set(key, { status: 'error', error });
      summary.failed++;
      summary.updated++;
      checkpoint();
      continue;
    }

    try {
      const data = fs.readFileSync(filePath);
      batch.push({ row, key, data });
      if (concurrency > 1 && batch.length >= concurrency) {
        const jobs = batch.splice(0, batch.length);
        await flushConcurrent(jobs);
        checkpoint();
      } else if (batch.length >= (opts.singleItem ? 1 : cfg.ocr.batchSize)) {
        await flushBatch();
        checkpoint();
      }
    } catch (err) {
      await flushBatch();
      const error = err instanceof Error ? err.message : String(err);
      appendResult(resultCsv, row, { status: 'error', fields: {}, error, raw: null });
      seenResults.set(key, { status: 'error', error });
      row.status = 'failed';
      row.reason = error;
      summary.failed++;
      summary.updated++;
      log.warn(`OCR failed ${row.filename}: ${error}`);
      checkpoint();
    }
  }
  if (concurrency > 1 && batch.length > 0) {
    const jobs = batch.splice(0, batch.length);
    await flushConcurrent(jobs);
  }
  await flushBatch();
  checkpoint();

  if (nextRows.length > 0) {
    writePendingCsv(pendingCsv, nextRows);
  }

  return summary;
}
