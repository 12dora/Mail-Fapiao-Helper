import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Browser } from 'playwright';
import { loadConfig, type Config } from '../config.js';
import { ArchiveRecoveryError, assertArchiveTransactionsRecovered } from '../download/archiveJournal.js';
import { emitTerminal, log } from '../log.js';
import { nonInvoiceReason } from '../mail/exclude.js';
import { parseMailWithGuards } from '../mail/fetcher.js';
import { persistPendingDurable, processMail, type ProcessMailResult } from '../pipeline.js';
import { fileExistsNonEmpty, StateStore, StateWriteError, type State } from '../state.js';
import { identityMatches, isMailHash, resolveMailIdentity } from '../util/hash.js';
import { parseRunArgs, type RunOpts } from './args.js';
import { launchBrowser } from './browser.js';
import { acquireCommandLock } from './lock.js';
import { backfillProcessedFromLedgers, collectEmlPaths, recoverQuarantinedState } from './rebuildState.js';
import { RUN_USAGE } from './usage.js';

type MailIdentity = ReturnType<typeof resolveMailIdentity>;
type ParsedMail = Awaited<ReturnType<typeof parseMailWithGuards>>;
type RunTerminalOutcome = 'ok' | 'failed' | 'mail_not_found' | 'fatal';

export class RunAccumulator {
  // 簇 C 终态计数：与 ProcessMailOutcome 一一对应（structured terminal event）。
  archived = 0;
  pending = 0;
  skipped = 0;
  failed = 0;
  /** 有票已归档但仍有待确认的邮件数（archived 的子集）。 */
  partial = 0;
  /** CORE-09：--only-mail 是否命中过目标（含 pending/<hash>.eml）。 */
  onlyMailMatched = false;
  readonly networkFailures: ProcessMailResult[] = [];

  recordOutcome(result: ProcessMailResult): void {
    if (result.reason === 'aborted') return;
    if ((result.outcome === 'pending_durable' || result.partial === true) && result.reason?.includes('network_retry_failed')) {
      this.networkFailures.push(result);
    }
    switch (result.outcome) {
      case 'archived':
        this.archived++;
        if (result.partial === true) this.partial++;
        break;
      case 'pending_durable': this.pending++; break;
      case 'skipped': this.skipped++; break;
      case 'retryable_failure':
        // BLOCKING 2：归档已成功但 pending 写失败时 partial=true——票已落盘，必须计入 archived。
        if (result.partial === true) { this.archived++; this.partial++; }
        this.failed++;
        break;
      case 'fatal_failure': this.failed++; break;
      default: this.failed++; break;
    }
  }

  /**
   * 结构化终态：任何退出路径（含 fatal / only-mail 未命中）都必须发出（BLOCKING 3/4）。
   * NEW DEFECT 2：网络失败诊断必须先于终态行，终态行是消费者看到的最后权威记录。
   * C6：outcome= 写在同一锚定行上，零计数失败不会被读成 success 闪绿。
   */
  emitRunTerminal(outcome: RunTerminalOutcome): void {
    // 先发 per-message 诊断，再发终态——有界 ring 不得把终态挤出窗口。
    if (this.networkFailures.length > 0) {
      log.warn(`Network retry failures moved to pending: ${this.networkFailures.length}`);
      for (const failure of this.networkFailures) {
        log.warn(`pending ${failure.hash} date=${failure.date} from="${failure.from}" subject="${failure.subject}" reason=${failure.reason}`);
      }
    }
    const processed = this.archived + this.pending;
    emitTerminal(
      `Run complete: processed=${processed}, partial=${this.partial}, skipped=${this.skipped}, failed=${this.failed}`
      + `, archived=${this.archived}, pending=${this.pending}, outcome=${outcome}`,
    );
  }
}

export interface RunContext {
  opts: RunOpts;
  cfg: Config;
  store: StateStore;
  accumulator: RunAccumulator;
  rawDir: string;
  pendingDir: string;
  inFlight: Set<string>;
  fatalAbort: AbortController;
  fatalError: unknown;
  browserInstance: Browser | undefined;
  browserPromise: Promise<Browser> | undefined;
  getBrowser: () => Promise<Browser>;
}

