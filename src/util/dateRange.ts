/**
 * 统一的日期范围契约（APP-07 / CORE-07）。
 *
 * - date-only（`YYYY-MM-DD`）按**本地时区**解释：下界取当天本地午夜，上界取
 *   「本地日历下一天」的午夜（不含）。用日历加一天而不是固定 86_400_000ms，
 *   所以夏令时切换当天（23 小时 / 25 小时）也不会漏掉或多带邮件。
 * - 完整 ISO timestamp 必须通过严格解析（年月日/时分秒/offset 独立校验 +
 *   round-trip），绝不再委托宽松的 `Date.parse`（会把 2026-02-31 滚到 3 月）。
 *
 * IMAP 查询与客户端过滤必须共享同一个窗口对象，调用方只应通过
 * `resolveDateWindowFromFilter()` 计算一次并向下传递。
 */

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 严格 ISO 8601 timestamp（带时间；date-only 走另一条路径）：
 * `YYYY-MM-DDTHH:mm[:ss[.sss]][Z|±HH:mm|±HHmm]`
 * 不接受 `07/29/2026`、空格分隔、缺少时区的含糊形式。
 */
const ISO_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:Z|([+-])(\d{2}):?(\d{2}))$/;

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

function isValidCalendarYmd(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  // UTC 构造 + round-trip，避免本地时区干扰日历校验。
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/**
 * 严格解析完整 ISO timestamp 为 epoch ms。失败返回 undefined。
 * 不走 `Date.parse`，因此不存在日期不会被滚到下月。
 */
function parseStrictIsoTimestamp(value: string): number | undefined {
  const matched = ISO_TIMESTAMP_RE.exec(value.trim());
  if (!matched) return undefined;
  const y = Number(matched[1]);
  const mo = Number(matched[2]);
  const d = Number(matched[3]);
  const hh = Number(matched[4]);
  const mm = Number(matched[5]);
  const ss = matched[6] !== undefined ? Number(matched[6]) : 0;
  const frac = matched[7];
  // 小数秒最多取到毫秒。
  const ms = frac !== undefined ? Number(frac.padEnd(3, '0').slice(0, 3)) : 0;
  if (!isValidCalendarYmd(y, mo, d)) return undefined;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59 || ss < 0 || ss > 59 || ms < 0 || ms > 999) {
    return undefined;
  }

  let offsetMin = 0;
  if (matched[8] !== undefined) {
    const sign = matched[8] === '-' ? -1 : 1;
    const oh = Number(matched[9]);
    const om = Number(matched[10]);
    if (oh < 0 || oh > 23 || om < 0 || om > 59) return undefined;
    offsetMin = sign * (oh * 60 + om);
  }
  // 无显式 offset 且不是 Z：上面正则要求 Z 或 ±offset，因此这里 offsetMin=0 表示 Z。
  const utcMs = Date.UTC(y, mo - 1, d, hh, mm, ss, ms) - offsetMin * 60_000;
  if (!Number.isFinite(utcMs)) return undefined;
  return utcMs;
}

/**
 * 是否是本模块可解析的边界（date-only 或完整 ISO timestamp）。
 * 形如 `2026-02-31` / `2026-02-31T00:00:00Z` 的不存在日历日一律判为非法。
 */
export function isValidDateBound(value: string): boolean {
  if (looksDateOnly(value)) return parseDateOnlyParts(value) !== undefined;
  return parseStrictIsoTimestamp(value) !== undefined;
}

/** 下界（含）：date-only -> 本地午夜；完整 timestamp -> 精确 instant。 */
export function resolveSinceBound(value: string): Date | undefined {
  if (looksDateOnly(value)) {
    const parts = parseDateOnlyParts(value);
    return parts ? new Date(parts.y, parts.m - 1, parts.d, 0, 0, 0, 0) : undefined;
  }
  const t = parseStrictIsoTimestamp(value);
  return t !== undefined ? new Date(t) : undefined;
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
  const t = parseStrictIsoTimestamp(value);
  return t !== undefined ? new Date(t + 1) : undefined;
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
