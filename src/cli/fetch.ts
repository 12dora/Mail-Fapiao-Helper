import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadConfig, type Config } from '../config.js';
import { fetchMails, missingImapCredentials, type RawMail } from '../mail/fetcher.js';
import { log } from '../log.js';
import { ensureSecureDir, fileExistsNonEmpty, secureFileMode, StateStore, uniqueTempPath } from '../state.js';
import { boundsAreOrdered } from '../util/dateRange.js';
import { isMailHash, legacyMsgIdHash, resolveMailIdentity } from '../util/hash.js';
import { csvCell, ensureCsvSchema, readCsvRows } from '../util/csv.js';
import { parseFetchArgs, type FetchOpts } from './args.js';
import { acquireCommandLock } from './lock.js';
import { backfillProcessedFromLedgers, recoverQuarantinedState } from './rebuildState.js';
import { FETCH_USAGE } from './usage.js';

export const INDEX_HEADER = 'mailHash,messageId,date,from,subject,mailbox,hasAttachment,bodyLinkCount';
export const INDEX_LEGACY_HEADERS = ['messageId,date,from,subject,mailbox,hasAttachment,bodyLinkCount'];

export function ensureIndexCsv(path: string): void {
  // CORE-05：空文件也要写表头，不能只判断 exists。
  // OCR-03：ensureCsvSchema 自身 fsync；mode 0600。
  ensureSecureDir(dirname(path));
  ensureCsvSchema(path, INDEX_HEADER, {
    upgradeFrom: INDEX_LEGACY_HEADERS,
    upgradeRow: (row) => {
      if (row.mailHash && isMailHash(row.mailHash)) return row;
      const mid = row.messageId ?? '';
      const legacy = isMailHash(mid) ? mid.toLowerCase() : legacyMsgIdHash(mid.length > 0 ? mid : undefined, row.from ?? '', row.date ?? '', row.subject ?? '');
      return { ...row, mailHash: legacy };
    },
  });
  secureFileMode(path);
}

/**
 * 一次性读出 INDEX.csv 已有的 mailHash 集合（兼容旧表：无 mailHash 时退回 legacy）。
 */
export function readIndexMailHashes(path: string): Set<string> {
  const out = new Set<string>();
  for (const row of readCsvRows(path)) {
    const h = (row.mailHash ?? '').trim();
    if (h && isMailHash(h)) { out.add(h.toLowerCase()); continue; }
    const mid = row.messageId ?? '';
    if (isMailHash(mid)) { out.add(mid.toLowerCase()); continue; }
    if (mid.length > 0 || (row.from ?? '') || (row.date ?? '') || (row.subject ?? '')) {
      out.add(legacyMsgIdHash(mid.length > 0 ? mid : undefined, row.from ?? '', row.date ?? '', row.subject ?? ''));
    }
  }
  return out;
}

export function appendIndexRow(path: string, m: RawMail, mailHash: string): void {
  const row = [csvCell(mailHash), csvCell(m.messageId ?? ''), csvCell(m.date.toISOString()), csvCell(m.from), csvCell(m.subject), csvCell(m.mailbox), m.hasAttachment ? '1' : '0', String(m.bodyLinkCount)].join(',');
  appendFileSync(path, `${row}\n`, 'utf8');
  secureFileMode(path);
}

export function writeEmlAtomic(path: string, data: Buffer): void {
  // 唯一临时名 + POSIX 0700/0600（APP-22）：固定的 `<path>.tmp` 会在多实例并发
  // 抓取时互相覆盖，默认 umask 又会让邮件原件对同机其他账号可读。
  ensureSecureDir(dirname(path));
  const tmp = uniqueTempPath(path);
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
  secureFileMode(path);
}

