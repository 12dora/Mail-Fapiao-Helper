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
  /** 确实尝试过、但没能取到本应存在的票：会形成待确认记录。 */
  | { kind: 'manual'; reason: string }
  /**
   * 这个提取器与本邮件无关（例如正文只有退订/隐私政策链接）。
   * 与 `manual` 的区别是：它不是「候选发票提取失败」，因此在同一封邮件里其他
   * 提取器成功时**不得**把整封邮件降级为部分成功（APP-01）。
   */
  | { kind: 'not_applicable'; reason?: string }
  | { kind: 'skip' };

export interface Extractor {
  name: string;
  canHandle(mail: ParsedMail): boolean;
  extract(mail: ParsedMail, ctx: Ctx): Promise<ExtractResult>;
}
