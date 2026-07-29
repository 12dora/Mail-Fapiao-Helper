import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import { csvCell, readCsvRows } from '../util/csv.js';
import { contentHash } from '../util/hash.js';
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
  if (row.format.toLowerCase() === 'image') {
    // 图片但无文件名扩展名时退回 .png。
    return '.png';
  }
  return '.pdf';
}

/** 已知文档扩展名：只有这些才从模板 stem 上剥离（NEW-DEFECT 5）。 */
const RECOGNIZED_DOC_EXT = new Set([
  '.pdf',
  '.ofd',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.xml',
  '.ofdx',
  '.zip',
]);

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

/**
 * 模板只生成 stem；最终扩展名始终来自源文件真实扩展名（OCR-09）。
 * 仅当模板后缀是「与真实扩展名匹配」或「已知文档扩展名」时才剥离；
 * 否则（如金额 `318.42`）整段保留在 stem 内（NEW-DEFECT 5）。
 */
function renderFilename(row: OcrResultRow, cfg: Config, log?: Logger): string {
  const rule = renderTemplate(cfg.rename.rule, row);
  const rendered = rule.complete ? rule.value : renderTemplate(cfg.rename.fallback, row).value;
  const realExt = extFor(row);
  const templateExt = path.extname(rendered);
  let stem: string;
  if (templateExt.length > 0) {
    const lower = templateExt.toLowerCase();
    const isRecognized = RECOGNIZED_DOC_EXT.has(lower);
    const matchesReal = lower === realExt.toLowerCase();
    if (matchesReal || isRecognized) {
      if (!matchesReal && isRecognized) {
        log?.warn?.(`rename template extension ${templateExt} replaced with ${realExt} for ${row.filename}`);
      }
      stem = rendered.slice(0, rendered.length - templateExt.length);
    } else {
      // 例如 `{seller}-{amount}` → `国家电网-318.42`：`.42` 不是文档扩展名。
      stem = rendered;
    }
  } else {
    stem = rendered;
  }
  // stem 可能仍含路径分隔符：safePathSegment 会 basename 清洗。
  const withExt = `${stem}${realExt}`;
  return safePathSegment(withExt, safePathSegment(row.filename || `${row.hash || 'document'}${realExt}`, `document${realExt}`));
}

function renderTargetDir(row: OcrResultRow, cfg: Config, organizedDir: string): string {
  if (!cfg.rename.organizeByType) return organizedDir;
  const rendered = renderTemplate(cfg.rename.typeDirRule, row).value;
  return path.join(organizedDir, safeRelativeDir(rendered));
}

function hashFile(filePath: string): string {
  return contentHash(fs.readFileSync(filePath));
}

/**
 * 冲突安全复制（OCR-14 / NEW-DEFECT 3）：
 * - 必须使用**当前源文件**的 contentHash，不得盲信 CSV 记录；
 * - 索引命中时重新校验目标文件哈希，防止陈旧索引导致静默漏票；
 * - 同名冲突用 per-base high-water，避免每行从 0 重新 stat。
 */
