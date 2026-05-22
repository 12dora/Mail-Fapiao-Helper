import fs from 'node:fs';
import path from 'node:path';
import type { DocumentFormat, PdfArtifact } from '../extract/types.js';
import { withDocumentClassification } from '../extract/classify.js';
import type { Logger } from '../log.js';

export interface DownloadResult {
  finalPath: string;
  filename: string;
  format: DocumentFormat;
  documentType: NonNullable<PdfArtifact['documentType']>;
  requiresOcr: boolean;
}

export interface DownloadOptions {
  avoidConflictBeforeOcr?: boolean;
}

type ArtifactExt = 'pdf' | 'ofd' | 'png' | 'jpg' | 'jpeg' | 'gif' | 'webp' | 'bmp';

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

function safeFilename(name: string, fallback: string, ext: ArtifactExt): string {
  const base = path.basename(name)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  const cleaned = base.length > 0 ? base : fallback;
  return path.extname(cleaned).length > 0 ? cleaned : `${cleaned}.${ext}`;
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
      fs.unlinkSync(stagingPath);
      return finalPath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function resolveConflict(targetPath: string): string {
  if (!fs.existsSync(targetPath)) return targetPath;

  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);

  let counter = 1;
  while (true) {
    const candidate = path.join(dir, `${base}-${counter}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
    counter++;
  }
}

export async function downloadPdfs(
  pdfs: PdfArtifact[],
  msgIdHash: string,
  invoicesDir: string,
  log: Logger,
  opts: DownloadOptions = {},
): Promise<DownloadResult[]> {
  const stagingDir = path.join(invoicesDir, '.staging', msgIdHash);
  ensureDir(stagingDir);

  const results: DownloadResult[] = [];

  for (let i = 0; i < pdfs.length; i++) {
    const raw = pdfs[i];
    if (!raw) continue;

    const ext = artifactExt(raw);
    const pdf = normalizeArtifact(raw, ext);
    const stagingPath = path.join(stagingDir, `${i}.${ext}`);

    fs.writeFileSync(stagingPath, pdf.data);
    log.debug(`Staged ${pdf.source} -> ${stagingPath}`);

    const finalPath = opts.avoidConflictBeforeOcr === false
      ? resolveConflict(path.join(invoicesDir, safeFilename(
          pdf.suggestedName || `${msgIdHash}-${i}.${ext}`,
          `${msgIdHash}-${i}.${ext}`,
          ext,
        )))
      : finalizeNumbered(stagingPath, invoicesDir, ext);

    if (opts.avoidConflictBeforeOcr === false) fs.renameSync(stagingPath, finalPath);
    log.debug(`Finalized ${stagingPath} -> ${finalPath}`);

    results.push({
      finalPath,
      filename: path.basename(finalPath),
      format: pdf.format ?? formatForExt(ext),
      documentType: pdf.documentType ?? 'invoice',
      requiresOcr: pdf.requiresOcr ?? true,
    });
  }

  try {
    fs.rmdirSync(stagingDir);
  } catch {
    // ignore
  }

  return results;
}

export const downloadDocuments = downloadPdfs;
