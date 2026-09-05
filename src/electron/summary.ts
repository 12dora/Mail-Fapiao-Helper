import fs from 'node:fs';
import path from 'node:path';
import { isSupportingDocument } from '../extract/classify.js';
import { loadConfig, type Config } from '../config.js';
import { summarizeOcr, type OcrSummary } from '../ocr/summary.js';
import { summarizePending, type PendingSummary } from '../pending/summary.js';
import { loadState } from '../state.js';
import { readCsvRows } from '../util/csv.js';
import { artifactIdentityForRow, indexArtifactResults, type ArtifactIndex } from '../util/identity.js';
import { mailHashForRow } from './mailStatus.js';

/**
 * 票据库行状态的后端枚举（APP-20）。renderer 必须复用这些常量，
 * 不要再用「排除识别失败」这类反向判断，那会把待补充/已归档也算成已识别。
 */
export const LIBRARY_STATUS = {
  COMPLETE: '完整',
  /** OCR 字段不全或尚未识别完：界面「信息不完整 / 待补充」。 */
  PENDING: '信息不完整',
  ARCHIVED: '已归档',
  FAILED: '识别失败',
} as const;

export type LibraryStatus = typeof LIBRARY_STATUS[keyof typeof LIBRARY_STATUS];

/** 全部合法状态，供 renderer 生成筛选项。 */
export const LIBRARY_STATUS_VALUES: readonly LibraryStatus[] = [
  LIBRARY_STATUS.COMPLETE,
  LIBRARY_STATUS.PENDING,
  LIBRARY_STATUS.ARCHIVED,
  LIBRARY_STATUS.FAILED,
];

/** 「已识别」= 已经拿到可用发票字段，不含待补充/已归档/识别失败。 */
export const RECOGNIZED_STATUSES: readonly LibraryStatus[] = [LIBRARY_STATUS.COMPLETE];

/** 「识别失败」筛选集合。 */
export const FAILED_STATUSES: readonly LibraryStatus[] = [LIBRARY_STATUS.FAILED];

/** 分页参数：默认 limit=500、offset=0；total 始终是切片前的真实总数。 */
export interface SummaryPageOptions {
  limit?: number;
  offset?: number;
}

const DEFAULT_PAGE_LIMIT = 500;

function pageOf<T>(rows: T[], opts: SummaryPageOptions | undefined): { rows: T[]; offset: number; limit: number } {
  const rawLimit = Number(opts?.limit);
  const rawOffset = Number(opts?.offset);
  const limit = Number.isFinite(rawLimit) && rawLimit >= 0 ? Math.min(100000, Math.floor(rawLimit)) : DEFAULT_PAGE_LIMIT;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.min(Math.floor(rawOffset), rows.length) : 0;
  return { rows: rows.slice(offset, offset + limit), offset, limit };
}

export interface InboxRow {
  mailHash: string;
  status: 'archived' | 'pending' | 'unprocessed' | 'ignored';
  documentCount: number;
  mailOpenable: boolean;
  messageId: string;
  date: string;
  from: string;
  subject: string;
  mailbox: string;
  hasAttachment: boolean;
  bodyLinkCount: number;
}

export interface InboxSummary {
  indexCsv: string;
  /** 切片前的真实总数。 */
  total: number;
  withAttachment: number;
  withLinks: number;
  earliestMonth: string;
  latestMonth: string;
  rows: InboxRow[];
  offset: number;
  limit: number;
}

export interface InvoiceRow {
  mailHash: string;
  messageId: string;
  from: string;
  subject: string;
  contentHash: string;
  fileHandle: string;
  duplicateGroup: string;
  duplicateCount: number;
  date: string;
  seller: string;
  invoiceNo: string;
  amount: string;
  source: string;
  filename: string;
  filePath: string;
  status: LibraryStatus;
  documentType: string;
  invoiceType: string;
  error: string;
}

function isArchivedDocument(name: string): boolean {
  return /\.(pdf|ofd|png|jpe?g|gif|webp|bmp)$/i.test(name);
}

export interface LibrarySummary {
  duplicates: { groups: number; rows: number };
  pendingCsv: string;
  resultsCsv: string;
  /** 切片前的可报销票据总数（含行程单，不含支撑材料）。 */
  total: number;
  /** 含支撑材料的完整行数，用于分页。 */
  documentTotal: number;
  recognized: number;
  failed: number;
  ignored: number;
  pending: number;
  invoiceLike: number;
  itinerary: number;
  supporting: number;
  rows: InvoiceRow[];
  offset: number;
  limit: number;
  /** 按后端枚举统计的票据状态行数（切片前，不含支撑材料）。 */
  statusCounts: Record<LibraryStatus, number>;
  ocr: OcrSummary;
}

