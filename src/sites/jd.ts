import type { Page } from 'playwright';
import type { Ctx, PdfArtifact } from '../extract/types.js';
import type { SiteHandler } from './types.js';
import { decodeHtmlEntities, fetchBuffer, filenameFromUrl } from './common.js';

const jdHandler: SiteHandler = {
  name: 'jd',

  match(url: string): boolean {
    try {
      const parsed = new URL(decodeHtmlEntities(url));
      return parsed.hostname.endsWith('jdcloud-oss.com')
        && parsed.pathname.toLowerCase().endsWith('.pdf');
    } catch {
      return false;
    }
  },

  async handle(_page: Page, url: string, ctx: Ctx): Promise<PdfArtifact[]> {
    const cleanUrl = decodeHtmlEntities(url);
    const { data, contentType } = await fetchBuffer(cleanUrl, ctx);
    if (!contentType.includes('application/pdf') && data.subarray(0, 4).toString('latin1') !== '%PDF') {
      throw new Error(`jd_no_pdf:${contentType || 'unknown'}`);
    }

    return [{
      data,
      source: cleanUrl,
      suggestedName: filenameFromUrl(cleanUrl, 'jd-invoice.pdf'),
    }];
  },
};

export default jdHandler;
