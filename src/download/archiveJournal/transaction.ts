import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { testFaultEnabled } from '../../util/testFaults.js';
import { readProcessStartId } from '../../util/dataDirLock.js';
import {
  disableCsvRollback,
  removeFileQuietly,
  removeJournalOrThrow,
  removePlannedFiles,
  removeTransactionStaging,
  truncateCsv,
} from './ownership.js';
import { journalDir, normalizePlannedFile, statOrNull, writeRecord } from './record.js';
import {
  ArchiveRecoveryError,
  type ArchiveStage,
  type ArchiveTransaction,
  type ArchiveTxPlan,
  type InstalledFile,
  type JournalRecord,
} from './types.js';

/**
 * TEST-10：测试专用 stage barrier。
 *
 * 仅在 `testFaultEnabled`（打包运行时恒 false；非打包需 token + 包根下 sentinel）
 * 且 `MFH_TEST_JOURNAL_HOLD_AT_STAGE=1` 时生效。写入 journal 并 fsync 到目标 stage 后：
 *   1. 若设置了 `MFH_TEST_JOURNAL_HOLD_SENTINEL` 且路径落在 tmp/cwd 下，把 stage 名写入；
 *   2. 自旋等待直到被 SIGKILL（不是 throw，否则 journal 会走同进程 rollback）。
 *
 * 父测试在 sentinel 出现后强杀子进程，再用新进程调用 recover 验证 durable 边界。
 */
function maybeHoldAtJournalStage(stage: ArchiveStage): void {
  if (!testFaultEnabled('MFH_TEST_JOURNAL_HOLD_AT_STAGE')) return;
  if (process.env.MFH_TEST_JOURNAL_HOLD_STAGE !== stage) return;
  const sentinel = process.env.MFH_TEST_JOURNAL_HOLD_SENTINEL;
  if (sentinel && sentinel.length > 0) {
    const resolved = path.resolve(sentinel);
    const roots = [
      path.resolve(os.tmpdir()),
      path.resolve(process.env.TMPDIR || process.env.TEMP || os.tmpdir()),
      path.resolve(process.cwd()),
    ];
    const allowed = roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
    if (allowed) {
      try {
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, `${stage}\n`, 'utf8');
      } catch {
        // parent will time out if the sentinel never appears
      }
    }
  }
  // Busy-wait until the parent SIGKILLs this process. Do not throw: a throw would
  // run in-process catch/rollback and defeat the durable-crash contract under test.
  for (;;) {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    } catch {
      // spin
    }
  }
}

export function beginArchiveTransaction(invoicesDir: string, plan: ArchiveTxPlan): ArchiveTransaction {
  if (testFaultEnabled('MFH_TEST_FAIL_BEGIN_ARCHIVE_TRANSACTION')) {
    throw new Error('forced_begin_archive_transaction_failure');
  }
  const txId = `${Date.now().toString(36)}-${process.pid.toString(36)}-${randomBytes(5).toString('hex')}`;
  const recordPath = path.join(journalDir(invoicesDir), `${txId}.json`);
  const files = plan.files.map(normalizePlannedFile);
  // 把共享 stagingDir 写进每条 planned file，恢复时不必依赖顶层字段。
  if (plan.stagingDir) {
    for (const f of files) {
      if (!f.stagingDir) f.stagingDir = plan.stagingDir;
    }
  }
  const record: JournalRecord = {
    txId,
    pid: process.pid,
    processStartId: readProcessStartId(process.pid),
    startedAtMs: Date.now(),
    stage: 'prepared',
    files,
    csv: plan.csv.map((item) => ({ path: item.path, baseLength: item.baseLength })),
    ...(plan.stagingDir ? { stagingDir: plan.stagingDir } : {}),
  };
  // 条目写入并 fsync 之后才允许开始安装文件。
  writeRecord(recordPath, record);
  // prepared 已 durable：强杀后恢复必须按 prepared 回滚（TEST-10）。
  maybeHoldAtJournalStage('prepared');

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
      maybeHoldAtJournalStage(stage);
    },

    commit(): void {
      // 成功后清理 staging；journal 删除表示事务完成。
      removeTransactionStaging(record, invoicesDir);
      removeFileQuietly(recordPath);
    },

    rollback(): void {
      try {
        const cleanup = removePlannedFiles(record, invoicesDir);
        removeTransactionStaging(record, invoicesDir);
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
