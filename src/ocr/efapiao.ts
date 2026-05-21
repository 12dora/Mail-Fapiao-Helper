import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.js';
import type { DocumentFormat, DocumentType } from '../extract/types.js';
import type { OcrProvider, OcrResult } from './types.js';

interface EfapiaoPayload {
  index?: number;
  filename?: string;
  status?: string;
  code?: string;
  message?: string;
  data?: Record<string, unknown>;
  engine?: Record<string, unknown>;
  document_type?: string | null;
  invoice_type?: string | null;
}

interface EfapiaoBatchPayload {
  status?: string;
  total?: number;
  succeeded?: number;
  failed?: number;
  items?: EfapiaoPayload[];
  detail?: unknown;
}

interface ServiceState {
  ready: boolean;
  failed: boolean;
  child?: ChildProcess;
  failureReason?: string;
}

const EFAPIAO_VERSION = '0.1.2';
const serviceStates = new Map<string, ServiceState>();

function platformArch(): string {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'darwin-x86_64';
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x86_64';
  if (process.platform === 'linux' && process.arch === 'arm64') return 'linux-arm64';
  if (process.platform === 'win32' && process.arch === 'x64') return 'windows-x86_64';
  return `${process.platform}-${process.arch}`;
}

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..');
}

function bundledBinaryPath(): string | undefined {
  const exe = process.platform === 'win32' ? 'efapiao.exe' : 'efapiao';
  const candidate = path.join(repoRoot(), 'vendor', 'efapiao', EFAPIAO_VERSION, platformArch(), exe);
  return fs.existsSync(candidate) ? candidate : undefined;
}

function binaryPath(cfg: Config): string {
  if (cfg.ocr.binaryPath !== 'auto') return cfg.ocr.binaryPath;
  return bundledBinaryPath() ?? 'efapiao';
}

