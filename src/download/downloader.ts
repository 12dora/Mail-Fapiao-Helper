import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { DocumentFormat, PdfArtifact } from '../extract/types.js';
import { withDocumentClassification } from '../extract/classify.js';
import { contentHash } from '../util/hash.js';
import type { Logger } from '../log.js';
import type { ArchivePlannedFile } from './archiveJournal.js';

export interface DownloadResult {
  /** 对应输入 `pdfs` 数组的下标：批次里可能有条目被复用/跳过，不能按顺序配对。 */
  sourceIndex: number;
  finalPath: string;
  filename: string;
  format: DocumentFormat;
  documentType: NonNullable<PdfArtifact['documentType']>;
  requiresOcr: boolean;
  contentHash: string;
  /** true 表示命中幂等协调，文件本来就已归档，本次没有新建文件。 */
  reused: boolean;
}

export interface DownloadOptions {
  avoidConflictBeforeOcr?: boolean;
  /**
   * 幂等协调（APP-03）：contentHash -> 已归档的最终文件名。命中的 artifact 会被
   * 跳过归档并直接复用既有文件，`--force` / `--only-mail` 重跑因此不会再产生
   * `-1/-2` 碰撞副本。
   */
  alreadyArchived?: Map<string, string>;
}

type ArtifactExt = 'pdf' | 'ofd' | 'png' | 'jpg' | 'jpeg' | 'gif' | 'webp' | 'bmp';

/** POSIX 权限：敏感文件 0600、目录 0700；Windows 上 chmod 语义不同，直接跳过。 */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** 按「目录 + 扩展名」缓存编号 high-water，避免每次从 0001 同步扫描（OCR-14）。 */
const numberedHighWater = new Map<string, number>();

function isPosix(): boolean {
  return process.platform !== 'win32';
}

/** 收紧文件/目录权限。失败只记为最佳努力，不应让归档整体失败（APP-22）。 */
function hardenPath(target: string, mode: number): void {
  if (!isPosix()) return;
  try {
    fs.chmodSync(target, mode);
  } catch {
    // 网络盘 / 非 POSIX 文件系统不支持 chmod，忽略。
  }
}

/**
 * 创建目录并在 POSIX 上收紧到 0700。只收紧“本次由我们创建”的目录：用户可能把
 * 归档路径指到已有的共享目录，不应该在背后修改它原有的权限（APP-22）。
 */
export function ensureSecureDir(dir: string): void {
  if (fs.existsSync(dir)) return;
  fs.mkdirSync(dir, { recursive: true, mode: isPosix() ? DIR_MODE : undefined });
  hardenPath(dir, DIR_MODE);
}

function imageExtFromName(name: string | undefined): Exclude<ArtifactExt, 'pdf' | 'ofd'> | undefined {
  const match = name?.toLowerCase().match(/\.((?:jpe?g)|png|gif|webp|bmp)$/);
  return match?.[1] as Exclude<ArtifactExt, 'pdf' | 'ofd'> | undefined;
}

function artifactExt(artifact: PdfArtifact): ArtifactExt {
  if (artifact.data.subarray(0, 4).toString('ascii') === '%PDF') return 'pdf';
  if (artifact.data.subarray(0, 2).toString('ascii') === 'PK') return 'ofd';
  if (artifact.format === 'ofd') return 'ofd';
  if (artifact.format === 'image') return imageExtFromName(artifact.suggestedName) ?? imageExtFromName(artifact.source) ?? 'png';
  if (artifact.suggestedName?.toLowerCase().endsWith('.ofd')) return 'ofd';
  if (artifact.source.toLowerCase().endsWith('.ofd')) return 'ofd';
  return 'pdf';
}

function formatForExt(ext: ArtifactExt): DocumentFormat {
  if (ext === 'ofd') return 'ofd';
  if (ext === 'pdf') return 'pdf';
  return 'image';
}

function normalizeArtifact(artifact: PdfArtifact, ext: ArtifactExt): PdfArtifact {
  const format = formatForExt(ext);
  return withDocumentClassification({ ...artifact, format }, format);
}

/** 会被规范扩展名替换掉的已知文档/文本扩展名（APP-12）。 */
const REPLACEABLE_EXT = /\.(pdf|ofd|zip|xml|ofdx|png|jpe?g|gif|webp|bmp|txt|htm|html|bin|dat)$/i;

