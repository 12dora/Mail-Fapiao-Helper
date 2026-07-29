import type { ParsedMail } from 'mailparser';
import { normalizeExtractedUrls } from '../util/url.js';

/**
 * 邮件正文链接扫描的唯一入口（EXT-12）。
 *
 * 此前 directLink 与 thirdParty 各自维护相同的 HTML href / 纯文本 URL 正则，
 * 任一处修了 entity 解码、锚文本或预算策略都会漂移。两个提取器只应调用本模块，
 * 再按 handler / 直链规则分流。
 */

export type MailLinkSource = 'html_href' | 'html_text' | 'text';

export interface MailLink {
  /** 规范化后的 http(s) URL。 */
  url: string;
  /** 首次出现的来源。 */
  source: MailLinkSource;
  /** 在该来源流中的顺序（0-based）。 */
  order: number;
}

function extractHrefsFromHtml(html: string): string[] {
  const links: string[] = [];
  // 支持双引号、单引号与无引号 href（常见于部分邮件客户端）。
  const hrefRegex = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefRegex.exec(html)) !== null) {
    const raw = match[1] ?? match[2] ?? match[3];
    if (raw) links.push(raw);
  }
  return links;
}

function extractUrlsFromText(text: string): string[] {
  const links: string[] = [];
  const urlRegex = /https?:\/\/[^\s<>"'{}|\\^`\[\]]+/gi;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(text)) !== null) {
    if (match[0]) links.push(match[0]);
  }
  return links;
}

/**
 * 从 ParsedMail 提取全部规范化 URL（按出现顺序去重）。
 * 与 `extractMailLinks` 相同候选集，只返回 URL 字符串，供现有调用方使用。
 */
export function extractMailUrls(mail: ParsedMail): string[] {
  return extractMailLinks(mail).map((item) => item.url);
}

/**
 * 从 ParsedMail 提取规范化 URL 及来源元数据。
 * HTML href 优先；同一 URL 只保留第一次出现的来源信息。
 */
export function extractMailLinks(mail: ParsedMail): MailLink[] {
  const raws: Array<{ raw: string; source: MailLinkSource; order: number }> = [];
  let order = 0;

  if (typeof mail.html === 'string') {
    for (const raw of extractHrefsFromHtml(mail.html)) {
      raws.push({ raw, source: 'html_href', order: order++ });
    }
    for (const raw of extractUrlsFromText(mail.html)) {
      raws.push({ raw, source: 'html_text', order: order++ });
    }
  }
  if (typeof mail.text === 'string') {
    for (const raw of extractUrlsFromText(mail.text)) {
      raws.push({ raw, source: 'text', order: order++ });
    }
  }

  const out: MailLink[] = [];
  const seen = new Set<string>();
  // 用 normalizeExtractedUrls 的语义逐条规范化，但保留首次来源。
  for (const item of raws) {
    const urls = normalizeExtractedUrls([item.raw]);
    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ url, source: item.source, order: item.order });
    }
  }
  return out;
}
