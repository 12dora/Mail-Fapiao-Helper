import type { DocumentFormat, DocumentType } from '../extract/types.js';

export type OcrStatus = 'success' | 'error';

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
  raw: unknown;
}

export interface OcrProvider {
  name: string;
  parse(data: Buffer, meta: { format: DocumentFormat; documentType: DocumentType; filename: string }): Promise<OcrResult>;
}
