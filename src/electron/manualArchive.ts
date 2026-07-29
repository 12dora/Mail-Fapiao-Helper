import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { csvCell, parseCsv } from '../util/csv.js';
import { contentHash } from '../util/hash.js';
import { ArchiveRecoveryError, assertArchiveTransactionsRecovered, beginArchiveTransaction } from '../download/archiveJournal.js';
import { sanitizeText } from './sanitize.js';
import { testFaultEnabled } from '../util/testFaults.js';

/**
 * 「选择文件归档」的事务化实现（APP-04 / OCR-05 / ELEC-09 / ELEC-10）。
 *
 * 与自动归档共用持久事务日志：先写入同卷 staging，再 hard-link 安装到最终路径，
 * journal 带 stagingPath 以便崩溃恢复能证明文件归属。同批 contentHash 去重；
 * 读取前限制文件数与累计字节，避免主进程被超大批次拖垮。
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
   * 只有归档台账和 OCR 队列都提交成功之后才会被调用。
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
/** 单批最多文件数（ELEC-10）。 */
const MAX_BATCH_FILES = 32;
/** 单批累计字节上限（ELEC-10）：约 256 MB。 */
const MAX_BATCH_BYTES = 256 * 1024 * 1024;

const LEDGER_HEADER = ['messageId', 'date', 'from', 'subject', 'filename', 'source', 'contentHash'];
const QUEUE_HEADER = [
  'hash', 'messageId', 'date', 'from', 'subject', 'filename',
  'source', 'format', 'documentType', 'status', 'reason', 'contentHash',
];
/** 组合键分隔符：用转义序列书写，源码里不会出现真实的 0x00 字节。 */
const SEP = '\u0000';

// ---------------------------------------------------------------------------
// 格式判定
// ---------------------------------------------------------------------------

type DetectResult =
  | { kind: 'ok'; format: ArchiveFormat; ext: string }
  /** PK 容器，但不是 OFD 包（就是一个普通压缩包）。 */
  | { kind: 'archive' }
  | { kind: 'unknown' };

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
/** 只读中央目录文件名，不解压任何条目；上限防止畸形包把主进程拖住。 */
const MAX_ZIP_ENTRIES = 2000;

/**
 * 只解析 ZIP 中央目录里的**文件名**（不解压、不分配 entry 数据），用来判断这个 PK
 * 容器到底是 OFD 包还是普通压缩包。刻意不使用 `adm-zip`：APP-09 记录了它可达的
 * 4GB 分配 DoS，而这里只需要读几个定长字段。
 */
function zipEntryNames(data: Buffer): string[] | undefined {
  const maxBack = Math.min(data.length, 66 * 1024);
  let eocd = -1;
  for (let i = data.length - 22; i >= data.length - maxBack && i >= 0; i--) {
    if (data.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0 || eocd + 20 > data.length) return undefined;
  const count = data.readUInt16LE(eocd + 10);
  const cdOffset = data.readUInt32LE(eocd + 16);
  // 0xFFFFFFFF 表示 ZIP64，这里不支持；返回 undefined 让调用方按「无法确认」处理。
  if (cdOffset === 0xFFFFFFFF || cdOffset >= data.length) return undefined;

  const names: string[] = [];
  let p = cdOffset;
  for (let i = 0; i < Math.min(count, MAX_ZIP_ENTRIES); i++) {
    if (p + 46 > data.length) return undefined;
    if (data.readUInt32LE(p) !== CENTRAL_HEADER_SIGNATURE) return undefined;
    const nameLen = data.readUInt16LE(p + 28);
    const extraLen = data.readUInt16LE(p + 30);
    const commentLen = data.readUInt16LE(p + 32);
    const nameStart = p + 46;
    if (nameStart + nameLen > data.length) return undefined;
    names.push(data.subarray(nameStart, nameStart + nameLen).toString('utf8'));
    p = nameStart + nameLen + extraLen + commentLen;
  }
  return names;
}

/** OFD 包必须在根目录带 `OFD.xml`（GB/T 33190）。没有它的 PK 容器就是普通压缩包。 */
function looksLikeOfdPackage(data: Buffer): boolean {
  const names = zipEntryNames(data);
  if (!names) return false;
  return names.some((name) => name.replace(/^[./\\]+/, '').toLowerCase() === 'ofd.xml');
}

/** 只按 magic bytes（以及 OFD 的必需结构）判定格式，不相信用户文件的扩展名。 */
function detectFormat(data: Buffer): DetectResult {
  if (data.subarray(0, 4).toString('ascii') === '%PDF') return { kind: 'ok', format: 'pdf', ext: 'pdf' };
  if (data.subarray(0, 2).toString('ascii') === 'PK') {
    // 复核指出的问题：旧实现把任意 PK 容器都当成 OFD，用户选一个普通 ZIP 会被
    // 改名成 NNNN.ofd 塞进识别队列，OCR 拿到的是无效 OFD。
    return looksLikeOfdPackage(data) ? { kind: 'ok', format: 'ofd', ext: 'ofd' } : { kind: 'archive' };
  }
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { kind: 'ok', format: 'image', ext: 'png' };
  }
  if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return { kind: 'ok', format: 'image', ext: 'jpg' };
  if (data.subarray(0, 4).toString('ascii') === 'GIF8') return { kind: 'ok', format: 'image', ext: 'gif' };
  if (data.subarray(0, 2).toString('ascii') === 'BM') return { kind: 'ok', format: 'image', ext: 'bmp' };
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { kind: 'ok', format: 'image', ext: 'webp' };
  }
  return { kind: 'unknown' };
}

