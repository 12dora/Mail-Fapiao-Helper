import type { Ctx } from '../extract/types.js';
import type { SiteHandleResult, SiteHandler } from './types.js';
import { assertDocumentResponse, decodeHtmlEntities, fetchBuffer, filenameFromUrl } from './common.js';

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

  async handle(url: string, ctx: Ctx): Promise<SiteHandleResult> {
    const cleanUrl = decodeHtmlEntities(url);
    const { data, contentType } = await fetchBuffer(cleanUrl, ctx);
    assertDocumentResponse({ data, contentType, label: 'jd', allow: ['pdf'] });

    return {
      artifacts: [{
        data,
        source: cleanUrl,
        suggestedName: filenameFromUrl(cleanUrl, 'jd-invoice.pdf'),
        format: 'pdf',
      }],
    };
  },
};

export default jdHandler;
