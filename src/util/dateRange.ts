/**
 * 统一的日期范围契约（APP-07）。
 *
 * - date-only（`YYYY-MM-DD`）按**本地时区**解释：下界取当天本地午夜，上界取
 *   「本地日历下一天」的午夜（不含）。用日历加一天而不是固定 86_400_000ms，
 *   所以夏令时切换当天（23 小时 / 25 小时）也不会漏掉或多带邮件。
 * - 完整 ISO timestamp 保留精确 instant，绝不再额外加 24 小时；上界按毫秒包含
 *   用户给定的那一刻（内部 +1ms 转换成半开区间 `[since, before)`）。
 *
 * IMAP 查询与客户端过滤必须共享同一个窗口对象，调用方只应通过
 * `resolveDateWindowFromFilter()` 计算一次并向下传递。
 */

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

interface DateOnlyParts {
  y: number;
  m: number;
  d: number;
}

/** 只判断形状：`YYYY-MM-DD`，日历日是否存在由 parseDateOnlyParts 负责。 */
function looksDateOnly(value: string): boolean {
  return DATE_ONLY_RE.test(value.trim());
}

function parseDateOnlyParts(value: string): DateOnlyParts | undefined {
  const matched = DATE_ONLY_RE.exec(value.trim());
  if (!matched) return undefined;
  const y = Number(matched[1]);
  const m = Number(matched[2]);
  const d = Number(matched[3]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return undefined;
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  // 拒绝 2026-02-31 这类不存在的日历日：本地构造后必须能原样读回。
  const probe = new Date(y, m - 1, d, 0, 0, 0, 0);
  if (probe.getFullYear() !== y || probe.getMonth() !== m - 1 || probe.getDate() !== d) {
    return undefined;
  }
  return { y, m, d };
}

/** 是否是纯日期（`YYYY-MM-DD`），即不带时间与时区的本地日历日。 */
export function isDateOnly(value: string): boolean {
  return parseDateOnlyParts(value) !== undefined;
}

/**
 * 是否是本模块可解析的边界（date-only 或完整 ISO timestamp）。
 * 形如 `2026-02-31` 的不存在日历日一律判为非法：不能让它掉进 `Date.parse()` 的
 * 宽松回退里被悄悄解释成 3 月 3 日。
 */
export function isValidDateBound(value: string): boolean {
  if (looksDateOnly(value)) return parseDateOnlyParts(value) !== undefined;
  return Number.isFinite(Date.parse(value));
}

/** 下界（含）：date-only -> 本地午夜；完整 timestamp -> 精确 instant。 */
export function resolveSinceBound(value: string): Date | undefined {
  if (looksDateOnly(value)) {
    const parts = parseDateOnlyParts(value);
    return parts ? new Date(parts.y, parts.m - 1, parts.d, 0, 0, 0, 0) : undefined;
  }
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t) : undefined;
}

/**
 * 上界（**不含**）：
 * - date-only -> 本地日历「加一天」的午夜，使这一整天被完整包含（DST 安全）；
 * - 完整 timestamp -> 该 instant + 1ms，使用户给定的精确时刻仍被包含，但绝不
 *   把上界放宽整整 24 小时。
 */
export function resolveUntilExclusiveBound(value: string): Date | undefined {
  if (looksDateOnly(value)) {
    const parts = parseDateOnlyParts(value);
    // Date 构造函数会把 day 溢出规范化到下个月/下一年，同时按本地时区解释，
    // 因此这就是「本地日历下一天的午夜」。
    return parts ? new Date(parts.y, parts.m - 1, parts.d + 1, 0, 0, 0, 0) : undefined;
  }
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t + 1) : undefined;
}

export interface DateWindow {
  /** 下界，包含。 */
  since: Date;
  /** 上界，**不包含**；undefined 表示没有上界。 */
  before: Date | undefined;
}

export interface DateWindowInput {
  /** `YYYY-MM-DD` 或完整 ISO timestamp；缺省时回退到 sinceDays 滚动窗口。 */
  since: string | undefined;
  /** `YYYY-MM-DD` 或完整 ISO timestamp；缺省表示无上界。 */
  until: string | undefined;
  /** 滚动窗口天数，仅在没有 since 时使用。 */
  sinceDays: number;
}

/** 计算唯一的抓取窗口 `[since, before)`；IMAP 查询与客户端过滤共用它。 */
export function resolveDateWindowFromFilter(input: DateWindowInput, now: Date = new Date()): DateWindow {
  let since: Date | undefined;
  if (input.since) since = resolveSinceBound(input.since);
  if (!since) {
    // 滚动 N 天窗口本身就是「时长」语义，按毫秒回退是正确的。
    since = new Date(now.getTime() - input.sinceDays * 86_400_000);
  }
  const before = input.until ? resolveUntilExclusiveBound(input.until) : undefined;
  return { since, before };
}

/**
 * IMAP `SINCE` 只有「日」粒度且按服务器时区匹配，因此把下界向前放宽到本地午夜，
 * 避免服务器把 `2026-07-27T12:30` 这样的时间戳截断后漏掉当天邮件；真正的精确
 * 下界仍由客户端按 `window.since` 过滤。
 */
export function imapSearchSince(window: DateWindow): Date {
  const s = window.since;
  return new Date(s.getFullYear(), s.getMonth(), s.getDate(), 0, 0, 0, 0);
}

/** 比较两个边界（任意可解析形式），since <= until 才合法。 */
export function boundsAreOrdered(since: string, until: string): boolean {
  const a = resolveSinceBound(since);
  const b = resolveUntilExclusiveBound(until);
  if (!a || !b) return true; // 解析失败由各自的校验报错，这里不重复报
  return a.getTime() < b.getTime();
}
