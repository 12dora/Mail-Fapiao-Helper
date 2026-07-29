import type { Ctx } from '../extract/types.js';
import type { SiteHandleResult, SiteHandler } from './types.js';
import { assertDocumentResponse, decodeHtmlEntities, fetchBuffer, safeFilename, tryDecodeURIComponent } from './common.js';

/** 百望短链域名：`match()` 与 `handle()` 必须使用同一个判定（APP-10B）。 */
function isBwjfShortLink(parsed: URL): boolean {
  return (parsed.hostname === 'www.bwjf.cn' || parsed.hostname === 'fp.bwjf.cn')
    && parsed.pathname.startsWith('/u/');
}

function isBwjfPdfUrlLink(parsed: URL): boolean {
  return (parsed.hostname === 'www.bwjf.cn' || parsed.hostname === 'fp.bwjf.cn')
    && parsed.searchParams.has('pdfUrl');
}

function isBaiwangPreview(parsed: URL): boolean {
  return parsed.hostname === 'pis.baiwang.com'
    && parsed.pathname.includes('/smkp-vue/previewInvoiceAllEle')
    && parsed.searchParams.has('param');
}

function isBaiwangLegacyPreview(parsed: URL): boolean {
  return parsed.hostname === 'i.baiwang.com'
    && parsed.pathname === '/kaipiao/previewInvoice'
    && parsed.searchParams.has('invoiceId');
}

function isBaiwangFormat(parsed: URL): boolean {
  return parsed.hostname === 'fp.baiwang.com' && parsed.pathname === '/format/d';
}

/** API 返回的下载地址必须落在百望相关 host，防止中间人替换为任意公网 PDF（EXT-06）。 */
function isAllowedBaiwangDownloadHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'baiwang.com'
    || h.endsWith('.baiwang.com')
    || h === 'bwjf.cn'
    || h.endsWith('.bwjf.cn')
    || h === 'baiwang.com.cn'
    || h.endsWith('.baiwang.com.cn');
}

function filenameFromDisposition(value: string | null): string {
  const encoded = value?.match(/filename\*=UTF-8''([^;\s]+)/i);
  if (encoded?.[1]) return safeFilename(tryDecodeURIComponent(encoded[1]), 'baiwang-invoice.pdf');
  const match = value?.match(/filename=([^;\s]+)/i);
  if (!match?.[1]) return 'baiwang-invoice.pdf';
  return safeFilename(tryDecodeURIComponent(match[1].replace(/^"|"$/g, '')), 'baiwang-invoice.pdf');
}

async function pdfFromUrl(url: string, ctx: Ctx, referer?: string) {
  const { data, contentType, contentDisposition } = await fetchBuffer(url, ctx, referer);

  // 与其他 handler 共用同一个文档响应校验（APP-10D）。
  assertDocumentResponse({ data, contentType, label: 'baiwang', allow: ['pdf'] });

  return {
    data,
    source: url,
    suggestedName: filenameFromDisposition(contentDisposition),
    format: 'pdf' as const,
  };
}

function directDownloadUrl(url: string): string | null {
  const parsed = new URL(url);
  if (isBaiwangPreview(parsed)) {
    const param = parsed.searchParams.get('param');
    if (!param) throw new Error('baiwang_param_missing');
    return `https://pis.baiwang.com/bwmg/mix/bw/downloadFormat?param=${encodeURIComponent(param)}&formatType=PDF`;
  }

  if (isBwjfPdfUrlLink(parsed)) {
    return parsed.searchParams.get('pdfUrl');
  }

  if (isBaiwangFormat(parsed)) {
    return url;
  }

  return null;
}

/**
 * 展开 bwjf 短链并校验最终 redirect：只有落到已受支持的百望地址才继续，
 * 否则报错，避免跟随任意跳转。
 */
