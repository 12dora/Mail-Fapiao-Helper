import type { ParsedMail } from 'mailparser';
import { createHash } from 'node:crypto';
import type { Ctx, ExtractIssue, Extractor, ExtractResult, PdfArtifact } from './types.js';
import { extractMailUrls } from './mailLinks.js';
import { handlers } from '../sites/registry.js';
import { preferPdfOverDuplicateOfd } from './documentIdentity.js';
import { assertDocumentResponse, detectDocumentKind, type DocumentKind } from '../sites/common.js';
import { assertPublicUrl, readCappedBuffer } from '../util/net.js';

function isPdfUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return false;
  }
}

function isOfdUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.pathname.toLowerCase().endsWith('.ofd');
  } catch {
    return false;
  }
}

function pdfVariantUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!parsed.pathname.includes('/kpfw/fpjfzz/v1/exportDzfpwjEwm')) return null;
    const format = parsed.searchParams.get('Wjgs')?.toUpperCase();
    if (format !== 'OFD' && format !== 'XML') return null;
    parsed.searchParams.set('Wjgs', 'PDF');
    return parsed.toString();
  } catch {
    return null;
  }
}

function pdfCandidateKey(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.pathname.includes('/kpfw/fpjfzz/v1/exportDzfpwjEwm')) {
      const fphm = parsed.searchParams.get('Fphm') ?? '';
      const kprq = parsed.searchParams.get('Kprq') ?? '';
      const jym = parsed.searchParams.get('Jym') ?? '';
      if (fphm.length > 0) return `tax:${parsed.hostname}:${fphm}:${kprq}:${jym}`;
    }
  } catch {
    // fall through
  }
  return url;
}

function isKnownPdfCandidate(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'yaduo-file-center-prod.oss-cn-hangzhou.aliyuncs.com'
        && parsed.pathname.includes('/inv-file/')) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function isProbeNoise(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === 'inv-veri.chinatax.gov.cn';
  } catch {
    return true;
  }
}

/** 发票语义信号：用于探测排序，优先检查更像发票的链接（EXT-02）。 */
function invoiceProbeScore(url: string): number {
  let score = 0;
  const lower = url.toLowerCase();
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    const params = parsed.searchParams;

    if (/(invoice|fapiao|fpjf|einvoice|dzfp|vat|发票)/i.test(host + path)) score += 40;
    if (params.has('invoiceId') || params.has('fphm') || params.has('Fphm') || params.has('param')
        || params.has('token') || params.has('id')) score += 25;
    if (path.endsWith('.pdf') || path.endsWith('.ofd') || path.includes('/pdf') || path.includes('/ofd')) score += 20;
    if (params.has('download') || path.includes('download') || path.includes('export')) score += 10;
    // 营销/退订类降权
    if (/(unsubscribe|privacy|terms|marketing|promo|ad\.)/i.test(lower)) score -= 50;
  } catch {
    return 0;
  }
  return score;
}

/** magic-byte 探测时只读前 2 KiB，避免把完整文档拉下来。 */
const PROBE_BYTE_CAP = 2048;

/**
 * 判断响应是否像发票文档（EXT-02 / EXT-08）。
 * HEAD 不可靠时用 Range/限字节 GET 核对 magic bytes。
 */
