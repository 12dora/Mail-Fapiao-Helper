import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { DocumentFormat, PdfArtifact } from '../extract/types.js';
import { withDocumentClassification } from '../extract/classify.js';
import { contentHash } from '../util/hash.js';
import type { Logger } from '../log.js';

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

function nextNumberedPath(dir: string, ext: ArtifactExt): string {
  let counter = 1;
  while (true) {
    const candidate = `${String(counter).padStart(4, '0')}.${ext}`;
    const candidatePath = path.join(dir, candidate);
    if (!fs.existsSync(candidatePath)) return candidatePath;
    counter++;
  }
}

/**
 * 独占创建一个空占位文件把最终路径“定下来”。
 *
 * 归档事务需要在写入任何内容之前就知道最终路径，才能把它们记进持久化 journal
 * （APP-03）。`wx` 是原子的独占创建，两个 worker 抢同一个建议名时不会互相覆盖，
 * 语义与原来的 `COPYFILE_EXCL` 一致。
 */
function reserveNumbered(invoicesDir: string, ext: ArtifactExt): string {
  while (true) {
    const finalPath = nextNumberedPath(invoicesDir, ext);
    try {
      fs.closeSync(fs.openSync(finalPath, 'wx', isPosix() ? FILE_MODE : undefined));
      hardenPath(finalPath, FILE_MODE);
      return finalPath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

/** 预留一个具名目标，冲突时追加 -1/-2。 */
function reserveNamed(targetPath: string): string {
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  let candidate = targetPath;
  let counter = 0;
  while (true) {
    try {
      fs.closeSync(fs.openSync(candidate, 'wx', isPosix() ? FILE_MODE : undefined));
      hardenPath(candidate, FILE_MODE);
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      counter++;
      candidate = path.join(dir, `${base}-${counter}${ext}`);
    }
  }
}

interface StagedDocument {
  index: number;
  stagingPath: string;
  ext: ArtifactExt;
  targetName: string;
  artifact: PdfArtifact;
  contentHash: string;
  /** `reserve()` 之后填入的最终路径。 */
  finalPath?: string;
}

/**
 * 一批文档的归档事务（APP-03）。
 *
 * 使用顺序固定为 `reserve() -> beginArchiveTransaction() -> commit() -> CSV 追加`：
 * `reserve()` 先用独占创建把全部最终路径定下来（0 字节占位），调用方据此写出
 * 持久化 journal，`commit()` 才把 staging 内容写进这些已预留的路径。这样即使进程
 * 在任一步被强杀，崩溃恢复也能凭 journal 找到并清掉半成品。
 */
export interface ArchiveBatch {
  /** 本批次需要新建文件的文档数量（不含幂等复用的条目）。 */
  readonly pending: number;
  /** 独占预留全部最终文件路径（0 字节占位），返回绝对路径列表。 */
  reserve(): string[];
  /** 把 staging 内容写入已预留的最终文件；返回结果按输入顺序排列。 */
  commit(): DownloadResult[];
  /** 回滚：删除本批次已预留/已落盘的最终文件与 staging 目录。 */
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

  const reused: DownloadResult[] = [];
  const staged: StagedDocument[] = [];

  try {
    for (let i = 0; i < pdfs.length; i++) {
      const raw = pdfs[i];
      if (!raw) continue;

      const ext = artifactExt(raw);
      const pdf = normalizeArtifact(raw, ext);
      const hash = contentHash(pdf.data);

      const existing = opts.alreadyArchived?.get(hash);
      if (existing) {
        const existingPath = path.join(invoicesDir, existing);
        if (fs.existsSync(existingPath)) {
          log.debug(`Reusing archived document ${existing} for ${pdf.source}`);
          reused.push({
            sourceIndex: i,
            finalPath: existingPath,
            filename: existing,
            format: pdf.format ?? formatForExt(ext),
            documentType: pdf.documentType ?? 'invoice',
            requiresOcr: pdf.requiresOcr ?? true,
            contentHash: hash,
            reused: true,
          });
          continue;
        }
      }

      const stagingPath = path.join(stagingDir, `${i}.${ext}`);
      fs.writeFileSync(stagingPath, pdf.data, { mode: isPosix() ? FILE_MODE : undefined });
      hardenPath(stagingPath, FILE_MODE);
      log.debug(`Staged ${pdf.source} -> ${stagingPath}`);

      staged.push({
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
  } catch (err) {
    removeStagingDir(stagingDir);
    throw err;
  }

  /** 已预留（可能还是 0 字节占位）的最终路径，回滚时全部删除。 */
  const reservedPaths: string[] = [];

  const rollback = (): void => {
    for (const filePath of reservedPaths.splice(0)) {
      try {
        fs.rmSync(filePath, { force: true });
        log.warn(`Rolled back archived file ${filePath}`);
      } catch (err) {
        log.warn(`Rollback failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    removeStagingDir(stagingDir);
  };

  const reserve = (): string[] => {
    if (reservedPaths.length > 0) return [...reservedPaths];
    try {
      for (const item of staged) {
        const finalPath = opts.avoidConflictBeforeOcr === false
          ? reserveNamed(path.join(invoicesDir, item.targetName))
          : reserveNumbered(invoicesDir, item.ext);
        item.finalPath = finalPath;
        reservedPaths.push(finalPath);
      }
    } catch (err) {
      rollback();
      throw err;
    }
    return [...reservedPaths];
  };

  const commit = (): DownloadResult[] => {
    if (reservedPaths.length === 0) reserve();
    const results: DownloadResult[] = [...reused];
    try {
      for (const item of staged) {
        const finalPath = item.finalPath;
        if (!finalPath) throw new Error('archive_batch_not_reserved');
        // 目标已由 reserve() 独占创建，这里只是把内容写进我们自己的文件。
        fs.copyFileSync(item.stagingPath, finalPath);
        hardenPath(finalPath, FILE_MODE);
        try {
          fs.unlinkSync(item.stagingPath);
        } catch {
          // staging 目录整体清理时会兜底。
        }
        log.debug(`Finalized ${item.stagingPath} -> ${finalPath}`);

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
      rollback();
      throw err;
    }
    removeStagingDir(stagingDir);
    results.sort((a, b) => a.sourceIndex - b.sourceIndex);
    return results;
  };

  return {
    pending: staged.length,
    reserve,
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
  return stageDocuments(pdfs, msgIdHash, invoicesDir, log, opts).commit();
}

export const downloadDocuments = downloadPdfs;
