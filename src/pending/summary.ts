import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import { readCsvRows } from '../util/csv.js';
import { msgIdHash } from '../util/hash.js';

export type PendingAction = 'retry' | 'refresh_link' | 'manual_archive' | 'ignore';

export interface PendingRow {
  hash: string;
  messageId: string;
  date: string;
  from: string;
  subject: string;
  reason: string;
}

export interface PendingGroup {
  key: string;
  title: string;
  count: number;
  action: PendingAction;
  description: string;
  rows: PendingRow[];
}

export interface PendingSummary {
  csvPath: string;
  total: number;
  groups: PendingGroup[];
}

function rowFromRaw(raw: Record<string, string>): PendingRow {
  const messageId = raw.messageId ?? '';
  const date = raw.date ?? '';
  const from = raw.from ?? '';
  const subject = raw.subject ?? '';
  return {
    hash: msgIdHash(messageId || undefined, from, date, subject),
    messageId,
    date,
    from,
    subject,
    reason: raw.reason ?? '',
  };
}

function classifyPending(row: PendingRow): Omit<PendingGroup, 'count' | 'rows'> {
  const reason = row.reason.toLowerCase();
  const from = row.from.toLowerCase();
  const subject = row.subject.toLowerCase();

  if (reason.includes('download_failed') || reason.includes('http_403') || reason.includes('403')) {
    if (from.includes('alitrip') || subject.includes('飞猪')) {
      return {
        key: 'expired_fliggy_link',
        title: '飞猪/接送机历史链接过期',
        action: 'refresh_link',
        description: '历史 PDF 链接多为签名 URL，403 后自动重试价值低；GUI 应提供重新授权、刷新链接或手动归档入口。',
      };
    }
    return {
      key: 'expired_or_failed_download',
      title: '下载失败或链接过期',
      action: 'refresh_link',
      description: '下载入口存在但当前不可取，优先让用户刷新授权或手动上传已下载文件。',
    };
  }

  if (reason.includes('huawei_travel_query_failed:130071003')) {
    return {
      key: 'expired_huawei_travel',
      title: '慧通差旅链接过期',
      action: 'refresh_link',
      description: '平台返回链接超过有效期，需要用户重新授权、重新打开平台，或手动上传发票。',
    };
  }

  if (reason.includes('no_pdf_links')) {
    return {
      key: 'no_pdf_links',
      title: '邮件无直接 PDF 链接',
      action: 'manual_archive',
      description: '邮件只包含授权入口、二维码或非 PDF 资源；GUI 应保留打开邮件、复制链接、手动归档入口。',
    };
  }

  if (reason.includes('no_supported_documents_in_attachments')) {
    return {
      key: 'no_supported_documents',
      title: '附件里没有支持文档',
      action: 'ignore',
      description: '附件不是 PDF/OFD/ZIP 中的支持文档，默认保持 manual，可由用户确认忽略。',
    };
  }

  if (reason.includes('network_retry_failed')) {
    return {
      key: 'network_retry_failed',
      title: '网络重试耗尽',
      action: 'retry',
      description: '更像临时网络或服务端失败，GUI 应提供重新处理当前邮件。',
    };
  }

  return {
    key: 'manual',
    title: '其他待人工处理',
    action: 'manual_archive',
    description: '尚无明确自动化策略，保留原始邮件与 reason 供人工判断。',
  };
}

export function summarizePending(cfg: Config): PendingSummary {
  const csvPath = path.join(path.resolve(cfg.paths.pending), 'pending.csv');
  const rows = readCsvRows(csvPath).map(rowFromRaw);
  const byKey = new Map<string, PendingGroup>();

  for (const row of rows) {
    const groupInfo = classifyPending(row);
    const existing = byKey.get(groupInfo.key);
    if (existing) {
      existing.rows.push(row);
      existing.count++;
    } else {
      byKey.set(groupInfo.key, { ...groupInfo, count: 1, rows: [row] });
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

export function pendingEmlPath(cfg: Config, row: PendingRow): string {
  return path.join(path.resolve(cfg.paths.pending), `${row.hash}.eml`);
}

export function pendingEmlExists(cfg: Config, row: PendingRow): boolean {
  return fs.existsSync(pendingEmlPath(cfg, row));
}
