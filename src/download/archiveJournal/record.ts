import fs from 'node:fs';
import path from 'node:path';
import {
  JOURNAL_INVALID_SHAPE_PREFIX,
  type ArchivePlannedFile,
  type ArchiveStage,
  type InstalledFile,
  type JournalRecord,
} from './types.js';

const JOURNAL_DIRNAME = '.journal';

export function journalDir(invoicesDir: string): string {
  return path.join(invoicesDir, JOURNAL_DIRNAME);
}

function isPosix(): boolean {
  return process.platform !== 'win32';
}

/** 写入 journal 条目并 fsync：条目必须先于任何文件安装落到磁盘。 */
export function writeRecord(recordPath: string, record: JournalRecord): void {
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

export function statOrNull(target: string): fs.Stats | null {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

export function normalizePlannedFile(file: string | ArchivePlannedFile): ArchivePlannedFile {
  return typeof file === 'string' ? { path: file, legacy: true } : { ...file };
}

const ARCHIVE_STAGES: ReadonlySet<string> = new Set([
  'prepared',
  'files-installed',
  'ledger-committed',
]);

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function parseJournalHeader(o: Record<string, unknown>): {
  txId: string;
  pid: number;
  processStartId?: string;
  startedAtMs: number;
  stage: ArchiveStage;
} {
  if (!isNonEmptyString(o.txId)) {
    throw new Error(`${JOURNAL_INVALID_SHAPE_PREFIX}:txId`);
  }
  if (typeof o.pid !== 'number' || !Number.isInteger(o.pid) || o.pid < 1) {
    throw new Error(`${JOURNAL_INVALID_SHAPE_PREFIX}:pid`);
  }
  if (o.processStartId !== undefined && typeof o.processStartId !== 'string') {
    throw new Error(`${JOURNAL_INVALID_SHAPE_PREFIX}:processStartId`);
  }
  if (typeof o.startedAtMs !== 'number' || !Number.isFinite(o.startedAtMs)) {
    throw new Error(`${JOURNAL_INVALID_SHAPE_PREFIX}:startedAtMs`);
  }
  if (typeof o.stage !== 'string' || !ARCHIVE_STAGES.has(o.stage)) {
    throw new Error(`${JOURNAL_INVALID_SHAPE_PREFIX}:stage`);
  }
  return {
    txId: o.txId,
    pid: o.pid,
    ...(typeof o.processStartId === 'string' ? { processStartId: o.processStartId } : {}),
    startedAtMs: o.startedAtMs,
    stage: o.stage as ArchiveStage,
  };
}

function parsePlannedFiles(value: unknown): ArchivePlannedFile[] {
  if (!Array.isArray(value)) {
    throw new Error(`${JOURNAL_INVALID_SHAPE_PREFIX}:files`);
  }
  const files: ArchivePlannedFile[] = [];
  for (let i = 0; i < value.length; i++) {
    const entry = value[i];
    if (typeof entry === 'string') {
      if (entry.length === 0) {
        throw new Error(`${JOURNAL_INVALID_SHAPE_PREFIX}:files[${i}]`);
      }
      files.push({ path: entry, legacy: true });
      continue;
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${JOURNAL_INVALID_SHAPE_PREFIX}:files[${i}]`);
    }
    const fe = entry as Record<string, unknown>;
    if (!isNonEmptyString(fe.path)) {
      throw new Error(`${JOURNAL_INVALID_SHAPE_PREFIX}:files[${i}].path`);
    }
    if (fe.stagingPath !== undefined && typeof fe.stagingPath !== 'string') {
      throw new Error(`${JOURNAL_INVALID_SHAPE_PREFIX}:files[${i}].stagingPath`);
    }
    if (fe.stagingDir !== undefined && typeof fe.stagingDir !== 'string') {
      throw new Error(`${JOURNAL_INVALID_SHAPE_PREFIX}:files[${i}].stagingDir`);
    }
    if (fe.legacy !== undefined && typeof fe.legacy !== 'boolean') {
      throw new Error(`${JOURNAL_INVALID_SHAPE_PREFIX}:files[${i}].legacy`);
    }
    const planned: ArchivePlannedFile = { path: fe.path };
    if (typeof fe.stagingPath === 'string') planned.stagingPath = fe.stagingPath;
    if (typeof fe.stagingDir === 'string') planned.stagingDir = fe.stagingDir;
    if (typeof fe.legacy === 'boolean') planned.legacy = fe.legacy;
    files.push(planned);
  }
  return files;
}

function parseCsvEntries(value: unknown): { path: string; baseLength: number }[] {
  if (!Array.isArray(value)) {
    throw new Error(`${JOURNAL_INVALID_SHAPE_PREFIX}:csv`);
  }
  const csv: { path: string; baseLength: number }[] = [];
  for (let i = 0; i < value.length; i++) {
    const entry = value[i];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${JOURNAL_INVALID_SHAPE_PREFIX}:csv[${i}]`);
    }
    const ce = entry as Record<string, unknown>;
    if (!isNonEmptyString(ce.path)) {
      throw new Error(`${JOURNAL_INVALID_SHAPE_PREFIX}:csv[${i}].path`);
    }
    if (typeof ce.baseLength !== 'number' || !Number.isFinite(ce.baseLength) || ce.baseLength < 0) {
      throw new Error(`${JOURNAL_INVALID_SHAPE_PREFIX}:csv[${i}].baseLength`);
    }
    csv.push({ path: ce.path, baseLength: ce.baseLength });
  }
  return csv;
}

function parseInstalledFiles(value: unknown): InstalledFile[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${JOURNAL_INVALID_SHAPE_PREFIX}:installed`);
  }
  const installed: InstalledFile[] = [];
  for (let i = 0; i < value.length; i++) {
    const entry = value[i];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${JOURNAL_INVALID_SHAPE_PREFIX}:installed[${i}]`);
    }
    const ie = entry as Record<string, unknown>;
    if (!isNonEmptyString(ie.path)) {
      throw new Error(`${JOURNAL_INVALID_SHAPE_PREFIX}:installed[${i}].path`);
    }
    if (typeof ie.size !== 'number' || !Number.isFinite(ie.size) || ie.size < 0) {
      throw new Error(`${JOURNAL_INVALID_SHAPE_PREFIX}:installed[${i}].size`);
    }
    if (typeof ie.mtimeMs !== 'number' || !Number.isFinite(ie.mtimeMs)) {
      throw new Error(`${JOURNAL_INVALID_SHAPE_PREFIX}:installed[${i}].mtimeMs`);
    }
    installed.push({ path: ie.path, size: ie.size, mtimeMs: ie.mtimeMs });
  }
  return installed;
}

