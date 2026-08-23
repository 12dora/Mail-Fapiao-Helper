import fs from 'node:fs';
import path from 'node:path';
import { isSameProcessAlive } from '../../util/dataDirLock.js';
import {
  STAGING_DIRNAME,
  STAGING_ORPHAN_GRACE_MS,
  disableCsvRollback,
  removeFileQuietly,
  removeJournalOrThrow,
  removePlannedFiles,
  removeTransactionStaging,
  resolveSafeStagingTxDir,
  truncateCsv,
} from './ownership.js';
import { journalDir, parseJournalRecord } from './record.js';
import {
  ArchiveRecoveryError,
  JOURNAL_INVALID_SHAPE_PREFIX,
  isJournalShapeFailureReason,
  type ArchiveRecoveryOptions,
  type JournalRecord,
} from './types.js';

interface RecoveryCount {
  rolledBack: number;
  skipped: number;
}

/**
 * 启动时扫描 `.staging`，清理已死亡进程遗留且超过宽限期的目录（OCR-07）。
 * 必须在持有 data-dir lock 的前提下调用（由 recoverArchiveTransactions 串联）。
 */
export function recoverOrphanStagingDirs(invoicesDir: string): { removed: number; skipped: number } {
  const stagingRoot = path.join(invoicesDir, STAGING_DIRNAME);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(stagingRoot, { withFileTypes: true });
  } catch {
    return { removed: 0, skipped: 0 };
  }

  let removed = 0;
  let skipped = 0;
  const now = Date.now();

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    // 符号链接目录：resolveSafeStagingTxDir 会拒绝；这里直接跳过。
    if (entry.isSymbolicLink()) {
      skipped++;
      continue;
    }
    const dirPath = path.join(stagingRoot, entry.name);
    const safe = resolveSafeStagingTxDir(dirPath, invoicesDir);
    if (!safe) {
      skipped++;
      continue;
    }

    // 命名约定：`${msgIdHash}-${pid36}-${randhex}`
    const parts = entry.name.split('-');
    let ownerPid = 0;
    if (parts.length >= 3) {
      const pidPart = parts[parts.length - 2] ?? '';
      const parsed = Number.parseInt(pidPart, 36);
      if (Number.isInteger(parsed) && parsed > 0) ownerPid = parsed;
    }

    let ageMs = 0;
    try {
      ageMs = now - fs.statSync(safe).mtimeMs;
    } catch {
      skipped++;
      continue;
    }

    // 宽限期内一律跳过，避免误删仍在写入的 staging。
    if (ageMs < STAGING_ORPHAN_GRACE_MS) {
      skipped++;
      continue;
    }

    // 能解析到 pid 且进程仍存活 → 跳过。
    if (ownerPid > 0 && isSameProcessAlive(ownerPid, undefined)) {
      skipped++;
      continue;
    }

    try {
      fs.rmSync(safe, { recursive: true, force: true });
      removed++;
    } catch {
      skipped++;
    }
  }

  return { removed, skipped };
}

function readJournalEntry(recordPath: string, opts: ArchiveRecoveryOptions): JournalRecord | null {
  try {
    const rawText = fs.readFileSync(recordPath, 'utf8');
    let raw: unknown;
    try {
      raw = JSON.parse(rawText) as unknown;
    } catch {
      throw new Error('archive_recovery_journal_malformed');
    }
    // 完整形态校验后再驱动任何恢复动作（S7）；非法条目 fail closed。
    return parseJournalRecord(raw);
  } catch (err) {
    // 无法读取、解析或形态非法：严格模式不得当作「已恢复」。
    if (opts.strict) {
      const code = (err as NodeJS.ErrnoException)?.code;
      const msg = err instanceof Error ? err.message : String(err);
      // 形态错误 / 解析错误：保留机器可读 reason，供 UI 隔离路径识别。
      if (isJournalShapeFailureReason(msg) || msg.startsWith(JOURNAL_INVALID_SHAPE_PREFIX)) {
        throw new ArchiveRecoveryError(new Error(msg));
      }
      throw new ArchiveRecoveryError(
        new Error(
          code
            ? `archive_recovery_journal_unreadable:${code}`
            : (msg || 'archive_recovery_journal_malformed'),
        ),
      );
    }
    return null;
  }
}

function rollbackRecord(recordPath: string, record: JournalRecord, invoicesDir: string): RecoveryCount {
  const cleanup = removePlannedFiles(record, invoicesDir);
  removeTransactionStaging(record, invoicesDir);
  if (cleanup.unresolved > 0) {
    // 无法证明文件所有权：禁用 CSV 截断并保留 journal。
    // disableCsvRollback 失败会抛错；成功后 strict 仍允许跳过（证据已 durable）。
    disableCsvRollback(recordPath, record);
    return { rolledBack: 0, skipped: 1 };
  }
  if (record.csvRollbackDisabled) {
    removeJournalOrThrow(recordPath);
    return { rolledBack: 1, skipped: 0 };
  }
  let csvOk = true;
  for (const item of record.csv) csvOk = truncateCsv(item.path, item.baseLength) && csvOk;
  if (!csvOk) throw new ArchiveRecoveryError(new Error('archive_recovery_csv_truncate_failed'));
  if (csvOk) {
    removeJournalOrThrow(recordPath);
    return { rolledBack: 1, skipped: 0 };
  } else {
    return { rolledBack: 0, skipped: 1 };
  }
}

