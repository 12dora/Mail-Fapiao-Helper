import type { DocumentFormat, DocumentType } from '../extract/types.js';

export interface InvoiceFields {
  seller: string;
  amount: string;
  date: string;
  invoiceNo: string;
  documentType: DocumentType;
  invoiceType: string;
}

export interface OcrProvider {
  name: string;
  parse(data: Buffer, meta: { format: DocumentFormat; documentType: DocumentType; filename: string }): Promise<Partial<InvoiceFields>>;
}
