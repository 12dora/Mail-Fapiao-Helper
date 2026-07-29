import path from 'node:path';
import type { Config } from '../config.js';
import { readCsvRows } from '../util/csv.js';
import { ArtifactIndex, type ArtifactIdentity } from '../util/identity.js';

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
  /** 真正识别失败（error），不含 partial。 */
  failed: number;
  /** 服务返回成功但关键字段缺失（COPY-03：独立计数，不算进 failed）。 */
  partial: number;
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

/** 统一的票据身份（APP-06A）：hash + filename + contentHash，source 仅作回退。 */
function rowIdentity(row: Record<string, string>): ArtifactIdentity {
  return {
    hash: row.hash ?? '',
    filename: row.filename ?? '',
    source: row.source ?? '',
    contentHash: row.contentHash ?? '',
  };
}

function indexResultRows(rows: Record<string, string>[]): ArtifactIndex<Record<string, string>> {
  const index = new ArtifactIndex<Record<string, string>>();
  for (const row of rows) {
    index.set(rowIdentity(row), row, (existing, next) => {
      const existingStatus = (existing.status ?? '').toLowerCase();
      const nextStatus = (next.status ?? '').toLowerCase();
      return !(existingStatus === 'success' && nextStatus !== 'success');
    });
  }
  return index;
}

export function summarizeOcr(cfg: Config, cwd = process.cwd()): OcrSummary {
  const pendingCsv = path.join(path.resolve(cwd, cfg.paths.invoices), 'ocr', 'ocr-pending.csv');
  const resultsCsv = path.resolve(cwd, cfg.ocr.resultsCsv);
  const pendingRows = readCsvRows(pendingCsv);
  const currentResults = indexResultRows(readCsvRows(resultsCsv));
  const resultRows = currentResults.values();
  const byDocumentType = new Map<string, OcrSummaryGroup>();
  const bySupportingReason = new Map<string, OcrSummaryGroup>();
  const byFailureReason = new Map<string, OcrSummaryGroup>();

  let recognized = 0;
  let failed = 0;
  let partial = 0;
  let ignored = 0;
  let pending = 0;

  for (const row of pendingRows) {
    const result = currentResults.get(rowIdentity(row));
    const resultStatus = (result?.status ?? '').toLowerCase();
    // APP-14C：结果 CSV 是权威来源。success/error 分别映射为 recognized/failed，
    // partial 独立计数（COPY-03），不再并进 failed。
    let status = (row.status ?? '').toLowerCase();
    let reason = row.reason ?? '';
    // 主动忽略的支撑材料保持 ignored，不被历史结果行改写。
    if (status !== 'ignored') {
      if (resultStatus === 'success') {
        status = 'recognized';
        reason = '';
      } else if (resultStatus === 'partial') {
        status = 'partial';
        reason = result?.error || reason || 'partial';
      } else if (resultStatus === 'error') {
        status = 'failed';
        reason = result?.error || reason || 'error';
      }
    }
    const documentType = result?.documentType || row.documentType || '';
    const example = exampleFromRow({ ...row, documentType, status }, reason);
    bump(byDocumentType, documentType || 'unknown', example);

    if (status === 'recognized') {
      recognized++;
    } else if (status === 'failed') {
      failed++;
      bump(byFailureReason, compactReason(reason) || 'failed', example);
    } else if (status === 'partial') {
      partial++;
      bump(byFailureReason, compactReason(reason) || 'partial', example);
    } else if (status === 'ignored') {
      ignored++;
      bump(bySupportingReason, reason || 'ignored', example);
    } else {
      pending++;
    }
  }

  if (failed === 0 && partial === 0 && resultRows.length > 0) {
    for (const row of resultRows) {
      const rowStatus = (row.status ?? '').toLowerCase();
      if (rowStatus !== 'error' && rowStatus !== 'partial') continue;
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
      } else if (status === 'partial') {
        partial++;
        bump(byFailureReason, compactReason(row.error ?? '') || 'partial', example);
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
    partial,
    ignored,
    pending,
    byDocumentType: sortedGroups(byDocumentType),
    bySupportingReason: sortedGroups(bySupportingReason),
    byFailureReason: sortedGroups(byFailureReason),
  };
}
