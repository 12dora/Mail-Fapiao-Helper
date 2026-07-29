import os from 'node:os';
import path from 'node:path';

/**
 * 统一脱敏工具（COPY-01 / ELEC-07）。
 *
 * 主进程的日志、IPC 事件和 GUI 历史都可能携带子进程原始 stderr、异常消息、
 * 完整签名 URL、本机绝对路径、邮箱地址和邮件 hash。这些内容对普通用户没有意义，
 * 而且在截图、剪贴板和历史文件里会泄漏票据访问凭据与本机身份，因此在进入
 * log / IPC / history 之前必须先经过这里。
 */

/** 对外事件的统一错误形状：message 是简洁中文，detail 是已脱敏的技术信息。 */
export interface UiError {
  code: string;
  message: string;
  detail?: string;
}

/** 看起来像凭据的 query 参数名，出现时连值一起隐藏。 */
const SECRET_PARAM = /(token|secret|key|sign|signature|auth|password|passwd|pass|credential|session|ticket|code)/i;

/** 需要在自由文本里屏蔽的 `key=value` / `key: value` 片段。 */
const SECRET_ASSIGN = /\b(token|secret|secretid|secretkey|apikey|api_key|key|sign|signature|auth|authorization|password|passwd|pass|credential)(\s*[=:]\s*)("?)([^\s"',;&)]+)\3/gi;

const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>）)\]，。；]+/gi;
const WINDOWS_PATH = /\b[A-Za-z]:\\[^\s"'<>|,;]+/g;
/** UNC 路径：\\server\share\... 或 //server/share/... */
const UNC_PATH = /(?:\\\\|\/\/)[^\s"'<>|,;]+/g;
// 只匹配「真正以 / 开头」的绝对路径；前面紧跟字母数字时（例如 2026/05/21）不匹配。
const POSIX_PATH = /(?<![A-Za-z0-9])(?:\/[A-Za-z0-9._@+\-一-龥]+){2,}\/?/g;
/**
 * 至少 12 位的十六进制串（邮件 hash / contentHash），含纯数字（全 decimal 合法 hex）。
 * 截断成短 ID。
 */
const LONG_HEX = /\b[0-9a-f]{12,}\b/gi;
/** 邮箱地址：诊断文本中隐藏本地部分（ELEC-07）。 */
const EMAIL_IN_TEXT = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g;
/** CLI 日志里的 subject="..." / from="..." 字段。 */
const QUOTED_FIELD = /\b(subject|from|to)=("?)([^"\n]*?)\2(?=\s|$|reason=|date=)/gi;
/** 非结构化主题泄漏：Subject: ... / 主题：... / 邮件主题：... */
const SUBJECT_LINE = /(?:^|[\s,;，；])((?:subject|主题|邮件主题)\s*[:：]\s*)([^\n\r,;；]{3,})/gi;

let managedRoots: { label: string; dir: string }[] = [];

/**
 * 注册需要整体替换成占位符的本机目录（dataDir / 应用安装目录 / 用户主目录）。
 * 在 main 启动时调用一次即可。
 */
export function registerManagedRoots(roots: { dataDir: string; appRoot: string }): void {
  const entries = [
    { label: '<数据目录>', dir: roots.dataDir },
    { label: '<应用目录>', dir: roots.appRoot },
    { label: '<用户目录>', dir: os.homedir() },
  ].filter((entry) => typeof entry.dir === 'string' && entry.dir.length > 0);
  // 长路径优先替换，避免 <用户目录> 抢先吃掉位于其下的 dataDir。
  managedRoots = entries
    .map((entry) => ({ label: entry.label, dir: path.resolve(entry.dir) }))
    .sort((a, b) => b.dir.length - a.dir.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 去掉 query 与 fragment；保留 host 与路径，便于判断是哪个站点出的问题。 */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const hadSecretParam = Array.from(url.searchParams.keys()).some((key) => SECRET_PARAM.test(key));
    const base = `${url.protocol}//${url.host}${url.pathname}`;
    if (url.search || url.hash) return `${base}${hadSecretParam ? '?<凭据参数已隐藏>' : '?…'}`;
    return base;
  } catch {
    // 不是合法 URL 时至少砍掉 ? 和 # 之后的内容。
    return raw.replace(/[?#].*$/, '');
  }
}

/** 绝对路径改成相对 dataDir 的路径；无法相对化时只保留文件名。 */
export function redactPath(raw: string): string {
  const normalized = raw.trim();
  if (normalized.length === 0) return normalized;
  // UNC：不尝试相对化，只保留最后一段。
  if (normalized.startsWith('\\\\') || normalized.startsWith('//')) {
    const parts = normalized.replace(/^[\\/]+/, '').split(/[\\/]/).filter(Boolean);
    return parts.length > 0 ? `…/${parts[parts.length - 1]}` : '…/<网络路径>';
  }
  for (const root of managedRoots) {
    const rel = path.relative(root.dir, path.resolve(normalized));
    if (rel === '') return root.label;
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return `${root.label}/${rel.split(path.sep).join('/')}`;
    }
  }
  return `…/${path.basename(normalized)}`;
}

/** 邮件 hash / contentHash 截断成可用于对账、但不可反查的短 ID。 */
export function shortId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) return trimmed;
  return `${trimmed.slice(0, 8)}…`;
}

