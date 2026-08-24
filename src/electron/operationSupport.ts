import fs from 'node:fs';
import path from 'node:path';
import { readCsvRows } from '../util/csv.js';
import { msgIdHash } from '../util/hash.js';
import type { AppSummary } from './summary.js';
import type { OpKind, OpLease, OperationCoordinator, RunningOp } from './opCoordinator.js';
import { BARE_MAIL_HASH_RE } from './cliProtocol.js';
import type { DateRangePayload } from './payload.js';

/** 回显给 renderer 的规范化筛选条件（APP-20 / 契约 5）。 */
export interface NormalizedFilter {
  matchSubject: boolean;
  matchBody: boolean;
  keywords: string[];
  since?: string;
  until?: string;
}

export interface BusyResponse {
  ok: false;
  code: string;
  message: string;
  detail?: string;
  running: RunningOp | null;
  summary: AppSummary;
}

/** 与 inbox 摘要行同形，renderer 可以直接复用同一套渲染。 */
export interface BatchRow {
  messageId: string;
  date: string;
  from: string;
  subject: string;
  mailbox: string;
  hasAttachment: boolean;
  bodyLinkCount: number;
}

export interface RunBatch {
  rows: BatchRow[];
  total: number;
}

/** 批次明细的展示上限；`total` 始终是本次真实条数，不受这个上限影响。 */
export const BATCH_ROW_LIMIT = 200;

export interface OperationSupportDependencies {
  coordinator: OperationCoordinator;
  appSummary(): AppSummary;
  readConfigForPaths(): Record<string, unknown>;
  asObject(value: unknown): Record<string, unknown>;
  samplesDirPath(): string;
  isCanonicallyInside(candidate: string, root: string): boolean;
  persistedMailHash(row: Record<string, string>): string | undefined;
  configPath: string;
  statePath: string;
}

