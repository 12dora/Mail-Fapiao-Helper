import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { testFaultEnabled } from '../util/testFaults.js';
import { isSameProcessAlive, readProcessStartId } from '../util/dataDirLock.js';

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

export class ArchiveRecoveryError extends Error {
  readonly code = 'archive_journal_recovery_failed';

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

interface ArchiveRecoveryOptions {
  strict?: boolean;
}

const JOURNAL_DIRNAME = '.journal';
const STAGING_DIRNAME = '.staging';
/** staging 目录宽限期：比它更年轻的活进程目录不清理。 */
const STAGING_ORPHAN_GRACE_MS = 60_000;

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

/**
 * 把内容追加到 CSV 并用 fsync 保证 durable（供 OCR-03 的 ledger-committed 顺序使用）。
 * 本模块提供原语；调用方（pipeline）应在 markStage('ledger-committed') 之前调用。
 */
export function appendCsvBlockDurable(csvPath: string, header: string, lines: string[]): void {
  if (lines.length === 0) return;
  const dir = path.dirname(csvPath);
  fs.mkdirSync(dir, { recursive: true, mode: isPosix() ? 0o700 : undefined });
  const existed = fs.existsSync(csvPath);
  const fd = fs.openSync(csvPath, 'a', isPosix() ? 0o600 : undefined);
  try {
    if (!existed) {
      fs.writeFileSync(fd, `\uFEFF${header}\n`, 'utf8');
    }
    fs.writeFileSync(fd, lines.join(''), 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // 新建文件时 fsync 父目录，保证目录项本身 durable。
  if (!existed) {
    try {
      const dirFd = fs.openSync(dir, 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // Windows 等不支持目录 fsync 时忽略。
    }
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
function resolveSafeStagingTxDir(candidate: string, invoicesDir: string): string | null {
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

/**
 * 按严格 containment + 事务身份删除 staging 目录（OCR-07）。
 * 损坏 journal 若把路径写成 `<invoices>/.staging` 本身或经 symlink 逃逸，
 * 不得递归删除无关/在用的 staging。
 */
function removeTransactionStaging(record: JournalRecord, invoicesDir: string): void {
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
  const dir = journalDir(invoicesDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
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
    } catch (err) {
      // 无法读取或解析：严格模式不得当作「已恢复」。
      if (opts.strict) {
        const code = (err as NodeJS.ErrnoException)?.code;
        throw new ArchiveRecoveryError(
          new Error(
            code
              ? `archive_recovery_journal_unreadable:${code}`
              : 'archive_recovery_journal_malformed',
          ),
        );
      }
      skipped++;
      continue;
    }
    if (!Array.isArray(record.files) || !Array.isArray(record.csv)) {
      if (opts.strict) {
        throw new ArchiveRecoveryError(new Error('archive_recovery_journal_invalid_shape'));
      }
      skipped++;
      continue;
    }
    record.files = record.files.map(normalizePlannedFile);

    // 另一个仍在运行的进程正持有这笔事务，不能替它回滚。
    // 使用 pid + processStartId，避免 PID 复用永久阻塞（OCR-06）。
    if (
      record.pid !== process.pid
      && isSameProcessAlive(record.pid, record.processStartId)
    ) {
      if (opts.strict) throw new ArchiveRecoveryError(new Error('archive_recovery_live_pid_journal'));
      skipped++;
      continue;
    }

    if (record.stage === 'ledger-committed') {
      // 文件与台账都已落盘，只是没来得及删 journal：按已完成处理。
      removeTransactionStaging(record, invoicesDir);
      removeJournalOrThrow(recordPath);
      skipped++;
      continue;
    }

    const cleanup = removePlannedFiles(record, invoicesDir);
    removeTransactionStaging(record, invoicesDir);
    if (cleanup.unresolved > 0) {
      // 无法证明文件所有权：禁用 CSV 截断并保留 journal。
      // disableCsvRollback 失败会抛错；成功后 strict 仍允许跳过（证据已 durable）。
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

  // journal 处理完后清孤儿 staging（无 journal 的崩溃窗口，OCR-07）。
  const staging = recoverOrphanStagingDirs(invoicesDir);
  skipped += staging.skipped;

  return { rolledBack, skipped };
}

export function assertArchiveTransactionsRecovered(invoicesDir: string): { rolledBack: number; skipped: number } {
  try {
    return recoverArchiveTransactions(invoicesDir, { strict: true });
  } catch (err) {
    throw new ArchiveRecoveryError(err);
  }
}
