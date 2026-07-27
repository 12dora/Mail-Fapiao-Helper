import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { testFaultEnabled } from '../util/testFaults.js';

/**
 * 归档事务的持久化清单（APP-03）。
 *
 * 「逐个原子复制文件」只保证单个文件不会写坏，并不保证「一批文件 + invoices.csv
 * + ocr-pending.csv」是一个整体。进程若在文件安装完成、CSV 追加之前崩溃或被强杀，
 * 只存在于 JS `catch` 里的回滚根本不会执行，最终目录会留下没有台账的孤儿文件；
 * 下次重跑因为索引只读 CSV，识别不到它们，于是重复归档。
 *
 * 这里把事务意图写进 `<invoicesDir>/.journal/<txId>.json` 并 `fsync`，崩溃后由
 * `recoverArchiveTransactions()` 依据 journal 回滚残留：
 *
 *   prepared        已规划最终文件路径，文件可能刚被安装  -> 仅删除能证明属于本事务的文件
 *   files-installed 文件内容已落盘，CSV 尚未（完整）追加  -> 删除文件并截断 CSV
 *   ledger-committed CSV 已全部追加，只差删除 journal     -> 视为已完成，仅清理 journal
 *
 * Electron 侧的手工归档会复用同一模块，因此本文件的导出签名不要改名。
 */

export type ArchiveStage = 'prepared' | 'files-installed' | 'ledger-committed';

export interface ArchivePlannedFile {
  path: string;
  /** Optional staging file used to prove ownership before installed fingerprints are durable. */
  stagingPath?: string;
  /** Internal marker for old journals that serialized `files` as plain strings. */
  legacy?: boolean;
}

export interface ArchiveTxPlan {
  /** 计划安装的最终文件绝对路径；带 stagingPath 时恢复可用 inode 证明所有权。 */
  files: Array<string | ArchivePlannedFile>;
  /** 将要追加的 CSV：路径 + 追加前的字节长度（不存在时为 0）。 */
  csv: { path: string; baseLength: number }[];
}

export interface ArchiveTransaction {
  readonly txId: string;
  markStage(stage: ArchiveStage): void;
  /** 全部成功：删除 journal 文件。 */
  commit(): void;
  /** 失败：按 journal 删除已安装文件并把 CSV 截断回 baseLength；无法完成时抛出 ArchiveRecoveryError。 */
  rollback(): void;
}

export class ArchiveRecoveryError extends Error {
  readonly code = 'archive_recovery_failed';

  constructor(cause: unknown) {
    super('archive_journal_recovery_failed');
    this.name = 'ArchiveRecoveryError';
    this.cause = cause;
  }
}

interface InstalledFile {
  path: string;
  size: number;
  mtimeMs: number;
}

interface JournalRecord {
  txId: string;
  pid: number;
  startedAtMs: number;
  stage: ArchiveStage;
  files: ArchivePlannedFile[];
  csv: { path: string; baseLength: number }[];
  /** Once any planned file could not be proven as ours, CSV rollback is permanently unsafe. */
  csvRollbackDisabled?: boolean;
  /** `files-installed` 阶段记录的实际文件指纹，恢复时用于保守校验。 */
  installed?: InstalledFile[];
}

interface ArchiveRecoveryOptions {
  strict?: boolean;
}

const JOURNAL_DIRNAME = '.journal';

function journalDir(invoicesDir: string): string {
  return path.join(invoicesDir, JOURNAL_DIRNAME);
}

function isPosix(): boolean {
  return process.platform !== 'win32';
}

