import type { DocumentFormat, DocumentType } from '../extract/types.js';

/**
 * OCR 结果状态。`partial` 表示服务返回了成功，但按 document type 的最小字段集
 * 判断结构为空或关键字段缺失（APP-14B）：既不能算识别成功，也不是纯粹的失败，
 * 需要保留人工复核入口。
 */
export type OcrStatus = 'success' | 'partial' | 'error';

export interface InvoiceFields {
  seller: string;
  amount: string;
  date: string;
  invoiceNo: string;
  documentType: DocumentType;
  invoiceType: string;
}

export interface OcrResult {
  status: OcrStatus;
  fields: Partial<InvoiceFields>;
  error: string;
  source?: {
    format: DocumentFormat;
    parserVersion: string;
    extractedBy: string;
    ocrVendor: string | null;
  };
  transport?: 'cli' | 'http';
  raw: unknown;
}

export interface OcrProvider {
  name: string;
  parse(data: Buffer, meta: { format: DocumentFormat; documentType: DocumentType; filename: string }): Promise<OcrResult>;
  parseBatch?(items: Array<{ data: Buffer; meta: { format: DocumentFormat; documentType: DocumentType; filename: string } }>): Promise<OcrResult[]>;
}
