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

function artifactExt(artifact: PdfArtifact): 'pdf' | 'ofd' {
  if (artifact.data.subarray(0, 4).toString('ascii') === '%PDF') return 'pdf';
  if (artifact.data.subarray(0, 2).toString('ascii') === 'PK') return 'ofd';
  if (artifact.format === 'ofd') return 'ofd';
  if (artifact.suggestedName?.toLowerCase().endsWith('.ofd')) return 'ofd';
  if (artifact.source.toLowerCase().endsWith('.ofd')) return 'ofd';
  return 'pdf';
}

function normalizeArtifact(artifact: PdfArtifact, ext: 'pdf' | 'ofd'): PdfArtifact {
  return withDocumentClassification({ ...artifact, format: ext }, ext);
}

function safeFilename(name: string, fallback: string, ext: 'pdf' | 'ofd'): string {
  const base = path.basename(name)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  const cleaned = base.length > 0 ? base : fallback;
  return path.extname(cleaned).length > 0 ? cleaned : `${cleaned}.${ext}`;
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
  log: Logger
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

    const suggestedName = safeFilename(
      pdf.suggestedName || `${msgIdHash}-${i}.${ext}`,
      `${msgIdHash}-${i}.${ext}`,
      ext,
    );
    const targetPath = path.join(invoicesDir, suggestedName);
    const finalPath = resolveConflict(targetPath);

    fs.renameSync(stagingPath, finalPath);
    log.debug(`Finalized ${stagingPath} -> ${finalPath}`);

    results.push({
      finalPath,
      filename: path.basename(finalPath),
      format: pdf.format ?? ext,
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