export function createOperationSupport(deps: OperationSupportDependencies) {
  const {
    coordinator,
    appSummary,
    readConfigForPaths,
    asObject,
    samplesDirPath,
    isCanonicallyInside,
    persistedMailHash,
    configPath,
    statePath,
  } = deps;

// ---------------------------------------------------------------------------
// 操作协调（APP-05）
// ---------------------------------------------------------------------------

function acquireOperation(kind: OpKind): { ok: true; lease: OpLease } | { ok: false; response: BusyResponse } {
  const begin = coordinator.begin(kind);
  if (begin.ok) return { ok: true, lease: begin.lease };
  return {
    ok: false,
    response: {
      ok: false,
      code: begin.code,
      message: begin.message,
      ...(begin.detail ? { detail: begin.detail } : {}),
      running: begin.running,
      summary: appSummary(),
    },
  };
}

function normalizedFilterFrom(range?: DateRangePayload): NormalizedFilter {
  const cfg = readConfigForPaths();
  const filter = asObject(cfg.filter);
  const keywords = Array.isArray(filter.keywords)
    ? filter.keywords.filter((item): item is string => typeof item === 'string')
    : [];
  const since = range?.from || (typeof filter.since === 'string' ? filter.since : undefined);
  const until = range?.to || (typeof filter.until === 'string' ? filter.until : undefined);
  return {
    matchSubject: filter.matchSubject !== false,
    matchBody: filter.matchBody !== false,
    keywords,
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
  };
}

// ---------------------------------------------------------------------------
// 「本次抓取 / 本次运行」批次明细（APP-20）
// ---------------------------------------------------------------------------

/**
 * 读 INDEX.csv 并按邮件身份 hash 建索引。
 * 优先持久化 `mailHash` 列；旧行才遗留重算 12 位（HASH-WIDTH / NEW-DEFECT 5）。
 */
function indexRowsByHash(): { byHash: Map<string, BatchRow>; byMessageId: Map<string, BatchRow> } {
  const byHash = new Map<string, BatchRow>();
  const byMessageId = new Map<string, BatchRow>();
  for (const row of readCsvRows(path.join(samplesDirPath(), 'INDEX.csv'))) {
    const messageId = row.messageId ?? '';
    const date = row.date ?? '';
    const from = row.from ?? '';
    const subject = row.subject ?? '';
    const batchRow: BatchRow = {
      messageId,
      date,
      from,
      subject,
      mailbox: row.mailbox ?? '',
      hasAttachment: (row.hasAttachment ?? '') === '1',
      bodyLinkCount: Number(row.bodyLinkCount ?? 0) || 0,
    };
    const persisted = persistedMailHash(row);
    if (persisted && !byHash.has(persisted)) byHash.set(persisted, batchRow);
    else if (!persisted) {
      // 旧 INDEX 无 mailHash：仅用遗留 12 位算法。
      const legacy = msgIdHash(messageId.length > 0 ? messageId : undefined, from, date, subject);
      if (!byHash.has(legacy)) byHash.set(legacy, batchRow);
    }
    if (messageId && !byMessageId.has(messageId)) byMessageId.set(messageId, batchRow);
  }
  return { byHash, byMessageId };
}

/**
 * 在 samples 目录下有界查找 `${hash}.eml`（HASH-WIDTH / NEW-DEFECT 5）。
 * - 优先直接路径与一级子目录
 * - 限制遍历文件数，避免主进程被大样本树拖垮
 * - 读取 Message-Id 时只读前 16 KiB，且使用 open/read 同一句柄
 */
function findSampleEmlByHash(hash: string): string | undefined {
  if (!BARE_MAIL_HASH_RE.test(hash)) return undefined;
  if (hash.includes('/') || hash.includes('\\') || hash.includes('..')) return undefined;
  const root = samplesDirPath();
  const direct = path.join(root, `${hash}.eml`);
  if (fs.existsSync(direct) && isCanonicallyInside(direct, root)) return direct;

  const MAX_ENTRIES = 400;
  let seen = 0;
  try {
    // 仅扫 root 与一层子目录（常见按月/邮箱分桶），禁止无界递归。
    const queue: string[] = [root];
    let depth0 = true;
    while (queue.length > 0 && seen < MAX_ENTRIES) {
      const dir = queue.shift()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (seen >= MAX_ENTRIES) break;
        seen++;
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isFile() && entry.name === `${hash}.eml`) {
          if (isCanonicallyInside(full, root)) return full;
        }
        if (depth0 && entry.isDirectory()) {
          queue.push(full);
        }
      }
      depth0 = false;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** 只读 EML 文件头前 maxBytes 字节（同一 fd）。 */
function readEmlHeader(emlPath: string, maxBytes = 16 * 1024): string {
  const fd = fs.openSync(emlPath, 'r');
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 由本次运行真实触达的邮件 hash 构造批次。**不是**「取 INDEX 最后 N 行」——
 * 那正是 APP-20 的原始缺陷；这里的 hash 全部来自本次子进程的逐封日志。
 */
function batchFromHashes(hashes: string[]): RunBatch {
  if (hashes.length === 0) return { rows: [], total: 0 };
  const { byHash, byMessageId } = indexRowsByHash();
  const rows: BatchRow[] = [];
  // 限制 fallback 扫描次数，防止主进程被拖垮。
  let fallbackReads = 0;
  const MAX_FALLBACK_READS = 32;
  for (const hash of hashes) {
    let row = byHash.get(hash);
    if (!row && fallbackReads < MAX_FALLBACK_READS) {
      const eml = findSampleEmlByHash(hash);
      if (eml) {
        fallbackReads++;
        try {
          const head = readEmlHeader(eml, 16 * 1024);
          const mid = /^message-id:\s*<?([^>\r\n]+)>?/im.exec(head)?.[1]?.trim();
          if (mid) row = byMessageId.get(mid) ?? byMessageId.get(`<${mid}>`);
        } catch {
          // ignore
        }
        if (!row) {
          row = {
            messageId: hash,
            date: '',
            from: '',
            subject: '',
            mailbox: '',
            hasAttachment: false,
            bodyLinkCount: 0,
          };
        }
      }
    }
    if (row) rows.push(row);
  }
  rows.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  return { rows: rows.slice(0, BATCH_ROW_LIMIT), total: hashes.length };
}

function fetchArgs(payload: DateRangePayload): string[] {
  const args = ['--config', configPath, '--state', statePath];
  args.push('--out', samplesDirPath());
  if (payload.from) args.push('--since', payload.from);
  if (payload.to) args.push('--until', payload.to);
  if (payload.dryRun) args.push('--dry-run');
  return args;
}

  return {
    acquireOperation,
    normalizedFilterFrom,
    batchFromHashes,
    fetchArgs,
  };
}
