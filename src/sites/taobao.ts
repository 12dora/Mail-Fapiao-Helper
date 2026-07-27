import type { Page } from 'playwright';
import type { Ctx, PdfArtifact } from '../extract/types.js';
import type { SiteHandler } from './types.js';
import { decodeHtmlEntities, detectDocumentKind, documentsFromZip, fetchBuffer } from './common.js';

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

    // 只按 magic bytes 判定，避免把 JSON 错误页当成发票（APP-10D）。
    const kind = detectDocumentKind(data);
    if (kind === 'pdf') {
      return [{ data, source: cleanUrl, suggestedName: 'taobao-invoice.pdf', format: 'pdf' }];
    }

    if (kind === 'archive') {
      // PDF / OFD / 图片都是受支持的发票格式，OFD-only 包不再被当成失败（APP-10C）。
      const { documents, skipped } = documentsFromZip(data, cleanUrl);
      if (skipped.length > 0) {
        ctx.log.warn(`taobao ZIP entries skipped: ${skipped.join(', ')}`);
      }
      if (documents.length > 0) return documents;
    }

    throw new Error(`taobao_no_document:${contentType || 'unknown'}:${kind}`);
  },
};

export default taobaoHandler;
