export interface InvoiceFields {
  seller: string;
  amount: string;
  date: string;
  invoiceNo: string;
}

export interface OcrProvider {
  name: string;
  parse(pdf: Buffer): Promise<Partial<InvoiceFields>>;
}
