import type { Page } from 'playwright';
import type { Ctx, PdfArtifact } from '../extract/types.js';
import type { SiteHandler } from './types.js';
import { decodeHtmlEntities, fetchBuffer, safeFilename } from './common.js';

function idFromUrl(url: string): string {
  const id = new URL(url).searchParams.get('id');
  if (!id) throw new Error('taxPreview_id_missing');
  return id;
}

function filenameFromDisposition(value: string | null, fallback: string): string {
  const match = value?.match(/filename="?([^";]+)"?/i);
  if (!match?.[1]) return fallback;
  return safeFilename(decodeURIComponent(match[1]), fallback);
}

const taxPreviewHandler: SiteHandler = {
  name: 'taxPreview',

  match(url: string): boolean {
    try {
      const parsed = new URL(decodeHtmlEntities(url));
      return parsed.hostname === 'fp.zjaphp.com'
        && parsed.pathname.includes('/skfw/fpView/toQdfpyl.htm')
        && parsed.searchParams.has('id');
    } catch {
      return false;
    }
  },

  async handle(_page: Page, url: string, ctx: Ctx): Promise<PdfArtifact[]> {
    const cleanUrl = decodeHtmlEntities(url);
    const id = idFromUrl(cleanUrl);
    const parsed = new URL(cleanUrl);
    const downloadUrl = `${parsed.origin}/ZZSKP/skfw/fpView/toDownloadQdPdf.htm?id=${encodeURIComponent(id)}`;
    const { data, contentType } = await fetchBuffer(downloadUrl, ctx, cleanUrl);

    if (!contentType.includes('pdf') && data.subarray(0, 4).toString('latin1') !== '%PDF') {
      throw new Error(`taxPreview_no_pdf:${contentType || 'unknown'}`);
    }

    const head = await ctx.http(downloadUrl, { method: 'HEAD' }).catch(() => null);
    return [{
      data,
      source: downloadUrl,
      suggestedName: filenameFromDisposition(head?.headers.get('content-disposition') ?? null, `${id}.pdf`),
    }];
  },
};

export default taxPreviewHandler;
