import type { Page } from 'playwright';
import type { Ctx, PdfArtifact } from '../extract/types.js';
import type { SiteHandler } from './types.js';
import { decodeHtmlEntities, fetchBuffer, safeFilename } from './common.js';

function filenameFromDisposition(value: string | null): string {
  const encoded = value?.match(/filename\*=UTF-8''([^;\s]+)/i);
  if (encoded?.[1]) return safeFilename(decodeURIComponent(encoded[1]), 'baiwang-invoice.pdf');
  const match = value?.match(/filename=([^;\s]+)/i);
  if (!match?.[1]) return 'baiwang-invoice.pdf';
  return safeFilename(decodeURIComponent(match[1].replace(/^"|"$/g, '')), 'baiwang-invoice.pdf');
}

async function pdfFromUrl(url: string, ctx: Ctx, referer?: string): Promise<PdfArtifact> {
  const { data, contentType, contentDisposition } = await fetchBuffer(url, ctx, referer);

  if (!contentType.includes('pdf') && data.subarray(0, 4).toString('latin1') !== '%PDF') {
    throw new Error(`baiwang_no_pdf:${contentType || 'unknown'}`);
  }

  return {
    data,
    source: url,
    suggestedName: filenameFromDisposition(contentDisposition),
  };
}

function directDownloadUrl(url: string): string | null {
  const parsed = new URL(url);
  if (parsed.hostname === 'pis.baiwang.com'
      && parsed.pathname.includes('/smkp-vue/previewInvoiceAllEle')
      && parsed.searchParams.has('param')) {
    const param = parsed.searchParams.get('param');
    if (!param) throw new Error('baiwang_param_missing');
    return `https://pis.baiwang.com/bwmg/mix/bw/downloadFormat?param=${encodeURIComponent(param)}&formatType=PDF`;
  }

  if ((parsed.hostname === 'www.bwjf.cn' || parsed.hostname === 'fp.bwjf.cn')
      && parsed.searchParams.has('pdfUrl')) {
    return parsed.searchParams.get('pdfUrl');
  }

  if (parsed.hostname === 'fp.baiwang.com' && parsed.pathname === '/format/d') {
    return url;
  }

  return null;
}

async function resolveBwjfShortUrl(url: string, ctx: Ctx): Promise<string> {
  const response = await ctx.http(url, {
    redirect: 'follow',
    headers: {
      Accept: 'text/html,*/*',
      'User-Agent': 'Mozilla/5.0 Mail-Fapiao-Helper',
    },
  });
  if (!response.ok) throw new Error(`http_${response.status}`);
  return response.url;
}

async function resolveLegacyPreview(url: string, ctx: Ctx): Promise<string> {
  const invoiceId = new URL(url).searchParams.get('invoiceId');
  if (!invoiceId) throw new Error('baiwang_invoice_id_missing');
  const apiUrl = `http://i.baiwang.com/api/forward/tour/invoices?invoiceId=${encodeURIComponent(invoiceId)}`;
  const response = await ctx.http(apiUrl, {
    headers: {
      Accept: 'application/json,*/*',
      'User-Agent': 'Mozilla/5.0 Mail-Fapiao-Helper',
    },
  });
  if (!response.ok) throw new Error(`http_${response.status}`);
  const json = await response.json() as { resultData?: Array<{ einvoiceUrl?: string }> };
  const downloadUrl = json.resultData?.find((row) => typeof row.einvoiceUrl === 'string')?.einvoiceUrl;
  if (!downloadUrl) throw new Error('baiwang_invoice_url_missing');
  return downloadUrl;
}

const baiwangHandler: SiteHandler = {
  name: 'baiwang',

  match(url: string): boolean {
    try {
      const parsed = new URL(decodeHtmlEntities(url));
      return (parsed.hostname === 'pis.baiwang.com'
          && parsed.pathname.includes('/smkp-vue/previewInvoiceAllEle')
          && parsed.searchParams.has('param'))
        || ((parsed.hostname === 'www.bwjf.cn' || parsed.hostname === 'fp.bwjf.cn')
          && (parsed.pathname.startsWith('/u/') || parsed.searchParams.has('pdfUrl')))
        || (parsed.hostname === 'i.baiwang.com'
          && parsed.pathname === '/kaipiao/previewInvoice'
          && parsed.searchParams.has('invoiceId'))
        || (parsed.hostname === 'fp.baiwang.com' && parsed.pathname === '/format/d');
    } catch {
      return false;
    }
  },

  async handle(_page: Page, url: string, ctx: Ctx): Promise<PdfArtifact[]> {
    const cleanUrl = decodeHtmlEntities(url);
    const parsed = new URL(cleanUrl);
    let downloadUrl = directDownloadUrl(cleanUrl);

    if (!downloadUrl && parsed.hostname === 'fp.bwjf.cn' && parsed.pathname.startsWith('/u/')) {
      downloadUrl = directDownloadUrl(await resolveBwjfShortUrl(cleanUrl, ctx));
    }
    if (!downloadUrl && parsed.hostname === 'i.baiwang.com') {
      downloadUrl = await resolveLegacyPreview(cleanUrl, ctx);
    }
    if (!downloadUrl) throw new Error('baiwang_download_url_missing');

    return [await pdfFromUrl(downloadUrl, ctx, cleanUrl)];
  },
};

export default baiwangHandler;
