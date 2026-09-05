import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../../config.js';
import { parseMailWithGuards } from '../../mail/fetcher.js';
import { extractMailUrls } from '../../extract/mailLinks.js';
import { linkedImageHasInvoiceEvidence } from '../../extract/assetEvidence.js';
import { handlers as siteHandlers } from '../../sites/registry.js';
import { summarizePending, type PendingCopy } from '../../pending/summary.js';
import { readCsvRows } from '../../util/csv.js';
import { MAIL_HASH_RE } from '../../util/hash.js';
import { ArtifactIndex, artifactIdentityForRow, indexArtifactResults } from '../../util/identity.js';
import { buildMailStatusIndex, mailHashForRow, mailStatusFor, type MailStatus } from '../mailStatus.js';
import { LIBRARY_STATUS, type InvoiceRow, type InboxRow, type LibraryStatus } from '../summary.js';
import { sanitizeText } from '../sanitize.js';
import { asObject } from '../payload.js';
import type { RegisterMailHandlersDeps } from './mailHandlers.js';

type CsvRow = Record<string, string>;

export interface DetailInvoiceRow extends InvoiceRow {
  mailHash: string;
  messageId: string;
  from: string;
  subject: string;
  contentHash: string;
  duplicateGroup: string;
  duplicateCount: number;
  fileHandle: string;
}

export interface MailDetail extends InboxRow {
  mailHash: string;
  status: MailStatus;
  emlExists: boolean;
  emlLocation: 'samples' | 'pending' | null;
  attachments: { filename: string; size: number; contentType: string }[];
  links: { url: string; label: string }[];
  documents: DetailInvoiceRow[];
  pending: (PendingCopy & { reason: string }) | null;
  history: { time: string; action: string; status: string; message: string }[];
}

const ocrFields = [
  'documentType', 'invoiceType', 'seller', 'amount', 'dateValue', 'invoiceNo', 'transport',
  'extractedBy', 'parserVersion', 'ocrVendor', 'status', 'error',
] as const;
const ledgerFields = ['messageId', 'date', 'from', 'subject', 'source', 'mailHash', 'contentHash'] as const;

export interface InvoiceDetail {
  row: DetailInvoiceRow;
  ocr: Record<typeof ocrFields[number], string> | null;
  ledger: Record<typeof ledgerFields[number], string> | null;
  file: { handle: string; exists: boolean; size: number; format: string };
  duplicates: DetailInvoiceRow[];
}

