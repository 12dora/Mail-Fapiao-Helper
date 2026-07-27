import type { ParsedMail } from 'mailparser';
import { createHash } from 'node:crypto';
import type { Ctx, ExtractIssue, Extractor, ExtractResult, PdfArtifact } from './types.js';
import { handlers } from '../sites/registry.js';
import { preferPdfOverDuplicateOfd } from './documentIdentity.js';
import { assertPublicUrl, assertPublicResponse, readCappedBuffer } from '../util/net.js';
import { normalizeExtractedUrls } from '../util/url.js';

function extractLinksFromHtml(html: string): string[] {
  const links: string[] = [];
  const hrefRegex = /href=["']([^"']+)["']/gi;
  let match;
  while ((match = hrefRegex.exec(html)) !== null) {
    if (match[1]) {
      links.push(match[1]);
    }
  }
  return links;
}

function extractLinksFromText(text: string): string[] {
  const links: string[] = [];
  const urlRegex = /https?:\/\/[^\s<>"'{}|\\^`\[\]]+/gi;
  let match;
  while ((match = urlRegex.exec(text)) !== null) {
    if (match[0]) {
      links.push(match[0]);
    }
  }
  return links;
}

function isPdfUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.pathname.toLowerCase().endsWith('.pdf');
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

async function probePdfContentType(url: string, ctx: Ctx): Promise<boolean> {
  try {
    // SSRF guard: reject non-http(s) and private/loopback targets before probing,
    // and re-check the final URL in case a public link redirected to an internal host.
    await assertPublicUrl(url);
    const response = await assertPublicResponse(await ctx.http(url, { method: 'HEAD' }));
    const contentType = response.headers.get('content-type');
    return contentType?.includes('application/pdf') ?? false;
  } catch (err) {
    if (err instanceof Error && err.message.includes('network_retry_failed')) {
      throw err;
    }
    ctx.log.debug(`HEAD probe skipped/failed for ${url}: ${err}`);
    return false;
  }
}

async function downloadPdf(url: string, ctx: Ctx): Promise<Buffer | null> {
  try {
    await assertPublicUrl(url);
  } catch (err) {
    ctx.log.warn(`Blocked unsafe URL ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  let response: Response;
  try {
    response = await assertPublicResponse(await ctx.http(url));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('blocked_url:')) {
      ctx.log.warn(`Blocked unsafe redirect ${url}: ${msg}`);
      return null;
    }
    throw err; // network_retry_failed etc. propagate to the caller's retry accounting
  }
  if (!response.ok) {
    ctx.log.debug(`GET ${url} failed: ${response.status}`);
    return null;
  }
  let data: Buffer;
  try {
    data = await readCappedBuffer(response);
  } catch (err) {
    ctx.log.warn(`GET ${url} body rejected: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('pdf') && data.subarray(0, 4).toString('latin1') !== '%PDF') {
    ctx.log.debug(`GET ${url} was not PDF: ${contentType || 'unknown'}`);
    return null;
  }
  return data;
}

function suggestFilename(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/');
    const lastSegment = segments[segments.length - 1];
    if (lastSegment && lastSegment.endsWith('.pdf')) {
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

function documentFormat(data: Buffer, source: string): 'pdf' | 'ofd' {
  if (data.subarray(0, 4).toString('ascii') === '%PDF') return 'pdf';
  if (data.subarray(0, 2).toString('ascii') === 'PK') return 'ofd';
  return source.toLowerCase().includes('/ofd/') || source.toLowerCase().endsWith('.ofd') ? 'ofd' : 'pdf';
}

function extractLinks(mail: ParsedMail): string[] {
  const links: string[] = [];
  if (typeof mail.html === 'string') {
    links.push(...extractLinksFromHtml(mail.html));
    links.push(...extractLinksFromText(mail.html));
  }
  if (typeof mail.text === 'string') links.push(...extractLinksFromText(mail.text));
  // 与 thirdParty 共用 URL normalizer：中文句末标点会被剥离，`new URL()` 校验
  // 不通过的 token 直接丢弃（APP-10A）。
  return normalizeExtractedUrls(links);
}

/** 已被站点处理器认领的链接由 thirdParty 负责，直链流程只处理其余链接。 */
function isSiteHandlerLink(link: string): boolean {
  return handlers.some((handler) => handler.match(link));
}

function plainLinks(mail: ParsedMail): string[] {
  return extractLinks(mail).filter((link) => !isSiteHandlerLink(link));
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
      return { kind: 'manual', reason: 'directLink:no_links' };
    }

    const pdfCandidates: string[] = [];
    const networkFailures: string[] = [];
    const issues: ExtractIssue[] = [];

    for (const link of links) {
      if (isPdfUrl(link)) {
        pdfCandidates.push(link);
        continue;
      }

      const pdfVariant = pdfVariantUrl(link);
      if (pdfVariant) {
        pdfCandidates.push(pdfVariant);
        continue;
      }

      if (isKnownPdfCandidate(link)) {
        pdfCandidates.push(link);
        continue;
      }

      if (isProbeNoise(link)) {
        continue;
      }

      try {
        if (await probePdfContentType(link, ctx)) {
          pdfCandidates.push(link);
        }
      } catch (err) {
        // HEAD 探测失败只说明“无法确认这是 PDF”，与正文里的营销链接无异，不作为
        // 部分失败上报；只有当整封邮件一个候选都没有时才由下面的分支抛出。
        const msg = err instanceof Error ? err.message : String(err);
        networkFailures.push(msg);
        ctx.log.warn(`PDF probe failed after retries for ${link}: ${msg}`);
      }
    }

    if (pdfCandidates.length === 0) {
      if (networkFailures.length > 0) {
        throw new Error(networkFailures[0]);
      }
      return { kind: 'manual', reason: 'directLink:no_pdf_links' };
    }

    const uniquePdfCandidates = Array.from(new Map(pdfCandidates.map((url) => [pdfCandidateKey(url), url])).values());
    ctx.log.debug(`Found ${uniquePdfCandidates.length} PDF links`);

    const pdfs: PdfArtifact[] = [];
    const seenPdfs = new Set<string>();

    for (const url of uniquePdfCandidates) {
      let data: Buffer | null;
      try {
        data = await downloadPdf(url, ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        networkFailures.push(msg);
        issues.push({ reason: `directLink:download_failed:${msg}`, retryable: true });
        ctx.log.warn(`PDF download failed after retries for ${url}: ${msg}`);
        continue;
      }
      if (!data) {
        issues.push({ reason: `directLink:download_rejected:${url}` });
        ctx.log.warn(`Failed to download ${url}`);
        continue;
      }

      const key = pdfContentKey(data);
      if (seenPdfs.has(key)) continue;
      seenPdfs.add(key);

      pdfs.push({
        data,
        source: url,
        suggestedName: suggestFilename(url),
        format: documentFormat(data, url),
      });
    }

    if (pdfs.length === 0) {
      if (networkFailures.length > 0) {
        throw new Error(networkFailures[0]);
      }
      return { kind: 'manual', reason: 'directLink:download_failed' };
    }

    // 去重只丢弃“可靠匹配到同一张票的 PDF”的那份 OFD，与附件流程共用同一算法：
    // 不再因为邮件里存在任意 PDF 就删掉不相关的 OFD（APP-02）。
    return {
      kind: 'pdf',
      pdfs: preferPdfOverDuplicateOfd(pdfs, ctx.log, mail.subject ?? undefined),
      issues,
    };
  },
};

export default directLinkExtractor;
