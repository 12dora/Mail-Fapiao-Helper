import type { ParsedMail } from 'mailparser';
import { createHash } from 'node:crypto';
import type { Ctx, Extractor, ExtractResult, PdfArtifact } from './types.js';
import { handlers } from '../sites/registry.js';

function cleanLink(url: string): string {
  return url
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, '')
    .trim();
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

async function probePdfContentType(url: string, ctx: Ctx): Promise<boolean> {
  try {
    const response = await ctx.http(url, { method: 'HEAD' });
    const contentType = response.headers.get('content-type');
    return contentType?.includes('application/pdf') ?? false;
  } catch (err) {
    ctx.log.debug(`HEAD probe failed for ${url}: ${err}`);
    return false;
  }
}

async function downloadPdf(url: string, ctx: Ctx): Promise<Buffer | null> {
  try {
    const response = await ctx.http(url);
    if (!response.ok) {
      ctx.log.debug(`GET ${url} failed: ${response.status}`);
      return null;
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    ctx.log.debug(`Download failed for ${url}: ${err}`);
    return null;
  }
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

    for (const link of links) {
      if (!link.startsWith('http://') && !link.startsWith('https://')) {
        continue;
      }

      if (isPdfUrl(link)) {
        pdfCandidates.push(link);
        continue;
      }

      if (await probePdfContentType(link, ctx)) {
        pdfCandidates.push(link);
      }
    }

    if (pdfCandidates.length === 0) {
      return { kind: 'manual', reason: 'directLink:no_pdf_links' };
    }

    ctx.log.debug(`Found ${pdfCandidates.length} PDF links`);

    const pdfs: PdfArtifact[] = [];
    const seenPdfs = new Set<string>();

    for (const url of pdfCandidates) {
      const data = await downloadPdf(url, ctx);
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
      return { kind: 'manual', reason: 'directLink:download_failed' };
    }

    return { kind: 'pdf', pdfs };
  },
};

export default directLinkExtractor;
