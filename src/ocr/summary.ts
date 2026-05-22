import path from 'node:path';
import type { Config } from '../config.js';
import { readCsvRows } from '../util/csv.js';

export interface OcrSummaryExample {
  hash: string;
  date: string;
  from: string;
  subject: string;
  filename: string;
  format: string;
  documentType: string;
  status: string;
  reason: string;
}

export interface OcrSummaryGroup {
  key: string;
  count: number;
  examples: OcrSummaryExample[];
}

export interface OcrSummary {
  pendingCsv: string;
  resultsCsv: string;
  total: number;
  recognized: number;
  failed: number;
  ignored: number;
  pending: number;
  byDocumentType: OcrSummaryGroup[];
  bySupportingReason: OcrSummaryGroup[];
  byFailureReason: OcrSummaryGroup[];
}

function exampleFromRow(row: Record<string, string>, reason: string): OcrSummaryExample {
  return {
    hash: row.hash ?? '',
    date: row.date ?? '',
    from: row.from ?? '',
    subject: row.subject ?? '',
    filename: row.filename ?? '',
    format: row.format ?? '',
    documentType: row.documentType ?? '',
    status: row.status ?? '',
    reason,
  };
}

function bump(map: Map<string, OcrSummaryGroup>, key: string, example: OcrSummaryExample): void {
  const normalized = key || 'unknown';
  const group = map.get(normalized);
  if (group) {
    group.count++;
    if (group.examples.length < 5) group.examples.push(example);
  } else {
    map.set(normalized, { key: normalized, count: 1, examples: [example] });
  }
}

function sortedGroups(map: Map<string, OcrSummaryGroup>): OcrSummaryGroup[] {
  return Array.from(map.values()).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function compactReason(reason: string): string {
  if (!reason) return '';
  const colon = reason.indexOf(':');
  if (colon > 0) return reason.slice(0, colon);
  return reason;
}

function resultKey(row: Record<string, string>): string {
  const hash = row.hash ?? '';
  const source = row.source ?? row.filename ?? '';
  if (!hash) return `filename\0${row.filename ?? source}`;
  return `${hash}\0${source}`;
}

function currentResultRows(rows: Record<string, string>[]): Record<string, string>[] {
  const index = new Map<string, Record<string, string>>();
  for (const row of rows) {
    const key = resultKey(row);
    const existing = index.get(key);
    const status = (row.status ?? '').toLowerCase();
    const existingStatus = (existing?.status ?? '').toLowerCase();
    if (existing && existingStatus === 'success' && status !== 'success') continue;
    index.set(key, row);
  }
  return Array.from(index.values());
}

export function summarizeOcr(cfg: Config, cwd = process.cwd()): OcrSummary {
  const pendingCsv = path.join(path.resolve(cwd, cfg.paths.invoices), 'ocr', 'ocr-pending.csv');
  const resultsCsv = path.resolve(cwd, cfg.ocr.resultsCsv);
  const pendingRows = readCsvRows(pendingCsv);
  const resultRows = currentResultRows(readCsvRows(resultsCsv));
  const currentResults = new Map(resultRows.map((row) => [resultKey(row), row]));
  const currentResultsByFilename = new Map(resultRows.map((row) => [row.filename ?? '', row]));
  const byDocumentType = new Map<string, OcrSummaryGroup>();
  const bySupportingReason = new Map<string, OcrSummaryGroup>();
  const byFailureReason = new Map<string, OcrSummaryGroup>();

  let recognized = 0;
  let failed = 0;
  let ignored = 0;
  let pending = 0;

  for (const row of pendingRows) {
    const result = currentResults.get(resultKey(row)) || currentResultsByFilename.get(row.filename ?? '');
    const resultStatus = (result?.status ?? '').toLowerCase();
    const status = resultStatus === 'success' ? 'recognized' : (row.status ?? '').toLowerCase();
    const documentType = result?.documentType || row.documentType || '';
    const reason = resultStatus === 'success' ? '' : (row.reason ?? '');
    const example = exampleFromRow({ ...row, documentType, status }, reason);
    bump(byDocumentType, documentType || 'unknown', example);

    if (status === 'recognized') {
      recognized++;
    } else if (status === 'failed') {
      failed++;
      bump(byFailureReason, compactReason(reason) || 'failed', example);
    } else if (status === 'ignored') {
      ignored++;
      bump(bySupportingReason, reason || 'ignored', example);
    } else {
      pending++;
    }
  }

  if (failed === 0 && resultRows.length > 0) {
    for (const row of resultRows) {
      if ((row.status ?? '').toLowerCase() !== 'error') continue;
      bump(byFailureReason, compactReason(row.error ?? '') || 'error', exampleFromRow(row, row.error ?? ''));
    }
  }

  if (pendingRows.length === 0 && resultRows.length > 0) {
    for (const row of resultRows) {
      const status = (row.status ?? '').toLowerCase();
      const documentType = row.documentType || 'invoice';
      const example = exampleFromRow(row, row.error ?? '');
      bump(byDocumentType, documentType, example);
      if (status === 'error') {
        failed++;
        bump(byFailureReason, compactReason(row.error ?? '') || 'error', example);
      } else {
        recognized++;
      }
    }
  }

  return {
    pendingCsv,
    resultsCsv,
    total: pendingRows.length || resultRows.length,
    recognized,
    failed,
    ignored,
    pending,
    byDocumentType: sortedGroups(byDocumentType),
    bySupportingReason: sortedGroups(bySupportingReason),
    byFailureReason: sortedGroups(byFailureReason),
  };
}