// ---------------------------------------------------------------------------
// CSV 追加（与自动归档一致：只 append，回滚靠 journal 截断回 baseLength）
// ---------------------------------------------------------------------------

function ensureCsvHeader(file: string, header: string[]): void {
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // UTF-8 BOM 与 CLI 写出的台账保持一致，Excel 才能正确显示中文。
  fs.writeFileSync(file, `\uFEFF${header.map(csvCell).join(',')}\n`, { encoding: 'utf8', mode: 0o600 });
}

function csvLine(values: string[]): string {
  return `${values.map(csvCell).join(',')}\n`;
}

function bodyRows(file: string): string[][] {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return parseCsv(text).slice(1);
}

/**
 * 一次性规划整批文件的最终名字。逐个调用「找下一个空号」会让同一批里的多个文件
 * 拿到同一个名字，因此这里统一扫描并在内存里占位。
 */
function planNumberedNames(dir: string, exts: string[]): string[] {
  const taken = new Set<string>();
  try {
    for (const entry of fs.readdirSync(dir)) taken.add(entry.toLowerCase());
  } catch {
    // 目录还不存在，等价于没有任何占用。
  }
  const out: string[] = [];
  let counter = 1;
  for (const ext of exts) {
    let name = '';
    while (counter < 100000) {
      const candidate = `${String(counter).padStart(4, '0')}.${ext}`;
      counter++;
      if (taken.has(candidate.toLowerCase())) continue;
      taken.add(candidate.toLowerCase());
      name = candidate;
      break;
    }
    if (!name) throw new Error('invoices directory is full of numbered files');
    out.push(name);
  }
  return out;
}

