import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { csvCell, parseCsv } from '../util/csv.js';
import { contentHash } from '../util/hash.js';
import { sanitizeText } from './sanitize.js';

/**
 * 「选择文件归档」的事务化实现（APP-04）。
 *
 * 旧实现逐个 `copyFileSync` 到最终目录后直接重写 `pending.csv`，既不写归档台账
 * 也不写 `ocr-pending.csv`：UI 说归档成功，但「开始识别」认为没有文件，原待确认
 * 上下文却已经被删掉；中途失败还会留下部分副本。
 *
 * 现在的顺序是：校验格式 → 计算 contentHash → staging → 原子安装文件 →
 * 写归档台账 → 写 OCR 队列 → 全部成功后才移除 pending 行；任一步失败都回滚。
 */

export type ArchiveFormat = 'pdf' | 'ofd' | 'image';

export interface ManualArchiveFile {
  filename: string;
  contentHash: string;
  format: ArchiveFormat;
}

export interface ManualArchiveInput {
  /** 用户在对话框里选择的绝对路径。 */
  sources: string[];
  invoicesDir: string;
  /** 归档台账 CSV（cfg.output.csv 的绝对路径）。 */
  ledgerCsv: string;
  /** OCR 队列 CSV（invoices/ocr/ocr-pending.csv）。 */
  ocrPendingCsv: string;
  /** 待确认行的短 hash，用于队列身份与移除。 */
  hash: string;
  /** 原待确认行，用于回填 messageId / date / from / subject。 */
  pendingRow?: Record<string, string> | undefined;
  /**
   * 移除待确认行的回调（由 main 提供，内部是原子重写 pending.csv）。
   * 只有归档台账和 OCR 队列都写成功之后才会被调用。
   */
  removePendingRow: () => number;
}

export interface ManualArchiveResult {
  ok: boolean;
  code?: string;
  message?: string;
  detail?: string;
  files: ManualArchiveFile[];
  /** 已经在台账/队列里存在、本次未重复归档的来源文件名。 */
  duplicates: string[];
  /** 是否成功从待确认队列移除了对应行。 */
  pendingRemoved: number;
}

/** 单个文件的大小上限，避免误选超大文件把归档目录塞满。 */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

const LEDGER_HEADER = ['messageId', 'date', 'from', 'subject', 'filename', 'source', 'contentHash'];
const QUEUE_HEADER = [
  'hash', 'messageId', 'date', 'from', 'subject', 'filename',
  'source', 'format', 'documentType', 'status', 'reason', 'contentHash',
];

interface DetectedFormat {
  format: ArchiveFormat;
  ext: string;
}

/** 只按 magic bytes 判定格式，不相信用户文件的扩展名。 */
function detectFormat(data: Buffer): DetectedFormat | undefined {
  if (data.subarray(0, 4).toString('ascii') === '%PDF') return { format: 'pdf', ext: 'pdf' };
  // OFD 与 ZIP 同为 PK 容器，沿用 downloader 的判定：PK -> ofd。
  if (data.subarray(0, 2).toString('ascii') === 'PK') return { format: 'ofd', ext: 'ofd' };
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { format: 'image', ext: 'png' };
  }
  if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return { format: 'image', ext: 'jpg' };
  if (data.subarray(0, 4).toString('ascii') === 'GIF8') return { format: 'image', ext: 'gif' };
  if (data.subarray(0, 2).toString('ascii') === 'BM') return { format: 'image', ext: 'bmp' };
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { format: 'image', ext: 'webp' };
  }
  return undefined;
}

function writeFileAtomic(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

interface CsvSnapshot {
  file: string;
  existed: boolean;
  content: string;
}

function snapshot(file: string): CsvSnapshot {
  const existed = fs.existsSync(file);
  return { file, existed, content: existed ? fs.readFileSync(file, 'utf8') : '' };
}

function restore(snap: CsvSnapshot): void {
  try {
    if (snap.existed) writeFileAtomic(snap.file, snap.content);
    else fs.rmSync(snap.file, { force: true });
  } catch {
    // 回滚已经是尽力而为的最后一步。
  }
}

function bodyRows(text: string): string[][] {
  const records = parseCsv(text.replace(/^﻿/, ''));
  return records.slice(1);
}

function renderCsv(header: string[], rows: string[][]): string {
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) lines.push(header.map((_, i) => csvCell(row[i] ?? '')).join(','));
  return `﻿${lines.join('\n')}\n`;
}

