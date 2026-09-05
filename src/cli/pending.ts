import { join, resolve } from 'node:path';
import { loadConfig, type Config } from '../config.js';
import { log } from '../log.js';
import { pendingEmlExists, summarizePending } from '../pending/summary.js';
import type { ProcessMailResult } from '../pipeline.js';
import { hardenFile, PENDING_CSV_HEADER, withCsvRetry } from '../pipeline/csvDurability.js';
import { readCsvRows, rewriteCsvRows } from '../util/csv.js';
import { isMailHash } from '../util/hash.js';
import { parsePendingArgs, type PendingOpts, type RunOpts } from './args.js';
import { finalizeRun, openRunContext, runWorkers } from './run.js';
import { PENDING_USAGE } from './usage.js';

export async function cmdPending(argv: string[]): Promise<number> {
  let parsed: PendingOpts | 'help';
  try { parsed = parsePendingArgs(argv); } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n`); process.stderr.write(PENDING_USAGE); return 2;
  }
  if (parsed === 'help') { process.stdout.write(PENDING_USAGE); return 0; }
  if (parsed.command === 'retry') return cmdPendingRetry(parsed);
  return cmdPendingList(parsed);
}

function cmdPendingList(opts: PendingOpts): number {
  let cfg: Config;
  try { cfg = loadConfig(resolve(opts.configPath)); } catch (e) { log.error((e as Error).message); return 2; }
  const summary = summarizePending(cfg);
  if (opts.json) { process.stdout.write(JSON.stringify(summary, null, 2) + '\n'); return 0; }
  process.stdout.write(`Pending queue: ${summary.total} (${summary.csvPath})\n`);
  for (const group of summary.groups) {
    process.stdout.write(`${group.title}: ${group.count} action=${group.action}\n`);
    process.stdout.write(`  ${group.description}\n`);
    for (const row of group.rows) {
      const eml = pendingEmlExists(cfg, row) ? 'eml=yes' : 'eml=no';
      process.stdout.write(`  ${row.hash} date=${row.date} from="${row.from}" subject="${row.subject}" reason=${row.reason} ${eml}\n`);
    }
  }
  return 0;
}

/** 一次重放的账目，供 `--json` 与人读输出共用。 */
interface RetryReport {
  attempted: number;
  resolved: number;
  stillPending: number;
  failed: number;
  removed: number;
  /** 重放后原因发生变化的行数（同一封邮件换了新的失败原因）。 */
  reasonsUpdated: number;
}

/**
 * 单封邮件在重放后是否已经不需要人工介入。
 *
 * - `archived` 且非 partial：票全部落盘，可以出队；
 * - `skipped`：这封邮件本来就无需归档（排除规则 / 提取器一致 skip），同样出队；
 * - 其余（含 `archived` + partial、`pending_durable`、失败）：保留在队列里。
 */
function isResolved(result: ProcessMailResult): boolean {
  if (result.outcome === 'skipped') return result.reason !== 'aborted';
  return result.outcome === 'archived' && result.partial !== true;
}

/** 收集一封邮件在本次重放里的全部身份别名，用来匹配 pending.csv 的 mailHash 列。 */
function resultHashes(result: ProcessMailResult): string[] {
  const out = [result.hash.toLowerCase()];
  if (isMailHash(result.messageId)) out.push(result.messageId.toLowerCase());
  return out;
}

/**
 * 按重放结果核对 pending.csv：成功的行删掉，仍失败的行换上最新原因。
 *
 * 顺序刻意是「先重放、后重写」：重放中途被强杀时 pending.csv 原封不动，
 * 队列不会因为一次失败的重试而丢记录。已归档的文档由 invoices.csv 的
 * `(messageId, source, contentHash)` 幂等键兜底，重复重放不会产生重复归档。
 */
function reconcilePendingCsv(
  csvPath: string,
  results: ProcessMailResult[],
): { removed: number; reasonsUpdated: number } {
  const resolvedHashes = new Set<string>();
  const freshReasons = new Map<string, string>();
  for (const result of results) {
    for (const hash of resultHashes(result)) {
      if (isResolved(result)) resolvedHashes.add(hash);
      else if (result.reason) freshReasons.set(hash, result.reason);
    }
  }
  if (resolvedHashes.size === 0 && freshReasons.size === 0) return { removed: 0, reasonsUpdated: 0 };

  const rows = readCsvRows(csvPath);
  if (rows.length === 0) return { removed: 0, reasonsUpdated: 0 };

  let removed = 0;
  let reasonsUpdated = 0;
  const kept: Record<string, string>[] = [];
  for (const row of rows) {
    const hash = (row.mailHash ?? '').trim().toLowerCase();
    if (hash.length > 0 && resolvedHashes.has(hash)) { removed++; continue; }
    const fresh = hash.length > 0 ? freshReasons.get(hash) : undefined;
    if (fresh !== undefined && fresh !== row.reason) {
      kept.push({ ...row, reason: fresh });
      reasonsUpdated++;
      continue;
    }
    kept.push(row);
  }
  if (removed === 0 && reasonsUpdated === 0) return { removed: 0, reasonsUpdated: 0 };

  withCsvRetry(() => rewriteCsvRows(csvPath, PENDING_CSV_HEADER, kept));
  hardenFile(csvPath);
  return { removed, reasonsUpdated };
}

function emitRetryReport(report: RetryReport, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }
  process.stdout.write(
    `Pending retry: attempted=${report.attempted}, resolved=${report.resolved}`
    + `, still_pending=${report.stillPending}, failed=${report.failed}`
    + `, rows_removed=${report.removed}, reasons_updated=${report.reasonsUpdated}\n`,
  );
}

/**
 * 重放整个待确认队列。
 *
 * 语义与「用户逐条点重试」完全一致，只是批量执行：强制重跑（`force`），输入是
 * `pending/<hash>.eml`，跑完再核对 pending.csv。不删除任何 `.eml`——队列副本是
 * 手动补档与再次重试的唯一依据，出队只改 CSV。
 */
async function cmdPendingRetry(opts: PendingOpts): Promise<number> {
  const runOpts: RunOpts = {
    configPath: opts.configPath,
    statePath: opts.statePath,
    onlyMail: undefined,
    concurrency: opts.concurrency,
    force: true,
    pendingRetry: true,
  };
  const opened = await openRunContext(runOpts);
  if (typeof opened === 'number') return opened;
  const context = opened;

  let exitCode = 0;
  try {
    await runWorkers(context);
  } catch (e) {
    try { context.store.flush(); } catch (flushErr) { log.error(`state flush failed: ${(flushErr as Error).message}`); }
    log.error(`pending retry aborted: ${(e as Error).message}`);
    exitCode = 1;
  } finally {
    if (context.browserInstance) {
      await context.browserInstance.close().catch((err) => {
        log.warn(`browser close failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  const results = context.accumulator.results;
  const csvPath = join(resolve(context.cfg.paths.pending), 'pending.csv');
  let reconciled = { removed: 0, reasonsUpdated: 0 };
  try {
    reconciled = reconcilePendingCsv(csvPath, results);
  } catch (e) {
    // 重放本身已经完成，账目没对上不该把成功的归档报成失败——降级为警告。
    log.warn(`pending.csv reconcile failed: ${(e as Error).message}`);
  }

  const resolved = results.filter(isResolved).length;
  emitRetryReport({
    attempted: results.length,
    resolved,
    stillPending: results.length - resolved,
    failed: context.accumulator.failed,
    ...reconciled,
  }, opts.json);

  // 终态行沿用 run 的契约，GUI 的 live parser 不用改。
  return finalizeRun(context, exitCode === 0 ? 'ok' : 'fatal', exitCode);
}
