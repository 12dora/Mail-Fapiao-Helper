import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import { readCsvRows } from '../util/csv.js';
import { isMailHash, msgIdHash } from '../util/hash.js';

export type PendingAction = 'retry' | 'refresh_link' | 'manual_archive' | 'ignore';

export interface PendingRow {
  hash: string;
  messageId: string;
  date: string;
  from: string;
  subject: string;
  /** 兼容字段：与 machineReason 相同，已做脱敏，不适合直接展示给用户。 */
  reason: string;
  /** 诊断用的机器原因；URL 已去掉 query/fragment。 */
  machineReason: string;
  /** 面向用户的原因分类。 */
  category: string;
  /** 面向用户的说明。 */
  userMessage: string;
  /** 面向用户的下一步操作。 */
  nextStep: string;
}

/** 面向用户的文案，与机器 reason 分离（COPY-05）。 */
export interface PendingCopy {
  category: string;
  userMessage: string;
  nextStep: string;
}

export interface PendingGroup {
  key: string;
  title: string;
  count: number;
  action: PendingAction;
  /** 兼容字段：等于 userMessage，只放用户能看懂的说明。 */
  description: string;
  category: string;
  userMessage: string;
  nextStep: string;
  /** 组内真实行数（rows 不做任何截断，因此与 count 一致）。 */
  total: number;
  rows: PendingRow[];
}

export interface PendingSummary {
  csvPath: string;
  total: number;
  groups: PendingGroup[];
}

/**
 * 机器 reason 脱敏（COPY-05）：签名 URL 的 query/fragment 常带 token，
 * 复制或分享待确认信息时不应把它带出去。
 */
function sanitizeMachineReason(reason: string): string {
  const redacted = reason.replace(/https?:\/\/[^\s,;"'）)]+/gi, (url) => {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    } catch {
      return url.split('#')[0]?.split('?')[0] ?? url;
    }
  });
  return redacted.length > 300 ? `${redacted.slice(0, 300)}…` : redacted;
}

/**
 * PENDING-HASH：优先读显式 `mailHash` 列（pipeline 写入的 12/32 位身份），
 * 绝不能在无 raw 时重算 msgIdHash——那会得到 legacy 12 位，与
 * `pending/<32-char>.eml` 文件名对不上。
 */
function rowFromRaw(raw: Record<string, string>): PendingRow {
  const messageId = raw.messageId ?? '';
  const date = raw.date ?? '';
  const from = raw.from ?? '';
  const subject = raw.subject ?? '';
  const machineReason = sanitizeMachineReason(raw.reason ?? '');
  const explicit = (raw.mailHash ?? raw.hash ?? '').trim();
  let hash: string;
  if (explicit && isMailHash(explicit)) {
    hash = explicit.toLowerCase();
  } else if (messageId && isMailHash(messageId)) {
    // 超大邮件等路径可能把 hash 写在 messageId 位。
    hash = messageId.toLowerCase();
  } else {
    // 仅旧行无 mailHash 列时的最后回退（legacy 12 位）。
    hash = msgIdHash(messageId || undefined, from, date, subject);
  }
  return {
    hash,
    messageId,
    date,
    from,
    subject,
    reason: machineReason,
    machineReason,
    category: '',
    userMessage: '',
    nextStep: '',
  };
}

type PendingGroupInfo = Omit<PendingGroup, 'count' | 'total' | 'rows'>;

/** 用面向用户的三段文案组装分组信息；description 保留为兼容字段。 */
function group(
  key: string,
  title: string,
  action: PendingAction,
  copy: PendingCopy,
): PendingGroupInfo {
  return { key, title, action, description: copy.userMessage, ...copy };
}

/**
 * 分类只看原始 reason（未脱敏），避免去掉 URL query 后丢失判定关键字；
 * 对外暴露的仍然是脱敏后的 machineReason 和用户文案。
 */
