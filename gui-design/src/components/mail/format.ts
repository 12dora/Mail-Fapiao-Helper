/** 邮件详情里的纯格式化函数，抽出来是为了让组件只剩布局。 */

/** 附件大小：小于 1 KB 显示字节，超过 1 MB 保留一位小数。 */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** `application/pdf` → `PDF`；拿不到子类型时返回空串，调用方自行省略。 */
export function formatType(contentType: string): string {
  if (!contentType) return '';
  const sub = contentType.split(';')[0]?.split('/')[1] ?? '';
  const tail = sub.split(/[.+]/).pop() ?? '';
  return tail.toUpperCase();
}

export interface LinkParts {
  host: string;
  path: string;
}

/** 链接拆成域名 + 路径两段显示：完整 URL 太长，域名才是用户认得出的部分。 */
export function splitLink(url: string): LinkParts {
  try {
    const parsed = new URL(url);
    return { host: parsed.host, path: `${parsed.pathname}${parsed.search}` };
  } catch {
    return { host: url, path: '' };
  }
}
