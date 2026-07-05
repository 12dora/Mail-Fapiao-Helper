import fs from 'node:fs';
import path from 'node:path';
import type { DocumentFormat, PdfArtifact } from '../extract/types.js';
import { withDocumentClassification } from '../extract/classify.js';
import { contentHash } from '../util/hash.js';
import type { Logger } from '../log.js';

export interface DownloadResult {
  finalPath: string;
  filename: string;
  format: DocumentFormat;
  documentType: NonNullable<PdfArtifact['documentType']>;
  requiresOcr: boolean;
  contentHash: string;
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

/**
 * Move staging -> a named target, appending -1/-2 on collision. Uses an atomic
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
      fs.unlinkSync(stagingPath);
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      counter++;
      candidate = path.join(dir, `${base}-${counter}${ext}`);
    }
  }
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
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
      ? finalizeNamed(stagingPath, path.join(invoicesDir, safeFilename(
          pdf.suggestedName || `${msgIdHash}-${i}.${ext}`,
          `${msgIdHash}-${i}.${ext}`,
          ext,
        )))
      : finalizeNumbered(stagingPath, invoicesDir, ext);

    log.debug(`Finalized ${stagingPath} -> ${finalPath}`);

    results.push({
      finalPath,
      filename: path.basename(finalPath),
      format: pdf.format ?? formatForExt(ext),
      documentType: pdf.documentType ?? 'invoice',
      requiresOcr: pdf.requiresOcr ?? true,
      contentHash: contentHash(pdf.data),
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
