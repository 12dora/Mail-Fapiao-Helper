import type { ParsedMail } from 'mailparser';
import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import type { Ctx, ExtractIssue, Extractor, ExtractResult, PdfArtifact } from './types.js';
import { extractMailUrls } from './mailLinks.js';
import { handlers } from '../sites/registry.js';
import type { SiteHandleResult, SiteHandler } from '../sites/types.js';

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

async function handleWithRetry(
  handler: SiteHandler,
  link: string,
  ctx: Ctx,
  page: Page | undefined,
): Promise<SiteHandleResult> {
  const attempts = ctx.cfg.network.retries + 1;
  let lastError = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await handler.handle(link, ctx, page);
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
    return extractMailUrls(mail).some((link) => handlers.some((handler) => handler.match(link)));
  },

  async extract(mail: ParsedMail, ctx: Ctx): Promise<ExtractResult> {
    const links = extractMailUrls(mail);
    const matched = links
      .map((link) => {
        const handler = handlers.find((h) => h.match(link));
        return handler ? { link, handler } : null;
      })
      .filter((item): item is { link: string; handler: SiteHandler } => item !== null);

    if (matched.length === 0) {
      return { kind: 'not_applicable', reason: 'thirdParty:no_matched_links' };
    }

    // EXT-09：仅当某个命中的 handler 声明 requiresBrowser 时才启动浏览器/创建 page。
    const needsBrowser = matched.some((item) => item.handler.requiresBrowser === true);
    let page: Page | undefined;
    if (needsBrowser) {
      page = await ctx.browser().then((browser) => browser.newPage());
    }

    try {
      const pdfs: PdfArtifact[] = [];
      const seenPdfs = new Set<string>();
      const issues: ExtractIssue[] = [];

      for (const { link, handler } of matched) {
        // 逐链接隔离：一个过期/损坏的站点链接不再丢掉已取得和后续的好链接（APP-01）。
        let handled: SiteHandleResult;
        try {
          handled = await handleWithRetry(handler, link, ctx, page);
        } catch (err) {
          const msg = errorMessage(err);
          issues.push({
            reason: `thirdParty:${handler.name}:${msg}`,
            retryable: msg.startsWith('network_retry_failed:'),
          });
          ctx.log.warn(`Site handler ${handler.name} failed for ${link}: ${msg}`);
          continue;
        }

        if (handled.issues && handled.issues.length > 0) {
          for (const issue of handled.issues) {
            issues.push({
              reason: issue.reason.startsWith('thirdParty:')
                ? issue.reason
                : `thirdParty:${handler.name}:${issue.reason}`,
              retryable: issue.retryable,
            });
          }
        }

        // EXT-03：匹配链接若既无 artifact 也无 issue，强制补一条，禁止静默空成功。
        if (handled.artifacts.length === 0 && (!handled.issues || handled.issues.length === 0)) {
          issues.push({ reason: `thirdParty:${handler.name}:empty_result:${link}` });
          ctx.log.warn(`Site handler ${handler.name} returned empty result for ${link}`);
        }

        for (const pdf of handled.artifacts) {
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
      if (page) await page.close();
    }
  },
};

export default thirdPartyExtractor;