function removeDirQuietly(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------

interface StagedSource {
  source: string;
  data: Buffer;
  format: ArchiveFormat;
  ext: string;
  hash: string;
}

export function runManualArchive(input: ManualArchiveInput): ManualArchiveResult {
  const empty: ManualArchiveResult = { ok: false, files: [], duplicates: [], pendingRemoved: 0 };
  if (input.sources.length === 0) {
    return { ...empty, code: 'manual_archive_no_files', message: '没有选择任何文件。' };
  }
  if (input.sources.length > MAX_BATCH_FILES) {
    return {
      ...empty,
      code: 'manual_archive_too_many_files',
      message: `一次最多选择 ${MAX_BATCH_FILES} 个文件，请分批归档。`,
    };
  }

  // ELEC-10：读取前先 stat，限制累计字节，避免同步读入超大批次冻结主进程。
  let totalBytes = 0;
  for (const source of input.sources) {
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
      totalBytes += stat.size;
      if (totalBytes > MAX_BATCH_BYTES) {
        return {
          ...empty,
          code: 'manual_archive_batch_too_large',
          message: '所选文件合计超过 256 MB，请减少文件数量后分批归档。',
        };
      }
    } catch (err) {
      return {
        ...empty,
        code: 'manual_archive_unreadable',
        message: `无法读取「${path.basename(source)}」，请确认文件仍然存在且可访问。`,
        detail: sanitizeText(err instanceof Error ? err.message : String(err)),
      };
    }
  }

  // 1) 读入并校验格式；任何一个不合格都不落盘。
  const staged: StagedSource[] = [];
  for (const source of input.sources) {
    let data: Buffer;
    try {
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
    if (detected.kind === 'archive') {
      return {
        ...empty,
        code: 'manual_archive_is_zip',
        message: `「${path.basename(source)}」是一个压缩包，不是发票文件。请先解压，再选择里面的 PDF 或 OFD 文件。`,
      };
    }
    if (detected.kind !== 'ok') {
      return {
        ...empty,
        code: 'manual_archive_unsupported_format',
        message: `「${path.basename(source)}」不是支持的发票文件（仅支持 PDF、OFD 和常见图片）。`,
      };
    }
    staged.push({ source, data, format: detected.format, ext: detected.ext, hash: contentHash(data) });
  }

  // ELEC-09：同批按 contentHash 去重，只保留第一个来源。
  const batchSeen = new Set<string>();
  const uniqueStaged: StagedSource[] = [];
  const batchDuplicates: string[] = [];
  for (const item of staged) {
    const key = `${input.hash}${SEP}${item.hash}`;
    if (batchSeen.has(key)) {
      batchDuplicates.push(path.basename(item.source));
      continue;
    }
    batchSeen.add(key);
    uniqueStaged.push(item);
  }

  assertArchiveTransactionsRecovered(input.invoicesDir);

  // 2) 读取台账与队列现状，做去重与「半提交修复」判定。
  const ledgerFilenameByKey = new Map<string, string>();
  for (const row of bodyRows(input.ledgerCsv)) {
    ledgerFilenameByKey.set(`${row[0] ?? ''}${SEP}${row[6] ?? ''}`, row[4] ?? '');
  }
  const queueSeen = new Set(bodyRows(input.ocrPendingCsv).map((row) => `${row[0] ?? ''}${SEP}${row[11] ?? ''}`));

  const pending = input.pendingRow ?? {};
  const messageId = pending.messageId ?? '';
  const date = pending.date ?? '';
  const from = pending.from ?? '';
  const subject = pending.subject ?? '';

  const duplicates: string[] = [...batchDuplicates];
  const toInstall: StagedSource[] = [];
  /** 台账已有、队列缺失：复用台账里的文件名补队列行，绝不再装一个新文件。 */
  const toReuse: { item: StagedSource; filename: string }[] = [];
  /** 本批已决定安装/复用的 contentHash，防止同批后续再装一次。 */
  const installSeen = new Set<string>();

  for (const item of uniqueStaged) {
    const queueKey = `${input.hash}${SEP}${item.hash}`;
    if (queueSeen.has(queueKey) || installSeen.has(queueKey)) {
      duplicates.push(path.basename(item.source));
      continue;
    }
    const ledgerFilename = ledgerFilenameByKey.get(`${messageId}${SEP}${item.hash}`);
    if (ledgerFilename && fs.existsSync(path.join(input.invoicesDir, ledgerFilename))) {
      toReuse.push({ item, filename: ledgerFilename });
      installSeen.add(queueKey);
      continue;
    }
    toInstall.push(item);
    installSeen.add(queueKey);
  }

  if (toInstall.length === 0 && toReuse.length === 0) {
    return {
      ok: false,
      code: 'manual_archive_all_duplicates',
      message: '选择的文件都已经归档过了，没有新增内容。',
      files: [],
      duplicates,
      pendingRemoved: 0,
    };
  }

  // 3) 规划最终文件名与 CSV 追加基线；先写 staging 再开 journal（OCR-05）。
  let plannedNames: string[];
  let ledgerBase: number;
  let queueBase: number;
  let stagingDir: string;
  const stagingPaths: string[] = [];
  try {
    fs.mkdirSync(input.invoicesDir, { recursive: true });
    plannedNames = planNumberedNames(input.invoicesDir, toInstall.map((item) => item.ext));
    ensureCsvHeader(input.ledgerCsv, LEDGER_HEADER);
    ensureCsvHeader(input.ocrPendingCsv, QUEUE_HEADER);
    ledgerBase = fs.statSync(input.ledgerCsv).size;
    queueBase = fs.statSync(input.ocrPendingCsv).size;

    stagingDir = path.join(
      input.invoicesDir,
      '.staging',
      `manual-${input.hash.slice(0, 12)}-${process.pid.toString(36)}-${randomBytes(4).toString('hex')}`,
    );
    fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
    for (let i = 0; i < toInstall.length; i++) {
      const item = toInstall[i];
      if (!item) throw new Error('archive plan mismatch');
      const stagingPath = path.join(stagingDir, `${i}.${item.ext}`);
      fs.writeFileSync(stagingPath, item.data, { mode: 0o600 });
      stagingPaths.push(stagingPath);
    }
  } catch (err) {
    return {
      ...empty,
      code: 'manual_archive_prepare_failed',
      message: '无法准备归档目录，请确认归档位置可写后重试。',
      detail: sanitizeText(err instanceof Error ? err.message : String(err)),
      duplicates,
    };
  }

  const plannedPaths = plannedNames.map((name) => path.join(input.invoicesDir, name));
  const plannedFiles = plannedPaths.map((finalPath, i) => ({
    path: finalPath,
    stagingPath: stagingPaths[i],
    stagingDir,
  }));

  const tx = beginArchiveTransaction(input.invoicesDir, {
    files: plannedFiles,
    csv: [
      { path: input.ledgerCsv, baseLength: ledgerBase },
      { path: input.ocrPendingCsv, baseLength: queueBase },
    ],
    stagingDir,
  });

  const archived: ManualArchiveFile[] = [];
  try {
    // 4) hard-link 安装：与自动归档一致，prepared 阶段可用 inode 证明归属（OCR-05）。
    for (let i = 0; i < toInstall.length; i++) {
      const item = toInstall[i];
      const target = plannedPaths[i];
      const stagingPath = stagingPaths[i];
      const name = plannedNames[i];
      if (!item || !target || !stagingPath || !name) throw new Error('archive plan mismatch');
      // 与自动归档一致：只用 hard-link。prepared 阶段恢复依赖 staging/final 同 inode
      // 证明归属；copy 无法证明，故不回退（OCR-05）。
      fs.linkSync(stagingPath, target);
      archived.push({ filename: name, contentHash: item.hash, format: item.format });
    }
    tx.markStage('files-installed');

    // 5) 先追加 OCR 队列，再追加台账（台账最后 → ledger-committed 才表示全部完成）。
    const queueLines = [
      ...toInstall.map((item, i) => csvLine([
        input.hash, messageId, date, from, subject, plannedNames[i] ?? '',
        path.basename(item.source), item.format, 'invoice', 'pending', 'manual_archive', item.hash,
      ])),
      ...toReuse.map(({ item, filename }) => csvLine([
        input.hash, messageId, date, from, subject, filename,
        path.basename(item.source), item.format, 'invoice', 'pending', 'manual_archive_repair', item.hash,
      ])),
    ];
    fs.appendFileSync(input.ocrPendingCsv, queueLines.join(''), 'utf8');
    if (testFaultEnabled('MFH_TEST_FAIL_AFTER_MANUAL_QUEUE_CSV')) {
      throw new Error('forced_after_manual_queue_csv_failure');
    }

    // 6) 追加台账（只为本次真正新装的文件）。
    const ledgerLines = toInstall.map((item, i) => csvLine([
      messageId, date, from, subject, plannedNames[i] ?? '', path.basename(item.source), item.hash,
    ]));
    if (ledgerLines.length > 0) fs.appendFileSync(input.ledgerCsv, ledgerLines.join(''), 'utf8');
    tx.markStage('ledger-committed');
    tx.commit();
  } catch (err) {
    try {
      tx.rollback();
    } catch (rollbackErr) {
      if (rollbackErr instanceof ArchiveRecoveryError) throw rollbackErr;
      throw err;
    } finally {
      removeDirQuietly(stagingDir);
    }
    return {
      ...empty,
      code: 'manual_archive_failed',
      message: '归档没有完成，已撤销本次改动，请检查归档目录是否可写后重试。',
      detail: sanitizeText(err instanceof Error ? err.message : String(err)),
      duplicates,
    };
  }

  for (const { item, filename } of toReuse) {
    archived.push({ filename, contentHash: item.hash, format: item.format });
  }

  // 7) 只有台账与队列都提交成功，才移除 pending 行；这一步失败不撤销归档，仅上报告警。
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
    ...(warning
      ? {
        code: 'manual_archive_pending_not_updated',
        detail: warning,
        message: '文件已归档并加入识别队列，但待确认记录没有移除，可稍后手动忽略。',
      }
      : {}),
  };
}
