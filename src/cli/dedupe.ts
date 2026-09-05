import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, type Config } from '../config.js';
import { log } from '../log.js';
import { assertArchiveTransactionsRecovered } from '../download/archiveJournal.js';
import { hardenFile, INVOICE_CSV_HEADER, withCsvRetry } from '../pipeline/csvDurability.js';
import { readCsvRows, rewriteCsvRows } from '../util/csv.js';
import { containerStemKey } from '../extract/documentIdentity.js';
import { contentHash as hashOf } from '../util/hash.js';
import { parseDedupeArgs, type DedupeOpts } from './args.js';
import { acquireCommandLock } from './lock.js';
import { DEDUPE_USAGE } from './usage.js';

/**
 * `mfh dedupe` —— 把「同一个容器里 `<stem>.pdf` 和 `<stem>.ofd` 是同一张票」这条
 * 规则回溯到**已经归档**的数据（EXT-14）。
 *
 * 提取侧的修复只防新增。在此之前，票根网通行费压缩包里每张票的 PDF 与 OFD 都各
 * 归档了一份，台账、OCR 队列和磁盘上因此各多出一份同票副本。
 *
 * 安全约束：
 * - 只处理**同一封邮件、同一容器路径、仅扩展名不同**的 PDF/OFD 配对，判据与
 *   `dropOfdSiblingsOfSamePdf()` 完全一致，不是通用的按文件名去重；
 * - 动手之前必须用 `contentHash` 证明磁盘上那个文件就是台账这一行指的文件，
 *   对不上就跳过并报出来——宁可留着让人查，也不删错文件；
 * - 文件是**移进隔离目录**，不是删除，随时可以搬回来；
 * - 默认 dry-run，`--apply` 才真正动手；重复执行是幂等的。
 */

interface LedgerRow {
  index: number;
  row: Record<string, string>;
  mailHash: string;
  source: string;
  filename: string;
  contentHash: string;
  ext: string;
}

