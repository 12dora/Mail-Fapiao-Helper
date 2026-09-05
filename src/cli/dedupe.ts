import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig, type Config } from '../config.js';
import { log } from '../log.js';
import { assertArchiveTransactionsRecovered } from '../download/archiveJournal.js';
import { readCsvRows } from '../util/csv.js';
import { containerStemKey } from '../extract/documentIdentity.js';
import { ArtifactIndex } from '../util/identity.js';
import { contentHash as hashOf } from '../util/hash.js';
import { parseDedupeArgs, type DedupeOpts } from './args.js';
import { acquireCommandLock } from './lock.js';
import { DEDUPE_USAGE } from './usage.js';
import { resolveDataDir } from '../util/dataDirLock.js';
import { applyDedupePlan, recoverDedupePlans, validArchivedFilename, writeAtomicJson } from './dedupeJournal.js';

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
  mode: 'container' | 'invoice-no';
  applied: boolean;
  recovered: number;
  quarantineDir: string | null;
  pairs: number;
  redundant: number;
  quarantined: number;
  ledgerRowsRemoved: number;
  ocrRowsRemoved: number;
  groups: Array<{
    invoiceNo: string;
    kept: { filename: string; date: string; seller: string; amount: string; format: string };
    removed: Array<{ filename: string; date: string; seller: string; amount: string; format: string; reason: string }>;
    conflict: boolean;
    conflictReason: string;
  }>;
  conflicts: number;
  skipped: Array<{ filename: string; reason: string }>;
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
  if (!validArchivedFilename(item.filename)) return { ok: false, why: 'invalid archived filename' };
  const file = path.join(invoicesDir, item.filename);
  if (!fs.existsSync(file)) return { ok: false, why: 'archived file is already gone' };
  if (item.contentHash.length === 0) return { ok: false, why: 'ledger row has no contentHash to verify against' };
  let actual: string;
  try {
    if (!fs.lstatSync(file).isFile()) return { ok: false, why: 'archived file is not a regular file' };
    actual = hashOf(fs.readFileSync(file));
  } catch (err) {
    return { ok: false, why: `unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (actual !== item.contentHash) {
    return { ok: false, why: `contentHash mismatch (ledger ${item.contentHash}, disk ${actual})` };
  }
  return { ok: true, file };
}

export function runDedupe(cfg: Config, opts: { apply: boolean; by?: DedupeOpts['by'] }, cwd = process.cwd()): DedupeReport {
  const recovered = recoverDedupePlans(cfg, cwd);
  const report = opts.by === 'invoice-no'
    ? runInvoiceNoDedupe(cfg, opts.apply, cwd)
    : runContainerDedupe(cfg, opts.apply, cwd);
  report.recovered = recovered;
  return report;
}

function runContainerDedupe(cfg: Config, apply: boolean, cwd: string): DedupeReport {
  const invoicesDir = path.resolve(cwd, cfg.paths.invoices);
  const ledgerCsv = path.resolve(cwd, cfg.output.csv);
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const quarantineDir = path.join(invoicesDir, '.dedupe-quarantine', stamp);

  const report: DedupeReport = {
    mode: 'container',
    recovered: 0,
    groups: [],
    conflicts: 0,
    pairs: 0,
    redundant: 0,
    quarantined: 0,
    ledgerRowsRemoved: 0,
    ocrRowsRemoved: 0,
    skipped: [],
    quarantineDir,
    applied: apply,
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
      report.skipped.push({ filename: item.filename || item.source, reason: check.why });
      continue;
    }
    actionable.push({ item, file: check.file });
  }
  report.redundant = actionable.length;

  if (!apply || actionable.length === 0) return report;

  Object.assign(report, applyDedupePlan(cfg, cwd, quarantineDir, actionable.map(({ item, file }) => ({
    source: file,
    target: path.join(quarantineDir, item.filename),
    filename: item.filename,
    contentHash: item.contentHash,
    csvKeys: { filename: item.filename, contentHash: item.contentHash },
  }))));
  return report;
}

function fileKey(row: Record<string, string>): string {
  return `${row.filename ?? ''}\0${(row.contentHash ?? '').trim().toLowerCase()}`;
}

function normalizeSeller(value: string): string {
  return value.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ').trim().replace(/\s+/g, ' ');
}

/** Compare decimal strings without losing precision through Number conversion. */
function normalizeAmount(value: string): string {
  const text = normalizeSeller(value).replace(/[\p{Sc},\s]/gu, '');
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || !(match[2] || match[3])) return text;
  const integer = (match[2] || '0').replace(/^0+(?=\d)/, '');
  const fraction = (match[3] || '').replace(/0+$/, '');
  const sign = match[1] === '-' && (integer !== '0' || fraction) ? '-' : '';
  return `${sign}${integer}${fraction ? `.${fraction}` : ''}`;
}

function runInvoiceNoDedupe(cfg: Config, apply: boolean, cwd: string): DedupeReport {
  const report: DedupeReport = {
    mode: 'invoice-no', applied: apply, recovered: 0, quarantineDir: null,
    pairs: 0, redundant: 0, quarantined: 0, ledgerRowsRemoved: 0, ocrRowsRemoved: 0,
    groups: [], conflicts: 0, skipped: [],
  };
  const invoicesDir = path.resolve(cwd, cfg.paths.invoices);
  const resultsCsv = path.resolve(cwd, cfg.ocr.resultsCsv);
  const index = new ArtifactIndex<Record<string, string>>();
  for (const row of readCsvRows(resultsCsv)) {
    index.set(row, row, (existing, next) =>
      !((existing.status ?? '').toLowerCase() === 'success' && (next.status ?? '').toLowerCase() !== 'success'));
  }
  const groups = new Map<string, Record<string, string>[]>();
  for (const row of index.values()) {
    const invoiceNo = (row.invoiceNo ?? '').trim();
    if ((row.status ?? '').toLowerCase() !== 'success' || !/^\d{20}$/.test(invoiceNo)) continue;
    const members = groups.get(invoiceNo) ?? [];
    members.push(row);
    groups.set(invoiceNo, members);
  }
  const detail = (row: Record<string, string>) => ({
    filename: row.filename ?? '', date: row.date ?? '', seller: row.seller ?? '', amount: row.amount ?? '',
    format: extOf(row.filename ?? '').slice(1) || row.format || '',
  });
  const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const dateOrder = (value: string | undefined) => {
    const time = Date.parse(value ?? '');
    return Number.isFinite(time) ? time : Infinity;
  };
  const rank = (row: Record<string, string>) => extOf(row.filename ?? '') === '.pdf' ? 0 : extOf(row.filename ?? '') === '.ofd' ? 1 : 2;
  const actionable = new Map<string, { item: LedgerRow; file: string }>();
  for (const [invoiceNo, members] of groups) {
    if (members.length < 2) continue;
    members.sort((a, b) => rank(a) - rank(b) || (dateOrder(a.date) - dateOrder(b.date) || 0) || compareText(a.filename ?? '', b.filename ?? ''));
    const keeper = members[0]!;
    const disagreements: string[] = [];
    if (new Set(members.map((row) => normalizeAmount(row.amount ?? ''))).size > 1) disagreements.push('amount');
    if (new Set(members.map((row) => normalizeSeller(row.seller ?? ''))).size > 1) disagreements.push('seller');
    const group: DedupeReport['groups'][number] = {
      invoiceNo, kept: detail(keeper), removed: [], conflict: disagreements.length > 0,
      conflictReason: disagreements.length ? `Conflicting ${disagreements.join(' and ')}` : '',
    };
    report.groups.push(group);
    if (group.conflict) { report.conflicts++; continue; }
    if (!fileMatchesRow(invoicesDir, toLedgerRow(keeper, 0)).ok) {
      report.skipped.push({ filename: keeper.filename ?? '', reason: 'keeper_unverified' });
      continue;
    }
    report.pairs++;
    for (const row of members.slice(1)) {
      const item = toLedgerRow(row, 0);
      // A historical identity may point at the same physical file as the keeper.
      if (item.filename === keeper.filename) {
        report.skipped.push({ filename: item.filename, reason: 'same filename as keeper' });
        continue;
      }
      const check = fileMatchesRow(invoicesDir, item);
      if (!check.ok) {
        report.skipped.push({ filename: item.filename, reason: check.why.replace(/ledger/g, 'OCR results') });
        continue;
      }
      group.removed.push({ ...detail(row), reason: 'Duplicate invoice number; PDF, date and filename preference' });
      actionable.set(fileKey(row), { item, file: check.file });
    }
  }
  report.redundant = actionable.size;
  if (!apply || !actionable.size) return report;
  const planDir = path.join(invoicesDir, '.dedupe-quarantine', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
  const quarantineDir = path.join(planDir, 'by-invoice-no');
  fs.mkdirSync(quarantineDir, { recursive: true });
  report.quarantineDir = quarantineDir;
  Object.assign(report, applyDedupePlan(cfg, cwd, planDir, [...actionable.values()].map(({ item, file }) => ({
    source: file,
    target: path.join(quarantineDir, item.filename),
    filename: item.filename,
    contentHash: item.contentHash,
    csvKeys: { filename: item.filename, contentHash: item.contentHash },
  }))));
  return report;
}

function printReport(report: DedupeReport): void {
  if (report.recovered) process.stdout.write(`Recovered pending dedupe moves: ${report.recovered}.\n`);
  if (report.mode === 'invoice-no') {
    process.stdout.write(`Invoice-number groups: ${report.groups.length}; ${report.applied ? 'removed' : 'would remove'}: ${report.applied ? report.quarantined : report.redundant}; conflicts: ${report.conflicts}; skipped: ${report.skipped.length}.\n`);
    if (report.quarantineDir) process.stdout.write(`Quarantine: ${report.quarantineDir}\n`);
    if (!report.applied) process.stdout.write('Dry run — no new cleanup applied. Re-run with --apply to perform the cleanup.\n');
    return;
  }
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
    process.stdout.write('Dry run — no new cleanup applied. Re-run with --apply to perform the cleanup.\n');
  }
  if (report.skipped.length > 0) {
    process.stdout.write(`Skipped ${report.skipped.length} row(s) whose ledger entry does not match the file on disk:\n`);
    for (const item of report.skipped.slice(0, 20)) process.stdout.write(`  ${item.filename}: ${item.reason}\n`);
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
    const report = runDedupe(cfg, { apply: parsed.apply, by: parsed.by });
    const reportFile = path.join(resolveDataDir({ configPath: parsed.configPath }), '.mfh-cache', 'dedupe-report.json');
    writeAtomicJson(reportFile, report);
    if (parsed.json) process.stdout.write(`${JSON.stringify(report)}\n`);
    else printReport(report);
    return 0;
  } catch (e) { log.error((e as Error).message); return 1; }
}