/** 归档目录里下一个未占用的 NNNN.ext；沿用自动归档的编号命名，避免 -1/-2 重复件。 */
function nextNumberedName(dir: string, ext: string): string {
  let counter = 1;
  while (counter < 100000) {
    const candidate = `${String(counter).padStart(4, '0')}.${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
    counter++;
  }
  throw new Error('invoices directory is full of numbered files');
}

export function runManualArchive(input: ManualArchiveInput): ManualArchiveResult {
  const empty: ManualArchiveResult = { ok: false, files: [], duplicates: [], pendingRemoved: 0 };
  if (input.sources.length === 0) {
    return { ...empty, code: 'manual_archive_no_files', message: '没有选择任何文件。' };
  }

  // 1) 先把全部候选读进内存并校验，任何一个不合格都不落盘（不产生部分副本）。
  const staged: { source: string; data: Buffer; detected: DetectedFormat; hash: string }[] = [];
  for (const source of input.sources) {
    let data: Buffer;
    try {
      const stat = fs.statSync(source);
      if (!stat.isFile()) {
        return { ...empty, code: 'manual_archive_not_a_file', message: `「${path.basename(source)}」不是一个文件。` };
      }
      if (stat.size === 0) {
        return { ...empty, code: 'manual_archive_empty_file', message: `「${path.basename(source)}」是空文件，无法归档。` };
      }
      if (stat.size > MAX_FILE_BYTES) {
        return {
          ...empty,
          code: 'manual_archive_too_large',
          message: `「${path.basename(source)}」超过 64 MB，无法归档。`,
        };
      }
      data = fs.readFileSync(source);
    } catch (err) {
      return {
        ...empty,
        code: 'manual_archive_unreadable',
        message: `无法读取「${path.basename(source)}」，请确认文件仍然存在且可访问。`,
        detail: sanitizeText(err instanceof Error ? err.message : String(err)),
      };
    }
    const detected = detectFormat(data);
    if (!detected) {
      return {
        ...empty,
        code: 'manual_archive_unsupported_format',
        message: `「${path.basename(source)}」不是支持的发票文件（仅支持 PDF、OFD 和常见图片）。`,
      };
    }
    staged.push({ source, data, detected, hash: contentHash(data) });
  }

  // 2) 读取台账与队列的当前内容，作为回滚快照和去重依据。
  const ledgerSnap = snapshot(input.ledgerCsv);
  const queueSnap = snapshot(input.ocrPendingCsv);
  const ledgerRows = ledgerSnap.existed ? bodyRows(ledgerSnap.content) : [];
  const queueRows = queueSnap.existed ? bodyRows(queueSnap.content) : [];
  const ledgerSeen = new Set(ledgerRows.map((row) => `${row[0] ?? ''}\0${row[6] ?? ''}`));
  const queueSeen = new Set(queueRows.map((row) => `${row[0] ?? ''}\0${row[11] ?? ''}`));

  const pending = input.pendingRow ?? {};
  const messageId = pending.messageId ?? '';
  const date = pending.date ?? '';
  const from = pending.from ?? '';
  const subject = pending.subject ?? '';

  const installed: string[] = [];
  const archived: ManualArchiveFile[] = [];
  const duplicates: string[] = [];
  const stagingDir = path.join(input.invoicesDir, '.staging', `manual-${input.hash || 'unknown'}-${randomBytes(3).toString('hex')}`);

  try {
    fs.mkdirSync(input.invoicesDir, { recursive: true });
    fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });

    // 3) 先写 staging，再用 COPYFILE_EXCL 原子安装到最终名字。
    for (const item of staged) {
      if (queueSeen.has(`${input.hash}\0${item.hash}`)) {
        duplicates.push(path.basename(item.source));
        continue;
      }
      const stagingPath = path.join(stagingDir, `${archived.length}.${item.detected.ext}`);
      fs.writeFileSync(stagingPath, item.data, { mode: 0o600 });

      let filename = '';
      for (let attempt = 0; attempt < 50; attempt++) {
        const candidate = nextNumberedName(input.invoicesDir, item.detected.ext);
        const finalPath = path.join(input.invoicesDir, candidate);
        try {
          fs.copyFileSync(stagingPath, finalPath, fs.constants.COPYFILE_EXCL);
          filename = candidate;
          installed.push(finalPath);
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        }
      }
      if (!filename) throw new Error('failed to allocate a unique filename in the invoices directory');
      fs.rmSync(stagingPath, { force: true });

      const source = path.basename(item.source);
      archived.push({ filename, contentHash: item.hash, format: item.detected.format });

      if (!ledgerSeen.has(`${messageId}\0${item.hash}`)) {
        ledgerRows.push([messageId, date, from, subject, filename, source, item.hash]);
        ledgerSeen.add(`${messageId}\0${item.hash}`);
      }
      queueRows.push([
        input.hash, messageId, date, from, subject, filename,
        source, item.detected.format, 'invoice', 'pending', 'manual_archive', item.hash,
      ]);
      queueSeen.add(`${input.hash}\0${item.hash}`);
    }

    if (archived.length === 0) {
      // 全部文件都已经归档过：不改台账/队列，也不动 pending 行。
      return {
        ok: false,
        code: 'manual_archive_all_duplicates',
        message: '选择的文件都已经归档过了，没有新增内容。',
        files: [],
        duplicates,
        pendingRemoved: 0,
      };
    }

    // 4) 台账与队列都用「整表原子替换」写入，杜绝半截追加。
    writeFileAtomic(input.ledgerCsv, renderCsv(LEDGER_HEADER, ledgerRows));
    writeFileAtomic(input.ocrPendingCsv, renderCsv(QUEUE_HEADER, queueRows));
  } catch (err) {
    // 回滚：删掉已安装的副本，恢复台账与队列。
    for (const file of installed) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // best-effort
      }
    }
    restore(ledgerSnap);
    restore(queueSnap);
    return {
      ...empty,
      code: 'manual_archive_failed',
      message: '归档没有完成，已撤销本次改动，请检查归档目录是否可写后重试。',
      detail: sanitizeText(err instanceof Error ? err.message : String(err)),
      duplicates,
    };
  } finally {
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }

  // 5) 只有前面全部成功，才移除 pending 行；这一步失败不撤销归档，仅上报告警。
  let pendingRemoved = 0;
  let warning: string | undefined;
  try {
    pendingRemoved = input.removePendingRow();
  } catch (err) {
    warning = sanitizeText(err instanceof Error ? err.message : String(err));
  }

  return {
    ok: true,
    files: archived,
    duplicates,
    pendingRemoved,
    ...(warning ? { code: 'manual_archive_pending_not_updated', detail: warning, message: '文件已归档并加入识别队列，但待确认记录没有移除，可稍后手动忽略。' } : {}),
  };
}