export interface DedupeReport {
  /** 台账里 PDF/OFD 成对出现的票数。 */
  pairs: number;
  /** 计划移除（或已移除）的冗余 OFD 行数。 */
  redundant: number;
  /** 实际移入隔离目录的文件数。 */
  quarantined: number;
  /** 从 invoices.csv 移除的行数。 */
  ledgerRowsRemoved: number;
  /** 从 OCR 队列 / 结果里移除的行数。 */
  ocrRowsRemoved: number;
  /** 台账与磁盘对不上、因此**没有**处理的行。 */
  skipped: string[];
  /** 隔离目录（`--apply` 时才创建）。 */
  quarantineDir: string;
  applied: boolean;
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/**
 * 分组键必须与提取侧**同一个函数**：清理规则一旦比归档规则宽，被清掉的行会在下次
 * 处理时原样长回来，来回抖动。`containerStemKey()` 返回 null 的来源（直链、通用
 * 词干）在这里也一律不参与。
 */
function stemOf(source: string): string | null {
  return containerStemKey(source);
}

function toLedgerRow(row: Record<string, string>, index: number): LedgerRow {
  const source = row.source ?? '';
  return {
    index,
    row,
    mailHash: (row.mailHash ?? '').trim().toLowerCase(),
    source,
    filename: row.filename ?? '',
    contentHash: (row.contentHash ?? '').trim().toLowerCase(),
    ext: extOf(source) || extOf(row.filename ?? ''),
  };
}

/**
 * 找出所有「同邮件 + 同容器路径 + 一 PDF 一 OFD」的配对，返回其中冗余的那份 OFD。
 * 一个 stem 下若出现多于两行（例如同名 image），只处理 pdf/ofd 这一对。
 */
function redundantOfdRows(rows: LedgerRow[]): LedgerRow[] {
  const groups = new Map<string, LedgerRow[]>();
  for (const item of rows) {
    const stem = stemOf(item.source);
    if (stem === null) continue;
    const key = `${item.mailHash}\0${stem}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }

  const redundant: LedgerRow[] = [];
  for (const bucket of groups.values()) {
    const pdf = bucket.find((item) => item.ext === '.pdf');
    if (!pdf) continue;
    for (const item of bucket) {
      if (item.ext === '.ofd') redundant.push(item);
    }
  }
  return redundant;
}

/** 磁盘上的文件确实是台账这一行指的那份吗？ */
function fileMatchesRow(invoicesDir: string, item: LedgerRow): { ok: true; file: string } | { ok: false; why: string } {
  if (item.filename.length === 0) return { ok: false, why: 'ledger row has no filename' };
  const file = path.join(invoicesDir, item.filename);
  if (!fs.existsSync(file)) return { ok: false, why: 'archived file is already gone' };
  if (item.contentHash.length === 0) return { ok: false, why: 'ledger row has no contentHash to verify against' };
  let actual: string;
  try {
    actual = hashOf(fs.readFileSync(file));
  } catch (err) {
    return { ok: false, why: `unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (actual !== item.contentHash) {
    return { ok: false, why: `contentHash mismatch (ledger ${item.contentHash}, disk ${actual})` };
  }
  return { ok: true, file };
}

/** 从一个 OCR CSV 里删掉指定 (hash, source) 的行；返回删除条数。 */
function pruneOcrCsv(csvPath: string, keys: Set<string>): number {
  if (!fs.existsSync(csvPath)) return 0;
  const rows = readCsvRows(csvPath);
  if (rows.length === 0) return 0;
  const kept = rows.filter((row) => !keys.has(`${(row.hash ?? '').trim().toLowerCase()}\0${row.source ?? ''}`));
  const removed = rows.length - kept.length;
  if (removed === 0) return 0;
  // 原样保留该文件当前的列集合：OCR 结果表随版本迁移过，不能硬套某一版表头。
  const header = `${Object.keys(rows[0] ?? {}).join(',')}\n`;
  withCsvRetry(() => rewriteCsvRows(csvPath, header, kept));
  hardenFile(csvPath);
  return removed;
}

export function runDedupe(cfg: Config, opts: { apply: boolean }, cwd = process.cwd()): DedupeReport {
  const invoicesDir = path.resolve(cwd, cfg.paths.invoices);
  const ledgerCsv = path.resolve(cwd, cfg.output.csv);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const quarantineDir = path.join(invoicesDir, '.dedupe-quarantine', stamp);

  const report: DedupeReport = {
    pairs: 0,
    redundant: 0,
    quarantined: 0,
    ledgerRowsRemoved: 0,
    ocrRowsRemoved: 0,
    skipped: [],
    quarantineDir,
    applied: opts.apply,
  };

  const rawRows = readCsvRows(ledgerCsv);
  if (rawRows.length === 0) return report;
  const rows = rawRows.map(toLedgerRow);
  const redundant = redundantOfdRows(rows);
  report.pairs = redundant.length;
  report.redundant = redundant.length;
  if (redundant.length === 0) return report;

  // 先整体校验，再决定动哪些行：校验不过的一行都不动，也不从台账里删。
  const actionable: Array<{ item: LedgerRow; file: string }> = [];
  for (const item of redundant) {
    const check = fileMatchesRow(invoicesDir, item);
    if (!check.ok) {
      report.skipped.push(`${item.filename || item.source}: ${check.why}`);
      continue;
    }
    actionable.push({ item, file: check.file });
  }
  report.redundant = actionable.length;

  if (!opts.apply || actionable.length === 0) return report;

  fs.mkdirSync(quarantineDir, { recursive: true });
  const removedIndexes = new Set<number>();
  const ocrKeys = new Set<string>();
  for (const { item, file } of actionable) {
    const target = path.join(quarantineDir, item.filename);
    try {
      fs.renameSync(file, target);
    } catch (err) {
      // 跨设备等 rename 失败：复制 + 删除原件，仍然不做不可逆的直接删除。
      try {
        fs.copyFileSync(file, target);
        fs.unlinkSync(file);
      } catch (copyErr) {
        report.skipped.push(`${item.filename}: quarantine failed: ${copyErr instanceof Error ? copyErr.message : String(copyErr)}`);
        continue;
      }
      void err;
    }
    report.quarantined++;
    removedIndexes.add(item.index);
    ocrKeys.add(`${item.mailHash}\0${item.source}`);
  }

  if (removedIndexes.size > 0) {
    const kept = rawRows.filter((_, index) => !removedIndexes.has(index));
    withCsvRetry(() => rewriteCsvRows(ledgerCsv, INVOICE_CSV_HEADER, kept));
    hardenFile(ledgerCsv);
    report.ledgerRowsRemoved = removedIndexes.size;

    report.ocrRowsRemoved += pruneOcrCsv(path.join(invoicesDir, 'ocr', 'ocr-pending.csv'), ocrKeys);
    report.ocrRowsRemoved += pruneOcrCsv(path.resolve(cwd, cfg.ocr.resultsCsv), ocrKeys);
  }

  return report;
}

function printReport(report: DedupeReport): void {
  if (report.redundant === 0 && report.skipped.length === 0) {
    process.stdout.write('No duplicate PDF/OFD pairs found; nothing to clean up.\n');
    return;
  }
  const verb = report.applied ? 'Removed' : 'Would remove';
  process.stdout.write(`${verb} ${report.redundant} redundant OFD copies of invoices already archived as PDF.\n`);
  if (report.applied) {
    process.stdout.write(`  files quarantined : ${report.quarantined} -> ${report.quarantineDir}\n`);
    process.stdout.write(`  ledger rows removed: ${report.ledgerRowsRemoved}\n`);
    process.stdout.write(`  OCR rows removed   : ${report.ocrRowsRemoved}\n`);
    process.stdout.write('Nothing was deleted. Delete the quarantine folder yourself once you are happy.\n');
  } else {
    process.stdout.write('Dry run — nothing changed. Re-run with --apply to perform the cleanup.\n');
  }
  if (report.skipped.length > 0) {
    process.stdout.write(`Skipped ${report.skipped.length} row(s) whose ledger entry does not match the file on disk:\n`);
    for (const item of report.skipped.slice(0, 20)) process.stdout.write(`  ${item}\n`);
    if (report.skipped.length > 20) process.stdout.write(`  … and ${report.skipped.length - 20} more\n`);
  }
}

export async function cmdDedupe(argv: string[]): Promise<number> {
  let parsed: DedupeOpts | 'help';
  try { parsed = parseDedupeArgs(argv); } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n`); process.stderr.write(DEDUPE_USAGE); return 2;
  }
  if (parsed === 'help') { process.stdout.write(DEDUPE_USAGE); return 0; }
  let cfg: Config;
  try { cfg = loadConfig(path.resolve(parsed.configPath)); } catch (e) { log.error((e as Error).message); return 2; }
  // 重写台账 + 移动归档文件：与 pipeline 互斥，必须占锁。
  if (!acquireCommandLock('pipeline', { configPath: parsed.configPath }, cfg)) return 2;
  try {
    assertArchiveTransactionsRecovered(path.resolve(cfg.paths.invoices));
    const report = runDedupe(cfg, { apply: parsed.apply });
    if (parsed.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else printReport(report);
    return 0;
  } catch (e) { log.error((e as Error).message); return 1; }
}
