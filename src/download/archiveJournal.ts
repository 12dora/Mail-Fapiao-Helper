/**
 * 归档事务公共入口。
 *
 * Electron 侧的手工归档会复用同一模块，因此本文件的导出签名不要改名。
 */
export {
  ArchiveRecoveryError,
  JOURNAL_INVALID_SHAPE_PREFIX,
  isJournalShapeFailureReason,
  type ArchivePlannedFile,
  type ArchiveStage,
  type ArchiveTransaction,
  type ArchiveTxPlan,
} from './archiveJournal/types.js';
export { appendCsvBlockDurable, journalRecordInvalidReason } from './archiveJournal/record.js';
export { beginArchiveTransaction } from './archiveJournal/transaction.js';
export {
  assertArchiveTransactionsRecovered,
  recoverArchiveTransactions,
  recoverOrphanStagingDirs,
} from './archiveJournal/recovery.js';