function copyFileConflictSafe(
  src: string,
  dest: string,
  contentIndex: Map<string, string>,
  nameHighWater: Map<string, number>,
  srcHash: string,
): { finalPath: string; copied: boolean; reason: string } {
  // 全局幂等：本批或历史已整理出相同内容——但必须复核目标仍在且哈希匹配。
  const known = contentIndex.get(srcHash);
  if (known) {
    try {
      if (fs.existsSync(known) && fs.statSync(known).isFile() && hashFile(known) === srcHash) {
        return { finalPath: known, copied: false, reason: 'already_exists_same_content' };
      }
    } catch {
      // 目标不可读：丢弃陈旧索引项，继续正常落盘路径。
    }
    contentIndex.delete(srcHash);
  }

  ensureDir(path.dirname(dest));
  const dir = path.dirname(dest);
  const ext = path.extname(dest);
  const base = path.basename(dest, ext);
  const srcSize = fs.statSync(src).size;
  // high-water key：同一目录下同一 stem 的编号水位（进程内，OCR-14 务实改进）。
  const hwKey = `${path.resolve(dir)}\0${base.toLowerCase()}\0${ext.toLowerCase()}`;
  let counter = nameHighWater.get(hwKey) ?? 0;

  for (;; counter++) {
    const candidate = counter === 0 ? dest : path.join(dir, `${base}-${counter}${ext}`);
    if (!fs.existsSync(candidate)) {
      fs.copyFileSync(src, candidate, fs.constants.COPYFILE_EXCL);
      contentIndex.set(srcHash, candidate);
      nameHighWater.set(hwKey, counter);
      return { finalPath: candidate, copied: true, reason: '' };
    }
    // 先比 size，再比 hash；hash 结果缓存进 contentIndex。
    try {
      const st = fs.statSync(candidate);
      if (!st.isFile() || st.size !== srcSize) {
        nameHighWater.set(hwKey, counter + 1);
        continue;
      }
      const candidateHash = hashFile(candidate);
      contentIndex.set(candidateHash, candidate);
      if (candidateHash === srcHash) {
        nameHighWater.set(hwKey, counter);
        return { finalPath: candidate, copied: false, reason: 'already_exists_same_content' };
      }
      nameHighWater.set(hwKey, counter + 1);
    } catch {
      // 竞态消失的文件：下一轮重试同 counter 会再观察。
      continue;
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

/**
 * 写 organize 审计行。失败时返回错误字符串，**绝不抛出**（OCR-10）：
 * 审计 sink 故障不能中止已复制文件之后的批次。
 * 零字节已存在文件视为新建，必须写 BOM+header（NEW-DEFECT 4）。
 */
export function writeOrganizeAudit(
  csvPath: string,
  row: OcrResultRow,
  outputPath: string,
  status: string,
  reason: string,
): string | undefined {
  try {
    ensureDir(path.dirname(csvPath));
    let isNew = true;
    try {
      const st = fs.statSync(csvPath);
      isNew = !st.isFile() || st.size === 0;
    } catch {
      isNew = true;
    }
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
    if (isNew) {
      fs.writeFileSync(csvPath, '\uFEFF' + header + line, 'utf8');
    } else {
      fs.appendFileSync(csvPath, line, 'utf8');
    }
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * 预检审计 CSV 是否可写；**不得创建**目标文件（NEW-DEFECT 4）。
 * 用父目录可写性 + 已存在文件的 W_OK 探测。
 */
function probeAuditSink(auditCsv: string): string | undefined {
  try {
    ensureDir(path.dirname(auditCsv));
    if (fs.existsSync(auditCsv)) {
      fs.accessSync(auditCsv, fs.constants.W_OK);
    } else {
      fs.accessSync(path.dirname(auditCsv), fs.constants.W_OK);
    }
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
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

  // 预检 audit sink：若目录/文件完全不可写，仍继续复制，但只 warn 一次（OCR-10）。
  const auditProbeError = probeAuditSink(auditCsv);
  let auditDisabled = false;
  if (auditProbeError) {
    auditDisabled = true;
    log.warn(`organize audit CSV not writable (${auditProbeError}); continuing without audit lines`);
  }

  // contentHash -> 已整理输出路径，跨行 O(1) 幂等（OCR-14）。
  const contentIndex = new Map<string, string>();
  // 同 stem 冲突编号 high-water，单次 run 内避免每行从 0 扫描（OCR-14 务实改进）。
  const nameHighWater = new Map<string, number>();

  function safeAudit(row: OcrResultRow, outputPath: string, status: string, reason: string): void {
    if (auditDisabled) return;
    const err = writeOrganizeAudit(auditCsv, row, outputPath, status, reason);
    if (err) {
      auditDisabled = true;
      log.warn(`organize audit write failed (${err}); further audit lines skipped`);
    }
  }

  for (const row of rows) {
    if (!resultIsUsable(row)) {
      summary.skipped++;
      safeAudit(row, '', 'skipped', row.error || `status=${row.status}`);
      continue;
    }

    if (row.filename.length === 0) {
      summary.failed++;
      safeAudit(row, '', 'failed', 'missing_filename');
      continue;
    }

    // basename() so a tampered/legacy CSV filename containing path segments can
    // never make organize read a file outside the archive directory.
    const src = path.join(invoicesDir, path.basename(row.filename));
    if (!fs.existsSync(src)) {
      summary.failed++;
      safeAudit(row, '', 'failed', `missing_source:${src}`);
      continue;
    }

    try {
      const filename = applyRename
        ? renderFilename(row, cfg, log)
        : safePathSegment(row.filename, `document${extFor(row)}`);
      const targetDir = renderTargetDir(row, cfg, organizedDir);

      // NEW-DEFECT 3：始终对当前源文件算 hash；CSV contentHash 仅作诊断对照。
      const srcHash = hashFile(src);
      if (row.contentHash && row.contentHash !== srcHash) {
        log.warn(
          `organize source contentHash drift for ${row.filename}: csv=${row.contentHash} actual=${srcHash}; using actual`,
        );
      }

      const result = copyFileConflictSafe(
        src,
        path.join(targetDir, filename),
        contentIndex,
        nameHighWater,
        srcHash,
      );
      if (result.copied) {
        summary.copied++;
        safeAudit(row, result.finalPath, 'copied', '');
        log.info(`organized ${row.filename} -> ${result.finalPath}`);
      } else {
        summary.skipped++;
        safeAudit(row, result.finalPath, 'skipped', result.reason);
        log.info(`organized skip ${row.filename}: ${result.reason}`);
      }
    } catch (err) {
      summary.failed++;
      const reason = err instanceof Error ? err.message : String(err);
      safeAudit(row, '', 'failed', reason);
      log.warn(`organize failed for ${row.filename}: ${reason}`);
    }
  }

  return summary;
}
