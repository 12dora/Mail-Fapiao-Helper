/**
 * 邮件正文里提取到的 URL 的统一清理与校验。
 *
 * 此前 directLink 与 thirdParty 各有一套清理逻辑：前者在第一个中文标点处截断，
 * 后者只解码两个 HTML entity，于是正文 `请下载：https://host/x?token=abc。`
 * 里的合法链接会带着句末标点被请求并失败（APP-10A）。这里统一为：
 * 解码 HTML entity -> 在已知行文分隔符处截断 -> 剥离结尾标点与不配对的成对括号
 * -> 用 `new URL()` 重新解析验证，解析不通过或非 http(s) 的 token 直接丢弃。
 *
 * EXT-10：完整支持十进制/十六进制数字实体及命名实体的大小写形式，避免
 * `?a=1&#38;token=abc` 被 `new URL()` 把 `#` 当成 fragment 起点而截断查询参数。
 */

/** 会出现在正文里、但绝不会出现在 URL 中的行文分隔符：命中即从此处截断。 */
const PROSE_CUT = /[，。；、：！？《》【】「」『』　]/;

/** 结尾可以无条件剥离的标点（半角句读 + 全角逗号句号已由 PROSE_CUT 处理）。 */
const TRAILING_PUNCT = new Set([',', '.', ';', ':', '!', '?', '"', "'", '`']);

/** 成对括号：只有在 URL 内部没有对应开括号时才剥离结尾的闭括号。 */
const BRACKET_PAIRS: Record<string, string> = {
  ')': '(',
  '）': '（',
  ']': '[',
  '】': '【',
  '}': '{',
  '》': '《',
};

/** 常见命名实体（小写键；解码时对命名做 case-insensitive 匹配）。 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  // URL 上下文里把 &nbsp; 去掉而不是保留空格（与历史行为一致）。
  nbsp: '',
};

/**
 * 解码 HTML 实体：命名（大小写不敏感）+ 十进制 `&#38;` + 十六进制 `&#x26;`。
 * 未知实体原样保留，避免误伤合法文本。
 */
export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (match, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const num = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(num) || num < 0 || num > 0x10ffff) return match;
      try {
        return String.fromCodePoint(num);
      } catch {
        return match;
      }
    }
    const mapped = NAMED_ENTITIES[body.toLowerCase()];
    return mapped !== undefined ? mapped : match;
  });
}

function countChar(value: string, ch: string): number {
  let n = 0;
  for (const c of value) if (c === ch) n++;
  return n;
}

/** 反复剥离结尾的行文标点；闭括号只在明显不配对时剥离，避免破坏合法 URL。 */
function stripTrailingProse(value: string): string {
  let s = value;
  for (;;) {
    const last = s[s.length - 1];
    if (!last) break;
    if (TRAILING_PUNCT.has(last)) {
      s = s.slice(0, -1);
      continue;
    }
    const open = BRACKET_PAIRS[last];
    if (open && countChar(s, open) < countChar(s, last)) {
      s = s.slice(0, -1);
      continue;
    }
    break;
  }
  return s;
}

/**
 * 把正文/HTML 里抓到的一个 token 规范成可请求的 http(s) URL。
 * 返回 null 表示这不是一个可用链接（相对路径、mailto、清理后仍解析失败等）。
 */
export function normalizeExtractedUrl(raw: string): string | null {
  let cleaned = decodeHtmlEntities(raw).trim();
  if (cleaned.length === 0) return null;

  const cut = cleaned.search(PROSE_CUT);
  if (cut >= 0) cleaned = cleaned.slice(0, cut);
  cleaned = stripTrailingProse(cleaned).trim();
  if (cleaned.length === 0) return null;

  // 交给 handler 匹配 / 下载之前先重新解析验证一次，只放行 http(s)。
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return cleaned;
}

/** 批量规范化并按原始顺序去重，丢弃无法解析的 token。 */
export function normalizeExtractedUrls(raws: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of raws) {
    const url = normalizeExtractedUrl(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}