export interface AppSummary {
  configPath: string;
  configExists: boolean;
  configError: string;
  history: RunHistoryEntry[];
  inbox: InboxSummary;
  library: LibrarySummary;
  pending: PendingSummary;
}

export interface RunHistoryEntry {
  id: string;
  time: string;
  action: string;
  title: string;
  status: 'success' | 'partial' | 'failed';
  message: string;
  detail: string;
  durationMs: number;
}

export function defaultConfigPath(cwd = process.cwd()): string {
  return path.resolve(cwd, 'config.json');
}

export function historyPath(cwd = process.cwd()): string {
  return path.resolve(cwd, '.mfh-cache', 'gui-history.json');
}

export function loadGuiConfig(
  configPath = defaultConfigPath(),
  fallbackConfigPath = path.resolve(process.cwd(), 'config.example.json'),
): { cfg: Config; error: string } {
  try {
    return { cfg: loadConfig(configPath), error: '' };
  } catch (err) {
    const fallback = fs.existsSync(fallbackConfigPath) ? fallbackConfigPath : configPath;
    return {
      cfg: loadConfig(fallback),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function monthFromIso(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(value: string): string {
  if (!value) return '暂无';
  const [year, month] = value.split('-');
  return year && month ? `${year}-${month}` : value;
}

function resolveIn(cwd: string, value: string): string {
  return path.resolve(cwd, value);
}

export function summarizeInbox(cfg: Config, cwd = process.cwd(), opts?: SummaryPageOptions): InboxSummary {
  const indexCsv = resolveIn(cwd, path.join(cfg.paths.samples, 'INDEX.csv'));
  const rawRows = readCsvRows(indexCsv);
  const documentCounts = new Map<string, number>();
  const legacyDocumentCounts = new Map<string, number>();
  for (const row of readCsvRows(resolveIn(cwd, cfg.output.csv))) {
    const hash = row.mailHash ? mailHashForRow(row) : '';
    const key = hash || row.messageId || '';
    if (!key) continue;
    const counts = hash ? documentCounts : legacyDocumentCounts;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const pendingHashes = new Set<string>();
  const pendingMessageIds = new Set<string>();
  for (const row of readCsvRows(resolveIn(cwd, path.join(cfg.paths.pending, 'pending.csv')))) {
    const hash = row.mailHash || row.hash ? mailHashForRow(row) : '';
    if (hash) pendingHashes.add(hash);
    else if (row.messageId) pendingMessageIds.add(row.messageId);
  }
  const processedHashes = new Set(loadState(resolveIn(cwd, 'state.json')).processedHashes);
  const mailFiles = new Set<string>();
  for (const dir of [cfg.paths.samples, cfg.paths.pending]) {
    try {
      for (const entry of fs.readdirSync(resolveIn(cwd, dir), { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.eml')) mailFiles.add(entry.name.slice(0, -4));
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  const rows = rawRows.map((row): InboxRow => {
    const mailHash = mailHashForRow(row);
    const messageId = row.messageId || '';
    const documentCount = (documentCounts.get(mailHash) ?? 0) + (legacyDocumentCounts.get(messageId) ?? 0);
    const pending = pendingHashes.has(mailHash) || pendingMessageIds.has(messageId);
    return {
      mailHash,
      messageId,
      status: documentCount > 0 ? 'archived' : pending ? 'pending' : processedHashes.has(mailHash) ? 'ignored' : 'unprocessed',
      documentCount,
      mailOpenable: mailFiles.has(mailHash),
      date: row.date ?? '',
      from: row.from ?? '',
      subject: row.subject ?? '',
      mailbox: row.mailbox ?? '',
      hasAttachment: (row.hasAttachment ?? '') === '1',
      bodyLinkCount: Number(row.bodyLinkCount ?? 0) || 0,
    };
  }).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));

  const months = rows.map((row) => monthFromIso(row.date)).filter(Boolean).sort();
  const page = pageOf(rows, opts);
  return {
    indexCsv,
    total: rows.length,
    withAttachment: rows.filter((row) => row.hasAttachment).length,
    withLinks: rows.filter((row) => row.bodyLinkCount > 0).length,
    earliestMonth: monthLabel(months[0] ?? ''),
    latestMonth: monthLabel(months[months.length - 1] ?? ''),
    rows: page.rows,
    offset: page.offset,
    limit: page.limit,
  };
}

function money(value: string): string {
  if (!value) return '';
  const n = Number(value.replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(n)) return value;
  return `¥ ${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 结果行 → 后端状态枚举（APP-20）。 */
function libraryStatusOf(row: Record<string, string>): LibraryStatus {
  if (isSupportingDocument(row)) return LIBRARY_STATUS.ARCHIVED;
  const status = (row.status ?? '').toLowerCase();
  if (status === 'error') return LIBRARY_STATUS.FAILED;
  if (status === 'partial') return LIBRARY_STATUS.PENDING;
  return (row.invoiceNo || row.seller || row.amount) ? LIBRARY_STATUS.COMPLETE : LIBRARY_STATUS.PENDING;
}

function pendingLibraryStatus(row: Record<string, string>): LibraryStatus {
  return isSupportingDocument(row) || row.status === 'ignored' ? LIBRARY_STATUS.ARCHIVED : LIBRARY_STATUS.PENDING;
}

function withSupportingEvidence(row: Record<string, string>, indexes: ArtifactIndex<Record<string, string>>[]): Record<string, string> {
  const identity = artifactIdentityForRow(row);
  const supporting = isSupportingDocument(row) || indexes.some((index) => {
    const evidence = index.get(identity);
    return evidence !== undefined && isSupportingDocument(evidence);
  });
  return supporting ? { ...row, documentType: 'supporting' } : row;
}

export function summarizeLibrary(cfg: Config, cwd = process.cwd(), opts?: SummaryPageOptions): LibrarySummary {
  const ocr = summarizeOcr(cfg, cwd);
  const ledgerRows = readCsvRows(resolveIn(cwd, cfg.output.csv));
  const queuedRows = readCsvRows(ocr.pendingCsv);
  const evidence = [indexArtifactResults(ledgerRows), indexArtifactResults(queuedRows)];
  const pendingDocuments = queuedRows.map((row) => withSupportingEvidence(row, evidence));
  const resultRows = indexArtifactResults(readCsvRows(ocr.resultsCsv)).values().map((row) => withSupportingEvidence(row, evidence));
  const ledgerByArtifact = new Map<string, Record<string, string>>();
  const ledgerByFilename = new Map<string, Record<string, string>>();
  for (const row of ledgerRows) {
    ledgerByArtifact.set(`${row.filename || ''}\0${row.contentHash || ''}`, row);
    ledgerByFilename.set(row.filename || '', row);
  }
  function metadata(row: Record<string, string>) {
    const filename = row.filename || '';
    const ledger = row.contentHash
      ? ledgerByArtifact.get(`${filename}\0${row.contentHash}`)
      : ledgerByFilename.get(filename);
    return {
      mailHash: row.hash || row.mailHash || ledger?.mailHash || '',
      messageId: row.messageId || ledger?.messageId || '',
      from: row.from || ledger?.from || '',
      subject: row.subject || ledger?.subject || '',
      contentHash: row.contentHash || ledger?.contentHash || '',
      fileHandle: filename ? resolveIn(cwd, path.join(cfg.paths.invoices, filename)) : '',
      duplicateGroup: '',
      duplicateCount: 0,
    };
  }
  const duplicateGroups = new Map<string, InvoiceRow[]>();
  const rows = resultRows
    .map((row): InvoiceRow => {
      const invoice: InvoiceRow = {
        ...metadata(row),
        date: row.dateValue || row.date || '',
        seller: row.seller || '未识别销售方',
        invoiceNo: (row.invoiceNo || '').trim(),
        amount: money(row.amount || ''),
        // COPY-17：OCR transport（http/cli）不是发票来源；在有真实邮件/站点溯源前
        // 普通列表不展示来源字段（空串），避免「归档文件」这种误导性占位。
        source: '',
        filename: row.filename || '',
        filePath: row.filename ? resolveIn(cwd, path.join(cfg.paths.invoices, row.filename)) : '',
        // partial：服务返回成功但关键字段缺失，属于「待补充」而不是「完整」（APP-14B）。
        status: libraryStatusOf(row),
        documentType: isSupportingDocument(row) ? 'supporting' : row.documentType || '',
        invoiceType: row.invoiceType || '',
        error: row.error || '',
      };
      if (invoice.invoiceNo && invoice.documentType !== 'supporting') {
        const group = duplicateGroups.get(invoice.invoiceNo) ?? [];
        group.push(invoice);
        duplicateGroups.set(invoice.invoiceNo, group);
      }
      return invoice;
    })
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const seenFiles = new Set(rows.map((row) => row.filename).filter(Boolean));
  for (const row of pendingDocuments) {
    const filename = row.filename || '';
    if (!filename || seenFiles.has(filename)) continue;
    seenFiles.add(filename);
    rows.push({
      ...metadata(row),
      date: row.date || '',
      seller: isSupportingDocument(row) ? '支撑材料' : '待识别',
      invoiceNo: '',
      amount: '',
      source: '',
      filename,
      filePath: resolveIn(cwd, path.join(cfg.paths.invoices, filename)),
      status: pendingLibraryStatus(row),
      documentType: isSupportingDocument(row) ? 'supporting' : row.documentType || '',
      invoiceType: '',
      error: row.reason || '',
    });
  }
  try {
    for (const entry of fs.readdirSync(resolveIn(cwd, cfg.paths.invoices), { withFileTypes: true })) {
      if (!entry.isFile() || !isArchivedDocument(entry.name) || seenFiles.has(entry.name)) continue;
      rows.push({
        ...metadata({ filename: entry.name }),
        date: '',
        seller: '待识别',
        invoiceNo: '',
        amount: '',
        source: '',
        filename: entry.name,
        filePath: resolveIn(cwd, path.join(cfg.paths.invoices, entry.name)),
        status: isSupportingDocument(withSupportingEvidence({ filename: entry.name }, evidence)) ? LIBRARY_STATUS.ARCHIVED : LIBRARY_STATUS.PENDING,
        documentType: isSupportingDocument(withSupportingEvidence({ filename: entry.name }, evidence)) ? 'supporting' : '',
        invoiceType: '',
        error: '',
      });
    }
  } catch {
    // Directory may not exist yet on a fresh install.
  }
  rows.sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || a.filename.localeCompare(b.filename, 'zh-CN'));

  const duplicates = { groups: 0, rows: 0 };
  for (const [invoiceNo, group] of duplicateGroups) {
    if (group.length < 2) continue;
    duplicates.groups++;
    duplicates.rows += group.length;
    for (const row of group) {
      row.duplicateGroup = invoiceNo;
      row.duplicateCount = group.length;
    }
  }

  const invoiceRows = rows.filter((row) => row.documentType !== 'supporting');
  const itinerary = invoiceRows.filter((row) => row.documentType === 'itinerary').length;
  const supporting = rows.length - invoiceRows.length;
  const invoiceLike = invoiceRows.length - itinerary;
  const statusCounts = {
    [LIBRARY_STATUS.COMPLETE]: 0,
    [LIBRARY_STATUS.PENDING]: 0,
    [LIBRARY_STATUS.ARCHIVED]: 0,
    [LIBRARY_STATUS.FAILED]: 0,
  } as Record<LibraryStatus, number>;
  for (const row of invoiceRows) statusCounts[row.status]++;
  const pendingRows = statusCounts[LIBRARY_STATUS.PENDING];
  const page = pageOf(rows, opts);
  return {
    duplicates,
    pendingCsv: ocr.pendingCsv,
    resultsCsv: ocr.resultsCsv,
    // total 只统计可报销票据（含行程单）；rows 同时保留支撑材料供筛选。
    total: invoiceRows.length,
    documentTotal: rows.length,
    recognized: statusCounts[LIBRARY_STATUS.COMPLETE],
    // COPY-03：failed 只含真正识别失败；partial 计入 pending 侧，与列表「信息不完整」一致。
    failed: statusCounts[LIBRARY_STATUS.FAILED],
    ignored: supporting,
    pending: pendingRows,
    invoiceLike,
    itinerary,
    supporting,
    rows: page.rows,
    offset: page.offset,
    limit: page.limit,
    statusCounts,
    ocr,
  };
}

export function loadAppSummary(
  configPath = defaultConfigPath(),
  cwd = process.cwd(),
  fallbackConfigPath = path.resolve(process.cwd(), 'config.example.json'),
): AppSummary {
  const configExists = fs.existsSync(configPath);
  const { cfg, error } = loadGuiConfig(configPath, fallbackConfigPath);
  return {
    configPath,
    configExists,
    configError: error,
    history: readRunHistory(cwd),
    inbox: summarizeInbox(cfg, cwd),
    library: summarizeLibrary(cfg, cwd),
    pending: summarizePending(cfg, cwd),
  };
}

export function readRunHistory(cwd = process.cwd()): RunHistoryEntry[] {
  const file = historyPath(cwd);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is RunHistoryEntry => (
      item !== null
      && typeof item === 'object'
      && typeof (item as RunHistoryEntry).id === 'string'
      && typeof (item as RunHistoryEntry).time === 'string'
      && typeof (item as RunHistoryEntry).title === 'string'
      && typeof (item as RunHistoryEntry).status === 'string'
    )).slice(0, 30);
  } catch {
    return [];
  }
}
