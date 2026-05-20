import type { Page } from 'playwright';
import type { Ctx, PdfArtifact } from '../extract/types.js';
import type { SiteHandler } from './types.js';
import { decodeHtmlEntities, fetchBuffer, filenameFromUrl } from './common.js';

const keruyunHandler: SiteHandler = {
  name: 'keruyun',

  match(url: string): boolean {
    try {
      const parsed = new URL(decodeHtmlEntities(url));
      return parsed.hostname === 'invoice.keruyun.com';
    } catch {
      return false;
    }
  },

  async handle(_page: Page, url: string, ctx: Ctx): Promise<PdfArtifact[]> {
    const cleanUrl = decodeHtmlEntities(url);
    const { data, contentType } = await fetchBuffer(cleanUrl, ctx);
    if (!contentType.includes('application/pdf') && data.subarray(0, 4).toString('latin1') !== '%PDF') {
      throw new Error(`keruyun_no_pdf:${contentType || 'unknown'}`);
    }

    return [{
      data,
      source: cleanUrl,
      suggestedName: filenameFromUrl(cleanUrl, 'keruyun-invoice.pdf'),
    }];
  },
};

export default keruyunHandler;
