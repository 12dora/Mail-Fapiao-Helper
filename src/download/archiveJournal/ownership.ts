import fs from 'node:fs';
import path from 'node:path';
import { testFaultEnabled } from '../../util/testFaults.js';
import { writeRecord, statOrNull } from './record.js';
import { ArchiveRecoveryError, type ArchivePlannedFile, type JournalRecord } from './types.js';

export const STAGING_DIRNAME = '.staging';
/** staging 目录宽限期：比它更年轻的活进程目录不清理。 */
export const STAGING_ORPHAN_GRACE_MS = 60_000;

function samePhysicalFile(a: string, b: string): boolean {
  const aStat = statOrNull(a);
  const bStat = statOrNull(b);
  if (!aStat?.isFile() || !bStat?.isFile()) return false;
  return aStat.dev === bStat.dev && aStat.ino === bStat.ino;
}

export function removeFileQuietly(target: string): boolean {
  try {
    fs.rmSync(target, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** 把 CSV 截回 baseLength；只在当前长度更长时动手，绝不扩展文件。 */
export function truncateCsv(csvPath: string, baseLength: number): boolean {
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
/**
 * staging 事务目录名（末两段固定为 pid36 + 8 位 hex）：
 * - 管线：`${msgIdHash}-${pid36}-${randhex8}`
 * - 手工：`manual-${hash12}-${pid36}-${randhex8}`
 * 拒绝 `.staging` 根本身、`..`、以及任意非约定名。
 */
const STAGING_TX_DIR_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*-[0-9a-z]+-[0-9a-f]{8}$/i;

/**
 * 词法 containment：`target` 必须是 `base` 的严格后代（不含 base 自身）。
 * 用于最终归档文件等不必跟随 symlink 的路径校验。
 */
function isStrictChildPath(target: string, base: string): boolean {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 兼容旧名：严格子路径（不再把 base 自身视为 contained）。 */
function isContainedPath(target: string, base: string): boolean {
  return isStrictChildPath(target, base);
}

/**
 * 解析并校验「可删除的事务 staging 目录」（OCR-07 rework）：
 * 1. 词法上必须是 `<invoices>/.staging` 的严格子目录（拒绝 staging 根本身）；
 * 2. 目录名符合事务命名约定；
 * 3. 路径上任何中间组件不得是 symlink（lstat）；
 * 4. realpath 后仍落在 staging 根的 realpath 之下。
 * 不满足则返回 null，调用方跳过删除。
 */
export function resolveSafeStagingTxDir(candidate: string, invoicesDir: string): string | null {
  const stagingRoot = path.resolve(invoicesDir, STAGING_DIRNAME);
  const target = path.resolve(candidate);
  if (!isStrictChildPath(target, stagingRoot)) return null;

  const leaf = path.basename(target);
  if (!leaf || leaf === '.' || leaf === '..') return null;
  if (!STAGING_TX_DIR_RE.test(leaf)) return null;
  // 事务目录必须是 staging 根的直接子目录，禁止 journal 指向深层/任意路径。
  if (path.dirname(target) !== stagingRoot) return null;

  // 逐段 lstat：拒绝中间 symlink 逃逸（path.resolve 不会展开 symlink）。
  let cursor = stagingRoot;
  // staging 根本身若是 symlink，realpath 后再比；根不存在则无法安全删除。
  let realRoot: string;
  try {
    const rootStat = fs.lstatSync(stagingRoot);
    if (rootStat.isSymbolicLink()) return null;
    if (!rootStat.isDirectory()) return null;
    realRoot = fs.realpathSync(stagingRoot);
  } catch {
    return null;
  }

  const relParts = path.relative(stagingRoot, target).split(path.sep).filter((p) => p && p !== '.');
  for (const part of relParts) {
    if (part === '..') return null;
    cursor = path.join(cursor, part);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cursor);
    } catch {
      return null;
    }
    if (st.isSymbolicLink()) return null;
  }
  if (!fs.statSync(target).isDirectory()) return null;

  let realTarget: string;
  try {
    realTarget = fs.realpathSync(target);
  } catch {
    return null;
  }
  const realRel = path.relative(realRoot, realTarget);
  if (!realRel || realRel.startsWith('..') || path.isAbsolute(realRel)) return null;
  return realTarget;
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
export function removePlannedFiles(record: JournalRecord, invoicesDir: string): { removed: number; unresolved: number } {
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

/**
 * 按严格 containment + 事务身份删除 staging 目录（OCR-07）。
 * 损坏 journal 若把路径写成 `<invoices>/.staging` 本身或经 symlink 逃逸，
 * 不得递归删除无关/在用的 staging。
 */
export function removeTransactionStaging(record: JournalRecord, invoicesDir: string): void {
  const candidates = new Set<string>();
  if (record.stagingDir) candidates.add(record.stagingDir);
  for (const planned of record.files) {
    if (planned.stagingDir) candidates.add(planned.stagingDir);
    // stagingPath 的父目录仅在仍能解析为合法事务目录时才采纳。
    if (planned.stagingPath) candidates.add(path.dirname(planned.stagingPath));
  }
  for (const dir of candidates) {
    const safe = resolveSafeStagingTxDir(dir, invoicesDir);
    if (!safe) continue;
    try {
      fs.rmSync(safe, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

export function disableCsvRollback(recordPath: string, record: JournalRecord): void {
  if (record.csvRollbackDisabled) return;
  if (testFaultEnabled('MFH_TEST_FAIL_CSV_ROLLBACK_DISABLE')) {
    throw new Error('forced_csv_rollback_disable_persist_failure');
  }
  record.csvRollbackDisabled = true;
  writeRecord(recordPath, record);
}

export function removeJournalOrThrow(recordPath: string): void {
  if (removeFileQuietly(recordPath)) return;
  throw new ArchiveRecoveryError(new Error('archive_journal_remove_failed'));
}
