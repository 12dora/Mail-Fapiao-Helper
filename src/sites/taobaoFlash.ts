import type { Page } from 'playwright';
import type { Ctx, PdfArtifact } from '../extract/types.js';
import type { SiteHandler } from './types.js';
import { decodeHtmlEntities, detectDocumentKind, documentsFromZip, fetchBuffer } from './common.js';

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

    const kind = detectDocumentKind(data);
    if (kind === 'pdf') {
      return [{ data, source: cleanUrl, suggestedName: 'taobao-flash-invoice.pdf', format: 'pdf' }];
    }

    if (kind === 'archive') {
      // PDF / OFD / 图片都是受支持的发票格式（APP-10C）。
      const { documents, skipped } = documentsFromZip(data, cleanUrl);
      if (skipped.length > 0) {
        ctx.log.warn(`taobaoFlash ZIP entries skipped: ${skipped.join(', ')}`);
      }
      if (documents.length > 0) return documents;
    }

    throw new Error(`taobaoFlash_no_document:${contentType || 'unknown'}:${kind}`);
  },
};

export default taobaoFlashHandler;
