import type { ParsedMail } from 'mailparser';
import { createHash } from 'node:crypto';
import type { Ctx, Extractor, ExtractResult, PdfArtifact } from './types.js';
import { handlers } from '../sites/registry.js';

function cleanLink(url: string): string {
  let cleaned = url
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, '')
    .trim();
  const cut = cleaned.search(/[，。；、）】》\u3000]/);
  if (cut >= 0) cleaned = cleaned.slice(0, cut);
  return cleaned.replace(/[),.;]+$/g, '');
}

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
    const response = await ctx.http(url, { method: 'HEAD' });
    const contentType = response.headers.get('content-type');
    return contentType?.includes('application/pdf') ?? false;
  } catch (err) {
    if (err instanceof Error && err.message.includes('network_retry_failed')) {
      throw err;
    }
    ctx.log.debug(`HEAD probe failed for ${url}: ${err}`);
    return false;
  }
}

async function downloadPdf(url: string, ctx: Ctx): Promise<Buffer | null> {
  const response = await ctx.http(url);
  if (!response.ok) {
    ctx.log.debug(`GET ${url} failed: ${response.status}`);
    return null;
  }
  const arrayBuffer = await response.arrayBuffer();
  const data = Buffer.from(arrayBuffer);
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

function extractLinks(mail: ParsedMail): string[] {
  const links: string[] = [];
  if (typeof mail.html === 'string') {
    links.push(...extractLinksFromHtml(mail.html));
    links.push(...extractLinksFromText(mail.html));
  }
  if (typeof mail.text === 'string') links.push(...extractLinksFromText(mail.text));
  return Array.from(new Set(links.map(cleanLink)));
}

const directLinkExtractor: Extractor = {
  name: 'directLink',

  canHandle(mail: ParsedMail): boolean {
    const links = extractLinks(mail);
    if (links.length === 0) return false;
    return links.every((link) => !handlers.some((handler) => handler.match(link)));
  },

  async extract(mail: ParsedMail, ctx: Ctx): Promise<ExtractResult> {
    const links = extractLinks(mail);

    if (links.length === 0) {
      return { kind: 'manual', reason: 'directLink:no_links' };
    }

    const pdfCandidates: string[] = [];
    const networkFailures: string[] = [];

    for (const link of links) {
      if (!link.startsWith('http://') && !link.startsWith('https://')) {
        continue;
      }

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
        ctx.log.warn(`PDF download failed after retries for ${url}: ${msg}`);
        continue;
      }
      if (!data) {
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
      });
    }

    if (pdfs.length === 0) {
      if (networkFailures.length > 0) {
        throw new Error(networkFailures[0]);
      }
      return { kind: 'manual', reason: 'directLink:download_failed' };
    }

    return { kind: 'pdf', pdfs };
  },
};

export default directLinkExtractor;
