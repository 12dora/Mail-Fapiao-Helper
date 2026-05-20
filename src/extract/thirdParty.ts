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
  let match: RegExpExecArray | null;
  while ((match = hrefRegex.exec(html)) !== null) {
    if (match[1]) links.push(match[1]);
  }
  return links;
}

function extractLinksFromText(text: string): string[] {
  const links: string[] = [];
  const urlRegex = /https?:\/\/[^\s<>"'{}|\\^`\[\]]+/gi;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(text)) !== null) {
    if (match[0]) links.push(match[0]);
  }
  return links;
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

function pdfContentKey(pdf: PdfArtifact): string {
  return createHash('sha1').update(pdf.data).digest('hex');
}

const thirdPartyExtractor: Extractor = {
  name: 'thirdParty',

  canHandle(mail: ParsedMail): boolean {
    return extractLinks(mail).some((link) => handlers.some((handler) => handler.match(link)));
  },

  async extract(mail: ParsedMail, ctx: Ctx): Promise<ExtractResult> {
    const page = await ctx.browser().then((browser) => browser.newPage());
    try {
      const pdfs: PdfArtifact[] = [];
      const seenPdfs = new Set<string>();
      for (const link of extractLinks(mail)) {
        const handler = handlers.find((h) => h.match(link));
        if (!handler) continue;
        const handled = await handler.handle(page, link, ctx);
        for (const pdf of handled) {
          const key = pdfContentKey(pdf);
          if (seenPdfs.has(key)) continue;
          seenPdfs.add(key);
          pdfs.push(pdf);
        }
      }

      if (pdfs.length === 0) {
        return { kind: 'manual', reason: 'thirdParty:no_pdfs' };
      }

      return { kind: 'pdf', pdfs };
    } finally {
      await page.close();
    }
  },
};

export default thirdPartyExtractor;
