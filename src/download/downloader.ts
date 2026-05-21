import fs from 'node:fs';
import path from 'node:path';
import type { PdfArtifact } from '../extract/types.js';
import type { Logger } from '../log.js';

export interface DownloadResult {
  finalPath: string;
  filename: string;
}

function artifactExt(artifact: PdfArtifact): 'pdf' | 'ofd' {
  if (artifact.format === 'ofd') return 'ofd';
  if (artifact.suggestedName?.toLowerCase().endsWith('.ofd')) return 'ofd';
  if (artifact.source.toLowerCase().endsWith('.ofd')) return 'ofd';
  return 'pdf';
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
    const pdf = pdfs[i];
    if (!pdf) continue;

    const ext = artifactExt(pdf);
    const stagingPath = path.join(stagingDir, `${i}.${ext}`);

    fs.writeFileSync(stagingPath, pdf.data);
    log.debug(`Staged ${pdf.source} -> ${stagingPath}`);

    const suggestedName = pdf.suggestedName || `${msgIdHash}-${i}.${ext}`;
    const targetPath = path.join(invoicesDir, suggestedName);
    const finalPath = resolveConflict(targetPath);

    fs.renameSync(stagingPath, finalPath);
    log.debug(`Finalized ${stagingPath} -> ${finalPath}`);

    results.push({
      finalPath,
      filename: path.basename(finalPath),
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