function recoverJournalRecord(
  recordPath: string,
  record: JournalRecord,
  invoicesDir: string,
  opts: ArchiveRecoveryOptions,
): RecoveryCount {
  // 另一个仍在运行的进程正持有这笔事务，不能替它回滚。
  // 使用 pid + processStartId，避免 PID 复用永久阻塞（OCR-06）。
  if (
    record.pid !== process.pid
    && isSameProcessAlive(record.pid, record.processStartId)
  ) {
    if (opts.strict) throw new ArchiveRecoveryError(new Error('archive_recovery_live_pid_journal'));
    return { rolledBack: 0, skipped: 1 };
  }

  if (record.stage === 'ledger-committed') {
    // 文件与台账都已落盘，只是没来得及删 journal：按已完成处理。
    removeTransactionStaging(record, invoicesDir);
    removeJournalOrThrow(recordPath);
    return { rolledBack: 0, skipped: 1 };
  }

  return rollbackRecord(recordPath, record, invoicesDir);
}

function recoverJournalDirectory(
  invoicesDir: string,
  opts: ArchiveRecoveryOptions,
): { entries: string[]; dir: string } | RecoveryCount {
  const dir = journalDir(invoicesDir);
  try {
    return { entries: fs.readdirSync(dir), dir };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      // 确认不存在：无 journal 可恢复，仍尝试清理孤儿 staging。
      const staging = recoverOrphanStagingDirs(invoicesDir);
      return { rolledBack: 0, skipped: staging.skipped };
    }
    // EACCES / EIO / 其它：无法判定是否有未提交事务 → 严格模式 fail-closed。
    if (opts.strict) {
      throw new ArchiveRecoveryError(
        new Error(`archive_recovery_journal_dir_unreadable:${code ?? 'unknown'}`),
      );
    }
    const staging = recoverOrphanStagingDirs(invoicesDir);
    return { rolledBack: 0, skipped: staging.skipped + 1 };
  }
}

/**
 * 启动时调用一次：回滚所有未提交的残留事务。
 * 仍被活着的进程持有的、以及已经进入 `ledger-committed` 的条目不会被回滚。
 *
 * **严格模式（strict）fail-closed**：
 * - journal 目录「确认不存在」(ENOENT) → 视为无残留，可继续；
 * - journal 目录/条目「无法判定」(EACCES/EIO/损坏 JSON/非法 shape) → 抛错阻断写入；
 * - 活 PID 持有的 journal → 抛错；
 * - 已安装文件无法证明所有权（unresolved）：持久化 csvRollbackDisabled 后仍计 skipped
 *   （CSV 截断已禁用；与既有回归一致）。若持久化失败则抛错。
 */
export function recoverArchiveTransactions(invoicesDir: string, opts: ArchiveRecoveryOptions = {}): { rolledBack: number; skipped: number } {
  const directory = recoverJournalDirectory(invoicesDir, opts);
  if ('rolledBack' in directory) return directory;

  let rolledBack = 0;
  let skipped = 0;

  for (const entry of directory.entries) {
    if (!entry.endsWith('.json')) {
      // 上一次崩溃留下的 .tmp：直接清掉，它从未生效过。
      if (entry.endsWith('.json.tmp')) removeFileQuietly(path.join(directory.dir, entry));
      continue;
    }
    const recordPath = path.join(directory.dir, entry);
    const record = readJournalEntry(recordPath, opts);
    if (!record) {
      skipped++;
      continue;
    }

    const recovered = recoverJournalRecord(recordPath, record, invoicesDir, opts);
    rolledBack += recovered.rolledBack;
    skipped += recovered.skipped;
  }

  // journal 处理完后清孤儿 staging（无 journal 的崩溃窗口，OCR-07）。
  const staging = recoverOrphanStagingDirs(invoicesDir);
  skipped += staging.skipped;

  return { rolledBack, skipped };
}

export function assertArchiveTransactionsRecovered(invoicesDir: string): { rolledBack: number; skipped: number } {
  try {
    return recoverArchiveTransactions(invoicesDir, { strict: true });
  } catch (err) {
    // 已是 ArchiveRecoveryError：直接抛出，保留 reason（invalid_shape / malformed 等）。
    // 再包一层时 constructor 也会透传 reason/cause，双保险供 Electron 隔离路由分支。
    if (err instanceof ArchiveRecoveryError) throw err;
    throw new ArchiveRecoveryError(err);
  }
}