export type MailDetailPayload = { hash: string };
export type InvoiceDetailPayload = { filename: string };
export type OpenMailPayload = { hash: string; reveal?: boolean };
/** Both lexical traversal and symlinks must remain within the invoices directory. */
export function invoicePath(root: string, filename: string): string | undefined {
  if (!filename || filename.includes('\0') || path.isAbsolute(filename)) return undefined;
  const target = path.resolve(root, filename);
  const inside = (candidate: string, base: string) => {
    const relative = path.relative(base, candidate);
    return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  if (!inside(target, path.resolve(root))) return undefined;
  try {
    if (!inside(fs.realpathSync(target), fs.realpathSync(root))) return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
    // Check the nearest existing parent even when the leaf is missing.
    let parent = path.dirname(target);
    while (!fs.existsSync(parent) && parent !== path.dirname(parent)) parent = path.dirname(parent);
    if (fs.existsSync(root)) {
      const realRoot = fs.realpathSync(root);
      const realParent = fs.realpathSync(parent);
      if (realParent !== realRoot && !inside(realParent, realRoot)) return undefined;
    }
  }
  return target;
}

export function currentOcrRows(rows: CsvRow[]): CsvRow[] {
  return indexArtifactResults(rows).values();
}

/** Mail links retain ordinary signed query values; only long query values are hidden. */
export function detailLinkUrl(url: string): string {
  const parsed = new URL(url);
  let changed = false;
  for (const key of new Set(parsed.searchParams.keys())) {
    const values = parsed.searchParams.getAll(key);
    if (!values.some(value => value.length > 64)) continue;
    parsed.searchParams.delete(key);
    for (const value of values) parsed.searchParams.append(key, value.length > 64 ? '[已隐藏]' : value);
    changed = true;
  }
  return changed ? parsed.toString() : url;
}

function detailSource(source: string): string {
  try {
    const parsed = new URL(detailLinkUrl(source));
    if (!parsed.username && !parsed.password) return detailLinkUrl(source);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return source;
  }
}

function pick<K extends string>(row: CsvRow, fields: readonly K[]): Record<K, string> {
  return Object.fromEntries(fields.map(key => [key, row[key] || ''])) as Record<K, string>;
}

function rowStatus(ocr?: CsvRow): LibraryStatus {
  if (!ocr) return LIBRARY_STATUS.PENDING;
  const status = (ocr.status || '').toLowerCase();
  if (status === 'error') return LIBRARY_STATUS.FAILED;
  if (status === 'partial') return LIBRARY_STATUS.PENDING;
  return ocr.invoiceNo || ocr.seller || ocr.amount ? LIBRARY_STATUS.COMPLETE : LIBRARY_STATUS.PENDING;
}

function displayAmount(amount: string): string {
  const numeric = Number(amount.replace(/[^\d.-]/g, ''));
  if (!amount || !Number.isFinite(numeric)) return amount;
  return `¥ ${numeric.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function issueInvoiceHandle(deps: RegisterMailHandlersDeps, filename: string): string {
  const target = invoicePath(deps.invoicesDirPath(), filename);
  return target ? deps.issueOpenableHandle(target) : '';
}

function appendRow(index: Map<string, CsvRow[]>, key: string, row: CsvRow): void {
  const group = index.get(key);
  if (group) group.push(row);
  else index.set(key, [row]);
}

/** All joins are indexed once per request, preserving ArtifactIndex's unambiguous legacy fallback. */
function snapshot(deps: RegisterMailHandlersDeps) {
  const cfg = deps.readConfigForPaths() as unknown as Config;
  const cwd = deps.realDataDir() || process.cwd();
  const ledger = readCsvRows(deps.ledgerCsvPath());
  const results = indexArtifactResults(readCsvRows(path.resolve(cwd, cfg.ocr.resultsCsv)));
  const ledgerByArtifact = new ArtifactIndex<CsvRow>();
  const ledgerByFilename = new Map<string, CsvRow>();
  const ledgerByMailHash = new Map<string, CsvRow[]>();
  const legacyLedgerByMessageId = new Map<string, CsvRow[]>();
  for (const row of ledger) {
    ledgerByArtifact.set(artifactIdentityForRow(row), row);
    if (!ledgerByFilename.has(row.filename || '')) ledgerByFilename.set(row.filename || '', row);
    appendRow(ledgerByMailHash, mailHashForRow(row), row);
    if (!row.mailHash) appendRow(legacyLedgerByMessageId, row.messageId || '', row);
  }
  const resultsByFilename = new Map<string, CsvRow>();
  const resultsByInvoiceNo = new Map<string, CsvRow[]>();
  for (const row of results.values()) {
    const filename = row.filename || '';
    const existing = resultsByFilename.get(filename);
    if (!existing || (existing.status?.toLowerCase() !== 'success' && row.status?.toLowerCase() === 'success')) {
      resultsByFilename.set(filename, row);
    }
    const number = (row.invoiceNo || '').trim();
    if (number) appendRow(resultsByInvoiceNo, number, row);
  }
  const resultFor = (row: CsvRow) => results.get(artifactIdentityForRow(row));
  const duplicateRows = (number: string) => resultsByInvoiceNo.get(number.trim()) || [];
  const asRow = (row: CsvRow, ocr = resultFor(row)): DetailInvoiceRow => {
    const filename = row.filename || '';
    const handle = issueInvoiceHandle(deps, filename);
    const number = (ocr?.invoiceNo || '').trim();
    const duplicateCount = duplicateRows(number).length;
    return {
      filename,
      filePath: handle,
      fileHandle: handle,
      date: ocr?.dateValue || row.date || '',
      seller: ocr?.seller || '待识别',
      amount: displayAmount(ocr?.amount || ''),
      invoiceNo: number,
      source: detailSource(row.source || ''),
      status: rowStatus(ocr),
      documentType: ocr?.documentType || '',
      invoiceType: ocr?.invoiceType || '',
      error: sanitizeText(ocr?.error || '', { maxLength: 200 }),
      mailHash: mailHashForRow({ ...ocr, ...row, mailHash: row.mailHash || ocr?.hash || '' }),
      messageId: row.messageId || ocr?.messageId || '',
      from: row.from || ocr?.from || '',
      subject: row.subject || ocr?.subject || '',
      contentHash: row.contentHash || ocr?.contentHash || '',
      duplicateGroup: duplicateCount > 1 ? number : '',
      duplicateCount: duplicateCount > 1 ? duplicateCount : 0,
    };
  };
  function documentsFor(hash: string, messageId: string): DetailInvoiceRow[] {
    const rows = new Set(ledgerByMailHash.get(hash) || []);
    if (messageId) {
      for (const row of legacyLedgerByMessageId.get(messageId) || []) rows.add(row);
    }
    return [...rows].map(row => asRow({ ...row, mailHash: row.mailHash || hash }));
  }
  function duplicatesFor(ocr: CsvRow | undefined, filename: string): DetailInvoiceRow[] {
    return duplicateRows(ocr?.invoiceNo || '')
      .filter(other => other.filename !== filename)
      .map(other => asRow(ledgerByArtifact.get(artifactIdentityForRow(other)) || other, other));
  }
  return {
    cfg, cwd, ledgerByMailHash, ledgerByFilename, resultsByFilename,
    resultFor, asRow, documentsFor, duplicatesFor,
  };
}

function projectHistory(cwd: string, hash: string): MailDetail['history'] {
  try {
    const entries: unknown = JSON.parse(fs.readFileSync(path.resolve(cwd, '.mfh-cache/gui-history.json'), 'utf8'));
    if (!Array.isArray(entries)) return [];
    return entries.map(asObject)
      .filter(entry => `${entry.detail || ''} ${entry.message || ''}`.toLowerCase().includes(hash))
      .map(entry => ({
        time: String(entry.time || ''),
        action: String(entry.action || ''),
        status: String(entry.status || ''),
        message: sanitizeText(String(entry.message || ''), { maxLength: 200 }),
      }));
  } catch {
    return []; // History is optional.
  }
}

function invoiceLinks(parsed: Awaited<ReturnType<typeof parseMailWithGuards>>): string[] {
  return extractMailUrls(parsed).filter(url => {
    if (siteHandlers.some(handler => handler.match(url))) return true;
    const target = new URL(url);
    if (/\.(pdf|ofd|zip)$/i.test(target.pathname)) return true;
    if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(target.pathname)) return linkedImageHasInvoiceEvidence(url);
    return target.hostname.toLowerCase() !== 'inv-veri.chinatax.gov.cn';
  });
}

async function readMail(target: string, deps: RegisterMailHandlersDeps) {
  const safe = deps.resolveOpenTarget(target);
  if (!safe.ok) throw new Error('mail_path_refused');
  const fd = fs.openSync(safe.path, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size > 32 * 1024 * 1024) throw new Error('mail_too_large');
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = fs.readSync(fd, bytes, offset, size - offset, offset);
      if (!read) break;
      offset += read;
    }
    return await parseMailWithGuards(bytes.subarray(0, offset));
  } finally {
    fs.closeSync(fd);
  }
}

export function registerDetailHandlers(deps: RegisterMailHandlersDeps): void {
  deps.handleTrusted('mfh:mail-detail', async (_event, payload) => {
    const missing = { ok: false, code: 'mail_not_found', message: '没有找到这封邮件。' };
    const hash = asObject(payload).hash;
    if (typeof hash !== 'string' || !MAIL_HASH_RE.test(hash)) return missing;
    try {
      const ctx = snapshot(deps);
      const normalized = hash.toLowerCase();
      const index = buildMailStatusIndex(ctx.cfg, ctx.cwd);
      if (!index.has(normalized)) return missing;
      const pendingRow = summarizePending(ctx.cfg, ctx.cwd).groups
        .flatMap(group => group.rows).find(row => row.hash === normalized);
      const indexed = readCsvRows(path.resolve(ctx.cwd, ctx.cfg.paths.samples, 'INDEX.csv'))
        .find(row => mailHashForRow(row) === normalized);
      const metadata = indexed || pendingRow || ctx.ledgerByMailHash.get(normalized)?.[0];
      let emlLocation: MailDetail['emlLocation'] = null;
      let parsed: Awaited<ReturnType<typeof parseMailWithGuards>> | undefined;
      for (const location of ['samples', 'pending'] as const) {
        const target = path.resolve(ctx.cwd, ctx.cfg.paths[location], `${normalized}.eml`);
        if (!fs.existsSync(target)) continue;
        emlLocation = location;
        parsed = await readMail(target, deps);
        break;
      }
      const messageId = metadata?.messageId || parsed?.messageId || '';
      const urls = parsed ? invoiceLinks(parsed) : [];
      const mail: MailDetail = {
        mailHash: normalized,
        messageId,
        date: metadata?.date || parsed?.date?.toISOString() || '',
        from: metadata?.from || parsed?.from?.text || '',
        subject: metadata?.subject || parsed?.subject || '',
        mailbox: indexed?.mailbox || '',
        hasAttachment: parsed ? parsed.attachments.length > 0 : indexed?.hasAttachment === '1',
        bodyLinkCount: parsed ? urls.length : Number(indexed?.bodyLinkCount || 0),
        ...mailStatusFor(index, normalized),
        emlExists: emlLocation !== null,
        emlLocation,
        attachments: (parsed?.attachments || []).slice(0, 50).map(attachment => ({
          filename: attachment.filename || '',
          size: attachment.size,
          contentType: attachment.contentType,
        })),
        links: urls.slice(0, 50).map(url => ({ url: detailLinkUrl(url), label: '' })),
        documents: ctx.documentsFor(normalized, messageId),
        pending: pendingRow ? pick(pendingRow as unknown as CsvRow, [
          'reason', 'category', 'userMessage', 'nextStep',
        ]) : null,
        history: projectHistory(ctx.cwd, normalized),
      };
      return { ok: true, mail };
    } catch {
      return { ok: false, code: 'eml_unreadable', message: '无法读取邮件详情，请稍后重试。' };
    }
  });

  deps.handleTrusted('mfh:invoice-detail', (_event, payload) => {
    const missing = { ok: false, code: 'invoice_not_found', message: '没有找到这张发票。' };
    const filename = asObject(payload).filename;
    if (typeof filename !== 'string') return missing;
    const target = invoicePath(deps.invoicesDirPath(), filename);
    if (!target) return missing;
    try {
      const ctx = snapshot(deps);
      const ledger = ctx.ledgerByFilename.get(filename);
      const ocr = ledger ? ctx.resultFor(ledger) : ctx.resultsByFilename.get(filename);
      let stat: fs.Stats | undefined;
      try {
        stat = fs.statSync(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if ((stat && !stat.isFile()) || (!ledger && !ocr && !stat)) return missing;
      const row = ctx.asRow(ledger || ocr || { filename }, ocr);
      const invoice: InvoiceDetail = {
        row,
        ocr: ocr ? { ...pick(ocr, ocrFields), error: sanitizeText(ocr.error || '', { maxLength: 200 }) } : null,
        ledger: ledger ? { ...pick(ledger, ledgerFields), source: detailSource(ledger.source || '') } : null,
        file: {
          handle: row.fileHandle,
          exists: !!stat,
          size: stat?.size || 0,
          format: path.extname(filename).slice(1).toLowerCase(),
        },
        duplicates: ctx.duplicatesFor(ocr, filename),
      };
      return { ok: true, invoice };
    } catch {
      return missing;
    }
  });
}
