import type { Ctx } from '../extract/types.js';
import type { SiteHandleResult, SiteHandler } from './types.js';
import { assertDocumentResponse, decodeHtmlEntities, fetchBuffer, safeFilename, tryDecodeURIComponent } from './common.js';

function extractInvoiceUrl(html: string): string | null {
  const match = html.match(/invoiceUrl\s*=\s*'([^']+)'/);
  return match?.[1] ? decodeHtmlEntities(match[1]) : null;
}

function filenameFromDisposition(value: string | null): string {
  const match = value?.match(/filename="?([^";]+)"?/i);
  if (!match?.[1]) return 'pingan-invoice.pdf';
  return safeFilename(tryDecodeURIComponent(match[1]), 'pingan-invoice.pdf');
}

async function resolveToken(url: string, ctx: Ctx): Promise<string> {
  const response = await ctx.http(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 Mail-Fapiao-Helper' },
  });
  if (!response.ok) throw new Error(`pingan_entry_http_${response.status}`);

  const finalUrl = response.url;
  const directToken = new URL(finalUrl).searchParams.get('q');
  if (directToken) return directToken;

  const html = await response.text();
  const invoiceUrl = extractInvoiceUrl(html);
  if (!invoiceUrl) throw new Error('pingan_invoice_url_missing');
  const token = new URL(invoiceUrl).searchParams.get('q');
  if (!token) throw new Error('pingan_token_missing');
  return token;
}

const pinganHandler: SiteHandler = {
  name: 'pingan',

  match(url: string): boolean {
    try {
      const parsed = new URL(decodeHtmlEntities(url));
      return (parsed.hostname === 'www.pingan.com' && parsed.pathname.startsWith('/dzfp/'))
        || parsed.hostname === 'vms-pvms.pa18.com'
        || parsed.hostname === 'dscs-ucup-evp-core.pingan.com.cn';
    } catch {
      return false;
    }
  },

  async handle(url: string, ctx: Ctx): Promise<SiteHandleResult> {
    const token = await resolveToken(decodeHtmlEntities(url), ctx);
    const downloadUrl = `https://dscs-ucup-evp-core.pingan.com.cn/ucup-evp-dmz/api/v1/preview?t=1&v=3&q=${encodeURIComponent(token)}`;
    const { data, contentType } = await fetchBuffer(downloadUrl, ctx);

    // 通用 MIME（octet-stream）必须配合 magic bytes 才放行，否则 JSON 错误页
    // 或网关响应会被当成发票归档并送进 OCR（APP-10D）。
    assertDocumentResponse({ data, contentType, label: 'pingan', allow: ['pdf'] });

    const head = await ctx.http(downloadUrl, { method: 'HEAD' }).catch(() => null);
    return {
      artifacts: [{
        data,
        source: downloadUrl,
        suggestedName: filenameFromDisposition(head?.headers.get('content-disposition') ?? null),
        format: 'pdf',
      }],
    };
  },
};

export default pinganHandler;
