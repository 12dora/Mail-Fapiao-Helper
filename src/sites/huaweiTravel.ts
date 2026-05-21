import type { Page } from 'playwright';
import type { Ctx, PdfArtifact } from '../extract/types.js';
import type { SiteHandler } from './types.js';
import { decodeHtmlEntities, fetchBuffer, safeFilename } from './common.js';

interface HuaweiTravelResponse {
  resultCode?: string;
  data?: {
    invoiceNo?: string;
    urlList?: Array<{ url?: string; format?: string }>;
  };
}

function tokenFromUrl(url: string): string {
  const parsed = new URL(url);
  const token = parsed.searchParams.get('token') ?? parsed.searchParams.get('invoiceId');
  if (!token) throw new Error('huawei_travel_token_missing');
  return token;
}

function tokenParamName(url: string): 'token' | 'invoiceId' {
  return new URL(url).searchParams.has('token') ? 'token' : 'invoiceId';
}

function filenameFromDisposition(value: string | null, fallback: string): string {
  const encoded = value?.match(/filename\*=UTF-8''([^;\s]+)/i);
  if (encoded?.[1]) return safeFilename(decodeURIComponent(encoded[1]), fallback);
  const plain = value?.match(/filename=([^;\s]+)/i);
  if (plain?.[1]) return safeFilename(decodeURIComponent(plain[1].replace(/^"|"$/g, '')), fallback);
  return fallback;
}

async function queryPdfToken(url: string, ctx: Ctx): Promise<{ token: string; invoiceNo: string }> {
  const token = tokenFromUrl(url);
  const tokenParam = tokenParamName(url);
  const response = await ctx.http('https://m-itravel.hwht.com/restapi/invoicecenter/service/invoice_url/query', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 Mail-Fapiao-Helper',
      Referer: url,
    },
    body: JSON.stringify({
      [tokenParam]: token,
      Hchannel: 'H5',
      Hversion: '8.7.7',
      Hplatform: 'webapp',
      Hproduct: 'HWHT',
      HtraceId: 'mail-fapiao-helper',
      displayCurrency: null,
    }),
  });
  if (!response.ok) throw new Error(`http_${response.status}`);

  const json = await response.json() as HuaweiTravelResponse;
  if (json.resultCode !== '0') throw new Error(`huawei_travel_query_failed:${json.resultCode ?? 'unknown'}`);
  const pdfToken = json.data?.urlList?.find((item) => item.format === 'PDF' && item.url)?.url;
  if (!pdfToken) throw new Error('huawei_travel_pdf_missing');
  return { token: pdfToken, invoiceNo: json.data?.invoiceNo ?? 'huawei-travel-invoice' };
}

const huaweiTravelHandler: SiteHandler = {
  name: 'huaweiTravel',

  match(url: string): boolean {
    try {
      const parsed = new URL(decodeHtmlEntities(url));
      return parsed.hostname === 'm-itravel.hwht.com'
        && parsed.pathname === '/invoiceViewDownload'
        && (parsed.searchParams.has('token') || parsed.searchParams.has('invoiceId'));
    } catch {
      return false;
    }
  },

  async handle(_page: Page, url: string, ctx: Ctx): Promise<PdfArtifact[]> {
    const cleanUrl = decodeHtmlEntities(url);
    const pdf = await queryPdfToken(cleanUrl, ctx);
    const downloadUrl = `https://m-itravel.hwht.com/restapi/mobile-bff/service/file/download?filename=${encodeURIComponent(pdf.token)}`;
    const { data, contentType, contentDisposition } = await fetchBuffer(downloadUrl, ctx, cleanUrl);
    if (!contentType.includes('pdf') && data.subarray(0, 4).toString('latin1') !== '%PDF') {
      throw new Error(`huawei_travel_no_pdf:${contentType || 'unknown'}`);
    }
    return [{
      data,
      source: downloadUrl,
      suggestedName: filenameFromDisposition(contentDisposition, `${pdf.invoiceNo}.pdf`),
    }];
  },
};

export default huaweiTravelHandler;
