import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, type Config } from '../config.js';
import { summarizeOcr, type OcrSummary } from '../ocr/summary.js';
import { summarizePending, type PendingSummary } from '../pending/summary.js';
import { readCsvRows } from '../util/csv.js';

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
  total: number;
  withAttachment: number;
  withLinks: number;
  earliestMonth: string;
  latestMonth: string;
  rows: InboxRow[];
}

export interface InvoiceRow {
  date: string;
  seller: string;
  invoiceNo: string;
  amount: string;
  source: string;
  filename: string;
  filePath: string;
  status: string;
  documentType: string;
  invoiceType: string;
  error: string;
}

function isArchivedDocument(name: string): boolean {
  return /\.(pdf|ofd)$/i.test(name);
}

export interface LibrarySummary {
  pendingCsv: string;
  resultsCsv: string;
  total: number;
  recognized: number;
  failed: number;
  ignored: number;
  pending: number;
  invoiceLike: number;
  itinerary: number;
  supporting: number;
  rows: InvoiceRow[];
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

export function loadGuiConfig(configPath = defaultConfigPath()): { cfg: Config; error: string } {
  try {
    return { cfg: loadConfig(configPath), error: '' };
  } catch (err) {
    const examplePath = path.resolve(process.cwd(), 'config.example.json');
    const fallback = fs.existsSync(examplePath) ? examplePath : configPath;
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

export function summarizeInbox(cfg: Config): InboxSummary {
  const indexCsv = path.resolve(cfg.paths.samples, 'INDEX.csv');
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
  return {
    indexCsv,
    total: rows.length,
    withAttachment: rows.filter((row) => row.hasAttachment).length,
    withLinks: rows.filter((row) => row.bodyLinkCount > 0).length,
    earliestMonth: monthLabel(months[0] ?? ''),
    latestMonth: monthLabel(months[months.length - 1] ?? ''),
    rows: rows.slice(0, 80),
  };
}

function money(value: string): string {
  if (!value) return '';
  const n = Number(value.replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(n)) return value;
  return `¥ ${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

export function summarizeLibrary(cfg: Config): LibrarySummary {
  const ocr = summarizeOcr(cfg);
  const resultRows = currentResultRows(readCsvRows(ocr.resultsCsv));
  const rows = resultRows
    .map((row): InvoiceRow => ({
      date: row.dateValue || row.date || '',
      seller: row.seller || '未识别销售方',
      invoiceNo: row.invoiceNo || '',
      amount: money(row.amount || ''),
      source: row.transport === 'http' ? '本机识别' : row.transport || '归档文件',
      filename: row.filename || '',
      filePath: row.filename ? path.resolve(cfg.paths.invoices, row.filename) : '',
      status: (row.status ?? '').toLowerCase() === 'error'
        ? '识别失败'
        : (row.invoiceNo || row.seller || row.amount) ? '完整' : '待补充',
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
      filePath: path.resolve(cfg.paths.invoices, filename),
      status: row.status === 'ignored' ? '已归档' : '待补充',
      documentType: row.documentType || '',
      invoiceType: '',
      error: row.reason || '',
    });
  }
  try {
    for (const entry of fs.readdirSync(path.resolve(cfg.paths.invoices), { withFileTypes: true })) {
      if (!entry.isFile() || !isArchivedDocument(entry.name) || seenFiles.has(entry.name)) continue;
      rows.push({
        date: '',
        seller: '待识别',
        invoiceNo: '',
        amount: '',
        source: '归档文件',
        filename: entry.name,
        filePath: path.resolve(cfg.paths.invoices, entry.name),
        status: '待补充',
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
  const pendingRows = rows.filter((row) => row.status === '待补充').length;
  return {
    pendingCsv: ocr.pendingCsv,
    resultsCsv: ocr.resultsCsv,
    total: Math.max(ocr.total, archivedTotal),
    recognized: ocr.recognized,
    failed: ocr.failed,
    ignored: ocr.ignored,
    pending: Math.max(ocr.pending, pendingRows),
    invoiceLike,
    itinerary,
    supporting,
    rows: rows.slice(0, 200),
    ocr,
  };
}

export function loadAppSummary(configPath = defaultConfigPath(), cwd = process.cwd()): AppSummary {
  const configExists = fs.existsSync(configPath);
  const { cfg, error } = loadGuiConfig(configPath);
  return {
    configPath,
    configExists,
    configError: error,
    history: readRunHistory(cwd),
    inbox: summarizeInbox(cfg),
    library: summarizeLibrary(cfg),
    pending: summarizePending(cfg),
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
