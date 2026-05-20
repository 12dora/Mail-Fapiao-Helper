import type { ParsedMail } from 'mailparser';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';

export interface Ctx {
  cfg: Config;
  log: Logger;
  browser: () => Promise<unknown>;
  http: typeof fetch;
}

export interface PdfArtifact {
  data: Buffer;
  source: string;
  suggestedName?: string;
}

export type ExtractResult =
  | { kind: 'pdf'; pdfs: PdfArtifact[] }
  | { kind: 'manual'; reason: string }
  | { kind: 'skip' };

export interface Extractor {
  name: string;
  canHandle(mail: ParsedMail): boolean;
  extract(mail: ParsedMail, ctx: Ctx): Promise<ExtractResult>;
}
