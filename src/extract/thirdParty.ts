import type { ParsedMail } from 'mailparser';
import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import type { Ctx, ExtractIssue, Extractor, ExtractResult, PdfArtifact } from './types.js';
import { handlers } from '../sites/registry.js';
import type { SiteHandler } from '../sites/types.js';
import { normalizeExtractedUrls } from '../util/url.js';

function extractLinksFromHtml(html: string): string[] {
  const links: string[] = [];
  const hrefRegex = /href=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefRegex.exec(html)) !== null) {
    if (match[1]) links.push(match[1]);
  }
  return links;
}

function extractLinksFromText(text: string): string[] {
  const links: string[] = [];
  const urlRegex = /https?:\/\/[^\s<>"'{}|\\^`\[\]]+/gi;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(text)) !== null) {
    if (match[0]) links.push(match[0]);
  }
  return links;
}

function extractLinks(mail: ParsedMail): string[] {
  const links: string[] = [];
  if (typeof mail.html === 'string') {
    links.push(...extractLinksFromHtml(mail.html));
    links.push(...extractLinksFromText(mail.html));
  }
  if (typeof mail.text === 'string') links.push(...extractLinksFromText(mail.text));
  // 与 directLink 共用 URL normalizer：此前只解码两个 HTML entity 并 trim，正文里
  // `...token=abc。` 这类链接会带着句末标点被请求并失败（APP-10A）。
  return normalizeExtractedUrls(links);
}

function pdfContentKey(pdf: PdfArtifact): string {
  return createHash('sha1').update(pdf.data).digest('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRetryableSiteError(err: unknown): boolean {
  const msg = errorMessage(err);
  if (msg.startsWith('network_retry_failed:')) return false;
  const lower = msg.toLowerCase();
  return lower.includes('timeout')
    // per-attempt deadline 在 body 阶段到期时由 readCappedBuffer 抛出（APP-13）。
    || lower.startsWith('response_timeout')
    || lower.includes('net::err')
    || lower.includes('econnreset')
    || lower.includes('econnrefused')
    || lower.includes('fetch failed');
}

async function handleWithRetry(handler: SiteHandler, page: Page, link: string, ctx: Ctx): Promise<PdfArtifact[]> {
  const attempts = ctx.cfg.network.retries + 1;
  let lastError = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await handler.handle(page, link, ctx);
    } catch (err) {
      const msg = errorMessage(err);
      if (!isRetryableSiteError(err)) {
        throw err;
      }
      lastError = msg;
      if (attempt === attempts) {
        throw new Error(`network_retry_failed:siteHandler:${handler.name}:${link}:${lastError}`);
      }
      ctx.log.warn(`network retry ${attempt}/${ctx.cfg.network.retries} siteHandler ${handler.name} ${link}: ${msg}`);
      if (ctx.cfg.network.retryDelayMs > 0) {
        await sleep(ctx.cfg.network.retryDelayMs * attempt);
      }
    }
  }
  throw new Error(`network_retry_failed:siteHandler:${handler.name}:${lastError || 'unknown'}`);
}

const thirdPartyExtractor: Extractor = {
  name: 'thirdParty',

  canHandle(mail: ParsedMail): boolean {
    return extractLinks(mail).some((link) => handlers.some((handler) => handler.match(link)));
  },

  async extract(mail: ParsedMail, ctx: Ctx): Promise<ExtractResult> {
    const page = await ctx.browser().then((browser) => browser.newPage());
    try {
      const pdfs: PdfArtifact[] = [];
      const seenPdfs = new Set<string>();
      const issues: ExtractIssue[] = [];
      for (const link of extractLinks(mail)) {
        const handler = handlers.find((h) => h.match(link));
        if (!handler) continue;
        // 逐链接隔离：一个过期/损坏的站点链接不再丢掉已取得和后续的好链接（APP-01）。
        let handled: PdfArtifact[];
        try {
          handled = await handleWithRetry(handler, page, link, ctx);
        } catch (err) {
          const msg = errorMessage(err);
          issues.push({
            reason: `thirdParty:${handler.name}:${msg}`,
            retryable: msg.startsWith('network_retry_failed:'),
          });
          ctx.log.warn(`Site handler ${handler.name} failed for ${link}: ${msg}`);
          continue;
        }
        for (const pdf of handled) {
          const key = pdfContentKey(pdf);
          if (seenPdfs.has(key)) continue;
          seenPdfs.add(key);
          pdfs.push(pdf);
        }
      }

      if (pdfs.length === 0) {
        // 全部链接都失败时，把第一条失败原因原样上报，保留
        // `network_retry_failed:` 前缀供上层做网络失败统计。
        const first = issues[0];
        return { kind: 'manual', reason: first ? first.reason : 'thirdParty:no_pdfs' };
      }

      return { kind: 'pdf', pdfs, issues };
    } finally {
      await page.close();
    }
  },
};

export default thirdPartyExtractor;