function classifyPending(row: PendingRow, rawReason: string): PendingGroupInfo {
  const reason = rawReason.toLowerCase();
  const from = row.from.toLowerCase();
  const subject = row.subject.toLowerCase();

  if (reason.includes('download_failed') || reason.includes('http_403') || reason.includes('403')) {
    if (from.includes('alitrip') || subject.includes('飞猪')) {
      return group('expired_fliggy_link', '飞猪/接送机历史链接过期', 'refresh_link', {
        category: '链接已过期',
        userMessage: '邮件里的发票下载链接已失效，无法自动获取发票。',
        nextStep: '请到飞猪或对应出行平台重新下载发票，再用「选择文件归档」上传。',
      });
    }
    return group('expired_or_failed_download', '下载失败或链接过期', 'refresh_link', {
      category: '下载失败',
      userMessage: '发票下载入口还在，但这次没能取回文件。',
      nextStep: '可以稍后重试；如果仍然失败，请到开票平台下载后手动上传。',
    });
  }

  if (reason.includes('huawei_travel_query_failed:130071003')) {
    return group('expired_huawei_travel', '慧通差旅链接过期', 'refresh_link', {
      category: '链接已过期',
      userMessage: '慧通差旅的发票链接已超过有效期。',
      nextStep: '请重新登录慧通差旅获取发票，再用「选择文件归档」上传。',
    });
  }

  if (reason.includes('no_pdf_links')) {
    return group('no_pdf_links', '邮件里没有可直接下载的发票', 'manual_archive', {
      category: '邮件内无发票文件',
      userMessage: '这封邮件只有开票入口、二维码或网页链接，没有可以直接下载的发票文件。',
      nextStep: '请打开邮件按提示自行开票或下载，再用「选择文件归档」上传。',
    });
  }

  if (reason.includes('no_supported_documents_in_attachments')) {
    return group('no_supported_documents', '附件不是发票文件', 'ignore', {
      category: '附件不是发票文件',
      userMessage: '附件不是可识别的发票格式（PDF、OFD，或包含它们的压缩包）。',
      nextStep: '确认这封邮件不含发票后可以忽略；如果确实有发票，请手动上传。',
    });
  }

  if (reason.includes('network_retry_failed')) {
    return group('network_retry_failed', '网络连接失败', 'retry', {
      category: '网络问题',
      userMessage: '多次尝试后仍然连不上开票网站。',
      nextStep: '请检查网络或稍后重新处理这封邮件。',
    });
  }

  return group('manual', '需要人工确认', 'manual_archive', {
    category: '需要人工确认',
    userMessage: '这封邮件暂时无法自动处理。',
    nextStep: '请打开原始邮件确认发票获取方式，必要时手动上传发票文件。',
  });
}

export function summarizePending(cfg: Config, cwd: string = process.cwd()): PendingSummary {
  const csvPath = path.join(path.resolve(cwd, cfg.paths.pending), 'pending.csv');
  const rows: PendingRow[] = [];
  const byKey = new Map<string, PendingGroup>();

  for (const raw of readCsvRows(csvPath)) {
    const row = rowFromRaw(raw);
    const groupInfo = classifyPending(row, raw.reason ?? '');
    row.category = groupInfo.category;
    row.userMessage = groupInfo.userMessage;
    row.nextStep = groupInfo.nextStep;
    rows.push(row);
    const existing = byKey.get(groupInfo.key);
    if (existing) {
      // 组内不做任何截断：第 7 条及以后的待确认项同样必须可达（UI-01）。
      existing.rows.push(row);
      existing.count++;
      existing.total++;
    } else {
      byKey.set(groupInfo.key, { ...groupInfo, count: 1, total: 1, rows: [row] });
    }
  }

  const order = ['expired_fliggy_link', 'no_pdf_links', 'expired_huawei_travel', 'no_supported_documents', 'network_retry_failed', 'expired_or_failed_download', 'manual'];
  const groups = Array.from(byKey.values()).sort((a, b) => {
    const ai = order.indexOf(a.key);
    const bi = order.indexOf(b.key);
    return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi)
      || b.count - a.count
      || a.title.localeCompare(b.title);
  });

  return { csvPath, total: rows.length, groups };
}

export function pendingEmlPath(cfg: Config, row: PendingRow, cwd: string = process.cwd()): string {
  return path.join(path.resolve(cwd, cfg.paths.pending), `${row.hash}.eml`);
}

export function pendingEmlExists(cfg: Config, row: PendingRow): boolean {
  return fs.existsSync(pendingEmlPath(cfg, row));
}
