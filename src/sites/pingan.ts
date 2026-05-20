import type { Page } from 'playwright';
import type { Ctx, PdfArtifact } from '../extract/types.js';
import type { SiteHandler } from './types.js';
import { decodeHtmlEntities, fetchBuffer, safeFilename } from './common.js';

function extractInvoiceUrl(html: string): string | null {
  const match = html.match(/invoiceUrl\s*=\s*'([^']+)'/);
  return match?.[1] ? decodeHtmlEntities(match[1]) : null;
}

function filenameFromDisposition(value: string | null): string {
  const match = value?.match(/filename="?([^";]+)"?/i);
  if (!match?.[1]) return 'pingan-invoice.pdf';
  return safeFilename(decodeURIComponent(match[1]), 'pingan-invoice.pdf');
}

async function resolveToken(url: string, ctx: Ctx): Promise<string> {
  const response = await ctx.http(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 Mail-Fapiao-Helper' },
  });
  if (!response.ok) throw new Error(`pingan_entry_http_${response.status}`);

  const finalUrl = response.url;
  const directToken = new URL(finalUrl).searchParams.get('q');
  if (directToken) return directToken;

  const html = await response.text();
  const invoiceUrl = extractInvoiceUrl(html);
  if (!invoiceUrl) throw new Error('pingan_invoice_url_missing');
  const token = new URL(invoiceUrl).searchParams.get('q');
  if (!token) throw new Error('pingan_token_missing');
  return token;
}

const pinganHandler: SiteHandler = {
  name: 'pingan',

  match(url: string): boolean {
    try {
      const parsed = new URL(decodeHtmlEntities(url));
      return (parsed.hostname === 'www.pingan.com' && parsed.pathname.startsWith('/dzfp/'))
        || parsed.hostname === 'vms-pvms.pa18.com'
        || parsed.hostname === 'dscs-ucup-evp-core.pingan.com.cn';
    } catch {
      return false;
    }
  },

  async handle(_page: Page, url: string, ctx: Ctx): Promise<PdfArtifact[]> {
    const token = await resolveToken(decodeHtmlEntities(url), ctx);
    const downloadUrl = `https://dscs-ucup-evp-core.pingan.com.cn/ucup-evp-dmz/api/v1/preview?t=1&v=3&q=${encodeURIComponent(token)}`;
    const { data, contentType } = await fetchBuffer(downloadUrl, ctx);

    if (!contentType.includes('pdf') && !contentType.includes('octet-stream')
        && data.subarray(0, 4).toString('latin1') !== '%PDF') {
      throw new Error(`pingan_no_pdf:${contentType || 'unknown'}`);
    }

    const head = await ctx.http(downloadUrl, { method: 'HEAD' }).catch(() => null);
    return [{
      data,
      source: downloadUrl,
      suggestedName: filenameFromDisposition(head?.headers.get('content-disposition') ?? null),
    }];
  },
};

export default pinganHandler;
