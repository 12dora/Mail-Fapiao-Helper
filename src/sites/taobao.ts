import type { Page } from 'playwright';
import type { Ctx, PdfArtifact } from '../extract/types.js';
import type { SiteHandler } from './types.js';
import { decodeHtmlEntities, fetchBuffer, pdfsFromZip } from './common.js';

const taobaoHandler: SiteHandler = {
  name: 'taobao',

  match(url: string): boolean {
    try {
      const parsed = new URL(decodeHtmlEntities(url));
      return parsed.hostname === 'einvoice.taobao.com'
        && parsed.pathname.includes('/api/invoice/downloadMailInvoice');
    } catch {
      return false;
    }
  },

  async handle(_page: Page, url: string, ctx: Ctx): Promise<PdfArtifact[]> {
    const cleanUrl = decodeHtmlEntities(url);
    const { data, contentType } = await fetchBuffer(cleanUrl, ctx);

    if (data.subarray(0, 4).toString('latin1') === '%PDF') {
      return [{ data, source: cleanUrl, suggestedName: 'taobao-invoice.pdf' }];
    }

    if (contentType.includes('application/zip')
        || contentType.includes('application/octet-stream')
        || data.subarray(0, 2).toString('latin1') === 'PK') {
      const pdfs = pdfsFromZip(data, cleanUrl);
      if (pdfs.length > 0) return pdfs;
    }

    throw new Error(`taobao_no_pdf:${contentType || 'unknown'}`);
  },
};

export default taobaoHandler;
