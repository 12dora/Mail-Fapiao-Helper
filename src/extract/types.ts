import type { ParsedMail } from 'mailparser';
import type { Browser } from 'playwright';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';

export interface Ctx {
  cfg: Config;
  log: Logger;
  browser: () => Promise<Browser>;
  http: typeof fetch;
}

export type DocumentFormat = 'pdf' | 'ofd' | 'image';
export type DocumentType = 'invoice' | 'itinerary' | 'supporting';

export interface DocumentArtifact {
  data: Buffer;
  source: string;
  suggestedName?: string;
  format?: DocumentFormat;
  documentType?: DocumentType;
  requiresOcr?: boolean;
}

export type PdfArtifact = DocumentArtifact;

export type ExtractResult =
  | { kind: 'pdf'; pdfs: PdfArtifact[] }
  | { kind: 'manual'; reason: string }
  | { kind: 'skip' };

export interface Extractor {
  name: string;
  canHandle(mail: ParsedMail): boolean;
  extract(mail: ParsedMail, ctx: Ctx): Promise<ExtractResult>;
}
