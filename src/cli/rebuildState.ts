import { existsSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Config } from '../config.js';
import { loadConfig } from '../config.js';
import { log } from '../log.js';
import { fileExistsNonEmpty, StateStore, type State } from '../state.js';
import { isMailHash, legacyMsgIdHash } from '../util/hash.js';
import { readCsvRows } from '../util/csv.js';
import { parseRebuildStateArgs, type RebuildStateOpts } from './args.js';
import { acquireCommandLock } from './lock.js';
import { REBUILD_STATE_USAGE } from './usage.js';

export async function* walkEmls(dir: string): AsyncGenerator<string> {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkEmls(fullPath);
    else if (entry.isFile() && entry.name.endsWith('.eml')) yield fullPath;
  }
}

export async function collectEmlPaths(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const emlPath of walkEmls(dir)) out.push(emlPath);
  return out;
}

// ---------------------------------------------------------------------------
// 状态重建（APP-18A）：只读缓存与台账，不删除任何业务数据
// ---------------------------------------------------------------------------

/**
 * 台账行 -> **唯一** primary 身份（write-primary / read-aliases 契约，BLOCKING 11）。
 *
 * - 有显式 `mailHash`/`hash`：只返回这一条，绝不附带 Message-Id 衍生的 12 位；
 * - 无显式列：才推导一条（超大邮件 hash 写在 messageId 位，或 legacy 12 位）；
 * - 禁止返回「32 位 + 其 12 位 legacy」双键——backfill 会把两者都写进 state，
 *   导致 processedHashes 基数 > 邮件数，并永久压制共享 Message-Id 的另一封邮件。
 */
export function primaryHashFromLedgerRow(row: Record<string, string>): string | undefined {
  const explicit = (row.mailHash ?? row.hash ?? '').trim();
  if (explicit && isMailHash(explicit)) return explicit.toLowerCase();
  const messageId = row.messageId ?? '';
  // 超大邮件路径曾把 hash 写在 messageId 位。
  if (isMailHash(messageId)) return messageId.toLowerCase();
  if (messageId.length > 0 || (row.from ?? '') || (row.date ?? '') || (row.subject ?? '')) {
    return legacyMsgIdHash(messageId.length > 0 ? messageId : undefined, row.from ?? '', row.date ?? '', row.subject ?? '');
  }
  return undefined;
}

/**
 * 缓存 .eml 的文件名就是 fetch 身份，因此这是唯一可信的 fetched 证据来源：
 * 文件不在（或为空）就不该记为已抓取，否则又会回到 APP-11 的空目录假象。
 */
export async function fetchedHashesFromCache(samplesDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const emlPath of await collectEmlPaths(samplesDir)) {
    if (!fileExistsNonEmpty(emlPath)) continue;
    const hash = basename(emlPath, '.eml');
    if (hash.length > 0) out.push(hash);
  }
  return out;
}

/** 从 invoices.csv（已归档）与 pending.csv（已进入待确认）恢复 processed 身份（每行一条 primary）。 */
export function processedHashesFromLedgers(cfg: Config): string[] {
  const out = new Set<string>();
  const add = (row: Record<string, string>): void => { const h = primaryHashFromLedgerRow(row); if (h) out.add(h); };
  for (const row of readCsvRows(resolve(cfg.output.csv))) add(row);
  for (const row of readCsvRows(join(resolve(cfg.paths.pending), 'pending.csv'))) add(row);
  // OCR 队列的 hash 列即 mailHash。
  const ocrPending = join(resolve(cfg.paths.invoices), 'ocr', 'ocr-pending.csv');
  for (const row of readCsvRows(ocrPending)) add(row);
  return [...out];
}

export async function rebuildStateFromDisk(cfg: Config, samplesDir: string): Promise<State> {
  return { processedHashes: processedHashesFromLedgers(cfg), fetchedHashes: await fetchedHashesFromCache(samplesDir) };
}

/**
 * CORE-03：把台账（invoices.csv 等）里的**primary** mailHash 幂等回填进 processed。
 *
 * 写侧只写 primary（每封邮件一条）；读侧用 `evidence` 覆盖升级前 12 位记录
 * （仅当本邮件运营身份就是 legacy 时，见 resolveMailIdentity.evidence）。
 * 禁止把 Message-Id 衍生 legacy 作为「另一封邮件」的 processed 证据写入 state。
 */
export function backfillProcessedFromLedgers(store: StateStore, cfg: Config): void {
  let added = 0;
  for (const h of processedHashesFromLedgers(cfg)) {
    if (!store.hasProcessed(h)) { store.addProcessed(h); added++; }
  }
  if (added > 0) {
    store.checkpoint(); store.flush();
    log.info(`mailHash 台账回填：新增 ${added} 条 processed 身份`);
  }
}

/**
 * state.json 损坏时的自动恢复：损坏文件已由 StateStore 隔离到带时间戳的备份，
 * 这里再从 INDEX/缓存/invoices.csv 重建可恢复身份，让 fetch/run 能继续跑完。
 */
export async function recoverQuarantinedState(store: StateStore, cfg: Config, samplesDir: string): Promise<void> {
  if (!store.quarantine) return;
  log.warn(store.quarantine.message);
  const rebuilt = await rebuildStateFromDisk(cfg, samplesDir);
  store.replaceAll(rebuilt);
  log.info(`state rebuilt from disk: fetched=${store.fetchedCount} processed=${store.processedCount}`);
}

export async function cmdRebuildState(argv: string[]): Promise<number> {
  let parsed: RebuildStateOpts | 'help';
  try { parsed = parseRebuildStateArgs(argv); } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n`); process.stderr.write(REBUILD_STATE_USAGE); return 2;
  }
  if (parsed === 'help') { process.stdout.write(REBUILD_STATE_USAGE); return 0; }
  let cfg: Config;
  try { cfg = loadConfig(resolve(parsed.configPath)); } catch (e) { log.error((e as Error).message); return 2; }
  const samplesDir = resolve(parsed.outDir ?? cfg.paths.samples);
  const statePath = resolve(parsed.statePath);
  try {
    const rebuilt = await rebuildStateFromDisk(cfg, samplesDir);
    if (parsed.dryRun) {
      log.info(`[dry-run] would rebuild ${statePath}: fetched=${new Set(rebuilt.fetchedHashes).size} processed=${new Set(rebuilt.processedHashes).size}`);
      return 0;
    }
    if (!acquireCommandLock('pipeline', { statePath: parsed.statePath, configPath: parsed.configPath }, cfg, { statePath: parsed.statePath })) return 2;
    const store = StateStore.open(statePath);
    if (store.quarantine) log.warn(store.quarantine.message);
    // 已处理身份只做并集：重建不应让历史上已处理的邮件重新进入处理队列。
    const existing = store.snapshot();
    store.replaceAll({
      processedHashes: [...existing.processedHashes, ...rebuilt.processedHashes],
      // 已抓取身份必须以缓存文件为准，缺失的条目要允许重新抓取。
      fetchedHashes: rebuilt.fetchedHashes,
    });
    log.info(`state rebuilt: ${statePath} fetched=${store.fetchedCount} processed=${store.processedCount}`);
    log.info('仅重建了状态文件，缓存邮件、INDEX.csv、invoices.csv、归档文件与待确认队列均未改动。');
    store.dispose(); return 0;
  } catch (e) { log.error(`rebuild-state failed: ${(e as Error).message}`); return 1; }
}
