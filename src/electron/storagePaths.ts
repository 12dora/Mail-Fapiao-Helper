import fs from 'node:fs';
import path from 'node:path';
import { readConfigForPaths } from './configService.js';
import { asObject } from './payload.js';
import { dataDir } from './runtime.js';
import { tempRoot } from './tempFiles.js';

// ---------------------------------------------------------------------------
// 目录与摘要
// ---------------------------------------------------------------------------

export function resolvedPath(section: 'paths' | 'ocr' | 'rename' | 'output', key: string, fallback: string): string {
  const cfg = readConfigForPaths();
  const block = asObject(cfg[section]);
  const value = block[key];
  return path.resolve(dataDir, typeof value === 'string' && value.length > 0 ? value : fallback);
}

export function pendingDirPath(): string {
  return resolvedPath('paths', 'pending', './pending');
}

export function invoicesDirPath(): string {
  return resolvedPath('paths', 'invoices', './invoices');
}

export function samplesDirPath(): string {
  return resolvedPath('paths', 'samples', './samples/raw');
}

export function ocrPendingCsvPath(): string {
  return path.join(invoicesDirPath(), 'ocr', 'ocr-pending.csv');
}

export function ocrResultsCsvPath(): string {
  return resolvedPath('ocr', 'resultsCsv', './invoices/ocr/ocr-results.csv');
}

export function ledgerCsvPath(): string {
  return resolvedPath('output', 'csv', './invoices/invoices.csv');
}

export function ensureBaseDirectories(): void {
  const cfg = readConfigForPaths();
  const paths = asObject(cfg.paths);
  const ocr = asObject(cfg.ocr);
  const rename = asObject(cfg.rename);
  const ensure = (value: unknown, fallback: string) => {
    const v = typeof value === 'string' && value.length > 0 ? value : fallback;
    fs.mkdirSync(path.resolve(dataDir, v), { recursive: true });
  };
  ensure(paths.samples, './samples/raw');
  ensure(paths.invoices, './invoices');
  ensure(paths.pending, './pending');
  if (typeof ocr.resultsCsv === 'string' && ocr.resultsCsv.length > 0) {
    fs.mkdirSync(path.dirname(path.resolve(dataDir, ocr.resultsCsv)), { recursive: true });
  }
  if (typeof rename.organizedDir === 'string' && rename.organizedDir.length > 0) {
    fs.mkdirSync(path.resolve(dataDir, rename.organizedDir), { recursive: true });
  }
  fs.mkdirSync(path.join(dataDir, '.mfh-cache'), { recursive: true });
  fs.mkdirSync(tempRoot(), { recursive: true });
}
