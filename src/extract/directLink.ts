import type { ParsedMail } from 'mailparser';
import type { Ctx, Extractor, ExtractResult, PdfArtifact } from './types.js';

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
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
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

const directLinkExtractor: Extractor = {
  name: 'directLink',

  canHandle(mail: ParsedMail): boolean {
    if (typeof mail.html === 'string' && mail.html.includes('href=')) {
      return true;
    }
    if (typeof mail.text === 'string' && /https?:\/\//i.test(mail.text)) {
      return true;
    }
    return false;
  },

  async extract(mail: ParsedMail, ctx: Ctx): Promise<ExtractResult> {
    let links: string[] = [];

    if (typeof mail.html === 'string') {
      links = extractLinksFromHtml(mail.html);
    } else if (typeof mail.text === 'string') {
      links = extractLinksFromText(mail.text);
    }

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

    for (const url of pdfCandidates) {
      const data = await downloadPdf(url, ctx);
      if (!data) {
        ctx.log.warn(`Failed to download ${url}`);
        continue;
      }

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
