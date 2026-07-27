import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import { csvCell, readCsvRows } from '../util/csv.js';
import { ArtifactIndex, type ArtifactIdentity } from '../util/identity.js';

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
  contentHash: string;
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
    contentHash: raw.contentHash ?? '',
  };
}

/** 统一的票据身份（APP-06A）：hash + filename + contentHash，source 仅作回退。 */
function rowIdentity(row: OcrResultRow): ArtifactIdentity {
  return {
    hash: row.hash,
    filename: row.filename,
    source: row.source,
    contentHash: row.contentHash,
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

function sameFileContent(left: string, right: string): boolean {
  const leftStat = fs.statSync(left);
  const rightStat = fs.statSync(right);
  if (leftStat.size !== rightStat.size) return false;
  return fs.readFileSync(left).equals(fs.readFileSync(right));
}

function copyFileConflictSafe(src: string, dest: string): { finalPath: string; copied: boolean; reason: string } {
  ensureDir(path.dirname(dest));
  const dir = path.dirname(dest);
  const ext = path.extname(dest);
  const base = path.basename(dest, ext);
  // Walk dest, dest-1, dest-2 … : copy into the first free slot, but if any
  // existing variant already holds this exact content, treat it as
  // already-organized. Otherwise two distinct documents that render to the same
  // name would spawn a brand-new -N duplicate on every re-run.
  for (let counter = 0; ; counter++) {
    const candidate = counter === 0 ? dest : path.join(dir, `${base}-${counter}${ext}`);
    if (!fs.existsSync(candidate)) {
      fs.copyFileSync(src, candidate, fs.constants.COPYFILE_EXCL);
      return { finalPath: candidate, copied: true, reason: '' };
    }
    if (sameFileContent(src, candidate)) {
      return { finalPath: candidate, copied: false, reason: 'already_exists_same_content' };
    }
  }
}

function resultIsUsable(row: OcrResultRow): boolean {
  const status = row.status.toLowerCase();
  return status === '' || status === 'success' || status === 'ok' || status === 'recognized';
}

export function readOcrResults(csvPath: string): OcrResultRow[] {
  const index = new ArtifactIndex<OcrResultRow>();
  for (const row of readCsvRows(csvPath).map(resultRow)) {
    // 以 filename 为主的统一身份键：同一封邮件里两份同名（source 相同）
    // 的不同文档不再互相折叠，某张票也不会从整理输出里消失（APP-06A）。
    index.set(rowIdentity(row), row, (existing, next) => (
      !(existing.status.toLowerCase() === 'success' && next.status.toLowerCase() !== 'success')
    ));
  }
  return index.values();
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

export function organizeFromOcrResults(cfg: Config, log: Logger, opts: { resultsCsv?: string; outDir?: string; applyRename?: boolean } = {}): OrganizeSummary {
  const resultsCsv = path.resolve(opts.resultsCsv ?? cfg.ocr.resultsCsv);
  const invoicesDir = path.resolve(cfg.paths.invoices);
  const organizedDir = path.resolve(opts.outDir ?? cfg.rename.organizedDir);
  const applyRename = opts.applyRename ?? cfg.rename.applyAfterOcr;
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

    // basename() so a tampered/legacy CSV filename containing path segments can
    // never make organize read a file outside the archive directory.
    const src = path.join(invoicesDir, path.basename(row.filename));
    if (!fs.existsSync(src)) {
      summary.failed++;
      writeOrganizeAudit(auditCsv, row, '', 'failed', `missing_source:${src}`);
      continue;
    }

    try {
      const filename = applyRename ? renderFilename(row, cfg) : safePathSegment(row.filename, 'document.pdf');
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
