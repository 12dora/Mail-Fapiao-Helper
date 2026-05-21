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

function readResultKeys(csvPath: string): Set<string> {
  const keys = new Set<string>();
  for (const row of readCsv(csvPath)) {
    keys.add(`${row.hash ?? ''}\0${row.source ?? ''}`);
  }
  return keys;
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
    result.status,
    result.error,
  ].map(csvCell).join(',') + '\n';
}

function appendResult(csvPath: string, row: PendingRow, result: OcrResult): void {
  const exists = fs.existsSync(csvPath);
  ensureDir(path.dirname(csvPath));
  const header = 'hash,messageId,date,from,subject,filename,source,format,documentType,invoiceType,seller,amount,dateValue,invoiceNo,status,error\n';
  if (!exists) {
    fs.writeFileSync(csvPath, '﻿' + header + resultLine(row, result), 'utf8');
  } else {
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
  const seenResults = opts.force ? new Set<string>() : readResultKeys(resultCsv);
  const provider = getOcrProvider(cfg);
  const summary: OcrRunSummary = { scanned: rows.length, parsed: 0, skipped: 0, failed: 0 };

  for (const row of rows) {
    const key = `${row.hash}\0${row.source}`;
    if (seenResults.has(key)) {
      summary.skipped++;
      continue;
    }

    const filePath = path.join(cfg.paths.invoices, row.filename);
    if (!fs.existsSync(filePath)) {
      appendResult(resultCsv, row, { status: 'error', fields: {}, error: `missing_file:${filePath}`, raw: null });
      summary.failed++;
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
      seenResults.add(key);
      if (result.status === 'success') {
        summary.parsed++;
        log.info(`OCR parsed ${row.filename}`);
      } else {
        summary.failed++;
        log.warn(`OCR failed ${row.filename}: ${result.error}`);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      appendResult(resultCsv, row, { status: 'error', fields: {}, error, raw: null });
      seenResults.add(key);
      summary.failed++;
      log.warn(`OCR failed ${row.filename}: ${error}`);
    }
  }

  return summary;
}
