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
import { buildMailStatusIndex, mailHashForRow, mailStatusFor, type MailStatus } from '../mailStatus.js';
import { LIBRARY_STATUS, type InvoiceRow, type InboxRow, type AppSummary } from '../summary.js';
import { sanitizeText } from '../sanitize.js';
import { asObject } from '../payload.js';
import type { RegisterMailHandlersDeps } from './mailHandlers.js';

type CsvRow = Record<string, string>;
export interface DetailInvoiceRow extends InvoiceRow {
  mailHash: string; messageId: string; from: string; subject: string; contentHash: string;
  duplicateGroup: string; duplicateCount: number; fileHandle: string;
}
export interface MailDetail extends InboxRow {
  mailHash: string; status: MailStatus; emlExists: boolean; emlLocation: 'samples' | 'pending' | null;
  attachments: { filename: string; size: number; contentType: string }[];
  links: { url: string; label: string }[];
  documents: DetailInvoiceRow[];
  pending: (PendingCopy & { reason: string }) | null;
  history: { time: string; action: string; status: string; message: string }[];
}
const ocrFields = ['documentType', 'invoiceType', 'seller', 'amount', 'dateValue', 'invoiceNo', 'transport', 'extractedBy', 'parserVersion', 'ocrVendor', 'status', 'error'] as const;
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
  const current = new Map<string, CsvRow>();
  for (const row of rows) {
    const key = `${row.filename || ''}\0${row.contentHash || ''}`;
    const previous = current.get(key);
    if (previous?.status?.toLowerCase() === 'success' && row.status?.toLowerCase() !== 'success') continue;
    current.set(key, row);
  }
  return [...current.values()];
}

/** Keep ordinary signed URLs intact; only long query values are hidden. */
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

function pick<K extends string>(row: CsvRow, fields: readonly K[]): Record<K, string> {
  return Object.fromEntries(fields.map(key => [key, row[key] || ''])) as Record<K, string>;
}