/** 写入 journal 条目并 fsync：条目必须先于任何文件安装落到磁盘。 */
function writeRecord(recordPath: string, record: JournalRecord): void {
  fs.mkdirSync(path.dirname(recordPath), { recursive: true, mode: isPosix() ? 0o700 : undefined });
  const tmpPath = `${recordPath}.tmp`;
  const fd = fs.openSync(tmpPath, 'w', isPosix() ? 0o600 : undefined);
  try {
    fs.writeFileSync(fd, JSON.stringify(record));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, recordPath);
  // rename 本身也要落盘，否则崩溃后目录项可能仍指向旧内容。
  try {
    const dirFd = fs.openSync(path.dirname(recordPath), 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    // Windows 不支持对目录 fsync，忽略。
  }
}

function statOrNull(target: string): fs.Stats | null {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

function normalizePlannedFile(file: string | ArchivePlannedFile): ArchivePlannedFile {
  return typeof file === 'string' ? { path: file, legacy: true } : { ...file };
}

function samePhysicalFile(a: string, b: string): boolean {
  const aStat = statOrNull(a);
  const bStat = statOrNull(b);
  if (!aStat?.isFile() || !bStat?.isFile()) return false;
  return aStat.dev === bStat.dev && aStat.ino === bStat.ino;
}

function removeFileQuietly(target: string): boolean {
  try {
    fs.rmSync(target, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** 把 CSV 截回 baseLength；只在当前长度更长时动手，绝不扩展文件。 */
function truncateCsv(csvPath: string, baseLength: number): boolean {
  const stat = statOrNull(csvPath);
  if (!stat) return true;
  if (stat.size <= baseLength) return true;
  try {
    if (testFaultEnabled('MFH_TEST_FAIL_CSV_TRUNCATE')) {
      throw new Error('forced_csv_truncate_failure');
    }
    if (baseLength === 0) {
      fs.rmSync(csvPath, { force: true });
    } else {
      fs.truncateSync(csvPath, baseLength);
    }
    return true;
  } catch {
    // 文件被占用时留给下一次恢复处理。
    return false;
  }
}

const LEGACY_PLACEHOLDER_MTIME_TOLERANCE_MS = 10_000;
const ARCHIVED_EXT = /\.(pdf|ofd|png|jpe?g|gif|webp|bmp)$/i;

function isContainedPath(target: string, base: string): boolean {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isSafeLegacyPlaceholder(planned: ArchivePlannedFile, stat: fs.Stats, record: JournalRecord, invoicesDir: string): boolean {
  if (!planned.legacy) return false;
  if (record.stage !== 'prepared') return false;
  if (!isContainedPath(planned.path, invoicesDir)) return false;
  if (!ARCHIVED_EXT.test(path.basename(planned.path))) return false;
  if (stat.size !== 0) return false;
  return Math.abs(stat.mtimeMs - record.startedAtMs) <= LEGACY_PLACEHOLDER_MTIME_TOLERANCE_MS;
}

/**
 * 删除本事务安装的文件。恢复路径必须保守：
 * - `files-installed` 之后按记录的 size + mtime 精确匹配；
 * - 仍处于 `prepared` 时只删除能被 staging inode 证明属于本事务的文件。
 * 任何不匹配的路径一律跳过，宁可留下孤儿也不能误删用户文件。
 */
function removePlannedFiles(record: JournalRecord, invoicesDir: string): { removed: number; unresolved: number } {
  let removed = 0;
  let unresolved = 0;
  const installed = new Map((record.installed ?? []).map((item) => [item.path, item]));

  for (const planned of record.files) {
    const filePath = planned.path;
    const stat = statOrNull(filePath);
    if (!stat || !stat.isFile()) continue;

    const fingerprint = installed.get(filePath);
    if (fingerprint) {
      if (stat.size !== fingerprint.size || Math.abs(stat.mtimeMs - fingerprint.mtimeMs) > 1) {
        unresolved++;
        continue;
      }
    } else if (!planned.stagingPath || !samePhysicalFile(filePath, planned.stagingPath)) {
      // prepared 阶段没有 durable installed fingerprint；只有 final path 与本事务
      // staging 文件仍是同一个 inode（hard-link 安装）时才能证明这是我们的文件。
      if (!isSafeLegacyPlaceholder(planned, stat, record, invoicesDir)) {
        unresolved++;
        continue;
      }
    }

    if (removeFileQuietly(filePath)) {
      removed++;
    } else {
      unresolved++;
    }
  }
  return { removed, unresolved };
}

function disableCsvRollback(recordPath: string, record: JournalRecord): void {
  if (record.csvRollbackDisabled) return;
  if (testFaultEnabled('MFH_TEST_FAIL_CSV_ROLLBACK_DISABLE')) {
    throw new Error('forced_csv_rollback_disable_persist_failure');
  }
  record.csvRollbackDisabled = true;
  writeRecord(recordPath, record);
}

function removeJournalOrThrow(recordPath: string): void {
  if (removeFileQuietly(recordPath)) return;
  throw new ArchiveRecoveryError(new Error('archive_journal_remove_failed'));
}

export function beginArchiveTransaction(invoicesDir: string, plan: ArchiveTxPlan): ArchiveTransaction {
  if (testFaultEnabled('MFH_TEST_FAIL_BEGIN_ARCHIVE_TRANSACTION')) {
    throw new Error('forced_begin_archive_transaction_failure');
  }
  const txId = `${Date.now().toString(36)}-${process.pid.toString(36)}-${randomBytes(5).toString('hex')}`;
  const recordPath = path.join(journalDir(invoicesDir), `${txId}.json`);
  const record: JournalRecord = {
    txId,
    pid: process.pid,
    startedAtMs: Date.now(),
    stage: 'prepared',
    files: plan.files.map(normalizePlannedFile),
    csv: plan.csv.map((item) => ({ path: item.path, baseLength: item.baseLength })),
  };
  // 条目写入并 fsync 之后才允许开始安装文件。
  writeRecord(recordPath, record);

  return {
    txId,

    markStage(stage: ArchiveStage): void {
      record.stage = stage;
      if (stage === 'files-installed') {
        const installed: InstalledFile[] = [];
        for (const { path: filePath } of record.files) {
          const stat = statOrNull(filePath);
          if (stat?.isFile()) {
            installed.push({ path: filePath, size: stat.size, mtimeMs: stat.mtimeMs });
          }
        }
        record.installed = installed;
      }
      writeRecord(recordPath, record);
    },

    commit(): void {
      removeFileQuietly(recordPath);
    },

    rollback(): void {
      try {
        const cleanup = removePlannedFiles(record, invoicesDir);
        if (cleanup.unresolved > 0) {
          disableCsvRollback(recordPath, record);
          throw new ArchiveRecoveryError(new Error('archive_rollback_unresolved_files'));
        }
        if (record.csvRollbackDisabled) {
          removeJournalOrThrow(recordPath);
          return;
        }
        let csvOk = true;
        for (const item of record.csv) csvOk = truncateCsv(item.path, item.baseLength) && csvOk;
        if (!csvOk) throw new ArchiveRecoveryError(new Error('archive_rollback_csv_truncate_failed'));
        removeJournalOrThrow(recordPath);
      } catch (err) {
        if (err instanceof ArchiveRecoveryError) throw err;
        throw new ArchiveRecoveryError(err);
      }
    },
  };
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM 表示进程存在但不属于当前用户。
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 启动时调用一次：回滚所有未提交的残留事务。
 * 仍被活着的进程持有的、以及已经进入 `ledger-committed` 的条目不会被回滚。
 */
export function recoverArchiveTransactions(invoicesDir: string, opts: ArchiveRecoveryOptions = {}): { rolledBack: number; skipped: number } {
  const dir = journalDir(invoicesDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { rolledBack: 0, skipped: 0 };
  }

  let rolledBack = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      // 上一次崩溃留下的 .tmp：直接清掉，它从未生效过。
      if (entry.endsWith('.json.tmp')) removeFileQuietly(path.join(dir, entry));
      continue;
    }
    const recordPath = path.join(dir, entry);
    let record: JournalRecord;
    try {
      record = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as JournalRecord;
    } catch {
      // 条目本身损坏：无法安全推断要删什么，保留给人工检查。
      skipped++;
      continue;
    }
    if (!Array.isArray(record.files) || !Array.isArray(record.csv)) {
      skipped++;
      continue;
    }
    record.files = record.files.map(normalizePlannedFile);

    // 另一个仍在运行的进程正持有这笔事务，不能替它回滚。
    if (record.pid !== process.pid && isProcessAlive(record.pid)) {
      if (opts.strict) throw new ArchiveRecoveryError(new Error('archive_recovery_live_pid_journal'));
      skipped++;
      continue;
    }

    if (record.stage === 'ledger-committed') {
      // 文件与台账都已落盘，只是没来得及删 journal：按已完成处理。
      removeJournalOrThrow(recordPath);
      skipped++;
      continue;
    }

    const cleanup = removePlannedFiles(record, invoicesDir);
    if (cleanup.unresolved > 0) {
      disableCsvRollback(recordPath, record);
      skipped++;
      continue;
    }
    if (record.csvRollbackDisabled) {
      removeJournalOrThrow(recordPath);
      rolledBack++;
      continue;
    }
    let csvOk = true;
    for (const item of record.csv) csvOk = truncateCsv(item.path, item.baseLength) && csvOk;
    if (!csvOk) throw new ArchiveRecoveryError(new Error('archive_recovery_csv_truncate_failed'));
    if (csvOk) {
      removeJournalOrThrow(recordPath);
      rolledBack++;
    } else {
      skipped++;
    }
  }

  return { rolledBack, skipped };
}

export function assertArchiveTransactionsRecovered(invoicesDir: string): { rolledBack: number; skipped: number } {
  try {
    return recoverArchiveTransactions(invoicesDir, { strict: true });
  } catch (err) {
    throw new ArchiveRecoveryError(err);
  }
}