async function resolveBwjfShortUrl(url: string, ctx: Ctx): Promise<string> {
  const response = await ctx.http(url, {
    redirect: 'follow',
    headers: {
      Accept: 'text/html,*/*',
      'User-Agent': 'Mozilla/5.0 Mail-Fapiao-Helper',
    },
  });
  if (!response.ok) throw new Error(`http_${response.status}`);
  const finalUrl = response.url || url;
  let parsed: URL;
  try {
    parsed = new URL(finalUrl);
  } catch {
    throw new Error('baiwang_shortlink_invalid_redirect');
  }
  if (!isBwjfPdfUrlLink(parsed) && !isBaiwangPreview(parsed) && !isBaiwangFormat(parsed)) {
    throw new Error(`baiwang_shortlink_unsupported_redirect:${parsed.hostname}`);
  }
  return finalUrl;
}

/**
 * 旧预览页：只走 HTTPS 解析下载地址（EXT-06）。
 * 明文 HTTP 会被链路中间人替换 einvoiceUrl，绝不能降级。
 */
async function resolveLegacyPreview(url: string, ctx: Ctx): Promise<string> {
  const invoiceId = new URL(url).searchParams.get('invoiceId');
  if (!invoiceId) throw new Error('baiwang_invoice_id_missing');
  const apiUrl = `https://i.baiwang.com/api/forward/cloud/invoices?invoiceId=${encodeURIComponent(invoiceId)}`;
  const response = await ctx.http(apiUrl, {
    headers: {
      Accept: 'application/json,*/*',
      'User-Agent': 'Mozilla/5.0 Mail-Fapiao-Helper',
    },
  });
  if (!response.ok) {
    // HTTPS 不可用时进入待确认，不回退到明文 HTTP。
    throw new Error(`baiwang_legacy_api_http_${response.status}`);
  }
  const json = await response.json() as { resultData?: Array<{ einvoiceUrl?: string }> };
  const downloadUrl = json.resultData?.find((row) => typeof row.einvoiceUrl === 'string')?.einvoiceUrl;
  if (!downloadUrl) throw new Error('baiwang_invoice_url_missing');

  let parsed: URL;
  try {
    parsed = new URL(downloadUrl);
  } catch {
    throw new Error('baiwang_invoice_url_invalid');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`baiwang_invoice_url_insecure:${parsed.protocol}`);
  }
  if (!isAllowedBaiwangDownloadHost(parsed.hostname)) {
    throw new Error(`baiwang_invoice_url_untrusted_host:${parsed.hostname}`);
  }
  return downloadUrl;
}

const baiwangHandler: SiteHandler = {
  name: 'baiwang',

  match(url: string): boolean {
    try {
      const parsed = new URL(decodeHtmlEntities(url));
      return isBaiwangPreview(parsed)
        || isBwjfShortLink(parsed)
        || isBwjfPdfUrlLink(parsed)
        || isBaiwangLegacyPreview(parsed)
        || isBaiwangFormat(parsed);
    } catch {
      return false;
    }
  },

  async handle(url: string, ctx: Ctx): Promise<SiteHandleResult> {
    const cleanUrl = decodeHtmlEntities(url);
    const parsed = new URL(cleanUrl);
    let downloadUrl = directDownloadUrl(cleanUrl);

    // `match()` 接受 www.bwjf.cn 与 fp.bwjf.cn 两个短链域名，短链解析必须覆盖
    // 同样两个域名，否则 www 短链虽被识别为受支持却必然落到手动处理（APP-10B）。
    if (!downloadUrl && isBwjfShortLink(parsed)) {
      downloadUrl = directDownloadUrl(await resolveBwjfShortUrl(cleanUrl, ctx));
    }
    if (!downloadUrl && isBaiwangLegacyPreview(parsed)) {
      downloadUrl = await resolveLegacyPreview(cleanUrl, ctx);
    }
    if (!downloadUrl) throw new Error('baiwang_download_url_missing');

    return { artifacts: [await pdfFromUrl(downloadUrl, ctx, cleanUrl)] };
  },
};

export default baiwangHandler;