export async function openRunContext(opts: RunOpts): Promise<RunContext | number> {
  let cfg: Config;
  try { cfg = loadConfig(resolve(opts.configPath)); } catch (e) { log.error((e as Error).message); return 2; }
  if (!acquireCommandLock('pipeline', { statePath: opts.statePath, configPath: opts.configPath }, cfg, { statePath: opts.statePath })) return 2;
  try { assertArchiveTransactionsRecovered(resolve(cfg.paths.invoices)); } catch (e) { log.error((e as Error).message); return 1; }
  const statePath = resolve(opts.statePath);
  let store: StateStore;
  try {
    store = StateStore.open(statePath);
    await recoverQuarantinedState(store, cfg, resolve(cfg.paths.samples));
    // CORE-03：台账 mailHash 回填；读侧 aliases 覆盖旧 12 位，不 bulk 写别名。
    backfillProcessedFromLedgers(store, cfg);
  } catch (e) { log.error((e as Error).message); return 1; }

  let context: RunContext;
  const getBrowser = async (): Promise<Browser> => {
    if (!context.browserInstance) {
      // 当前站点 handler 默认不需要浏览器（EXT-09）；仅惰性启动。
      context.browserPromise ??= launchBrowser(cfg);
      context.browserInstance = await context.browserPromise;
    }
    return context.browserInstance;
  };
  context = {
    opts, cfg, store, accumulator: new RunAccumulator(), rawDir: cfg.paths.samples,
    pendingDir: resolve(cfg.paths.pending), inFlight: new Set<string>(),
    // CORE-02：致命错误时 abort 所有 worker，并在归档临界区前再次检查。
    fatalAbort: new AbortController(), fatalError: undefined,
    browserInstance: undefined, browserPromise: undefined, getBrowser,
  };
  log.info('Starting run...');
  return context;
}

function markOnlyMailIfMatch(context: RunContext, identity: MailIdentity, fileHash?: string): boolean {
  if (context.opts.onlyMail === undefined) return true;
  const target = context.opts.onlyMail.trim().toLowerCase();
  if (identityMatches(context.opts.onlyMail, identity)) {
    context.accumulator.onlyMailMatched = true;
    return true;
  }
  // 文件名本身就是用户指定的 hash（pending 重试常见）。
  if (fileHash && isMailHash(fileHash) && fileHash.toLowerCase() === target) {
    context.accumulator.onlyMailMatched = true;
    return true;
  }
  return false;
}

export function resolveCachedMailIdentity(mail: ParsedMail, raw: Buffer, fileHash: string): MailIdentity {
  return resolveMailIdentity({
    messageId: mail.messageId ?? undefined,
    from: mail.from?.text ?? '',
    date: mail.date?.toISOString() ?? '',
    subject: mail.subject ?? '',
    raw,
    fileHash: isMailHash(fileHash) ? fileHash : undefined,
  });
}

