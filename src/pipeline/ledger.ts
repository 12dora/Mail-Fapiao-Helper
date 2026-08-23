import fs from 'node:fs';
import path from 'node:path';
import { contentHash as contentHashOf, isMailHash, msgIdHash as msgIdHashFn } from '../util/hash.js';
import { ensureCsvSchema, parseCsv, readCsvRows, rewriteCsvRows } from '../util/csv.js';
import {
  hardenFile,
  INVOICE_CSV_HEADER,
  INVOICE_CSV_LEGACY,
  OCR_CSV_HEADER,
  OCR_CSV_LEGACY,
  withCsvRetry,
} from './csvDurability.js';

export interface ArchivedIndex {
  /** `${messageId}\0${contentHash}` -> 已归档文件名。 */
  byKey: Map<string, string>;
  /** 本邮件已归档的 contentHash -> 文件名，用于归档前的幂等协调。 */
  byContentHash: Map<string, string>;
}

/**
 * 从已归档文件回填 contentHash（六列表头升级后列为空时）。
 * 只接受 invoices 目录下的 basename，拒绝路径穿越。
 */
function hashArchivedFile(invoicesDir: string, filename: string): string {
  // 只认 basename，杜绝台账 filename 路径穿越。
  const leaf = path.basename(filename);
  if (!leaf || leaf === '.' || leaf === '..') return '';
  try {
    const resolved = path.resolve(invoicesDir, leaf);
    const root = path.resolve(invoicesDir);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return '';
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return '';
    return contentHashOf(fs.readFileSync(resolved));
  } catch {
    return '';
  }
}

/**
 * 读取 invoices.csv，建立 `(messageId, source, contentHash)` 维度的已归档索引。
 * `--force` / `--only-mail` 重跑靠它复用既有文件，而不是新建 `-1/-2` 碰撞副本（APP-03）。
 *
 * 六列 legacy 升级后 contentHash 可能为空：此时对磁盘上的归档文件现算 hash，
 * 保证升级用户 force-rerun 不会装出碰撞后缀副本（BLOCKING 14）。
 */
export function readArchivedIndex(csvPath: string, messageId: string, invoicesDir: string): ArchivedIndex {
  const byKey = new Map<string, string>();
  const byContentHash = new Map<string, string>();
  if (!fs.existsSync(csvPath)) return { byKey, byContentHash };
  const content = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  const records = parseCsv(content);
  const header = records[0] ?? [];
  const idx = (name: string): number => header.indexOf(name);
  const iMessageId = idx('messageId') >= 0 ? idx('messageId') : 0;
  const iFilename = idx('filename') >= 0 ? idx('filename') : 4;
  const iSource = idx('source') >= 0 ? idx('source') : 5;
  const iHash = idx('contentHash') >= 0 ? idx('contentHash') : 6;
  for (let i = 1; i < records.length; i++) {
    const cols = records[i] ?? [];
    const rowMessageId = cols[iMessageId] ?? '';
    const filename = cols[iFilename] ?? '';
    const source = cols[iSource] ?? '';
    let hash = (cols[iHash] ?? '').trim();
    if (hash.length === 0 && filename.length > 0) {
      hash = hashArchivedFile(invoicesDir, filename);
    }
    if (hash.length === 0) continue;
    byKey.set(`${rowMessageId}\0${source}\0${hash}`, filename);
    if (rowMessageId === messageId && filename.length > 0) {
      byContentHash.set(hash, filename);
    }
  }
  return { byKey, byContentHash };
}

/** 读取 OCR 队列里已存在的 `${hash}\0${contentHash}`，用于追加去重。 */
export function readOcrKeys(csvPath: string): Set<string> {
  const keys = new Set<string>();
  if (!fs.existsSync(csvPath)) return keys;
  const content = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  const records = parseCsv(content);
  const header = records[0] ?? [];
  const iHash = header.indexOf('hash') >= 0 ? header.indexOf('hash') : 0;
  const iContent = header.indexOf('contentHash') >= 0 ? header.indexOf('contentHash') : 11;
  for (let i = 1; i < records.length; i++) {
    const cols = records[i] ?? [];
    keys.add(`${cols[iHash] ?? ''}\0${cols[iContent] ?? ''}`);
  }
  return keys;
}

/**
 * 升级/修复 invoices 行：补 mailHash；contentHash 为空时对归档文件现算回填
 * （BLOCKING 14：六列 legacy 不得留下空 contentHash 导致 force-rerun 装副本）。
 */
export function fillInvoiceRow(row: Record<string, string>, invoicesDir: string): Record<string, string> {
  let contentHash = (row.contentHash ?? '').trim();
  const filename = row.filename ?? '';
  if (!contentHash && filename.length > 0) {
    contentHash = hashArchivedFile(invoicesDir, filename);
  }
  let mailHash = (row.mailHash ?? '').trim();
  if (!mailHash) {
    const messageId = row.messageId ?? '';
    if (isMailHash(messageId)) {
      mailHash = messageId.toLowerCase();
    } else {
      mailHash = msgIdHashFn(
        messageId.length > 0 ? messageId : undefined,
        row.from ?? '',
        row.date ?? '',
        row.subject ?? '',
      );
    }
  }
  return { ...row, mailHash, contentHash };
}

/** 当前 schema 下 blank contentHash/mailHash 回填（已升表头但列值为空的升级残骸）。 */
function repairInvoiceLedgerRows(csvPath: string, invoicesDir: string): void {
  if (!fs.existsSync(csvPath)) return;
  try {
    if (fs.statSync(csvPath).size === 0) return;
  } catch {
    return;
  }
  const rows = readCsvRows(csvPath);
  if (rows.length === 0) return;
  let dirty = false;
  const fixed = rows.map((row) => {
    const needHash = !(row.contentHash ?? '').trim();
    const needMail = !(row.mailHash ?? '').trim();
    if (!needHash && !needMail) return row;
    dirty = true;
    return fillInvoiceRow(row, invoicesDir);
  });
  if (!dirty) return;
  withCsvRetry(() => rewriteCsvRows(csvPath, INVOICE_CSV_HEADER, fixed));
  hardenFile(csvPath);
}

export function ensureInvoiceSchema(csvPath: string, invoicesDir: string): void {
  ensureCsvSchema(csvPath, INVOICE_CSV_HEADER, {
    upgradeFrom: INVOICE_CSV_LEGACY,
    upgradeRow: (row) => fillInvoiceRow(row, invoicesDir),
  });
  repairInvoiceLedgerRows(csvPath, invoicesDir);
}

export function ensureOcrSchema(csvPath: string): void {
  ensureCsvSchema(csvPath, OCR_CSV_HEADER, {
    upgradeFrom: OCR_CSV_LEGACY,
    upgradeRow: (row) => ({ ...row, contentHash: row.contentHash ?? '' }),
  });
}
