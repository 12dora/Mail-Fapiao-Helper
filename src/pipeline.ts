import fs from 'node:fs';
import path from 'node:path';
import type { ParsedMail } from 'mailparser';
import type { Browser } from 'playwright';
import type { Config } from './config.js';
import type { Logger } from './log.js';
import type { State } from './state.js';
import { msgIdHash as msgIdHashFn } from './util/hash.js';
import { extractors } from './extract/registry.js';
import type { Ctx } from './extract/types.js';
import { downloadDocuments } from './download/downloader.js';

interface CsvRow {
  messageId: string;
  date: string;
  from: string;
  subject: string;
  filename: string;
  source: string;
}

interface OcrPendingRow extends CsvRow {
  hash: string;
  format: string;
  documentType: string;
  reason: string;
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

export interface ProcessMailResult {
  hash: string;
  messageId: string;
  date: string;
  from: string;
  subject: string;
  outcome: 'pdf' | 'manual' | 'skip';
  reason?: string;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function csvCell(v: string): string {
  if (/[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function csvContainsDocument(csvPath: string, row: CsvRow): boolean {
  if (!fs.existsSync(csvPath)) return false;
  const content = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  const lines = content.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cols = parseCsvLine(line);
    if ((cols[0] ?? '') === row.messageId && (cols[5] ?? '') === row.source) {
      return true;
    }
  }
  return false;
}

function appendCsv(csvPath: string, row: CsvRow): void {
  const exists = fs.existsSync(csvPath);
  const header = 'messageId,date,from,subject,filename,source\n';
  const line = [
    row.messageId,
    row.date,
    row.from,
    row.subject,
    row.filename,
    row.source,
  ].map(csvCell).join(',') + '\n';

  if (!exists) {
    fs.writeFileSync(csvPath, '﻿' + header + line, 'utf8');
  } else {
    if (csvContainsDocument(csvPath, row)) {
      return;
    }
    fs.appendFileSync(csvPath, line, 'utf8');
  }
}

function appendOcrPendingCsv(csvPath: string, row: OcrPendingRow): void {
  const exists = fs.existsSync(csvPath);
  const header = 'hash,messageId,date,from,subject,filename,source,format,documentType,reason\n';
  const line = [
    row.hash,
    row.messageId,
    row.date,
    row.from,
    row.subject,
    row.filename,
    row.source,
    row.format,
    row.documentType,
    row.reason,
  ].map(csvCell).join(',') + '\n';

  ensureDir(path.dirname(csvPath));
  if (!exists) {
    fs.writeFileSync(csvPath, '﻿' + header + line, 'utf8');
  } else {
    const content = fs.readFileSync(csvPath, 'utf8');
    if (content.includes(`${row.hash},`) && content.includes(row.filename)) {
      return;
    }
    fs.appendFileSync(csvPath, line, 'utf8');
  }
}

function writePendingEml(mail: ParsedMail, pendingDir: string, hash: string): void {
  ensureDir(pendingDir);
  const emlPath = path.join(pendingDir, `${hash}.eml`);
  const tmpPath = `${emlPath}.tmp`;

  if (fs.existsSync(emlPath)) return;

  const raw = (mail as any).raw || Buffer.from('');
  fs.writeFileSync(tmpPath, raw);
  fs.renameSync(tmpPath, emlPath);
}

function appendPendingCsv(csvPath: string, mail: ParsedMail, reason: string): void {
  const exists = fs.existsSync(csvPath);
  const header = 'messageId,date,from,subject,reason\n';
  const messageId = mail.messageId || '';
  const date = mail.date?.toISOString() || '';
  const from = mail.from?.text || '';
  const subject = mail.subject || '';
  const line = [messageId, date, from, subject, reason].map(csvCell).join(',') + '\n';

  if (!exists) {
    fs.writeFileSync(csvPath, '﻿' + header + line, 'utf8');
  } else {
    const content = fs.readFileSync(csvPath, 'utf8');
    if (content.includes(messageId)) {
      return;
    }
    fs.appendFileSync(csvPath, line, 'utf8');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function requestUrl(input: FetchInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestMethod(init: FetchInit): string {
  return (init?.method ?? 'GET').toUpperCase();
}

function makeRetryingFetch(cfg: Config, log: Logger): typeof fetch {
  return (async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const attempts = cfg.network.retries + 1;
    const url = requestUrl(input);
    const method = requestMethod(init);
    let lastError = '';

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await fetch(input, init);
        if (!isRetryableStatus(response.status)) {
          return response;
        }
        lastError = `http_${response.status}`;
        if (attempt === attempts) {
          throw new Error(`network_retry_failed:${method}:${url}:${lastError}`);
        }
        log.warn(`network retry ${attempt}/${cfg.network.retries} ${method} ${url}: ${lastError}`);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('network_retry_failed:')) {
          throw err;
        }
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt === attempts) {
          throw new Error(`network_retry_failed:${method}:${url}:${lastError}`);
        }
        log.warn(`network retry ${attempt}/${cfg.network.retries} ${method} ${url}: ${lastError}`);
      }

      if (cfg.network.retryDelayMs > 0) {
        await sleep(cfg.network.retryDelayMs * attempt);
      }
    }

    throw new Error(`network_retry_failed:${method}:${url}:${lastError || 'unknown'}`);
  }) as typeof fetch;
}

export async function processMail(
  mail: ParsedMail,
  cfg: Config,
  log: Logger,
  state: State,
  saveState: () => void,
  browser: () => Promise<Browser>,
  opts: { force?: boolean } = {},
): Promise<ProcessMailResult> {
  const hash = msgIdHashFn(
    mail.messageId ?? undefined,
    mail.from?.text ?? '',
    mail.date?.toISOString() ?? '',
    mail.subject ?? '',
  );
  const messageId = mail.messageId || hash;
  const baseResult = {
    hash,
    messageId,
    date: mail.date?.toISOString() || '',
    from: mail.from?.text || '',
    subject: mail.subject || '',
  };

  if (!opts.force && state.processedHashes.includes(hash)) {
    log.debug(`Skip already processed ${hash}`);
    return { ...baseResult, outcome: 'skip', reason: 'already_processed' };
  }

  const ctx: Ctx = {
    cfg,
    log,
    browser,
    http: makeRetryingFetch(cfg, log),
  };

  let matchedExtractor = null;
  for (const extractor of extractors) {
    if (extractor.canHandle(mail)) {
      matchedExtractor = extractor;
      break;
    }
  }

  if (!matchedExtractor) {
    log.info(`No extractor matched ${hash}, -> manual`);
    writePendingEml(mail, cfg.paths.pending, hash);
    appendPendingCsv(path.join(cfg.paths.pending, 'pending.csv'), mail, 'no_extractor');
    if (!state.processedHashes.includes(hash)) state.processedHashes.push(hash);
    saveState();
    return { ...baseResult, outcome: 'manual', reason: 'no_extractor' };
  }

  log.info(`Matched extractor: ${matchedExtractor.name} for ${hash}`);

  let result;
  try {
    result = await matchedExtractor.extract(mail, ctx);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const reason = `${matchedExtractor.name}:${errMsg}`;
    log.warn(`Extractor failed for ${hash}: ${reason}`);
    writePendingEml(mail, cfg.paths.pending, hash);
    appendPendingCsv(path.join(cfg.paths.pending, 'pending.csv'), mail, reason);
    if (!state.processedHashes.includes(hash)) state.processedHashes.push(hash);
    saveState();
    return { ...baseResult, outcome: 'manual', reason };
  }

  if (result.kind === 'skip') {
    log.info(`Skipped ${hash}`);
    if (!state.processedHashes.includes(hash)) state.processedHashes.push(hash);
    saveState();
    return { ...baseResult, outcome: 'skip' };
  }

  if (result.kind === 'manual') {
    log.info(`Manual ${hash}: ${result.reason}`);
    writePendingEml(mail, cfg.paths.pending, hash);
    appendPendingCsv(path.join(cfg.paths.pending, 'pending.csv'), mail, result.reason);
    if (!state.processedHashes.includes(hash)) state.processedHashes.push(hash);
    saveState();
    return { ...baseResult, outcome: 'manual', reason: result.reason };
  }

  const downloads = await downloadDocuments(result.pdfs, hash, cfg.paths.invoices, log);

  const csvPath = path.join(cfg.paths.invoices, 'invoices.csv');
  const ocrPendingCsvPath = path.join(cfg.paths.invoices, 'ocr', 'ocr-pending.csv');
  for (let i = 0; i < downloads.length; i++) {
    const dl = downloads[i];
    const pdf = result.pdfs[i];
    if (!dl || !pdf) continue;

    appendCsv(csvPath, {
      messageId,
      date: mail.date?.toISOString() || '',
      from: mail.from?.text || '',
      subject: mail.subject || '',
      filename: dl.filename,
      source: pdf.source,
    });

    if (pdf.requiresOcr || pdf.format === 'ofd') {
      appendOcrPendingCsv(ocrPendingCsvPath, {
        hash,
        messageId,
        date: mail.date?.toISOString() || '',
        from: mail.from?.text || '',
        subject: mail.subject || '',
        filename: dl.filename,
        source: pdf.source,
        format: pdf.format ?? 'pdf',
        documentType: pdf.documentType ?? 'invoice',
        reason: pdf.format === 'ofd' ? 'ofd_itinerary_requires_ocr' : 'requires_ocr',
      });
    }
  }

  log.info(`Processed ${hash}: ${downloads.length} documents`);
  if (!state.processedHashes.includes(hash)) state.processedHashes.push(hash);
  saveState();
  return { ...baseResult, outcome: 'pdf' };
}
