import type { Page } from 'playwright';
import type { Ctx, PdfArtifact } from '../extract/types.js';
import type { SiteHandler } from './types.js';
import { decodeHtmlEntities, fetchBuffer, pdfsFromZip } from './common.js';

const taobaoFlashHandler: SiteHandler = {
  name: 'taobaoFlash',

  match(url: string): boolean {
    try {
      const parsed = new URL(decodeHtmlEntities(url));
      return parsed.hostname === 'fin-invoice-zbprod-zb1-oss-1.oss-cn-zhangjiakou.aliyuncs.com'
        && parsed.pathname.toLowerCase().endsWith('.zip');
    } catch {
      return false;
    }
  },

  async handle(_page: Page, url: string, ctx: Ctx): Promise<PdfArtifact[]> {
    const cleanUrl = decodeHtmlEntities(url);
    const { data, contentType } = await fetchBuffer(cleanUrl, ctx);

    if (contentType.includes('application/zip')
        || contentType.includes('application/octet-stream')
        || data.subarray(0, 2).toString('latin1') === 'PK') {
      const pdfs = pdfsFromZip(data, cleanUrl);
      if (pdfs.length > 0) return pdfs;
    }

    throw new Error(`taobaoFlash_no_pdf:${contentType || 'unknown'}`);
  },
};

export default taobaoFlashHandler;
