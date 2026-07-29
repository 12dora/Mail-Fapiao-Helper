import type { Ctx, ExtractIssue, PdfArtifact } from '../extract/types.js';
import type { Page } from 'playwright';

/**
 * 站点处理器的结构化结果（EXT-03）。
 * 禁止用空数组表示“匹配了但说不清有没有票”：每个已匹配链接至少要产出
 * 一个 artifact 或一条 issue，ZIP 部分失败也必须写入 issues。
 */
export interface SiteHandleResult {
  artifacts: PdfArtifact[];
  issues?: ExtractIssue[];
}

export interface SiteHandler {
  name: string;
  match(url: string): boolean;
  /**
   * 是否需要 Playwright 页面（EXT-09）。
   * 当前全部 handler 只走 `ctx.http`，默认 false；真正需要浏览器时再声明 true，
   * thirdParty 才会惰性创建 page。
   */
  requiresBrowser?: boolean;
  /**
   * 处理已匹配的链接。`page` 仅在 `requiresBrowser === true` 时由调度器注入。
   */
  handle(url: string, ctx: Ctx, page?: Page): Promise<SiteHandleResult>;
}
