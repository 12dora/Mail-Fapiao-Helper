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
 */

export type ArchiveStage = 'prepared' | 'files-installed' | 'ledger-committed';

export interface ArchivePlannedFile {
  path: string;
  /** Optional staging file used to prove ownership before installed fingerprints are durable. */
  stagingPath?: string;
  /** Staging 事务目录；恢复时按 containment 删除（OCR-07）。 */
  stagingDir?: string;
  /** Internal marker for old journals that serialized `files` as plain strings. */
  legacy?: boolean;
}

export interface ArchiveTxPlan {
  /** 计划安装的最终文件绝对路径；带 stagingPath 时恢复可用 inode 证明所有权。 */
  files: Array<string | ArchivePlannedFile>;
  /** 将要追加的 CSV：路径 + 追加前的字节长度（不存在时为 0）。 */
  csv: { path: string; baseLength: number }[];
  /** 可选：整批共享的 staging 根目录，恢复时一并清理。 */
  stagingDir?: string;
}

export interface ArchiveTransaction {
  readonly txId: string;
  markStage(stage: ArchiveStage): void;
  /** 全部成功：删除 journal 文件。 */
  commit(): void;
  /** 失败：按 journal 删除已安装文件并把 CSV 截断回 baseLength；无法完成时抛出 ArchiveRecoveryError。 */
  rollback(): void;
}

/**
 * 机器可读 journal 形态错误前缀。Electron 隔离路径可据此识别「可安全隔离」条目
 *（与 JSON 解析失败一样 fail closed，不驱动恢复动作）。
 */
export const JOURNAL_INVALID_SHAPE_PREFIX = 'archive_recovery_journal_invalid_shape';

export class ArchiveRecoveryError extends Error {
  readonly code = 'archive_journal_recovery_failed';
  /**
   * 机器可读原因（通常等于 cause.message），例如
   * `archive_recovery_journal_invalid_shape:stage` / `archive_recovery_live_pid_journal`。
   * UI 隔离路径应读此字段，勿解析本地化 message。
   */
  readonly reason: string;

  constructor(cause: unknown) {
    super('archive_journal_recovery_failed');
    this.name = 'ArchiveRecoveryError';
    // 再包一层时保留原 reason / cause，避免 message 被统一成 code 后丢失分支键。
    if (cause instanceof ArchiveRecoveryError) {
      this.reason = cause.reason;
      this.cause = cause.cause ?? cause;
      return;
    }
    this.cause = cause;
    this.reason = cause instanceof Error
      ? cause.message
      : typeof cause === 'string'
        ? cause
        : 'archive_journal_recovery_failed';
  }
}

/** 是否为 journal 形态/解析类错误（可隔离，不得驱动回滚动作）。 */
export function isJournalShapeFailureReason(reason: string): boolean {
  return reason === 'archive_recovery_journal_malformed'
    || reason.startsWith(JOURNAL_INVALID_SHAPE_PREFIX);
}

export interface InstalledFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface JournalRecord {
  txId: string;
  pid: number;
  /** 进程出生标识，避免 PID 复用导致 journal 永久阻塞恢复（OCR-06）。 */
  processStartId?: string;
  startedAtMs: number;
  stage: ArchiveStage;
  files: ArchivePlannedFile[];
  csv: { path: string; baseLength: number }[];
  /** Once any planned file could not be proven as ours, CSV rollback is permanently unsafe. */
  csvRollbackDisabled?: boolean;
  /** `files-installed` 阶段记录的实际文件指纹，恢复时用于保守校验。 */
  installed?: InstalledFile[];
  /** 本事务的 staging 目录，恢复完成后删除（OCR-07）。 */
  stagingDir?: string;
}

export interface ArchiveRecoveryOptions {
  strict?: boolean;
}