export function registerDetailHandlers(deps: RegisterMailHandlersDeps): void {
  function context() {
    const cfg = deps.readConfigForPaths() as unknown as Config;
    const cwd = deps.realDataDir() || process.cwd();
    const summary = deps.appSummary() as AppSummary;
    const ledger = readCsvRows(deps.ledgerCsvPath());
    const results = currentOcrRows(readCsvRows(path.resolve(cwd, cfg.ocr.resultsCsv)));
    const resultFor = (row: CsvRow) => results.find(result => result.filename === row.filename && (result.contentHash || '') === (row.contentHash || ''));
    const asRow = (row: CsvRow, ocr = resultFor(row)): DetailInvoiceRow => {
      const filename = row.filename || '';
      const target = invoicePath(deps.invoicesDirPath(), filename);
      // The public facade invokes its private rendererOpenablePath; keep all redaction there.
      const handle = target ? deps.sanitizeAppSummary({ ...summary, library: { ...summary.library, rows: [{ filename, filePath: target, fileHandle: target, mailHash: '', messageId: '', from: '', subject: '', contentHash: '', duplicateGroup: '', duplicateCount: 0, date: '', seller: '', invoiceNo: '', amount: '', source: '', status: LIBRARY_STATUS.PENDING, documentType: '', invoiceType: '', error: '' }] } }).library.rows[0]?.filePath || '' : '';
      const number = ocr?.invoiceNo || '';
      const duplicateCount = /^\d{20}$/.test(number) && ocr?.status?.toLowerCase() === 'success'
        ? results.filter(r => r.status?.toLowerCase() === 'success' && r.invoiceNo === number).length : 0;
      const amount = ocr?.amount || '';
      const numeric = Number(amount.replace(/[^\d.-]/g, ''));
      return {
        filename, filePath: handle, fileHandle: handle, date: ocr?.dateValue || row.date || '',
        seller: ocr?.seller || '待识别', amount: amount && Number.isFinite(numeric) ? `¥ ${numeric.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : amount,
        invoiceNo: number, source: row.source || '', status: !ocr ? LIBRARY_STATUS.PENDING : ocr.status === 'error' ? LIBRARY_STATUS.FAILED : ocr.status === 'success' && (number || ocr.seller || amount) ? LIBRARY_STATUS.COMPLETE : LIBRARY_STATUS.PENDING,
        documentType: ocr?.documentType || '', invoiceType: ocr?.invoiceType || '', error: sanitizeText(ocr?.error || '', { maxLength: 200 }),
        mailHash: row.mailHash || ocr?.hash || mailHashForRow(row), messageId: row.messageId || ocr?.messageId || '',
        from: row.from || ocr?.from || '', subject: row.subject || ocr?.subject || '', contentHash: row.contentHash || '',
        duplicateGroup: duplicateCount > 1 ? number : '', duplicateCount: duplicateCount > 1 ? duplicateCount : 0,
      };
    };
    return { cfg, cwd, ledger, results, resultFor, asRow };
  }

  deps.handleTrusted('mfh:mail-detail', async (_event, payload) => {
    const hash = asObject(payload).hash;
    if (typeof hash !== 'string' || !MAIL_HASH_RE.test(hash)) return { ok: false, code: 'mail_not_found', message: '没有找到这封邮件。' };
    try {
      const ctx = context();
      const normalized = hash.toLowerCase();
      const index = buildMailStatusIndex(ctx.cfg, ctx.cwd);
      if (!index.has(normalized)) return { ok: false, code: 'mail_not_found', message: '没有找到这封邮件。' };
      const pendingRow = summarizePending(ctx.cfg, ctx.cwd).groups.flatMap(g => g.rows).find(r => r.hash === normalized);
      const indexed = readCsvRows(path.resolve(ctx.cwd, ctx.cfg.paths.samples, 'INDEX.csv')).find(r => mailHashForRow(r) === normalized);
      const metadata = indexed || pendingRow || ctx.ledger.find(r => mailHashForRow(r) === normalized);
      let emlLocation: MailDetail['emlLocation'] = null;
      let parsed: Awaited<ReturnType<typeof parseMailWithGuards>> | undefined;
      for (const location of ['samples', 'pending'] as const) {
        const target = path.resolve(ctx.cwd, ctx.cfg.paths[location], `${normalized}.eml`);
        if (!fs.existsSync(target)) continue;
        emlLocation = location;
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
          parsed = await parseMailWithGuards(bytes.subarray(0, offset));
        } finally { fs.closeSync(fd); }
        break;
      }
      const messageId = metadata?.messageId || parsed?.messageId || '';
      const urls = parsed ? extractMailUrls(parsed).filter(url => {
        if (siteHandlers.some(handler => handler.match(url))) return true;
        const target = new URL(url);
        if (/\.(pdf|ofd|zip)$/i.test(target.pathname)) return true;
        if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(target.pathname)) return linkedImageHasInvoiceEvidence(url);
        return target.hostname.toLowerCase() !== 'inv-veri.chinatax.gov.cn';
      }) : [];
      let history: MailDetail['history'] = [];
      try {
        const entries: unknown = JSON.parse(fs.readFileSync(path.resolve(ctx.cwd, '.mfh-cache/gui-history.json'), 'utf8'));
        if (Array.isArray(entries)) history = entries.filter(entry => `${entry?.detail || ''} ${entry?.message || ''}`.toLowerCase().includes(normalized)).map(entry => ({ time: String(entry.time || ''), action: String(entry.action || ''), status: String(entry.status || ''), message: sanitizeText(String(entry.message || ''), { maxLength: 200 }) }));
      } catch { /* History is optional. */ }
      const mail: MailDetail = {
        mailHash: normalized, messageId, date: metadata?.date || parsed?.date?.toISOString() || '',
        from: metadata?.from || parsed?.from?.text || '', subject: metadata?.subject || parsed?.subject || '',
        mailbox: indexed?.mailbox || '', hasAttachment: parsed ? parsed.attachments.length > 0 : indexed?.hasAttachment === '1',
        bodyLinkCount: parsed ? urls.length : Number(indexed?.bodyLinkCount || 0), ...mailStatusFor(index, normalized),
        emlExists: emlLocation !== null, emlLocation,
        attachments: (parsed?.attachments || []).slice(0, 50).map(a => ({ filename: a.filename || '', size: a.size, contentType: a.contentType })),
        links: urls.slice(0, 50).map(url => ({ url: detailLinkUrl(url), label: '' })),
        documents: ctx.ledger.filter(row => row.mailHash ? row.mailHash.toLowerCase() === normalized : !!messageId && row.messageId === messageId).map(row => ctx.asRow({ ...row, mailHash: row.mailHash || normalized })),
        pending: pendingRow ? pick(pendingRow as unknown as CsvRow, ['reason', 'category', 'userMessage', 'nextStep']) : null,
        history,
      };
      return { ok: true, mail };
    } catch { return { ok: false, code: 'eml_unreadable', message: '无法读取邮件详情，请稍后重试。' }; }
  });

  deps.handleTrusted('mfh:invoice-detail', (_event, payload) => {
    const missing = { ok: false, code: 'invoice_not_found', message: '没有找到这张发票。' };
    const filename = asObject(payload).filename;
    if (typeof filename !== 'string') return missing;
    const target = invoicePath(deps.invoicesDirPath(), filename);
    if (!target) return missing;
    try {
      const ctx = context();
      const ledger = ctx.ledger.find(row => row.filename === filename);
      const ocr = ledger ? ctx.resultFor(ledger) : ctx.results.filter(row => row.filename === filename).sort((a, b) => Number(b.status === 'success') - Number(a.status === 'success'))[0];
      let stat: fs.Stats | undefined;
      try { stat = fs.statSync(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if ((stat && !stat.isFile()) || (!ledger && !ocr && !stat)) return missing;
      const row = ctx.asRow(ledger || ocr || { filename }, ocr);
      const invoice: InvoiceDetail = {
        row, ocr: ocr ? { ...pick(ocr, ocrFields), error: sanitizeText(ocr.error || '', { maxLength: 200 }) } : null,
        ledger: ledger ? pick(ledger, ledgerFields) : null,
        file: { handle: row.fileHandle, exists: !!stat, size: stat?.size || 0, format: path.extname(filename).slice(1).toLowerCase() },
        duplicates: ocr?.status === 'success' && /^\d{20}$/.test(ocr.invoiceNo || '') ? ctx.results.filter(other => other.status === 'success' && other.invoiceNo === ocr.invoiceNo && other.filename !== filename).map(other => ctx.asRow(ctx.ledger.find(l => l.filename === other.filename && l.contentHash === other.contentHash) || other, other)) : [],
      };
      return { ok: true, invoice };
    } catch { return missing; }
  });
}
