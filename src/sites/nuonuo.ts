import type { Ctx } from '../extract/types.js';
import type { SiteHandleResult, SiteHandler } from './types.js';
import { assertPublicUrl, readCappedBuffer } from '../util/net.js';
import { assertDocumentResponse } from './common.js';

function isNuonuoHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'nnfp.jss.com.cn'
    || h === 'nnfp.nuonuo.com'
    || h.endsWith('.nuonuo.com')
    || h.endsWith('.jss.com.cn');
}

interface NuonuoDetailResponse {
  status?: string;
  msg?: string | null;
  data?: {
    invoiceSimpleVo?: {
      fphm?: string;
      url?: string;
    };
  } | null;
}

function extractParamList(url: string): string | null {
  const parsed = new URL(url);
  const paramList = parsed.searchParams.get('paramList');
  if (paramList) return paramList;

  return null;
}

function invoiceEntryUrl(url: string): string | null {
  const parsed = new URL(url);
  if (parsed.pathname === '/allow/service/getEwmImg.do') {
    // The `content` param is an attacker-controlled URL from the email. Only
    // follow it if it is an http(s) nuonuo host, otherwise this is an SSRF.
    const content = parsed.searchParams.get('content');
    if (!content) return null;
    let target: URL;
    try {
      target = new URL(content);
    } catch {
      return null;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
    if (!isNuonuoHost(target.hostname)) return null;
    return target.toString();
  }
  if (parsed.pathname.startsWith('/scan-invoice/printQrcode')) {
    return url;
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length === 1 && parts[0]) {
    return url;
  }
  return null;
}

function makeSuggestedName(invoiceNo: string | undefined, fallback: string): string {
  if (invoiceNo && invoiceNo.length > 0) return `${invoiceNo}.pdf`;
  return `${fallback}.pdf`;
}

async function resolveShortLink(url: string, ctx: Ctx): Promise<string> {
  const response = await ctx.http(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 Mail-Fapiao-Helper',
    },
  });
  return response.url || url;
}

async function fetchDetail(url: string, paramList: string, ctx: Ctx): Promise<NuonuoDetailResponse> {
  const body = new URLSearchParams({
    paramList,
    aliView: 'true',
    invoiceDetailMiddleUri: `printQrcode?paramList=${paramList}&aliView=true&shortLinkSource=1&wxApplet=0`,
    shortLinkSource: '1',
  });

  const response = await ctx.http('https://nnfp.jss.com.cn/scan2/getIvcDetailShow.do', {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'https://nnfp.jss.com.cn',
      Referer: url,
      'User-Agent': 'Mozilla/5.0 Mail-Fapiao-Helper',
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`nuonuo_detail_http_${response.status}`);
  }

  return await response.json() as NuonuoDetailResponse;
}

async function downloadPdf(url: string, ctx: Ctx): Promise<Buffer> {
  await assertPublicUrl(url);
  const response = await ctx.http(url, {
    headers: {
      Accept: 'application/pdf,*/*',
      Referer: 'https://nnfp.jss.com.cn/',
      'User-Agent': 'Mozilla/5.0 Mail-Fapiao-Helper',
    },
  });

  if (!response.ok) {
    throw new Error(`nuonuo_pdf_http_${response.status}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const data = await readCappedBuffer(response);
  // 只认 magic bytes：带 `%PDF` 头的通用 MIME 也是合法发票，不能因为 CDN 返回
  // application/octet-stream 就把有效 PDF 打进待确认（APP-10D）。
  assertDocumentResponse({ data, contentType, label: 'nuonuo_pdf', allow: ['pdf'] });
  return data;
}

const nuonuoHandler: SiteHandler = {
  name: 'nuonuo',

  match(url: string): boolean {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return host === 'nnfp.jss.com.cn' || host === 'nnfp.nuonuo.com';
    } catch {
      return false;
    }
  },

  async handle(url: string, ctx: Ctx): Promise<SiteHandleResult> {
    const entryUrl = invoiceEntryUrl(url);
    // EXT-03：匹配但无法解析入口时返回 issue，禁止空数组静默成功。
    if (!entryUrl) {
      return {
        artifacts: [],
        issues: [{ reason: `entry_url_unresolved:${url}` }],
      };
    }

    const resolvedUrl = entryUrl.includes('/scan-invoice/printQrcode')
      ? entryUrl
      : await resolveShortLink(entryUrl, ctx);
    const paramList = extractParamList(resolvedUrl);
    if (!paramList) {
      return {
        artifacts: [],
        issues: [{ reason: `paramList_missing:${resolvedUrl}` }],
      };
    }

    const detail = await fetchDetail(resolvedUrl, paramList, ctx);
    if (detail.status !== '0000') {
      throw new Error(`nuonuo_detail_${detail.status ?? 'unknown'}:${detail.msg ?? ''}`);
    }

    const simple = detail.data?.invoiceSimpleVo;
    const pdfUrl = simple?.url;
    if (!pdfUrl) {
      throw new Error('nuonuo_pdf_url_missing');
    }

    const data = await downloadPdf(pdfUrl, ctx);
    const shortCode = new URL(url).pathname.split('/').filter(Boolean).pop() ?? 'nuonuo';
    return {
      artifacts: [{
        data,
        source: pdfUrl,
        suggestedName: makeSuggestedName(simple?.fphm, shortCode),
        format: 'pdf',
      }],
    };
  },
};

export default nuonuoHandler;
