import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import { csvCell, readCsvRows } from '../util/csv.js';

export interface OcrResultRow {
  hash: string;
  messageId: string;
  date: string;
  from: string;
  subject: string;
  filename: string;
  source: string;
  format: string;
  documentType: string;
  invoiceType: string;
  seller: string;
  amount: string;
  invoiceNo: string;
  status: string;
  error: string;
}

export interface OrganizeSummary {
  scanned: number;
  copied: number;
  skipped: number;
  failed: number;
}

function resultRow(raw: Record<string, string>): OcrResultRow {
  return {
    hash: raw.hash ?? '',
    messageId: raw.messageId ?? '',
    date: raw.dateValue ?? raw.date ?? '',
    from: raw.from ?? '',
    subject: raw.subject ?? '',
    filename: raw.filename ?? '',
    source: raw.source ?? '',
    format: raw.format ?? '',
    documentType: raw.documentType ?? '',
    invoiceType: raw.invoiceType ?? '',
    seller: raw.seller ?? '',
    amount: raw.amount ?? '',
    invoiceNo: raw.invoiceNo ?? '',
    status: raw.status ?? '',
    error: raw.error ?? '',
  };
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function safePathSegment(value: string, fallback: string): string {
  const base = path.basename(value)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (base === '.' || base === '..') return fallback;
  return base.length > 0 ? base : fallback;
}

function safeRelativeDir(value: string): string {
  const parts = value
    .split(/[\\/]+/)
    .map((part) => safePathSegment(part, 'unknown'))
    .filter((part) => part.length > 0 && part !== '.' && part !== '..');
  return parts.length > 0 ? path.join(...parts) : 'unknown';
}

function extFor(row: OcrResultRow): string {
  const filenameExt = path.extname(row.filename);
  if (filenameExt) return filenameExt;
  if (row.format.toLowerCase() === 'ofd') return '.ofd';
  return '.pdf';
}

function templateValues(row: OcrResultRow): Record<string, string> {
  return {
    hash: row.hash,
    messageId: row.messageId,
    date: row.date,
    from: row.from,
    subject: row.subject,
    filename: row.filename,
    source: row.source,
    format: row.format,
    documentType: row.documentType,
    invoiceType: row.invoiceType,
    seller: row.seller,
    amount: row.amount,
    invoiceNo: row.invoiceNo,
    status: row.status,
    error: row.error,
  };
}

function renderTemplate(template: string, row: OcrResultRow): { value: string; complete: boolean } {
  const values = templateValues(row);
  let complete = true;
  const value = template.replace(/\{([A-Za-z0-9_]+)\}/g, (_all, key: string) => {
    const v = values[key] ?? '';
    if (v.length === 0) complete = false;
    return v;
  });
  return { value, complete };
}

function renderFilename(row: OcrResultRow, cfg: Config): string {
  const rule = renderTemplate(cfg.rename.rule, row);
  const rendered = rule.complete ? rule.value : renderTemplate(cfg.rename.fallback, row).value;
  const ext = extFor(row);
  const withExt = path.extname(rendered).length > 0 ? rendered : `${rendered}${ext}`;
  return safePathSegment(withExt, safePathSegment(row.filename || `${row.hash || 'document'}${ext}`, `document${ext}`));
}

function renderTargetDir(row: OcrResultRow, cfg: Config, organizedDir: string): string {
  if (!cfg.rename.organizeByType) return organizedDir;
  const rendered = renderTemplate(cfg.rename.typeDirRule, row).value;
  return path.join(organizedDir, safeRelativeDir(rendered));
}

function resolveConflict(targetPath: string): string {
  if (!fs.existsSync(targetPath)) return targetPath;
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  let counter = 1;
  while (true) {
    const candidate = path.join(dir, `${base}-${counter}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
    counter++;
  }
}

function sameFileContent(left: string, right: string): boolean {
  const leftStat = fs.statSync(left);
  const rightStat = fs.statSync(right);
  if (leftStat.size !== rightStat.size) return false;
  return fs.readFileSync(left).equals(fs.readFileSync(right));
}

function copyFileConflictSafe(src: string, dest: string): { finalPath: string; copied: boolean; reason: string } {
  ensureDir(path.dirname(dest));
  if (fs.existsSync(dest) && sameFileContent(src, dest)) {
    return { finalPath: dest, copied: false, reason: 'already_exists_same_content' };
  }
  const finalPath = resolveConflict(dest);
  fs.copyFileSync(src, finalPath, fs.constants.COPYFILE_EXCL);
  return { finalPath, copied: true, reason: '' };
}

function resultIsUsable(row: OcrResultRow): boolean {
  const status = row.status.toLowerCase();
  return status === '' || status === 'success' || status === 'ok' || status === 'recognized';
}

export function readOcrResults(csvPath: string): OcrResultRow[] {
  const index = new Map<string, OcrResultRow>();
  for (const row of readCsvRows(csvPath).map(resultRow)) {
    const key = `${row.hash}\0${row.source || row.filename}`;
    const existing = index.get(key);
    const status = row.status.toLowerCase();
    const existingStatus = existing?.status.toLowerCase() ?? '';
    if (existing && existingStatus === 'success' && status !== 'success') continue;
    index.set(key, row);
  }
  return Array.from(index.values());
}

export function writeOrganizeAudit(csvPath: string, row: OcrResultRow, outputPath: string, status: string, reason: string): void {
  const exists = fs.existsSync(csvPath);
  ensureDir(path.dirname(csvPath));
  const header = 'hash,messageId,filename,source,outputPath,status,reason\n';
  const line = [
    row.hash,
    row.messageId,
    row.filename,
    row.source,
    outputPath,
    status,
    reason,
  ].map(csvCell).join(',') + '\n';
  if (!exists) {
    fs.writeFileSync(csvPath, '﻿' + header + line, 'utf8');
  } else {
    fs.appendFileSync(csvPath, line, 'utf8');
  }
}

export function organizeFromOcrResults(cfg: Config, log: Logger, opts: { resultsCsv?: string; outDir?: string } = {}): OrganizeSummary {
  const resultsCsv = path.resolve(opts.resultsCsv ?? cfg.ocr.resultsCsv);
  const invoicesDir = path.resolve(cfg.paths.invoices);
  const organizedDir = path.resolve(opts.outDir ?? cfg.rename.organizedDir);
  const auditCsv = path.join(organizedDir, 'organize-results.csv');
  const rows = readOcrResults(resultsCsv);
  const summary: OrganizeSummary = { scanned: rows.length, copied: 0, skipped: 0, failed: 0 };

  if (rows.length === 0) {
    log.warn(`No OCR result rows found: ${resultsCsv}`);
    return summary;
  }

  for (const row of rows) {
    if (!resultIsUsable(row)) {
      summary.skipped++;
      writeOrganizeAudit(auditCsv, row, '', 'skipped', row.error || `status=${row.status}`);
      continue;
    }

    if (row.filename.length === 0) {
      summary.failed++;
      writeOrganizeAudit(auditCsv, row, '', 'failed', 'missing_filename');
      continue;
    }

    const src = path.join(invoicesDir, row.filename);
    if (!fs.existsSync(src)) {
      summary.failed++;
      writeOrganizeAudit(auditCsv, row, '', 'failed', `missing_source:${src}`);
      continue;
    }

    try {
      const filename = cfg.rename.applyAfterOcr ? renderFilename(row, cfg) : safePathSegment(row.filename, 'document.pdf');
      const targetDir = renderTargetDir(row, cfg, organizedDir);
      const result = copyFileConflictSafe(src, path.join(targetDir, filename));
      if (result.copied) {
        summary.copied++;
        writeOrganizeAudit(auditCsv, row, result.finalPath, 'copied', '');
        log.info(`organized ${row.filename} -> ${result.finalPath}`);
      } else {
        summary.skipped++;
        writeOrganizeAudit(auditCsv, row, result.finalPath, 'skipped', result.reason);
        log.info(`organized skip ${row.filename}: ${result.reason}`);
      }
    } catch (err) {
      summary.failed++;
      const reason = err instanceof Error ? err.message : String(err);
      writeOrganizeAudit(auditCsv, row, '', 'failed', reason);
      log.warn(`organize failed for ${row.filename}: ${reason}`);
    }
  }

  return summary;
}
