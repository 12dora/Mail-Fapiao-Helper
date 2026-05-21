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
  return value === 'ofd' ? 'ofd' : 'pdf';
}

function asDocumentType(value: string): DocumentType {
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
    index.set(`${row.hash ?? ''}\0${row.source ?? ''}`, {
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

export async function runOcrPending(cfg: Config, log: Logger, opts: { force?: boolean } = {}): Promise<OcrRunSummary> {
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

  for (let i = 0; i < nextRows.length; i++) {
    const row = nextRows[i];
    if (!row) continue;
    const key = `${row.hash}\0${row.source}`;
    if (seenResults.has(key)) {
      const existing = seenResults.get(key);
      if (existing?.status === 'success') {
        row.status = 'recognized';
        row.reason = 'already_in_results';
      } else if (existing?.status === 'error') {
        row.status = 'failed';
        row.reason = existing.error || 'already_failed_in_results';
      }
      summary.skipped++;
      continue;
    }

    const filePath = path.join(cfg.paths.invoices, row.filename);
    if (!fs.existsSync(filePath)) {
      const error = `missing_file:${filePath}`;
      appendResult(resultCsv, row, { status: 'error', fields: {}, error, raw: null });
      row.status = 'failed';
      row.reason = error;
      seenResults.set(key, { status: 'error', error });
      summary.failed++;
      summary.updated++;
      continue;
    }

    try {
      const data = fs.readFileSync(filePath);
      const result = await provider.parse(data, {
        format: row.format,
        documentType: row.documentType,
        filename: row.filename,
      });
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
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      appendResult(resultCsv, row, { status: 'error', fields: {}, error, raw: null });
      seenResults.set(key, { status: 'error', error });
      row.status = 'failed';
      row.reason = error;
      summary.failed++;
      summary.updated++;
      log.warn(`OCR failed ${row.filename}: ${error}`);
    }
  }

  if (nextRows.length > 0) {
    writePendingCsv(pendingCsv, nextRows);
  }

  return summary;
}