export function monthDir(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

interface FetchState {
  cfg: Config;
  opts: FetchOpts;
  outDir: string;
  indexCsv: string;
  indexedMailHashes: Set<string>;
  store: StateStore;
  seen: number;
  saved: number;
  repaired: number;
  skippedKnown: number;
}

export async function openFetchState(opts: FetchOpts): Promise<FetchState | number> {
  let cfg: Config;
  try { cfg = loadConfig(resolve(opts.configPath)); } catch (e) { log.error((e as Error).message); return 2; }
  if (opts.sinceDaysOverride !== undefined) cfg = { ...cfg, filter: { ...cfg.filter, sinceDays: opts.sinceDaysOverride } };
  if (opts.sinceOverride !== undefined) cfg = { ...cfg, filter: { ...cfg.filter, since: opts.sinceOverride } };
  if (opts.untilOverride !== undefined) cfg = { ...cfg, filter: { ...cfg.filter, until: opts.untilOverride } };
  if (cfg.filter.since && cfg.filter.until && !boundsAreOrdered(cfg.filter.since, cfg.filter.until)) {
    log.error(`filter.since (${cfg.filter.since}) must be <= filter.until (${cfg.filter.until})`); return 2;
  }
  const missingCredentials = missingImapCredentials(cfg);
  if (missingCredentials.length > 0) {
    log.error(`尚未配置邮箱：请先在设置中填写 ${missingCredentials.join('、')} 后再抓取邮件。`); return 2;
  }
  const outDir = resolve(opts.outDir ?? cfg.paths.samples);
  // --dry-run 不写数据目录，因此不占锁。正式运行按写目标持锁（CORE-01，含 --out）。
  if (!opts.dryRun && !acquireCommandLock('fetch', { statePath: opts.statePath, configPath: opts.configPath }, cfg, { samplesDir: outDir, statePath: opts.statePath })) return 2;
  const indexCsv = join(outDir, 'INDEX.csv');
  if (!opts.dryRun) ensureIndexCsv(indexCsv);
  const indexedMailHashes = readIndexMailHashes(indexCsv);
  const statePath = resolve(opts.statePath);
  let store: StateStore;
  try {
    if (opts.dryRun) {
      // CORE-06：dry-run 只读 state，损坏时只报告、绝不 quarantine/重写。
      store = StateStore.openReadOnly(statePath);
      if (store.quarantine) log.warn(store.quarantine.message);
    } else {
      store = StateStore.open(statePath);
      await recoverQuarantinedState(store, cfg, outDir);
      // CORE-03：台账 mailHash 回填；读侧用 aliases 覆盖旧 12 位，不写多别名。
      backfillProcessedFromLedgers(store, cfg);
    }
  } catch (e) { log.error((e as Error).message); return 1; }
  return { cfg, opts, outDir, indexCsv, indexedMailHashes, store, seen: 0, saved: 0, repaired: 0, skippedKnown: 0 };
}

export function processFetchedMail(state: FetchState, mail: RawMail): void {
  state.seen++;
  // CORE-03：内容绑定 primary；fetched/INDEX 只用 evidence，绝不单靠 Message-Id 跳过。
  const identity = resolveMailIdentity({ messageId: mail.messageId, from: mail.from, date: mail.date.toISOString(), subject: mail.subject, raw: mail.raw });
  const hash = identity.primary;
  // APP-11：primary 缓存，或「字节完全一致」的 legacy 缓存，才算本邮件已抓取。
  // 仅文件名存在不够：共享 Message-Id 时 legacy 路径可能是另一封邮件的 .eml。
  const month = monthDir(mail.date);
  const primaryPath = join(state.outDir, month, `${hash}.eml`);
  const legacyPath = identity.legacy !== hash ? join(state.outDir, month, `${identity.legacy}.eml`) : undefined;
  const cachedPrimary = fileExistsNonEmpty(primaryPath);
  const cachedLegacyOwn = Boolean(legacyPath && fileExistsNonEmpty(legacyPath) && (() => {
    try { return readFileSync(legacyPath!).equals(mail.raw); } catch { return false; }
  })());
  const cached = cachedPrimary || cachedLegacyOwn;
  const emlPath = cachedPrimary ? primaryPath : (cachedLegacyOwn && legacyPath ? legacyPath : primaryPath);
  // 本邮件自己的 pre-upgrade 记录：legacy 文件字节与当前 raw 一致时，才把 legacy
  // 纳入 fetched 证据（认领本邮件升级前 state）；否则不得折叠另一封邮件。
  const fetchEvidence = cachedLegacyOwn ? [...new Set([...identity.evidence, identity.legacy])] : [...identity.evidence];
  if (state.store.hasFetchedAny(fetchEvidence) && cached) {
    // 读侧 evidence 命中即跳过；不回写多别名（非对称读写）。
    state.skippedKnown++; return;
  }
  if (state.opts.dryRun) {
    const why = state.store.hasFetchedAny(fetchEvidence) ? '(state 已记录但缓存缺失，需要重新抓取)' : '';
    log.info(`[dry-run] would save ${emlPath} (subject="${mail.subject}")${why}`); return;
  }
  if (!cached) {
    if (state.store.hasFetchedAny(fetchEvidence)) {
      state.repaired++; log.info(`cached eml missing/empty, re-fetching ${hash}: ${primaryPath}`);
    }
    writeEmlAtomic(primaryPath, mail.raw);
  } else log.info(`eml exists, skip write: ${emlPath}`);
  // INDEX 按 primary 去重，禁止 Message-Id legacy 单独充当「已索引」证据。
  if (!fetchEvidence.some((a) => state.indexedMailHashes.has(a))) {
    appendIndexRow(state.indexCsv, mail, hash);
    for (const a of fetchEvidence) state.indexedMailHashes.add(a);
  }
  // CORE-03 非对称写：只记 primary 一条。
  state.store.addFetched(hash);
  state.store.checkpoint();
  state.saved++;
  log.info(`saved ${hash} subject="${mail.subject}"`);
}

export function closeFetchState(state: FetchState): void {
  // 命令结束时显式 flush 并注销，未达阈值的增量才算真正落盘。
  // dry-run 的只读 store 未注册 activeStores，dispose 也是安全的空 flush。
  if (!state.opts.dryRun) state.store.dispose();
}

export async function cmdFetch(argv: string[]): Promise<number> {
  let parsed: FetchOpts | 'help';
  try { parsed = parseFetchArgs(argv); } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n`); process.stderr.write(FETCH_USAGE); return 2;
  }
  if (parsed === 'help') { process.stdout.write(FETCH_USAGE); return 0; }
  const opened = await openFetchState(parsed);
  if (typeof opened === 'number') return opened;
  const state = opened;
  try {
    for await (const mail of fetchMails(state.cfg, log)) processFetchedMail(state, mail);
    closeFetchState(state);
  } catch (e) {
    // 有界批量 checkpoint 必须在致命错误时显式 flush，否则本次已落盘的 .eml 会
    // 失去对应的 state 记录（CODE-07）。
    if (!state.opts.dryRun) {
      try { state.store.flush(); } catch (flushErr) { log.error(`state flush failed: ${(flushErr as Error).message}`); }
    }
    log.error(`fetch aborted: ${(e as Error).message}`); return 1;
  }
  log.info(`done: seen=${state.seen} saved=${state.saved} repaired=${state.repaired} skippedKnown=${state.skippedKnown} dryRun=${state.opts.dryRun}`);
  return 0;
}
