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

/**
 * 一个提取器内部“部分失败”的记录。提取器即使拿到了部分文档，也必须把失败的候选
 * 逐条汇报上来，pipeline 才能既归档已取得的票、又留下可见的待确认记录（APP-01）。
 */
export interface ExtractIssue {
  /** 机器可读原因，如 `directLink:download_failed:<url>`。 */
  reason: string;
  /** 是否属于网络重试耗尽这类可恢复失败。 */
  retryable?: boolean;
}

export type ExtractResult =
  | { kind: 'pdf'; pdfs: PdfArtifact[]; issues?: ExtractIssue[] }
  | { kind: 'manual'; reason: string }
  | { kind: 'skip' };

export interface Extractor {
  name: string;
  canHandle(mail: ParsedMail): boolean;
  extract(mail: ParsedMail, ctx: Ctx): Promise<ExtractResult>;
}
