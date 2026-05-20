import type { Page } from 'playwright';
import type { Ctx, PdfArtifact } from '../extract/types.js';
import type { SiteHandler } from './types.js';
import { decodeHtmlEntities, fetchBuffer, safeFilename } from './common.js';

function paramFromUrl(url: string): string {
  const param = new URL(url).searchParams.get('param');
  if (!param) throw new Error('baiwang_param_missing');
  return param;
}

function filenameFromDisposition(value: string | null): string {
  const match = value?.match(/fileName=([^;\s]+)/i);
  if (!match?.[1]) return 'baiwang-invoice.pdf';
  return safeFilename(decodeURIComponent(match[1]), 'baiwang-invoice.pdf');
}

const baiwangHandler: SiteHandler = {
  name: 'baiwang',

  match(url: string): boolean {
    try {
      const parsed = new URL(decodeHtmlEntities(url));
      return parsed.hostname === 'pis.baiwang.com'
        && parsed.pathname.includes('/smkp-vue/previewInvoiceAllEle')
        && parsed.searchParams.has('param');
    } catch {
      return false;
    }
  },

  async handle(_page: Page, url: string, ctx: Ctx): Promise<PdfArtifact[]> {
    const cleanUrl = decodeHtmlEntities(url);
    const param = paramFromUrl(cleanUrl);
    const downloadUrl = `https://pis.baiwang.com/bwmg/mix/bw/downloadFormat?param=${encodeURIComponent(param)}&formatType=PDF`;
    const { data, contentType } = await fetchBuffer(downloadUrl, ctx, cleanUrl);

    if (!contentType.includes('pdf') && data.subarray(0, 4).toString('latin1') !== '%PDF') {
      throw new Error(`baiwang_no_pdf:${contentType || 'unknown'}`);
    }

    const head = await ctx.http(downloadUrl, { method: 'HEAD' }).catch(() => null);
    return [{
      data,
      source: downloadUrl,
      suggestedName: filenameFromDisposition(head?.headers.get('content-disposition') ?? null),
    }];
  },
};

export default baiwangHandler;