/**
 * 严格解析 journal JSON 形态。任何不合规字段 fail closed，并抛出
 * `archive_recovery_journal_invalid_shape:<field>` 机器可读原因。
 * 兼容旧 journal：`files` 条目可为非空路径字符串（legacy）。
 */
export function parseJournalRecord(raw: unknown): JournalRecord {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${JOURNAL_INVALID_SHAPE_PREFIX}:not_object`);
  }
  const o = raw as Record<string, unknown>;
  const header = parseJournalHeader(o);
  if (!Array.isArray(o.files)) {
    throw new Error(`${JOURNAL_INVALID_SHAPE_PREFIX}:files`);
  }
  if (!Array.isArray(o.csv)) {
    throw new Error(`${JOURNAL_INVALID_SHAPE_PREFIX}:csv`);
  }
  const files = parsePlannedFiles(o.files);
  const csv = parseCsvEntries(o.csv);

  if (o.csvRollbackDisabled !== undefined && typeof o.csvRollbackDisabled !== 'boolean') {
    throw new Error(`${JOURNAL_INVALID_SHAPE_PREFIX}:csvRollbackDisabled`);
  }
  const installed = parseInstalledFiles(o.installed);
  if (o.stagingDir !== undefined && typeof o.stagingDir !== 'string') {
    throw new Error(`${JOURNAL_INVALID_SHAPE_PREFIX}:stagingDir`);
  }

  const record: JournalRecord = {
    txId: header.txId,
    pid: header.pid,
    startedAtMs: header.startedAtMs,
    stage: header.stage,
    files,
    csv,
  };
  if (header.processStartId !== undefined) record.processStartId = header.processStartId;
  if (o.csvRollbackDisabled === true) record.csvRollbackDisabled = true;
  if (installed) record.installed = installed;
  if (typeof o.stagingDir === 'string') record.stagingDir = o.stagingDir;
  return record;
}

/**
 * 供 Electron 隔离路径：返回 null 表示形态合法；否则返回机器可读 reason。
 * 不执行任何恢复/删除动作。
 */
export function journalRecordInvalidReason(raw: unknown): string | null {
  try {
    parseJournalRecord(raw);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : JOURNAL_INVALID_SHAPE_PREFIX;
  }
}
