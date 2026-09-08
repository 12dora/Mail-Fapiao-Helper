import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import { hardenFile, withCsvRetry } from '../pipeline/csvDurability.js';
import { readCsvRows, rewriteCsvRows } from '../util/csv.js';
import { contentHash as hashOf } from '../util/hash.js';

export interface DedupeMove {
  source: string;
  target: string;
  filename: string;
  contentHash: string;
  csvKeys: { filename: string; contentHash: string };
}

interface DedupePlan {
  version: 1;
  csvPaths: { ledger: string; pending: string; results: string };
  moves: DedupeMove[];
}

interface PlanCounts {
  quarantined: number;
  ledgerRowsRemoved: number;
  ocrRowsRemoved: number;
}

function syncDirectory(dir: string): void {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function writeAtomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    const fd = fs.openSync(temp, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    syncDirectory(path.dirname(file));
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export function validArchivedFilename(filename: string): boolean {
  return !!filename && filename !== '.' && filename !== '..'
    && path.basename(filename) === filename && !/[\\\0]/.test(filename)
    && !path.win32.isAbsolute(filename);
}

function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function existingParent(file: string): string {
  let parent = path.dirname(file);
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  return fs.realpathSync(parent);
}

function csvPaths(cfg: Config, cwd: string): DedupePlan['csvPaths'] {
  return {
    ledger: path.resolve(cwd, cfg.output.csv),
    pending: path.resolve(cwd, cfg.paths.invoices, 'ocr', 'ocr-pending.csv'),
    results: path.resolve(cwd, cfg.ocr.resultsCsv),
  };
}

function matchesFile(file: string, contentHash: string): boolean {
  return fs.lstatSync(file).isFile() && hashOf(fs.readFileSync(file)) === contentHash;
}

function pruneCsv(file: string, keys: Map<string, Set<string>>): number {
  const rows = readCsvRows(file, { strict: true });
  const kept = rows.filter((row) => {
    const hashes = keys.get(row.filename ?? '');
    const hash = (row.contentHash ?? '').trim().toLowerCase();
    return !hashes || (!!hash && !hashes.has(hash));
  });
  const removed = rows.length - kept.length;
  if (removed) {
    const header = `${Object.keys(rows[0]!).join(',')}\n`;
    withCsvRetry(() => rewriteCsvRows(file, header, kept));
    hardenFile(file);
  }
  return removed;
}

/** Prune every CSV before the first move. Leave the plan in place on any failure. */
function finishPlan(planFile: string, plan: DedupePlan): PlanCounts {
  const keys = new Map<string, Set<string>>();
  for (const move of plan.moves) {
    // Recovery never trusts changed source bytes or an unrelated quarantine target.
    const sourceExists = fs.existsSync(move.source);
    const targetExists = fs.existsSync(move.target);
    if ((!sourceExists && !targetExists)
      || (sourceExists && !matchesFile(move.source, move.contentHash))
      || (targetExists && !matchesFile(move.target, move.contentHash))) {
      throw new Error(`Dedupe recovery cannot verify ${move.filename}`);
    }
    const hashes = keys.get(move.csvKeys.filename) ?? new Set<string>();
    hashes.add(move.csvKeys.contentHash);
    keys.set(move.csvKeys.filename, hashes);
  }
  const ledgerRowsRemoved = pruneCsv(plan.csvPaths.ledger, keys);
  const ocrRowsRemoved = pruneCsv(plan.csvPaths.pending, keys) + pruneCsv(plan.csvPaths.results, keys);
  let quarantined = 0;
  for (const move of plan.moves) {
    if (!fs.existsSync(move.source)) continue;
    fs.mkdirSync(path.dirname(move.target), { recursive: true });
    if (fs.existsSync(move.target)) {
      fs.unlinkSync(move.source); // A previous copy succeeded before unlink was interrupted.
    } else {
      try {
        fs.renameSync(move.source, move.target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
        // Publish only complete copies, so an interrupted copy cannot poison recovery.
        const temp = `${move.target}.copying`;
        fs.copyFileSync(move.source, temp);
        const fd = fs.openSync(temp, 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(temp, move.target);
        fs.unlinkSync(move.source);
      }
    }
    syncDirectory(path.dirname(move.target));
    syncDirectory(path.dirname(move.source));
    quarantined++;
  }
  fs.unlinkSync(planFile);
  syncDirectory(path.dirname(planFile));
  return { quarantined, ledgerRowsRemoved, ocrRowsRemoved };
}

export function applyDedupePlan(
  cfg: Config, cwd: string, planDir: string, moves: DedupeMove[],
): PlanCounts {
  const plan: DedupePlan = { version: 1, csvPaths: csvPaths(cfg, cwd), moves };
  const planFile = path.join(planDir, 'plan.json');
  writeAtomicJson(planFile, plan);
  return finishPlan(planFile, plan);
}

function* loadRecoveryPlans(root: string): Generator<string> {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const planFile = path.join(root, entry.name, 'plan.json');
    if (fs.existsSync(planFile)) yield planFile;
  }
}

function validateRecoveryPlan(plan: DedupePlan, expectedPaths: DedupePlan['csvPaths']): void {
  if (plan.version !== 1 || !Array.isArray(plan.moves)
    || Object.entries(expectedPaths).some(([key, file]) => plan.csvPaths?.[key as keyof typeof expectedPaths] !== file)) {
    throw new Error('Invalid dedupe recovery plan');
  }
}

function validateRecoveryMove(
  move: DedupeMove, invoicesDir: string, planDir: string, realInvoicesDir: string, realPlanDir: string,
): void {
  if (typeof move.filename !== 'string' || !validArchivedFilename(move.filename)
    || typeof move.contentHash !== 'string' || !move.contentHash
    || move.source !== path.join(invoicesDir, move.filename)
    || typeof move.target !== 'string' || path.resolve(move.target) !== move.target
    || !inside(planDir, move.target)
    || path.basename(move.target) !== move.filename
    || move.csvKeys?.filename !== move.filename || move.csvKeys.contentHash !== move.contentHash
    || !inside(realInvoicesDir, realPlanDir)
    || !(existingParent(move.target) === realPlanDir || inside(realPlanDir, existingParent(move.target)))) {
    throw new Error('Invalid dedupe recovery move');
  }
}

/** Called before any mode, while cmdDedupe holds the pipeline command lock. */
export function recoverDedupePlans(cfg: Config, cwd: string): number {
  const invoicesDir = path.resolve(cwd, cfg.paths.invoices);
  const root = path.join(invoicesDir, '.dedupe-quarantine');
  if (!fs.existsSync(root)) return 0;
  const expectedPaths = csvPaths(cfg, cwd);
  let recovered = 0;
  for (const planFile of loadRecoveryPlans(root)) {
    const plan = JSON.parse(fs.readFileSync(planFile, 'utf8')) as DedupePlan;
    validateRecoveryPlan(plan, expectedPaths);
    const planDir = path.dirname(planFile);
    const realPlanDir = fs.realpathSync(planDir);
    const realInvoicesDir = fs.realpathSync(invoicesDir);
    for (const move of plan.moves) {
      validateRecoveryMove(move, invoicesDir, planDir, realInvoicesDir, realPlanDir);
    }
    finishPlan(planFile, plan);
    recovered += plan.moves.length;
  }
  return recovered;
}
