import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readCsvRows, csvCell, parseCsv } from '../util/csv.js';
import { msgIdHash } from '../util/hash.js';
import { BARE_MAIL_HASH_RE } from './cliProtocol.js';

export interface PendingStoreDependencies {
  dataDir: string;
  pendingDirPath(): string;
  isCanonicallyInside(candidate: string, root: string): boolean;
  resolveCanonicalPath(target: string): string | undefined;
}

export function createPendingStore(deps: PendingStoreDependencies) {
  const { dataDir, pendingDirPath, isCanonicallyInside, resolveCanonicalPath } = deps;

function rewritePendingCsv(filter: (row: Record<string, string>) => boolean): { removed: number; remaining: number } {
  const pendingCsv = path.join(pendingDirPath(), 'pending.csv');
  if (!fs.existsSync(pendingCsv)) return { removed: 0, remaining: 0 };
  const text = fs.readFileSync(pendingCsv, 'utf8');
  const bom = text.startsWith('﻿') ? '﻿' : '';
  const records = parseCsv(text.replace(/^﻿/, ''));
  const header = records[0] ?? [];
  if (header.length === 0) return { removed: 0, remaining: 0 };
  const out = [`${bom}${header.map(csvCell).join(',')}`];
  let removed = 0;
  let remaining = 0;
  for (let r = 1; r < records.length; r++) {
    const cols = records[r] ?? [];
    const row: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) {
      const key = header[i];
      if (!key) continue;
      row[key] = cols[i] ?? '';
    }
    if (filter(row)) {
      out.push(header.map((_, i) => csvCell(cols[i] ?? '')).join(','));
      remaining++;
    } else {
      removed++;
    }
  }
  // 原子替换：live CSV 不再有被写坏成半截的机会。
  const tmp = `${pendingCsv}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, `${out.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, pendingCsv);
  return { removed, remaining };
}

/**
 * 取行上持久化的邮件身份（HASH-WIDTH / NEW-DEFECT 5）。
 * 优先 `mailHash`（并发 agent 写入的 INDEX/pending/invoices 列），其次合法的 `hash` 列，
 * 再次 messageId 本身已是裸 hash；旧行才回退到 msgIdHash 重算。
 */
function persistedMailHash(row: Record<string, string>): string | undefined {
  for (const key of ['mailHash', 'hash'] as const) {
    const raw = (row[key] ?? '').trim().toLowerCase();
    if (BARE_MAIL_HASH_RE.test(raw)) return raw;
  }
  const mid = (row.messageId ?? '').trim().toLowerCase();
  if (BARE_MAIL_HASH_RE.test(mid)) return mid;
  return undefined;
}

function pendingRowHashLegacy(row: Record<string, string>): string {
  return msgIdHash(row.messageId || undefined, row.from ?? '', row.date ?? '', row.subject ?? '');
}

/** 行是否对应该 hash：优先持久化字段，旧行才重算（HASH-WIDTH）。 */
function pendingRowMatchesHash(row: Record<string, string>, hash: string): boolean {
  const want = hash.trim().toLowerCase();
  if (!BARE_MAIL_HASH_RE.test(want)) return false;
  const persisted = persistedMailHash(row);
  if (persisted) return persisted === want;
  // 旧行无 mailHash/hash：仅对 12 位历史键做遗留重算，避免把 32 位键误配到 sha1 前缀。
  if (want.length === 12 && pendingRowHashLegacy(row) === want) return true;
  return false;
}

function findPendingRow(hash: string): Record<string, string> | undefined {
  const pendingCsv = path.join(pendingDirPath(), 'pending.csv');
  for (const row of readCsvRows(pendingCsv)) {
    if (pendingRowMatchesHash(row, hash)) return row;
  }
  return undefined;
}

/**
 * 在 pending 目录内解析 `${hash}.eml`：先校验 hash 形态，再 canonical containment
 * （ELEC-06），禁止 symlink 逃逸与 `../` 路径穿越。
 */
function pendingEmlPathForHash(hash: string): string | undefined {
  if (!BARE_MAIL_HASH_RE.test(hash)) return undefined;
  // 文件名只允许裸 hash，杜绝路径段注入。
  if (hash.includes('/') || hash.includes('\\') || hash.includes('..')) return undefined;
  const root = pendingDirPath();
  const candidate = path.join(root, `${hash}.eml`);
  if (!isCanonicallyInside(candidate, root)) return undefined;
  if (!isCanonicallyInside(candidate, dataDir) && !isCanonicallyInside(root, dataDir)) {
    // pending 在 dataDir 外时，仍要求最终路径落在 pending 根内。
    if (!isCanonicallyInside(candidate, root)) return undefined;
  }
  return resolveCanonicalPath(candidate) ?? candidate;
}

  return {
    rewritePendingCsv,
    persistedMailHash,
    pendingRowHashLegacy,
    pendingRowMatchesHash,
    findPendingRow,
    pendingEmlPathForHash,
  };
}