function stringValue(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function nestedName(v: unknown): string {
  if (v && typeof v === 'object' && 'name' in v) {
    return stringValue((v as { name?: unknown }).name);
  }
  return '';
}

function nestedRecord(v: unknown, key: string): Record<string, unknown> {
  if (v && typeof v === 'object' && key in v) {
    const child = (v as Record<string, unknown>)[key];
    if (child && typeof child === 'object') return child as Record<string, unknown>;
  }
  return {};
}

function hintFor(format: DocumentFormat): string {
  return format === 'ofd' ? 'ofd' : 'pdf';
}

function documentTypeFromEfapiao(value: string, fallback: DocumentType): DocumentType {
  if (value.includes('itinerary') || value.includes('rail')) return 'itinerary';
  if (value.includes('fapiao')) return 'invoice';
  return fallback;
}

function parseEfapiaoJson(text: string): EfapiaoPayload {
  const trimmed = text.trim();
  if (!trimmed) return {};
  return JSON.parse(trimmed) as EfapiaoPayload;
}

function compactError(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function serviceBaseUrl(cfg: Config): string {
  if (cfg.ocr.serviceUrl) return cfg.ocr.serviceUrl.replace(/\/+$/, '');
  return `http://${cfg.ocr.serviceHost}:${cfg.ocr.servicePort}`;
}

function serviceKey(cfg: Config): string {
  return `${binaryPath(cfg)}\0${cfg.ocr.serviceHost}\0${cfg.ocr.servicePort}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref();
  return controller.signal;
}

function toEfapiaoPayload(value: unknown): EfapiaoPayload {
  if (value && typeof value === 'object') return value as EfapiaoPayload;
  return {};
}

async function healthOk(cfg: Config): Promise<boolean> {
  try {
    const res = await fetch(`${serviceBaseUrl(cfg)}/v1/health`, {
      method: 'GET',
      signal: timeoutSignal(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(cfg: Config, child: ChildProcess, state: ServiceState): Promise<void> {
  const deadline = Date.now() + cfg.ocr.serviceStartupMs;
  const stderr: Buffer[] = [];
  const onStderr = (chunk: Buffer) => stderr.push(chunk);
  const onExit = (code: number | null) => {
    if (!state.ready) {
      state.failed = true;
      state.failureReason = `efapiao_serve_exit_${code}:${compactError(Buffer.concat(stderr).toString('utf8'))}`;
    }
  };
  child.stderr?.on('data', onStderr);
  child.on('exit', onExit);

  while (Date.now() < deadline) {
    if (await healthOk(cfg)) {
      state.ready = true;
      child.stderr?.off('data', onStderr);
      child.off('exit', onExit);
      child.stdout?.destroy();
      child.stderr?.destroy();
      return;
    }
    if (state.failed) break;
    await sleep(300);
  }

  child.kill('SIGTERM');
  const reason = state.failureReason || `efapiao_serve_unhealthy:${serviceBaseUrl(cfg)}/v1/health`;
  state.failed = true;
  state.failureReason = reason;
  throw new Error(reason);
}

async function ensureService(cfg: Config): Promise<void> {
  if (await healthOk(cfg)) return;

  const key = serviceKey(cfg);
  const existing = serviceStates.get(key);
  if (existing?.ready) return;
  if (existing?.failed) throw new Error(existing.failureReason || 'efapiao_serve_failed');

  const state: ServiceState = { ready: false, failed: false };
  serviceStates.set(key, state);
  const child = spawn(binaryPath(cfg), [
    'serve',
    '--host',
    cfg.ocr.serviceHost,
    '--port',
    String(cfg.ocr.servicePort),
    '--workers',
    String(cfg.ocr.serviceWorkers),
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, EFAPIAO_OCR_VENDOR: process.env.EFAPIAO_OCR_VENDOR ?? 'none' },
  });
  state.child = child;
  child.unref();
  await waitForHealth(cfg, child, state);
}

async function runService(
  cfg: Config,
  data: Buffer,
  meta: { format: DocumentFormat; filename: string },
): Promise<EfapiaoPayload> {
  await ensureService(cfg);
  const form = new FormData();
  form.set('file', new Blob([data]), meta.filename);
  form.set('hint_type', hintFor(meta.format));
  form.set('ocr_mode', 'auto');

  const res = await fetch(`${serviceBaseUrl(cfg)}/v1/invoices/parse`, {
    method: 'POST',
    body: form,
    signal: timeoutSignal(cfg.ocr.timeoutMs),
  });
  const text = await res.text();
  let payload: EfapiaoPayload;
  try {
    payload = parseEfapiaoJson(text);
  } catch {
    throw new Error(`efapiao_http_invalid_json:http_${res.status}:${compactError(text)}`);
  }
  if (res.ok) return payload;
  return {
    status: 'error',
    ...(payload as Record<string, unknown>),
    ...nestedRecord(payload, 'detail'),
  };
}

async function runServiceBatch(
  cfg: Config,
  items: Array<{ data: Buffer; meta: { filename: string } }>,
): Promise<EfapiaoPayload[]> {
  await ensureService(cfg);
  const form = new FormData();
  for (const item of items) {
    form.append('files', new Blob([item.data]), item.meta.filename);
  }
  form.set('hint_type', 'auto');
  form.set('ocr_mode', 'auto');

  const res = await fetch(`${serviceBaseUrl(cfg)}/v1/invoices/parse-batch`, {
    method: 'POST',
    body: form,
    signal: timeoutSignal(cfg.ocr.timeoutMs),
  });
  const text = await res.text();
  let payload: EfapiaoBatchPayload;
  try {
    payload = parseEfapiaoJson(text) as EfapiaoBatchPayload;
  } catch {
    throw new Error(`efapiao_http_invalid_json:http_${res.status}:${compactError(text)}`);
  }

  if (!res.ok) {
    const detail = toEfapiaoPayload(payload.detail);
    throw new Error(`efapiao_http_batch_error:http_${res.status}:${compactError(detail.message || text)}`);
  }
  if (!Array.isArray(payload.items)) {
    throw new Error(`efapiao_http_batch_invalid_response:${compactError(text)}`);
  }

  const byIndex = new Map<number, EfapiaoPayload>();
  for (const item of payload.items) {
    if (typeof item.index === 'number') byIndex.set(item.index, item);
  }
  return items.map((_, index) => byIndex.get(index) ?? {
    status: 'error',
    code: 'missing_batch_item',
    message: `efapiao batch response missing item index ${index}`,
  });
}

function runBinary(
  cfg: Config,
  data: Buffer,
  meta: { format: DocumentFormat; documentType: DocumentType; filename: string },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath(cfg), [
      'parse',
      '-',
      '--hint',
      hintFor(meta.format),
      '--ocr-mode',
      'auto',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, EFAPIAO_OCR_VENDOR: process.env.EFAPIAO_OCR_VENDOR ?? 'none' },
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`efapiao timeout after ${cfg.ocr.timeoutMs}ms`));
    }, cfg.ocr.timeoutMs);

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });

    child.stdin.end(data);
  });
}

function okResult(payload: EfapiaoPayload, fallbackDocumentType: DocumentType, transport: 'cli' | 'http'): OcrResult {
  const data = payload.data ?? {};
  const source = nestedRecord(data, 'source');
  const documentTypeRaw = stringValue(data.document_type) || stringValue(payload.document_type);
  const invoiceType = stringValue(data.invoice_type) || stringValue(payload.invoice_type);
  const sourceFormat = stringValue(source.format);
  return {
    status: 'success',
    fields: {
      seller: nestedName(data.seller),
      amount: stringValue(data.amount_with_tax) || stringValue(data.amount_without_tax),
      date: stringValue(data.issue_date),
      invoiceNo: stringValue(data.invoice_number) || stringValue(data.invoice_code),
      documentType: documentTypeFromEfapiao(documentTypeRaw, fallbackDocumentType),
      invoiceType,
    },
    error: '',
    source: {
      format: sourceFormat === 'ofd' ? 'ofd' : 'pdf',
      parserVersion: stringValue(source.parser_version),
      extractedBy: stringValue(source.extracted_by),
      ocrVendor: stringValue(source.ocr_vendor) || null,
    },
    transport,
    raw: payload,
  };
}

function errorResult(payload: EfapiaoPayload, fallbackError: string, transport: 'cli' | 'http'): OcrResult {
  const code = stringValue(payload.code);
  const message = stringValue(payload.message);
  const error = [code, message].filter(Boolean).join(':') || fallbackError;
  return {
    status: 'error',
    fields: {
      invoiceType: stringValue(payload.invoice_type),
      documentType: documentTypeFromEfapiao(stringValue(payload.document_type), 'invoice'),
    },
    error,
    transport,
    raw: payload,
  };
}

async function parseViaCli(cfg: Config, data: Buffer, meta: { format: DocumentFormat; documentType: DocumentType; filename: string }): Promise<OcrResult> {
  const result = await runBinary(cfg, data, meta);
  const rawJson = result.code === 0 ? result.stdout : result.stderr || result.stdout;
  let payload: EfapiaoPayload;
  try {
    payload = parseEfapiaoJson(rawJson);
  } catch {
    return {
      status: 'error',
      fields: {},
      error: `efapiao_invalid_json:exit_${result.code}:${compactError(rawJson)}`,
      transport: 'cli',
      raw: rawJson,
    };
  }

  if (result.code === 0 && payload.status === 'ok') {
    return okResult(payload, meta.documentType, 'cli');
  }
  return errorResult(payload, `efapiao_exit_${result.code}`, 'cli');
}

async function parseViaService(cfg: Config, data: Buffer, meta: { format: DocumentFormat; documentType: DocumentType; filename: string }): Promise<OcrResult> {
  const payload = await runService(cfg, data, meta);
  if (payload.status === 'ok') {
    return okResult(payload, meta.documentType, 'http');
  }
  return errorResult(payload, 'efapiao_http_error', 'http');
}

async function parseBatchViaService(
  cfg: Config,
  items: Array<{ data: Buffer; meta: { format: DocumentFormat; documentType: DocumentType; filename: string } }>,
): Promise<OcrResult[]> {
  const payloads = await runServiceBatch(cfg, items);
  return payloads.map((payload, index) => {
    const meta = items[index]?.meta;
    if (payload.status === 'ok') {
      return okResult(payload, meta?.documentType ?? 'invoice', 'http');
    }
    return errorResult(payload, 'efapiao_http_error', 'http');
  });
}

export function createEfapiaoProvider(cfg: Config): OcrProvider {
  return {
    name: 'efapiao',

    async parse(data, meta): Promise<OcrResult> {
      if (cfg.ocr.executionMode === 'cli') {
        return parseViaCli(cfg, data, meta);
      }

      try {
        return await parseViaService(cfg, data, meta);
      } catch (err) {
        if (cfg.ocr.executionMode === 'serve') throw err;
        const reason = err instanceof Error ? err.message : String(err);
        const cliResult = await parseViaCli(cfg, data, meta);
        if (!cliResult.error) return cliResult;
        cliResult.error = `serve_fallback:${reason};${cliResult.error}`;
        return cliResult;
      }
    },

    async parseBatch(items): Promise<OcrResult[]> {
      if (cfg.ocr.executionMode === 'cli') {
        const results: OcrResult[] = [];
        for (const item of items) {
          results.push(await parseViaCli(cfg, item.data, item.meta));
        }
        return results;
      }

      try {
        return await parseBatchViaService(cfg, items);
      } catch (err) {
        if (cfg.ocr.executionMode === 'serve') throw err;
        const reason = err instanceof Error ? err.message : String(err);
        const results: OcrResult[] = [];
        for (const item of items) {
          const cliResult = await parseViaCli(cfg, item.data, item.meta);
          if (cliResult.error) cliResult.error = `serve_fallback:${reason};${cliResult.error}`;
          results.push(cliResult);
        }
        return results;
      }
    },
  };
}
