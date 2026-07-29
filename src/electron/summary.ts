import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, type Config } from '../config.js';
import { summarizeOcr, type OcrSummary } from '../ocr/summary.js';
import { summarizePending, type PendingSummary } from '../pending/summary.js';
import { readCsvRows } from '../util/csv.js';
import { ArtifactIndex, type ArtifactIdentity } from '../util/identity.js';

/**
 * 票据库行状态的后端枚举（APP-20）。renderer 必须复用这些常量，
 * 不要再用「排除识别失败」这类反向判断，那会把待补充/已归档也算成已识别。
 */
export const LIBRARY_STATUS = {
  COMPLETE: '完整',
  PENDING: '待补充',
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
  const limit = Number.isFinite(rawLimit) && rawLimit >= 0 ? Math.floor(rawLimit) : DEFAULT_PAGE_LIMIT;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.min(Math.floor(rawOffset), rows.length) : 0;
  return { rows: rows.slice(offset, offset + limit), offset, limit };
}

export interface InboxRow {
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
  pendingCsv: string;
  resultsCsv: string;
  /** 切片前的真实总数。 */
  total: number;
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
  /** 按后端枚举统计的各状态行数（切片前）。 */
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
  const rows = rawRows.map((row): InboxRow => ({
    messageId: row.messageId ?? '',
    date: row.date ?? '',
    from: row.from ?? '',
    subject: row.subject ?? '',
    mailbox: row.mailbox ?? '',
    hasAttachment: (row.hasAttachment ?? '') === '1',
    bodyLinkCount: Number(row.bodyLinkCount ?? 0) || 0,
  })).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));

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

/** 统一的票据身份（APP-06A）：hash + filename + contentHash，source 仅作回退。 */
function rowIdentity(row: Record<string, string>): ArtifactIdentity {
  return {
    hash: row.hash ?? '',
    filename: row.filename ?? '',
    source: row.source ?? '',
    contentHash: row.contentHash ?? '',
  };
}

function currentResultRows(rows: Record<string, string>[]): Record<string, string>[] {
  const index = new ArtifactIndex<Record<string, string>>();
  for (const row of rows) {
    index.set(rowIdentity(row), row, (existing, next) => {
      const existingStatus = (existing.status ?? '').toLowerCase();
      const nextStatus = (next.status ?? '').toLowerCase();
      return !(existingStatus === 'success' && nextStatus !== 'success');
    });
  }
  return index.values();
}

/** 结果行 → 后端状态枚举（APP-20）。 */
function libraryStatusOf(row: Record<string, string>): LibraryStatus {
  const status = (row.status ?? '').toLowerCase();
  if (status === 'error') return LIBRARY_STATUS.FAILED;
  if (status === 'partial') return LIBRARY_STATUS.PENDING;
  return (row.invoiceNo || row.seller || row.amount) ? LIBRARY_STATUS.COMPLETE : LIBRARY_STATUS.PENDING;
}

export function summarizeLibrary(cfg: Config, cwd = process.cwd(), opts?: SummaryPageOptions): LibrarySummary {
  const ocr = summarizeOcr(cfg, cwd);
  const resultRows = currentResultRows(readCsvRows(ocr.resultsCsv));
  const rows = resultRows
    .map((row): InvoiceRow => ({
      date: row.dateValue || row.date || '',
      seller: row.seller || '未识别销售方',
      invoiceNo: row.invoiceNo || '',
      amount: money(row.amount || ''),
      // COPY-17：transport 是识别调用方式，不是发票来源；普通列表不展示 http/cli。
      source: '归档文件',
      filename: row.filename || '',
      filePath: row.filename ? resolveIn(cwd, path.join(cfg.paths.invoices, row.filename)) : '',
      // partial：服务返回成功但关键字段缺失，属于「待补充」而不是「完整」（APP-14B）。
      status: libraryStatusOf(row),
      documentType: row.documentType || '',
      invoiceType: row.invoiceType || '',
      error: row.error || '',
    }))
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const seenFiles = new Set(rows.map((row) => row.filename).filter(Boolean));
  for (const row of readCsvRows(ocr.pendingCsv)) {
    const filename = row.filename || '';
    if (!filename || seenFiles.has(filename)) continue;
    seenFiles.add(filename);
    rows.push({
      date: row.date || '',
      seller: row.documentType === 'supporting' ? '支撑材料' : '待识别',
      invoiceNo: '',
      amount: '',
      source: '归档文件',
      filename,
      filePath: resolveIn(cwd, path.join(cfg.paths.invoices, filename)),
      status: row.status === 'ignored' ? LIBRARY_STATUS.ARCHIVED : LIBRARY_STATUS.PENDING,
      documentType: row.documentType || '',
      invoiceType: '',
      error: row.reason || '',
    });
  }
  try {
    for (const entry of fs.readdirSync(resolveIn(cwd, cfg.paths.invoices), { withFileTypes: true })) {
      if (!entry.isFile() || !isArchivedDocument(entry.name) || seenFiles.has(entry.name)) continue;
      rows.push({
        date: '',
        seller: '待识别',
        invoiceNo: '',
        amount: '',
        source: '归档文件',
        filename: entry.name,
        filePath: resolveIn(cwd, path.join(cfg.paths.invoices, entry.name)),
        status: LIBRARY_STATUS.PENDING,
        documentType: '',
        invoiceType: '',
        error: '',
      });
    }
  } catch {
    // Directory may not exist yet on a fresh install.
  }
  rows.sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || a.filename.localeCompare(b.filename, 'zh-CN'));

  const itinerary = ocr.byDocumentType.find((group) => group.key === 'itinerary')?.count ?? 0;
  const supporting = ocr.ignored;
  const invoiceLike = Math.max(0, ocr.recognized - itinerary);
  const archivedTotal = rows.filter((row) => isArchivedDocument(row.filename)).length;
  const statusCounts = {
    [LIBRARY_STATUS.COMPLETE]: 0,
    [LIBRARY_STATUS.PENDING]: 0,
    [LIBRARY_STATUS.ARCHIVED]: 0,
    [LIBRARY_STATUS.FAILED]: 0,
  } as Record<LibraryStatus, number>;
  for (const row of rows) statusCounts[row.status]++;
  const pendingRows = statusCounts[LIBRARY_STATUS.PENDING];
  const page = pageOf(rows, opts);
  return {
    pendingCsv: ocr.pendingCsv,
    resultsCsv: ocr.resultsCsv,
    // total 是切片前的真实总数，renderer 据此判断是否还有下一页。
    total: Math.max(ocr.total, archivedTotal, rows.length),
    recognized: ocr.recognized,
    failed: ocr.failed,
    ignored: ocr.ignored,
    pending: Math.max(ocr.pending, pendingRows),
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