export function queueOversizedMail(context: RunContext, emlPath: string, raw: Buffer, fileHash: string, msg: string): void {
  // CORE-03e：沿用 .eml 文件名上的 fetch 身份，禁止 content-only 重算分叉。
  const identity = resolveMailIdentity({
    from: '', date: '', subject: '',
    fileHash: isMailHash(fileHash) ? fileHash : undefined,
    raw: isMailHash(fileHash) ? undefined : raw,
  });
  const hash = identity.primary;
  if (!markOnlyMailIfMatch(context, identity, fileHash)) return;
  const reason = 'mail_too_large_to_parse';
  log.warn(`mail too large, routing to pending: ${hash} (${msg})`);
  try {
    // EXT-05 / item 10：走 durable pending 原语，保留 fetch 时身份。
    persistPendingDurable({
      cfg: context.cfg,
      mailHash: hash,
      reason: '邮件过大无法解析（原始超过 32MB），请在待确认中手动选择发票文件归档',
      raw, messageId: '', date: '', from: '', subject: basename(emlPath),
    });
    context.store.addProcessed(hash);
    context.store.checkpoint();
    context.accumulator.pending++;
    // 与 degradeToPending 一致：批次明细靠 `Manual <hash>:` 组装（NON-BLOCKING 1）。
    log.info(`Manual ${hash}: ${reason}`);
  } catch (writeErr) {
    // item 9：StateWriteError 必须传播到 abort，不能被吞掉。
    if (writeErr instanceof StateWriteError) {
      if (!context.fatalError) context.fatalError = writeErr;
      context.fatalAbort.abort();
      throw writeErr;
    }
    // item 10：pending 写失败 = 可重试失败，计 failed，最终非 0 退出。
    context.accumulator.failed++;
    log.warn(`Failed to queue oversized mail ${emlPath} to pending: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
  }
}

export function shouldSkipMail(context: RunContext, mail: ParsedMail, identity: MailIdentity, fileHash: string): boolean {
  const hash = identity.primary;
  // CORE-03f / CORE-09：--only-mail 接受 12/32 位，匹配任意别名；未命中则跳过。
  if (!markOnlyMailIfMatch(context, identity, fileHash)) return true;
  // 并发去重只用 evidence，避免共享 Message-Id 的两封邮件互斥（CORE-03）。
  if (identity.evidence.some((a) => context.inFlight.has(a)) || context.inFlight.has(hash)) {
    context.accumulator.skipped++;
    return true;
  }
  const excludeReason = nonInvoiceReason({ from: mail.from?.text ?? '', subject: mail.subject ?? '' });
  if (excludeReason) {
    log.info(`Excluded ${hash}: ${excludeReason}`);
    // 明确排除的邮件视作 handled（skipped 语义：无需用户再处理）。
    context.accumulator.skipped++;
    context.store.addProcessed(hash);
    context.store.checkpoint();
    return true;
  }
  // CORE-03a：禁止仅凭 Message-Id 判定已处理；读侧只用 evidence。
  if (context.opts.onlyMail === undefined && !context.opts.force && context.store.hasProcessedAny(identity.evidence)) {
    context.accumulator.skipped++;
    return true;
  }
  return context.fatalAbort.signal.aborted;
}

export async function processOneMail(context: RunContext, mail: ParsedMail, identity: MailIdentity, raw: Buffer, fileHash: string): Promise<void> {
  const hash = identity.primary;
  context.inFlight.add(hash);
  for (const a of identity.evidence) context.inFlight.add(a);
  try {
    const already = context.store.hasProcessedAny(identity.evidence);
    const taskState: State = {
      // 只带当前邮件的判定所需：pipeline 用 evidence∩state 判断是否已处理。
      // 已处理时 seed primary 即可；写回也只记 primary。
      processedHashes: already ? [hash] : [],
      // pipeline 不读取 fetchedHashes，无需复制整份集合。
      fetchedHashes: [],
    };
    const taskSaveState = () => {
      for (const item of taskState.processedHashes) context.store.addProcessed(item);
      context.store.checkpoint();
    };
    const result = await processMail(mail, context.cfg, log, taskState, taskSaveState, context.getBrowser, {
      force: context.opts.force || context.opts.onlyMail !== undefined,
      raw,
      signal: context.fatalAbort.signal,
      fileHash: isMailHash(fileHash) ? fileHash : undefined,
    });
    for (const item of taskState.processedHashes) context.store.addProcessed(item);
    context.accumulator.recordOutcome(result);
  } finally {
    context.inFlight.delete(hash);
    for (const a of identity.evidence) context.inFlight.delete(a);
  }
}

export async function handleEml(context: RunContext, emlPath: string): Promise<void> {
  if (context.fatalAbort.signal.aborted) return;
  const raw = readFileSync(emlPath);
  // CORE-03e：缓存文件名即 fetch 时身份；超大邮件解析失败时必须沿用它。
  const fileHash = basename(emlPath, '.eml');
  let mail: ParsedMail;
  try {
    // 缓存的 .eml 同样是不可信输入：沿用抓取侧的大小上限、linkify 关闭与解析超时
    // （APP-09）。超限邮件转入待确认（EXT-05），不能静默 failed 后永久无法补档。
    mail = await parseMailWithGuards(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('mail_too_large_to_parse:')) {
      queueOversizedMail(context, emlPath, raw, fileHash, msg);
      return;
    }
    throw err;
  }
  const identity = resolveCachedMailIdentity(mail, raw, fileHash);
  if (shouldSkipMail(context, mail, identity, fileHash)) return;
  await processOneMail(context, mail, identity, raw, fileHash);
}

export async function runWorkers(context: RunContext): Promise<void> {
  // CORE-09：--only-mail 优先使用 pending/<hash>.eml（待确认页重试的权威副本）。
  let emlPaths: string[];
  if (context.opts.onlyMail !== undefined && isMailHash(context.opts.onlyMail)) {
    const target = context.opts.onlyMail.trim().toLowerCase();
    const pendingEml = join(context.pendingDir, `${target}.eml`);
    if (fileExistsNonEmpty(pendingEml)) {
      emlPaths = [pendingEml];
      context.accumulator.onlyMailMatched = true;
    } else {
      // 再扫 samples；文件名直接等于 target 时也算命中。
      const all = await collectEmlPaths(context.rawDir);
      const byName = all.filter((p) => basename(p, '.eml').toLowerCase() === target);
      emlPaths = byName.length > 0 ? byName : all;
    }
  } else emlPaths = await collectEmlPaths(context.rawDir);
  let next = 0;
  const workerCount = Math.min(context.opts.concurrency, Math.max(emlPaths.length, 1));
  log.info(`Queued ${emlPaths.length} cached emails with concurrency=${workerCount}`);
  const worker = async (): Promise<void> => {
    while (true) {
      if (context.fatalAbort.signal.aborted) return;
      const emlPath = emlPaths[next++];
      if (!emlPath) return;
      try { await handleEml(context, emlPath); } catch (err) {
        // Iron rule: state writes and unsafe archive recovery failures must
        // abort the whole run. 用 allSettled 等全部 worker 退出后再离开锁域
        // （CORE-02），不要靠 Promise.all 的提前 reject。
        if (err instanceof StateWriteError || err instanceof ArchiveRecoveryError) {
          if (!context.fatalError) context.fatalError = err;
          context.fatalAbort.abort();
          return;
        }
        context.accumulator.failed++;
        log.warn(`Failed to process ${emlPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
  if (context.fatalError) throw context.fatalError;
  // 有界批量 checkpoint 之后必须显式 flush 并注销，命令结束时状态才算真正落盘。
  context.store.dispose();
}

/**
   * 结构化终态 outcome 字段（与 Electron live parser 约定）：
   * - `ok`             — 无失败、非 only-mail 未命中
   * - `failed`         — 有 failed 计数（具体 partial/failed 仍看计数）
   * - `mail_not_found` — `--only-mail` 目标未命中（零计数也不得渲染为成功）
   * - `fatal`          — StateWrite/ArchiveRecovery 等整次中止
   *
   * 行格式（字段顺序固定，outcome 始终在末尾）：
   * `Run complete: processed=N, partial=N, skipped=N, failed=N, archived=N, pending=N, outcome=<token>`
   */
export function finalizeRun(context: RunContext, outcome: RunTerminalOutcome, exitCode: number): number {
  let terminalOutcome = outcome;
  let code = exitCode;
  // 成功路径：在 finally（含 browser close 日志）之后再判定 only-mail / failed。
  // catch 已写入 exitCode=1 时不得覆盖 fatal/mail_not_found outcome。
  if (code === 0) {
    // CORE-09 / C6：--only-mail 未命中 → 非 0，且终态行带 outcome=mail_not_found。
    if (context.opts.onlyMail !== undefined && !context.accumulator.onlyMailMatched) {
      log.error(`mail_not_found: only-mail target not found (${context.opts.onlyMail})`);
      terminalOutcome = 'mail_not_found'; code = 1;
    } else {
      // CORE-04：任一 retryable/fatal failure → 非 0；全成功才是 0。
      terminalOutcome = context.accumulator.failed > 0 ? 'failed' : 'ok';
      code = context.accumulator.failed > 0 ? 1 : 0;
    }
  }
  // BLOCKING 3/4 + NEW DEFECT 2：权威终态必须是命令的最后输出
  //（网络诊断 → 本行；覆盖 success / partial / failed / fatal / mail_not_found）。
  // processed = archived + pending（不含 skipped/failed）。
  context.accumulator.emitRunTerminal(terminalOutcome);
  return code;
}

export async function cmdRun(argv: string[]): Promise<number> {
  let parsed: RunOpts | 'help';
  try { parsed = parseRunArgs(argv); } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n`); process.stderr.write(RUN_USAGE); return 2;
  }
  if (parsed === 'help') { process.stdout.write(RUN_USAGE); return 0; }
  const opened = await openRunContext(parsed);
  if (typeof opened === 'number') return opened;
  const context = opened;
  // 终态 outcome / 退出码在 try·catch·finally 之后统一发出（NEW DEFECT 2：终态最后）。
  let exitCode = 0;
  let terminalOutcome: RunTerminalOutcome = 'ok';
  try { await runWorkers(context); } catch (e) {
    try { context.store.flush(); } catch (flushErr) { log.error(`state flush failed: ${(flushErr as Error).message}`); }
    log.error(`run aborted: ${(e as Error).message}`);
    // CORE-09：fatal 路径上若 only-mail 也未命中，优先标 mail_not_found。
    if (context.opts.onlyMail !== undefined && !context.accumulator.onlyMailMatched) {
      log.error(`mail_not_found: only-mail target not found (${context.opts.onlyMail})`);
      terminalOutcome = 'mail_not_found';
    } else terminalOutcome = 'fatal';
    exitCode = 1;
  } finally {
    if (context.browserInstance) {
      // Never let a browser-teardown failure turn a successful run into exit 1;
      // the documents are already archived by this point.
      await context.browserInstance.close().catch((err) => {
        log.warn(`browser close failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }
  return finalizeRun(context, terminalOutcome, exitCode);
}
