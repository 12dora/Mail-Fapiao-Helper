import type { ParsedMail } from 'mailparser';
import type { Logger } from '../log.js';
import { contentHash as contentHashOf } from '../util/hash.js';
import { extractors } from '../extract/registry.js';
import type { Ctx, ExtractIssue, PdfArtifact } from '../extract/types.js';
import { invoiceNoKey, looksLikeOfdItinerary } from '../extract/documentIdentity.js';
import { looksLikeOfdItineraryText } from '../extract/classify.js';
import { redactErrorDetail, sanitizePendingReason } from './retryFetch.js';

// ---------------------------------------------------------------------------
// 可组合的提取协议（APP-01）
// ---------------------------------------------------------------------------

export interface AggregatedExtraction {
  /** 按内容身份去重后的候选文档。 */
  artifacts: PdfArtifact[];
  /** 所有候选来源的失败记录，含被跳过的附件、失败的链接和抛异常的提取器。 */
  issues: ExtractIssue[];
  /** `canHandle()` 为真、因而实际运行过的提取器名。 */
  matched: string[];
  /**
   * 判定为“与本邮件无关”的提取器原因。它们只在整封邮件零产出时用于 pending
   * 说明，**绝不**参与部分成功判定：常见的「有效附件 + 退订/隐私政策链接」邮件
   * 不能因为 directLink 找不到 PDF 就整封变成待确认（APP-01）。
   */
  notApplicable: string[];
  /** 返回 `skip` 的提取器数量。 */
  skipped: number;
}

/**
 * EXT-07：跨来源 PDF/OFD 去重只认**强发票身份**（20 位发票号一致）。
 * 文件名相等绝不足以删除另一来源的 OFD——附件 PDF 与站点 OFD 常撞名。
 */
export function preferPdfOverStrongIdentityOfd(
  artifacts: PdfArtifact[],
  log: Logger,
  subject?: string,
): PdfArtifact[] {
  const pdfs = artifacts.filter((item) => (item.format ?? 'pdf') === 'pdf');
  const subjectIsItinerary = looksLikeOfdItineraryText(subject);
  const out: PdfArtifact[] = [];

  for (const artifact of artifacts) {
    if (artifact.format !== 'ofd') {
      out.push(artifact);
      continue;
    }

    if (subjectIsItinerary || looksLikeOfdItinerary(artifact)) {
      out.push({ ...artifact, documentType: artifact.documentType ?? 'itinerary', requiresOcr: true });
      continue;
    }

    const ofdNo = invoiceNoKey(artifact);
    if (!ofdNo) {
      // 无强身份：保留 OFD，交给 OCR 后再合并。
      out.push({ ...artifact, documentType: artifact.documentType ?? 'invoice', requiresOcr: true });
      continue;
    }
    const duplicatePdf = pdfs.find((pdf) => {
      const pdfNo = invoiceNoKey(pdf);
      return Boolean(pdfNo && pdfNo === ofdNo);
    });
    if (duplicatePdf) {
      log.debug(`Filtered duplicate OFD invoice ${artifact.source}; keeping PDF ${duplicatePdf.source} (invoiceNo=${ofdNo})`);
      continue;
    }

    out.push({ ...artifact, documentType: artifact.documentType ?? 'invoice', requiresOcr: true });
  }

  return out;
}

/**
 * 依次运行所有 `canHandle()` 为真的提取器并汇总结果。
 *
 * 此前 pipeline 在第一个匹配处 `break`，附件、普通直链和站点链接无法共同贡献
 * artifact，混合邮件会静默漏票；现在改为逐来源汇总、以 contentHash 去重，并把
 * 每个来源的失败逐条留存，交给调用方形成“部分成功 + 待确认”的最终状态（APP-01）。
 */
export async function runExtractors(mail: ParsedMail, ctx: Ctx, hash: string): Promise<AggregatedExtraction> {
  const artifacts: PdfArtifact[] = [];
  const issues: ExtractIssue[] = [];
  const matched: string[] = [];
  const notApplicable: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (const extractor of extractors) {
    let claims = false;
    try {
      claims = extractor.canHandle(mail);
    } catch (err) {
      issues.push({ reason: `${extractor.name}:canHandle_failed:${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    if (!claims) continue;
    matched.push(extractor.name);

    let result;
    try {
      result = await extractor.extract(mail, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // CORE-08：提取器异常可能夹带签名 URL。
      const safeMsg = redactErrorDetail(msg);
      ctx.log.warn(`Extractor ${extractor.name} failed for ${hash}: ${safeMsg}`);
      issues.push({ reason: `${extractor.name}:${safeMsg}`, retryable: safeMsg.includes('network_retry_failed') });
      continue;
    }

    if (result.kind === 'skip') {
      skipped++;
      continue;
    }
    if (result.kind === 'not_applicable') {
      notApplicable.push(result.reason ?? `${extractor.name}:not_applicable`);
      continue;
    }
    if (result.kind === 'manual') {
      const safeReason = sanitizePendingReason(result.reason);
      issues.push({ reason: safeReason, retryable: safeReason.includes('network_retry_failed') });
      continue;
    }

    for (const issue of result.issues ?? []) {
      issues.push({
        ...issue,
        reason: sanitizePendingReason(issue.reason),
      });
    }
    for (const artifact of result.pdfs) {
      const key = contentHashOf(artifact.data);
      if (seen.has(key)) continue;
      seen.add(key);
      artifacts.push(artifact);
    }
  }

  // EXT-07：跨来源仅按强发票号去重；文件名撞名不得删票。
  const deduped = preferPdfOverStrongIdentityOfd(artifacts, ctx.log, mail.subject ?? undefined);
  return { artifacts: deduped, issues, matched, notApplicable, skipped };
}

export function summarizeReasons(reasons: string[]): string {
  const head = reasons[0] ?? 'unknown';
  return reasons.length > 1 ? `${head} (+${reasons.length - 1})` : head;
}

export function summarizeIssues(issues: ExtractIssue[]): string {
  return summarizeReasons(issues.map((issue) => issue.reason));
}
