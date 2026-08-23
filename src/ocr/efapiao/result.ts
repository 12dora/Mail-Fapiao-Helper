import type { DocumentType } from '../../extract/types.js';
import type { InvoiceFields, OcrResult } from '../types.js';

export interface EfapiaoPayload {
  index?: number;
  filename?: string;
  status?: string;
  code?: string;
  message?: string;
  data?: Record<string, unknown>;
  engine?: Record<string, unknown>;
  document_type?: string | null;
  invoice_type?: string | null;
  format?: string | null;
}

export interface EfapiaoBatchPayload {
  status?: string;
  total?: number;
  succeeded?: number;
  failed?: number;
  items?: EfapiaoPayload[];
  detail?: unknown;
}

export function stringValue(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function nestedName(v: unknown): string {
  if (v && typeof v === 'object' && 'name' in v) {
    return stringValue((v as { name?: unknown }).name);
  }
  return '';
}

export function nestedRecord(v: unknown, key: string): Record<string, unknown> {
  if (v && typeof v === 'object' && key in v) {
    const child = (v as Record<string, unknown>)[key];
    if (child && typeof child === 'object') return child as Record<string, unknown>;
  }
  return {};
}

function documentTypeFromEfapiao(value: string, fallback: DocumentType): DocumentType {
  if (value.includes('itinerary') || value.includes('rail')) return 'itinerary';
  if (value.includes('fapiao')) return 'invoice';
  return fallback;
}

export function parseEfapiaoJson(text: string): EfapiaoPayload {
  const trimmed = text.trim();
  if (!trimmed) return {};
  return JSON.parse(trimmed) as EfapiaoPayload;
}

export function compactError(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 500);
}

export function toEfapiaoPayload(value: unknown): EfapiaoPayload {
  if (value && typeof value === 'object') return value as EfapiaoPayload;
  return {};
}

function filled(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 按 document type 定义最小有效字段集（APP-14B）。
 * 顶层 `status:"ok"` 但结构为空/关键字段缺失时不能算识别成功，否则这份文档会从
 * 待处理和失败工作量里同时消失，重跑还会被当作已完成而跳过。
 * 返回空字符串表示通过，否则返回可读的缺失说明。
 */
function missingCoreFields(documentType: DocumentType, fields: Partial<InvoiceFields>): string {
  const present = [
    filled(fields.invoiceNo) ? 'invoiceNo' : '',
    filled(fields.seller) ? 'seller' : '',
    filled(fields.amount) ? 'amount' : '',
    filled(fields.date) ? 'date' : '',
  ].filter(Boolean);
  if (present.length === 0) return 'no_fields';
  if (documentType === 'invoice') {
    // 发票至少要有票号，或者「销售方 + 金额」这一组可对账的字段。
    if (filled(fields.invoiceNo)) return '';
    if (filled(fields.seller) && filled(fields.amount)) return '';
    return 'need_invoiceNo_or_seller_and_amount';
  }
  if (documentType === 'itinerary') {
    // 行程单不一定有票号，但至少要有两项可用字段才有归档价值。
    return present.length >= 2 ? '' : 'need_two_of_invoiceNo_seller_amount_date';
  }
  return '';
}

export function okResult(payload: EfapiaoPayload, fallbackDocumentType: DocumentType, transport: 'cli' | 'http'): OcrResult {
  const data = payload.data ?? {};
  const source = nestedRecord(data, 'source');
  const documentTypeRaw = stringValue(data.document_type) || stringValue(payload.document_type);
  const invoiceType = stringValue(data.invoice_type) || stringValue(payload.invoice_type);
  const sourceFormat = stringValue(source.format) || stringValue(payload.format);
  const fields: Partial<InvoiceFields> = {
    seller: nestedName(data.seller),
    amount: stringValue(data.amount_with_tax) || stringValue(data.amount_without_tax),
    date: stringValue(data.issue_date),
    invoiceNo: stringValue(data.invoice_number) || stringValue(data.invoice_code),
    documentType: documentTypeFromEfapiao(documentTypeRaw, fallbackDocumentType),
    invoiceType,
  };
  const missing = missingCoreFields(fields.documentType ?? fallbackDocumentType, fields);
  return {
    // 字段不完整时给出明确的 partial 状态，保留已解析字段供人工复核。
    status: missing ? 'partial' : 'success',
    fields,
    error: missing ? `efapiao_incomplete_result:${missing}` : '',
    source: {
      format: sourceFormat === 'ofd' || sourceFormat === 'image' ? sourceFormat : 'pdf',
      parserVersion: stringValue(source.parser_version),
      extractedBy: stringValue(source.extracted_by),
      ocrVendor: stringValue(source.ocr_vendor) || null,
    },
    transport,
    raw: payload,
  };
}

export function errorResult(payload: EfapiaoPayload, fallbackError: string, transport: 'cli' | 'http', fallbackDocumentType: DocumentType): OcrResult {
  const code = stringValue(payload.code);
  const message = stringValue(payload.message);
  const error = [code, message].filter(Boolean).join(':') || fallbackError;
  return {
    status: 'error',
    fields: {
      invoiceType: stringValue(payload.invoice_type),
      documentType: documentTypeFromEfapiao(stringValue(payload.document_type), fallbackDocumentType),
    },
    error,
    transport,
    raw: payload,
  };
}
