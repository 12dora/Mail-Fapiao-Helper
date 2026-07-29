import type { Ctx } from '../extract/types.js';
import type { SiteHandleResult, SiteHandler } from './types.js';
import { assertDocumentResponse, decodeHtmlEntities, fetchBuffer, filenameFromUrl } from './common.js';

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

  async handle(url: string, ctx: Ctx): Promise<SiteHandleResult> {
    const cleanUrl = decodeHtmlEntities(url);
    const { data, contentType } = await fetchBuffer(cleanUrl, ctx);
    assertDocumentResponse({ data, contentType, label: 'keruyun', allow: ['pdf'] });

    return {
      artifacts: [{
        data,
        source: cleanUrl,
        suggestedName: filenameFromUrl(cleanUrl, 'keruyun-invoice.pdf'),
        format: 'pdf',
      }],
    };
  },
};

export default keruyunHandler;