/**
 * 最终文件名 = 清洗后的 stem + 由 magic bytes 决定的规范扩展名。
 *
 * 此前 `safeFilename()` 保留建议名里已有的扩展名，于是 OFD 字节会被存成
 * `invoice.pdf`，而返回的 metadata 却是 `ofd`，外部工具与内部记录互相矛盾（APP-12）。
 */
function finalFilename(name: string, fallbackStem: string, ext: ArtifactExt): string {
  const base = path.basename(name)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  const source = base.length > 0 ? base : fallbackStem;
  // 只替换“已知文档扩展名”，避免把 `账单2024.01.15` 的日期尾巴当成扩展名剥掉。
  const stem = source.replace(REPLACEABLE_EXT, '').trim();
  const finalStem = stem.length > 0 ? stem : fallbackStem;
  return `${finalStem}.${ext}`;
}

function highWaterKey(dir: string, ext: ArtifactExt): string {
  return `${path.resolve(dir)}\0${ext}`;
}

/**
 * 首次使用某扩展名时扫描目录，找出当前最大编号；之后只从 high-water 向前走（OCR-14）。
 * 碰到洞或外部新建文件时 existsSync 会向前校正。
 */
function initialHighWater(dir: string, ext: ArtifactExt): number {
  let max = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const re = new RegExp(`^(\\d{4,})\\.${ext}$`, 'i');
  for (const name of entries) {
    const m = name.match(re);
    if (!m) continue;
    const n = Number.parseInt(m[1]!, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

function nextNumberedPath(dir: string, ext: ArtifactExt, reserved: Set<string>): string {
  const key = highWaterKey(dir, ext);
  let counter = numberedHighWater.get(key);
  if (counter === undefined) {
    counter = initialHighWater(dir, ext);
  }
  // 从 high-water 的下一个开始；若撞 reserved/磁盘则继续向前。
  counter = Math.max(0, counter) + 1;
  while (true) {
    const candidate = `${String(counter).padStart(4, '0')}.${ext}`;
    const candidatePath = path.join(dir, candidate);
    const reservedKey = candidatePath.toLowerCase();
    if (!reserved.has(reservedKey) && !fs.existsSync(candidatePath)) {
      reserved.add(reservedKey);
      numberedHighWater.set(key, counter);
      return candidatePath;
    }
    counter++;
  }
}

/**
 * 只规划编号文件名，不触碰最终目录。
 * journal 必须先于任何 final path mutation 落盘；真正创建在 commit() 内用独占
 * hard-link / copy 完成，若中途撞名则整批事务化失败。
 */
function planNumbered(invoicesDir: string, ext: ArtifactExt, reserved: Set<string>): string {
  return nextNumberedPath(invoicesDir, ext, reserved);
}

/** 规划一个具名目标，冲突时追加 -1/-2；不创建最终文件。 */
function planNamed(targetPath: string, reserved: Set<string>): string {
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  let candidate = targetPath;
  let counter = 0;
  while (true) {
    const key = candidate.toLowerCase();
    if (!reserved.has(key) && !fs.existsSync(candidate)) {
      reserved.add(key);
      return candidate;
    }
    counter++;
    candidate = path.join(dir, `${base}-${counter}${ext}`);
  }
}

interface StagedDocument {
  index: number;
  stagingPath: string;
  ext: ArtifactExt;
  targetName: string;
  artifact: PdfArtifact;
  contentHash: string;
  /** `plan()` 之后填入的最终路径。 */
  finalPath?: string;
}

/**
 * 一批文档的归档事务（APP-03）。
 *
 * 使用顺序固定为 `plan() -> beginArchiveTransaction() -> commit() -> CSV 追加`：
 * `plan()` 只在内存中选择最终路径，不创建 0 字节占位；调用方先写出持久化 journal，
 * `commit()` 才在 active journal 下独占创建最终文件。这样 final archive 目录的第一
 * 次 mutation 一定发生在 durable journal 之后。
 */
export interface ArchiveBatch {
  /** 本批次需要新建文件的文档数量（不含幂等复用的条目）。 */
  readonly pending: number;
  /** 本批次 staging 目录绝对路径，应写入 journal 供崩溃恢复清理（OCR-07）。 */
  readonly stagingDir: string;
  /** 规划全部最终文件路径，返回给 archive journal 持久化。 */
  plan(): ArchivePlannedFile[];
  /** 在 active journal 下独占创建最终文件；返回结果按输入顺序排列。 */
  commit(): DownloadResult[];
  /** 回滚：删除能证明属于本批次的最终文件与 staging 目录。 */
  rollback(): void;
  /** 只清理 staging，不动最终文件。 */
  dispose(): void;
}

function removeStagingDir(stagingDir: string): void {
  try {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function isContainedInDir(target: string, base: string): boolean {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 幂等复用前校验：路径 containment、是普通文件、contentHash 仍匹配（OCR-08）。
 * 不匹配时返回 null，调用方应按本次 artifact 重新归档。
 */
function tryReuseArchived(
  invoicesDir: string,
  existingName: string,
  expectedHash: string,
  log: Logger,
): { path: string; filename: string } | null {
  // basename + containment：legacy/恶意 CSV 不得逃出归档目录。
  const leaf = path.basename(existingName);
  if (!leaf || leaf === '.' || leaf === '..') return null;
  const existingPath = path.join(invoicesDir, leaf);
  if (!isContainedInDir(existingPath, invoicesDir)) return null;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(existingPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) {
    log.warn(`Archived path is not a file, will re-archive: ${leaf}`);
    return null;
  }
  // 与 MAX_DOC_BYTES 对齐的合理上界；过大视为损坏映射。
  if (stat.size <= 0 || stat.size > 50 * 1024 * 1024) {
    log.warn(`Archived file size unreasonable (${stat.size}), will re-archive: ${leaf}`);
    return null;
  }

  let data: Buffer;
  try {
    data = fs.readFileSync(existingPath);
  } catch (err) {
    log.warn(`Failed to read archived file for hash check: ${leaf}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (data.length !== stat.size) {
    log.warn(`Archived file size changed during read, will re-archive: ${leaf}`);
    return null;
  }
  const actual = contentHash(data);
  if (actual !== expectedHash) {
    log.warn(`Archived contentHash mismatch for ${leaf}: expected=${expectedHash} actual=${actual}; will re-archive`);
    return null;
  }
  return { path: existingPath, filename: leaf };
}

interface ArchiveBatchState {
  invoicesDir: string;
  log: Logger;
  opts: DownloadOptions;
  stagingDir: string;
  reused: DownloadResult[];
  staged: StagedDocument[];
  plannedPaths: ArchivePlannedFile[];
}

function stageInputs(
  pdfs: PdfArtifact[],
  msgIdHash: string,
  state: ArchiveBatchState,
): void {
  for (let i = 0; i < pdfs.length; i++) {
    const raw = pdfs[i];
    if (!raw) continue;

    const ext = artifactExt(raw);
    const pdf = normalizeArtifact(raw, ext);
    const hash = contentHash(pdf.data);

    const existing = state.opts.alreadyArchived?.get(hash);
    if (existing) {
      const hit = tryReuseArchived(state.invoicesDir, existing, hash, state.log);
      if (hit) {
        state.log.debug(`Reusing archived document ${hit.filename} for ${pdf.source}`);
        state.reused.push({
          sourceIndex: i,
          finalPath: hit.path,
          filename: hit.filename,
          format: pdf.format ?? formatForExt(ext),
          documentType: pdf.documentType ?? 'invoice',
          requiresOcr: pdf.requiresOcr ?? true,
          contentHash: hash,
          reused: true,
        });
        continue;
      }
      // 映射损坏或不匹配：落入重新 staging/归档路径。
    }

    const stagingPath = path.join(state.stagingDir, `${i}.${ext}`);
    fs.writeFileSync(stagingPath, pdf.data, { mode: isPosix() ? FILE_MODE : undefined });
    hardenPath(stagingPath, FILE_MODE);
    state.log.debug(`Staged ${pdf.source} -> ${stagingPath}`);

    state.staged.push({
      index: i,
      stagingPath,
      ext,
      targetName: finalFilename(
        pdf.suggestedName || `${msgIdHash}-${i}`,
        `${msgIdHash}-${i}`,
        ext,
      ),
      artifact: pdf,
      contentHash: hash,
    });
  }
}

function rollbackBatch(state: ArchiveBatchState): void {
  for (const item of state.staged) {
    const filePath = item.finalPath;
    if (!filePath) continue;
    try {
      const finalStat = fs.statSync(filePath);
      const stagingStat = fs.statSync(item.stagingPath);
      if (finalStat.dev === stagingStat.dev && finalStat.ino === stagingStat.ino) {
        fs.rmSync(filePath, { force: true });
        state.log.warn(`Rolled back archived file ${filePath}`);
      }
    } catch (err) {
      state.log.warn(`Rollback failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  removeStagingDir(state.stagingDir);
}

function planBatch(state: ArchiveBatchState): ArchivePlannedFile[] {
  if (state.plannedPaths.length > 0) return state.plannedPaths.map((item) => ({ ...item }));
  const reserved = new Set<string>();
  for (const item of state.staged) {
    const finalPath = state.opts.avoidConflictBeforeOcr === false
      ? planNamed(path.join(state.invoicesDir, item.targetName), reserved)
      : planNumbered(state.invoicesDir, item.ext, reserved);
    item.finalPath = finalPath;
    state.plannedPaths.push({
      path: finalPath,
      stagingPath: item.stagingPath,
      stagingDir: state.stagingDir,
    });
  }
  return state.plannedPaths.map((item) => ({ ...item }));
}

function commitBatch(state: ArchiveBatchState): DownloadResult[] {
  if (state.plannedPaths.length === 0) planBatch(state);
  const results: DownloadResult[] = [...state.reused];
  try {
    for (const item of state.staged) {
      const finalPath = item.finalPath;
      if (!finalPath) throw new Error('archive_batch_not_planned');
      // 优先 hard-link staging -> final：若进程在 journal prepared 与
      // files-installed 之间被强杀，恢复可以用 inode 证明 final 属于本事务。
      try {
        fs.linkSync(item.stagingPath, finalPath);
      } catch (err) {
        // Do not fall back to copy. Prepared-stage recovery proves ownership
        // with the staging/final hard-link inode; a copied final file cannot be
        // distinguished from a raced-in writer before `files-installed` is
        // durably recorded.
        throw err;
      }
      hardenPath(finalPath, FILE_MODE);
      state.log.debug(`Finalized ${item.stagingPath} -> ${finalPath}`);

      results.push({
        sourceIndex: item.index,
        finalPath,
        filename: path.basename(finalPath),
        format: item.artifact.format ?? formatForExt(item.ext),
        documentType: item.artifact.documentType ?? 'invoice',
        requiresOcr: item.artifact.requiresOcr ?? true,
        contentHash: item.contentHash,
        reused: false,
      });
    }
  } catch (err) {
    // 提交中途失败：整批回滚，绝不留下“部分批次”。
    rollbackBatch(state);
    throw err;
  }
  results.sort((a, b) => a.sourceIndex - b.sourceIndex);
  return results;
}

export function stageDocuments(
  pdfs: PdfArtifact[],
  msgIdHash: string,
  invoicesDir: string,
  log: Logger,
  opts: DownloadOptions = {},
): ArchiveBatch {
  ensureSecureDir(invoicesDir);
  // 唯一事务目录：并发 worker / 多实例不会互相踩到同一个 staging 路径。
  const stagingDir = path.join(
    invoicesDir,
    '.staging',
    `${msgIdHash}-${process.pid.toString(36)}-${randomBytes(4).toString('hex')}`,
  );
  ensureSecureDir(path.dirname(stagingDir));
  ensureSecureDir(stagingDir);

  const state: ArchiveBatchState = {
    invoicesDir,
    log,
    opts,
    stagingDir,
    reused: [],
    staged: [],
    plannedPaths: [],
  };

  try {
    stageInputs(pdfs, msgIdHash, state);
  } catch (err) {
    removeStagingDir(stagingDir);
    throw err;
  }

  /** 已规划的最终路径。 */
  const rollback = (): void => rollbackBatch(state);

  const plan = (): ArchivePlannedFile[] => planBatch(state);

  const commit = (): DownloadResult[] => commitBatch(state);

  return {
    pending: state.staged.length,
    stagingDir,
    plan,
    commit,
    rollback,
    dispose: (): void => removeStagingDir(stagingDir),
  };
}

/** 兼容入口：暂存后立即提交，供不需要事务边界的调用方使用。 */
export async function downloadPdfs(
  pdfs: PdfArtifact[],
  msgIdHash: string,
  invoicesDir: string,
  log: Logger,
  opts: DownloadOptions = {},
): Promise<DownloadResult[]> {
  const batch = stageDocuments(pdfs, msgIdHash, invoicesDir, log, opts);
  try {
    return batch.commit();
  } finally {
    batch.dispose();
  }
}

export const downloadDocuments = downloadPdfs;
