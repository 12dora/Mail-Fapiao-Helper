import { spawn } from 'node:child_process';
import type { Config } from '../config.js';
import type { DocumentFormat, DocumentType } from '../extract/types.js';
import type { OcrProvider, OcrResult } from './types.js';

interface EfapiaoPayload {
  status?: string;
  code?: string;
  message?: string;
  data?: Record<string, unknown>;
  engine?: Record<string, unknown>;
  document_type?: string | null;
  invoice_type?: string | null;
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

function runBinary(
  cfg: Config,
  data: Buffer,
  meta: { format: DocumentFormat; documentType: DocumentType; filename: string },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cfg.ocr.binaryPath, [
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

function okResult(payload: EfapiaoPayload, fallbackDocumentType: DocumentType): OcrResult {
  const data = payload.data ?? {};
  const documentTypeRaw = stringValue(data.document_type) || stringValue(payload.document_type);
  const invoiceType = stringValue(data.invoice_type) || stringValue(payload.invoice_type);
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
    raw: payload,
  };
}

function errorResult(payload: EfapiaoPayload, fallbackError: string): OcrResult {
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
    raw: payload,
  };
}

export function createEfapiaoProvider(cfg: Config): OcrProvider {
  return {
    name: 'efapiao',

    async parse(data, meta): Promise<OcrResult> {
      const result = await runBinary(cfg, data, meta);
      const rawJson = result.code === 0 ? result.stdout : result.stderr || result.stdout;
      let payload: EfapiaoPayload;
      try {
        payload = parseEfapiaoJson(rawJson);
      } catch {
        return {
          status: 'error',
          fields: {},
          error: `efapiao_invalid_json:exit_${result.code}:${rawJson.slice(0, 500)}`,
          raw: rawJson,
        };
      }

      if (result.code === 0 && payload.status === 'ok') {
        return okResult(payload, meta.documentType);
      }
      return errorResult(payload, `efapiao_exit_${result.code}`);
    },
  };
}
