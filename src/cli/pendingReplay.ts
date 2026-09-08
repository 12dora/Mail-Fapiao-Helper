import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { readCsvRows } from '../util/csv.js';

export interface PendingReplaySelection {
  /** 仍在 pending.csv 里、且队列目录有 `.eml` 副本的邮件。 */
  paths: string[];
  /** 队列目录里已经出队（不在 pending.csv）的历史副本数，不再重放。 */
  stale: number;
  /** pending.csv 里有、但 `.eml` 副本缺失的行数。 */
  missing: number;
}

/**
 * 「全部重试」只重放 pending.csv 里仍待确认的邮件。
 *
 * 队列目录刻意保留每封邮件的 `.eml` 副本（出队只改 CSV），以前把目录里全部副本都
 * 重放一遍：已归档的邮件被反复重跑，遇到每次下载字节都不同的开票接口就一次多归档
 * 一份，台账越点越长。
 */
export function selectPendingReplayPaths(emlPaths: string[], pendingCsvPath: string): PendingReplaySelection {
  const listed = new Set<string>();
  if (existsSync(pendingCsvPath)) {
    for (const row of readCsvRows(pendingCsvPath)) {
      const hash = (row.mailHash ?? '').trim().toLowerCase();
      if (hash) listed.add(hash);
    }
  }
  const paths: string[] = [];
  const present = new Set<string>();
  for (const emlPath of emlPaths) {
    const hash = basename(emlPath, '.eml').toLowerCase();
    if (!listed.has(hash)) continue;
    present.add(hash);
    paths.push(emlPath);
  }
  return {
    paths,
    stale: emlPaths.length - paths.length,
    missing: listed.size - present.size,
  };
}