/** 邮箱脱敏：保留域名，本地部分只留首字符。 */
export function redactEmail(raw: string): string {
  const at = raw.lastIndexOf('@');
  if (at <= 0) return '<邮箱已隐藏>';
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  if (!domain) return '<邮箱已隐藏>';
  const head = local.charAt(0) || '*';
  return `${head}***@${domain}`;
}

/**
 * 对任意技术文本做统一脱敏：URL 去 query/fragment、绝对路径相对化、
 * 屏蔽 token 样式赋值、邮箱、邮件主题字段、邮件 hash 截断。
 */
export function sanitizeText(input: unknown, opts: { maxLength?: number } = {}): string {
  if (input === undefined || input === null) return '';
  let text = typeof input === 'string' ? input : String(input);

  // 已经脱敏完成的片段先换成占位符，避免后续规则把 URL 里的 path 或
  // `<数据目录>/a/b` 再切一次。
  const kept: string[] = [];
  const NUL = String.fromCharCode(0);
  const keep = (value: string): string => {
    kept.push(value);
    return `${NUL}${kept.length - 1}${NUL}`;
  };

  // 先处理带 dataDir 前缀的裸目录本体（没有后续路径段时 POSIX_PATH 也能覆盖，
  // 这里只是让 label 优先命中最长的根目录）。
  for (const root of managedRoots) {
    text = text.replace(new RegExp(`${escapeRegExp(root.dir)}(?![A-Za-z0-9._/\\\\-])`, 'g'), () => keep(root.label));
  }
  text = text.replace(URL_IN_TEXT, (match) => keep(redactUrl(match)));
  text = text.replace(UNC_PATH, (match) => keep(redactPath(match)));
  text = text.replace(WINDOWS_PATH, (match) => keep(redactPath(match)));
  text = text.replace(POSIX_PATH, (match) => keep(redactPath(match)));
  text = text.replace(EMAIL_IN_TEXT, (match) => keep(redactEmail(match)));
  text = text.replace(QUOTED_FIELD, (_m, key: string, quote: string, value: string) => {
    if (String(key).toLowerCase() === 'from') {
      return `${key}=${quote}${redactEmail(value)}${quote}`;
    }
    // subject：不把报销主题送进 progress / history
    return `${key}=${quote}<主题已隐藏>${quote}`;
  });
  text = text.replace(SUBJECT_LINE, (_m, label: string) => `${label}<主题已隐藏>`);
  text = text.replace(SECRET_ASSIGN, (_m, key: string, sep: string) => `${key}${sep}***`);
  text = text.replace(LONG_HEX, (match) => shortId(match));
  text = text.replace(new RegExp(`${NUL}(\\d+)${NUL}`, 'g'), (_m, index: string) => kept[Number(index)] ?? '');

  const max = opts.maxLength ?? 500;
  if (text.length > max) text = `${text.slice(0, max)}…`;
  return text;
}

/** 从异常构造对外错误对象；原始 message 只作为已脱敏的 detail 出现。 */
export function toUiError(code: string, message: string, err?: unknown): UiError {
  const detail = err === undefined
    ? undefined
    : sanitizeText(err instanceof Error ? err.message : String(err));
  return detail ? { code, message, detail } : { code, message };
}
