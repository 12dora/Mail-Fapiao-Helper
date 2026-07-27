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

function finalizeNumbered(stagingPath: string, invoicesDir: string, ext: ArtifactExt): string {
  while (true) {
    const finalPath = nextNumberedPath(invoicesDir, ext);
    try {
      fs.copyFileSync(stagingPath, finalPath, fs.constants.COPYFILE_EXCL);
      hardenPath(finalPath, FILE_MODE);
      return finalPath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

/**
 * Copy staging -> a named target, appending -1/-2 on collision. Uses an atomic
 * exclusive create (COPYFILE_EXCL) rather than existsSync+rename so two workers
 * racing on the same suggested name can never silently overwrite each other.
 */
function finalizeNamed(stagingPath: string, targetPath: string): string {
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  let candidate = targetPath;
  let counter = 0;
  while (true) {
    try {
      fs.copyFileSync(stagingPath, candidate, fs.constants.COPYFILE_EXCL);
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
}

/**
 * 一批文档的归档事务（APP-03）。
 *
 * `stageDocuments()` 先把整批写进唯一事务目录，`commit()` 才把它们逐个原子搬到
 * 最终目录并返回结果，`rollback()` 会删掉本批次已经提交的最终文件和 staging 目录。
 * 调用方必须在 CSV / OCR 队列全部写入成功之后才认为归档完成。
 */
export interface ArchiveBatch {
  /** 本批次需要新建文件的文档数量（不含幂等复用的条目）。 */
  readonly pending: number;
  /** 原子提交整批；返回结果按输入顺序排列。失败时自动回滚并抛出。 */
  commit(): DownloadResult[];
  /** 回滚：删除本批次已落盘的最终文件与 staging 目录。 */
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

  const committed: string[] = [];

  const rollback = (): void => {
    for (const filePath of committed.splice(0)) {
      try {
        fs.rmSync(filePath, { force: true });
        log.warn(`Rolled back archived file ${filePath}`);
      } catch (err) {
        log.warn(`Rollback failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    removeStagingDir(stagingDir);
  };

  const commit = (): DownloadResult[] => {
    const results: DownloadResult[] = [...reused];
    try {
      for (const item of staged) {
        const finalPath = opts.avoidConflictBeforeOcr === false
          ? finalizeNamed(item.stagingPath, path.join(invoicesDir, item.targetName))
          : finalizeNumbered(item.stagingPath, invoicesDir, item.ext);
        committed.push(finalPath);
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