async function probeIsDocument(url: string, ctx: Ctx): Promise<boolean> {
  await assertPublicUrl(url);

  // 1) HEAD：仅当明确返回 PDF/OFD/ZIP 相关 content-type 时才信任为候选。
  try {
    // WIRE-01：ctx.http = safeFetch，无需事后 assertPublicResponse。
    const head = await ctx.http(url, { method: 'HEAD' });
    if (head.ok) {
      const contentType = (head.headers.get('content-type') ?? '').toLowerCase();
      if (contentType.includes('application/pdf')
          || contentType.includes('application/ofd')
          || contentType.includes('application/vnd.ofd')
          || contentType.includes('application/zip')) {
        return true;
      }
      // HEAD 200 但无类型 / 通用类型：落到 magic 探测，不直接判否。
      const ambiguous = !contentType
        || contentType.includes('octet-stream')
        || contentType.includes('application/force-download')
        || contentType.includes('binary');
      if (!ambiguous && !contentType.includes('pdf') && !contentType.includes('ofd')
          && !contentType.includes('zip') && !contentType.includes('image')) {
        // 明确的 HTML/JSON 等：仍可能是伪装，继续 magic 探测更稳妥。
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('network_retry_failed')) {
      throw err;
    }
    ctx.log.debug(`HEAD probe inconclusive for ${url}: ${err}`);
  }

  // 2) Range / 限字节 GET：用 magic bytes 判定（应对 405、无 Content-Type、假 MIME）。
  try {
    const response = await ctx.http(url, {
      method: 'GET',
      headers: {
        Range: `bytes=0-${PROBE_BYTE_CAP - 1}`,
        Accept: 'application/pdf,application/zip,application/octet-stream,*/*',
        'User-Agent': 'Mozilla/5.0 Mail-Fapiao-Helper',
      },
    });
    if (!response.ok && response.status !== 206) {
      ctx.log.debug(`GET probe ${url} status ${response.status}`);
      return false;
    }
    const data = await readCappedBuffer(response, PROBE_BYTE_CAP);
    const kind = detectDocumentKind(data);
    return kind === 'pdf' || kind === 'archive' || kind === 'image';
  } catch (err) {
    if (err instanceof Error && err.message.includes('network_retry_failed')) {
      throw err;
    }
    ctx.log.debug(`GET magic probe failed for ${url}: ${err}`);
    return false;
  }
}

/** 下载结果：拿到字节，或一个“不是发票”的软拒绝原因（不构成失败）。 */
type DownloadOutcome = { data: Buffer; kind: DocumentKind } | { rejected: string };

async function downloadDocument(url: string, ctx: Ctx): Promise<DownloadOutcome> {
  try {
    await assertPublicUrl(url);
  } catch (err) {
    ctx.log.warn(`Blocked unsafe URL ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return { rejected: 'blocked_url' };
  }
  let response: Response;
  try {
    // ctx.http 已经在同一个 attempt 内读完并缓冲了 body（APP-13），因此这里的
    // network_retry_failed 已经覆盖 header 与 body 两个阶段的超时。
    // WIRE-01：safeFetch 已在每跳发出前校验。
    response = await ctx.http(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('blocked_url:')) {
      ctx.log.warn(`Blocked unsafe redirect ${url}: ${msg}`);
      return { rejected: 'blocked_url' };
    }
    if (msg.startsWith('response_too_large:')) {
      ctx.log.warn(`GET ${url} body rejected: ${msg}`);
      return { rejected: msg };
    }
    throw err; // network_retry_failed etc. propagate to the caller's retry accounting
  }
  if (!response.ok) {
    ctx.log.debug(`GET ${url} failed: ${response.status}`);
    return { rejected: `http_${response.status}` };
  }
  let data: Buffer;
  try {
    data = await readCappedBuffer(response);
  } catch (err) {
    ctx.log.warn(`GET ${url} body rejected: ${err instanceof Error ? err.message : String(err)}`);
    return { rejected: 'body_rejected' };
  }
  const contentType = response.headers.get('content-type') ?? '';
  // EXT-08：与站点 handler 共用 magic-byte 校验，拒绝“MIME 声称 PDF 的 JSON 错误页”。
  try {
    const kind = assertDocumentResponse({
      data,
      contentType,
      label: 'directLink',
      allow: ['pdf', 'archive', 'image'],
    });
    return { data, kind };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log.debug(`GET ${url} was not a document: ${msg}`);
    return { rejected: 'not_a_document' };
  }
}

function suggestFilename(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/');
    const lastSegment = segments[segments.length - 1];
    if (lastSegment && /\.(pdf|ofd)$/i.test(lastSegment)) {
      return decodeURIComponent(lastSegment);
    }
  } catch {
    // ignore
  }
  return '';
}

function pdfContentKey(pdf: Buffer): string {
  return createHash('sha1').update(pdf).digest('hex');
}

function documentFormat(kind: DocumentKind, source: string): 'pdf' | 'ofd' | 'image' {
  if (kind === 'pdf') return 'pdf';
  if (kind === 'image') return 'image';
  // archive：OFD 与 ZIP 都是 PK 头；按 URL/文件名区分，默认 ofd（直链常见为 ofd）。
  if (isOfdUrl(source) || source.toLowerCase().includes('/ofd/') || source.toLowerCase().endsWith('.ofd')) {
    return 'ofd';
  }
  if (source.toLowerCase().endsWith('.zip')) {
    // ZIP 包应走站点 handler / 附件解包；此处保守当 ofd 会让后续 OCR 失败，
    // 但 directLink 历史上把 PK 当 ofd。保持兼容：非 .zip 的 PK 视为 ofd。
    return 'ofd';
  }
  return 'ofd';
}

/** 没有强 PDF 特征的链接最多探测这么多个，避免营销邮件把 run 拖成线性等待。 */
const MAX_PROBE_LINKS = 8;
/** HEAD/GET 探测的有界并发度。 */
const PROBE_CONCURRENCY = 4;

/** 保序的有界并发 map，用来替代逐链接串行探测。 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      out[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 已被站点处理器认领的链接由 thirdParty 负责，直链流程只处理其余链接。 */
function isSiteHandlerLink(link: string): boolean {
  return handlers.some((handler) => handler.match(link));
}

function plainLinks(mail: ParsedMail): string[] {
  return extractMailUrls(mail).filter((link) => !isSiteHandlerLink(link));
}

const directLinkExtractor: Extractor = {
  name: 'directLink',

  // 只要邮件里存在“没有被站点处理器认领”的链接就参与提取。此前只要出现任意一个
  // 站点链接就整封放弃，导致“站点链接 + 普通直链”的邮件漏掉直链那张票（APP-01）。
  canHandle(mail: ParsedMail): boolean {
    return plainLinks(mail).length > 0;
  },

  async extract(mail: ParsedMail, ctx: Ctx): Promise<ExtractResult> {
    const links = plainLinks(mail);

    if (links.length === 0) {
      return { kind: 'not_applicable', reason: 'directLink:no_links' };
    }

    // 强 PDF 特征的链接不限量；其余链接只是“可能是发票”，探测数量设上限并做有界
    // 并发，避免退订/隐私政策/营销链接把处理时间拉成 链接数 × 重试次数 × timeout。
    const strongCandidates: string[] = [];
    const probeTargets: string[] = [];

    for (const link of links) {
      if (isPdfUrl(link) || isOfdUrl(link)) {
        strongCandidates.push(link);
        continue;
      }

      const pdfVariant = pdfVariantUrl(link);
      if (pdfVariant) {
        strongCandidates.push(pdfVariant);
        continue;
      }

      if (isKnownPdfCandidate(link)) {
        strongCandidates.push(link);
        continue;
      }

      if (isProbeNoise(link)) {
        continue;
      }

      probeTargets.push(link);
    }

    // EXT-02：按发票语义排序后再截断预算，而不是按正文出现顺序硬切。
    probeTargets.sort((a, b) => invoiceProbeScore(b) - invoiceProbeScore(a));
    const probedLinks = probeTargets.slice(0, MAX_PROBE_LINKS);
    const unprobedLinks = probeTargets.slice(MAX_PROBE_LINKS);
    if (unprobedLinks.length > 0) {
      ctx.log.warn(
        `directLink: probe budget ${MAX_PROBE_LINKS}/${probeTargets.length}; `
        + `${unprobedLinks.length} candidate(s) left unchecked`,
      );
    }

    const probeFailures: string[] = [];
    const issues: ExtractIssue[] = [];

    // 预算外的候选必须变成可见 issue，不能静默 not_applicable（EXT-02）。
    if (unprobedLinks.length > 0) {
      issues.push({
        reason: `directLink:probe_budget_exceeded:${unprobedLinks.length}:${unprobedLinks.slice(0, 3).join('|')}`,
      });
    }

    const probed = await mapWithConcurrency(probedLinks, PROBE_CONCURRENCY, async (link) => {
      try {
        return await probeIsDocument(link, ctx) ? link : null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        probeFailures.push(msg);
        issues.push({ reason: `directLink:probe_failed:${msg}`, retryable: true });
        ctx.log.warn(`PDF probe failed after retries for ${link}: ${msg}`);
        return null;
      }
    });

    const pdfCandidates = [...strongCandidates, ...probed.filter((link): link is string => link !== null)];

    if (pdfCandidates.length === 0) {
      // 有未检查候选或探测失败：这是部分失败，不能当成“本提取器不适用”。
      if (unprobedLinks.length > 0 || probeFailures.length > 0) {
        const first = issues[0]?.reason
          ?? (probeFailures[0] ? `directLink:probe_unavailable:${probeFailures[0]}` : 'directLink:probe_budget_exceeded');
        return { kind: 'manual', reason: first };
      }
      // 邮件里只有普通链接，没有任何发票线索：本提取器不适用，不是提取失败。
      return { kind: 'not_applicable', reason: 'directLink:no_pdf_links' };
    }

    const uniquePdfCandidates = Array.from(new Map(pdfCandidates.map((url) => [pdfCandidateKey(url), url])).values());
    ctx.log.debug(`Found ${uniquePdfCandidates.length} PDF links`);

    const pdfs: PdfArtifact[] = [];
    const seenPdfs = new Set<string>();
    const networkFailures: string[] = [];
    // 只在“强特征候选”上把软拒绝算作真实缺票：被探测判定为 PDF 却下不下来同样算。
    let rejectedCandidates = 0;

    for (const url of uniquePdfCandidates) {
      let outcome: DownloadOutcome;
      try {
        outcome = await downloadDocument(url, ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        networkFailures.push(msg);
        issues.push({ reason: `directLink:download_failed:${msg}`, retryable: true });
        ctx.log.warn(`PDF download failed after retries for ${url}: ${msg}`);
        continue;
      }
      if (!('data' in outcome)) {
        rejectedCandidates++;
        issues.push({ reason: `directLink:download_rejected:${outcome.rejected}` });
        ctx.log.warn(`Failed to download ${url}: ${outcome.rejected}`);
        continue;
      }

      const { data, kind } = outcome;
      const key = pdfContentKey(data);
      if (seenPdfs.has(key)) continue;
      seenPdfs.add(key);

      const format = documentFormat(kind, url);
      pdfs.push({
        data,
        source: url,
        suggestedName: suggestFilename(url),
        format,
        requiresOcr: format !== 'pdf',
      });
    }

    if (pdfs.length === 0) {
      if (networkFailures.length > 0) {
        throw new Error(networkFailures[0]);
      }
      if (rejectedCandidates === 0 && unprobedLinks.length === 0) {
        return { kind: 'not_applicable', reason: 'directLink:no_pdf_links' };
      }
      return { kind: 'manual', reason: issues[0]?.reason ?? 'directLink:download_failed' };
    }

    // 去重只丢弃“可靠匹配到同一张票的 PDF”的那份 OFD，与附件流程共用同一算法：
    // 不再因为邮件里存在任意 PDF 就删掉不相关的 OFD（APP-02 / EXT-01）。
    return {
      kind: 'pdf',
      pdfs: preferPdfOverDuplicateOfd(pdfs, ctx.log, mail.subject ?? undefined),
      issues,
    };
  },
};

export default directLinkExtractor;
