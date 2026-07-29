#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { loadConfig, type Config } from './config.js';
import { fetchMails, missingImapCredentials, parseMailWithGuards, type RawMail } from './mail/fetcher.js';
import { nonInvoiceReason } from './mail/exclude.js';
import { log } from './log.js';
import {
  ensureSecureDir,
  fileExistsNonEmpty,
  flushActiveStates,
  secureFileMode,
  StateStore,
  StateWriteError,
  uniqueTempPath,
  type State,
} from './state.js';
import {
  acquireDataDirLock,
  resolveDataDir,
  type DataDirHints,
  type DataDirLease,
  type DataOpKind,
} from './util/dataDirLock.js';
import { boundsAreOrdered, isValidDateBound } from './util/dateRange.js';
import { msgIdHash } from './util/hash.js';
import { ArchiveRecoveryError, assertArchiveTransactionsRecovered } from './download/archiveJournal.js';
import { processMail } from './pipeline.js';
import type { ProcessMailResult } from './pipeline.js';
import { organizeFromOcrResults } from './rename/rename.js';
import { runOcrPending } from './ocr/runner.js';
import { stopEfapiaoServices } from './ocr/efapiao.js';
import { summarizeOcr } from './ocr/summary.js';
import { pendingEmlExists, summarizePending } from './pending/summary.js';
import { readCsvRows, csvCell, ensureCsvSchema, parseCsvLine } from './util/csv.js';

const ROOT_USAGE = `mfh — Mail Fapiao Helper

Usage:
  mfh <command> [options]

Commands:
  fetch          Fetch matching mails as .eml into samples/raw/
  run            Process emails and extract invoices
  ocr            Run OCR for archived documents
  pending        Inspect manual processing queue
  organize       Copy archived invoices into optional OCR-based names/folders
  rebuild-state  Rebuild state.json from INDEX/cache/invoices.csv (no data deleted)

Options:
  -h, --help    Show this help

Run 'mfh <command> --help' for command-specific options.
`;

/**
 * 可选浏览器启动（APP-19 / EXT-09 / WIRE-03）。
 *
 * 当前站点处理器均不依赖 Playwright page，普通 HTTP 下载不需要浏览器。
 * 仅当未来 handler 声明需要浏览器、或显式调用 getBrowser 时才会走到这里。
 * 应用**不会**自动下载浏览器；桌面版优先系统 Chrome / Edge。
 */
async function launchBrowser(cfg: Config): Promise<Browser> {
  const launchOptions = {
    headless: cfg.playwright.headless,
    timeout: cfg.playwright.timeoutMs,
  };
  const desktopApp = process.env.MFH_APP_ROOT || process.env.MFH_RESOURCE_ROOT;
  const failures: string[] = [];
  const attempts: Array<() => Promise<Browser>> = desktopApp
    ? [
      () => chromium.launch({ ...launchOptions, channel: 'chrome' }),
      () => chromium.launch({ ...launchOptions, channel: 'msedge' }),
      () => chromium.launch(launchOptions),
    ]
    : [
      () => chromium.launch(launchOptions),
      () => chromium.launch({ ...launchOptions, channel: 'chrome' }),
      () => chromium.launch({ ...launchOptions, channel: 'msedge' }),
    ];
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  throw new Error(
    '可选的浏览器自动化未能启动：本机没有找到可用的 Chrome、Microsoft Edge 或 Playwright Chromium。'
    + '当前发票站点下载默认只走 HTTP，一般不需要浏览器；若你未使用依赖浏览器的扩展处理器，可忽略本错误。'
    + `原始错误：${failures[failures.length - 1] ?? 'unknown'}`,
  );
}

const PENDING_USAGE = `mfh pending — inspect manual processing queue

Usage:
  mfh pending <command> [options]

Commands:
  list    List emails currently in pending.csv

Options:
  --config <path>      Path to config.json        (default: ./config.json)
  --json               Print machine-readable summary for GUI integration
  -h, --help           Show this help
`;

const ORGANIZE_USAGE = `mfh organize — copy archived invoices into optional OCR-based names/folders

Usage:
  mfh organize [options]

Options:
  --config <path>       Path to config.json                 (default: ./config.json)
  --results-csv <path>  OCR result CSV to consume           (default: config.ocr.resultsCsv)
  --out <dir>           Organized output directory          (default: config.rename.organizedDir)
  --apply-rename        Force OCR-based renaming for this run (overrides config.rename.applyAfterOcr)
  --no-apply-rename     Disable OCR-based renaming for this run
  -h, --help            Show this help

Notes:
  * This command does not call OCR or LLM providers.
  * It never moves or overwrites the original files in config.paths.invoices.
`;

const OCR_USAGE = `mfh ocr — run OCR for archived documents

Usage:
  mfh ocr <command> [options]

Commands:
  run      Parse documents listed in invoices/ocr/ocr-pending.csv
  summary  Summarize recognized / failed / ignored OCR queue state

Options:
  --config <path>      Path to config.json        (default: ./config.json)
  --force              Re-parse rows already present in ocr.resultsCsv
  --single-item        Parse files one by one for visible progress and checkpoint resume
  --concurrency <n>    Parse up to N files in parallel
  --allow-parse-failures
                       Exit 0 when OCR transport completed but some rows failed to parse
  --json               Print machine-readable summary for GUI integration
  -h, --help           Show this help
`;

const FETCH_USAGE = `mfh fetch — fetch matching mails as .eml

Usage:
  mfh fetch [options]

Options:
  --config <path>      Path to config.json        (default: ./config.json)
  --state <path>       Path to state.json         (default: ./state.json)
  --out <dir>          Output dir for samples     (default: config.paths.samples)
  --since-days <n>     Use a rolling N-day window (overrides config.filter.sinceDays)
  --since <date>       Lower bound, inclusive     (YYYY-MM-DD or ISO 8601)
  --until <date>       Upper bound, inclusive     (YYYY-MM-DD or ISO 8601)
  --dry-run            Do not write files; only log what would happen
  -h, --help           Show this help

Notes:
  * --since / --until take precedence over --since-days (and the corresponding
    config fields). You can use either bound alone.
  * Both bounds accept whole-day dates (YYYY-MM-DD) or full ISO timestamps.
  * YYYY-MM-DD is interpreted in the LOCAL calendar: --until 2026-07-27 includes
    the whole local day. A full ISO timestamp keeps its exact instant and is
    never widened by 24 hours.
`;

const REBUILD_STATE_USAGE = `mfh rebuild-state — rebuild state.json from on-disk evidence

Usage:
  mfh rebuild-state [options]

Options:
  --config <path>      Path to config.json        (default: ./config.json)
  --state <path>       Path to state.json         (default: ./state.json)
  --out <dir>          Cached mail dir to scan    (default: config.paths.samples)
  --dry-run            Only report what would be rebuilt
  -h, --help           Show this help

Notes:
  * Only state.json is rewritten. Cached .eml files, INDEX.csv, invoices.csv,
    archived documents and the pending queue are never deleted or modified.
  * A corrupt state.json is moved aside to a timestamped .bak first.
`;

interface FetchOpts {
  configPath: string;
  statePath: string;
  outDir: string | undefined;
  sinceDaysOverride: number | undefined;
  sinceOverride: string | undefined;
  untilOverride: string | undefined;
  dryRun: boolean;
}

interface OrganizeOpts {
  configPath: string;
  resultsCsv: string | undefined;
  outDir: string | undefined;
  applyRename: boolean | undefined;
}

interface OcrOpts {
  command: 'run' | 'summary';
  configPath: string;
  force: boolean;
  singleItem: boolean;
  concurrency: number;
  allowParseFailures: boolean;
  json: boolean;
}

function parseFetchArgs(argv: string[]): FetchOpts | 'help' {
  const opts: FetchOpts = {
    configPath: './config.json',
    statePath: './state.json',
    outDir: undefined,
    sinceDaysOverride: undefined,
    sinceOverride: undefined,
    untilOverride: undefined,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--dry-run') { opts.dryRun = true; continue; }
    if (a === '--config') { opts.configPath = requireValue(argv, ++i, a); continue; }
    if (a === '--state') { opts.statePath = requireValue(argv, ++i, a); continue; }
    if (a === '--out') { opts.outDir = requireValue(argv, ++i, a); continue; }
    if (a === '--since-days') {
      const v = Number(requireValue(argv, ++i, a));
      if (!Number.isFinite(v) || v <= 0) throw new Error(`--since-days expects a positive number`);
      opts.sinceDaysOverride = v;
      continue;
    }
    if (a === '--since') {
      const v = requireValue(argv, ++i, a);
      if (!isValidDateBound(v)) throw new Error(`--since="${v}" is not a parseable date`);
      opts.sinceOverride = v;
      continue;
    }
    if (a === '--until') {
      const v = requireValue(argv, ++i, a);
      if (!isValidDateBound(v)) throw new Error(`--until="${v}" is not a parseable date`);
      opts.untilOverride = v;
      continue;
    }
    throw new Error(`unknown option: ${a}`);
  }
  // 用与抓取窗口一致的边界解释来比较，避免 date-only 与完整 timestamp 混用时误判。
  if (opts.sinceOverride && opts.untilOverride
      && !boundsAreOrdered(opts.sinceOverride, opts.untilOverride)) {
    throw new Error(`--since must be <= --until`);
  }
  return opts;
}

function parseOrganizeArgs(argv: string[]): OrganizeOpts | 'help' {
  const opts: OrganizeOpts = {
    configPath: './config.json',
    resultsCsv: undefined,
    outDir: undefined,
    applyRename: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--config') { opts.configPath = requireValue(argv, ++i, a); continue; }
    if (a === '--results-csv') { opts.resultsCsv = requireValue(argv, ++i, a); continue; }
    if (a === '--out') { opts.outDir = requireValue(argv, ++i, a); continue; }
    if (a === '--apply-rename') { opts.applyRename = true; continue; }
    if (a === '--no-apply-rename') { opts.applyRename = false; continue; }
    throw new Error(`unknown option: ${a}`);
  }
  return opts;
}

function parseOcrArgs(argv: string[]): OcrOpts | 'help' {
  if (argv.length === 0) return 'help';
  const [subcmd, ...rest] = argv;
  if (subcmd === '-h' || subcmd === '--help') return 'help';
  if (subcmd !== 'run' && subcmd !== 'summary') throw new Error(`unknown ocr command: ${subcmd}`);

  const opts: OcrOpts = {
    command: subcmd,
    configPath: './config.json',
    force: false,
    singleItem: false,
    concurrency: 1,
    allowParseFailures: false,
    json: false,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--force') { opts.force = true; continue; }
    if (a === '--single-item') { opts.singleItem = true; continue; }
    if (a === '--concurrency') {
      const v = Number(requireValue(rest, ++i, a));
      if (!Number.isInteger(v) || v <= 0) throw new Error('--concurrency expects a positive integer');
      opts.concurrency = v;
      continue;
    }
    if (a === '--allow-parse-failures') { opts.allowParseFailures = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--config') { opts.configPath = requireValue(rest, ++i, a); continue; }
    throw new Error(`unknown option: ${a}`);
  }
  if (opts.command === 'summary' && (opts.force || opts.singleItem || opts.concurrency !== 1 || opts.allowParseFailures)) {
    throw new Error('--force, --single-item, --concurrency and --allow-parse-failures are only valid for mfh ocr run');
  }
  return opts;
}

function requireValue(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined || v.startsWith('-')) throw new Error(`${flag} requires a value`);
  return v;
}

// ---------------------------------------------------------------------------
// 数据目录跨进程锁（APP-05）
// ---------------------------------------------------------------------------

/**
 * 本进程持有的数据目录租约。GUI 侧由 `OperationCoordinator` 持有同一把锁，
 * 两侧共用 `src/util/dataDirLock.ts` 描述的同一套锁文件协议，因此
 * 「GUI 挡住 CLI」「CLI 挡住 GUI」「两个 CLI 实例互斥」三条都成立。
 */
let activeDataDirLease: DataDirLease | undefined;

/**
 * CORE-01：锁身份必须覆盖实际写入目标，不能单靠 `--state` 父目录。
 * 两个 CLI 若用不同 state 路径但同一 invoices/csv，必须争同一把锁。
 */
function commonPathPrefix(a: string, b: string): string {
  const left = resolve(a).split(sep);
  const right = resolve(b).split(sep);
  const out: string[] = [];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) break;
    out.push(left[i]!);
  }
  if (out.length === 0) return '';
  // Windows 盘符根：`C:` → `C:\`
  if (out.length === 1 && /^[A-Za-z]:$/.test(out[0]!)) return `${out[0]}${sep}`;
  return out.join(sep) || sep;
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith('..'));
}

/**
 * 从 config 的实际写目标推导锁目录。优先 MFH_DATA_DIR；否则取 samples /
 * invoices / pending / output.csv 父目录的公共前缀；无法收敛时锁 invoices 本身。
 */
function resolveLockDataDir(cfg: Config, hints: DataDirHints = {}): string {
  const fromEnv = process.env.MFH_DATA_DIR;
  if (fromEnv && fromEnv.length > 0) return resolve(fromEnv);

  const writeDirs = [
    resolve(cfg.paths.samples),
    resolve(cfg.paths.invoices),
    resolve(cfg.paths.pending),
    dirname(resolve(cfg.output.csv)),
  ];
  let common = writeDirs[0]!;
  for (const d of writeDirs.slice(1)) {
    common = commonPathPrefix(common, d);
    if (!common) break;
  }
  // 公共前缀退化为盘符/根时，改锁 invoices（主归档面），避免整盘一把锁。
  const degenerate = !common || common === sep || /^[A-Za-z]:\\?$/.test(common);
  const lockDir = degenerate ? resolve(cfg.paths.invoices) : common;

  // 若调用方还传了 --state，且 state 落在另一棵树上：仍以写目标为准持锁，
  // 并打一条警告——state 隔离不能换来双写台账。
  if (hints.statePath && hints.statePath.length > 0) {
    const stateDir = dirname(resolve(hints.statePath));
    if (!isPathInside(lockDir, stateDir) && !isPathInside(stateDir, lockDir)) {
      log.warn(
        `state 路径（${stateDir}）不在业务数据锁目录（${lockDir}）内；`
        + `锁按 invoices/samples/pending/csv 持有，避免两个 --state 并发写同一台账。`,
      );
    }
  }
  return lockDir;
}

/**
 * 会写数据目录的命令入口统一走这里。拿不到锁时只打印中文提示，由调用方返回
 * 退出码 2，不抛栈。只读命令与 `--dry-run` 不需要调用本函数。
 *
 * 已加载 config 时必须传入 `cfg`，以便 CORE-01 按写目标持锁。
 */
function acquireCommandLock(kind: DataOpKind, hints: DataDirHints, cfg?: Config): boolean {
  const dataDir = cfg ? resolveLockDataDir(cfg, hints) : resolveDataDir(hints);
  const result = acquireDataDirLock(dataDir, kind);
  if (!result.ok) {
    log.error(result.message);
    return false;
  }
  activeDataDirLease = result.lease;
  if (result.lease.inherited) {
    log.debug(`data dir lock inherited from parent process (${result.lease.lockPath})`);
  }
  return true;
}

/** 幂等释放；正常结束、异常与信号退出三条路径都会走到。 */
function releaseDataDirLock(): void {
  const lease = activeDataDirLease;
  activeDataDirLease = undefined;
  if (!lease) return;
  try {
    lease.release();
  } catch {
    // best-effort：释放失败会留下一把锁，下次由陈旧回收清理。
  }
}

const INDEX_HEADER = 'messageId,date,from,subject,mailbox,hasAttachment,bodyLinkCount';

function ensureIndexCsv(path: string): void {
  // CORE-05：空文件也要写表头，不能只判断 exists。
  ensureSecureDir(dirname(path));
  ensureCsvSchema(path, INDEX_HEADER);
  secureFileMode(path);
}

/**
 * 一次性读出 INDEX.csv 已有的 messageId 集合。旧实现对每封邮件都重读整表，
 * 邮件量增大后同样呈二次成本（CODE-07）。
 */
function readIndexMessageIds(path: string): Set<string> {
  const out = new Set<string>();
  if (!existsSync(path)) return out;
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const first = parseCsvLine(line)[0] ?? '';
    if (first.length > 0) out.add(first);
  }
  return out;
}

function appendIndexRow(path: string, m: RawMail): void {
  const row = [
    csvCell(m.messageId ?? ''),
    csvCell(m.date.toISOString()),
    csvCell(m.from),
    csvCell(m.subject),
    csvCell(m.mailbox),
    m.hasAttachment ? '1' : '0',
    String(m.bodyLinkCount),
  ].join(',');
  appendFileSync(path, `${row}\n`, 'utf8');
}

function writeEmlAtomic(path: string, data: Buffer): void {
  // 唯一临时名 + POSIX 0700/0600（APP-22）：固定的 `<path>.tmp` 会在多实例并发
  // 抓取时互相覆盖，默认 umask 又会让邮件原件对同机其他账号可读。
  ensureSecureDir(dirname(path));
  const tmp = uniqueTempPath(path);
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
  secureFileMode(path);
}

function monthDir(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

async function cmdFetch(argv: string[]): Promise<number> {
  let parsed: FetchOpts | 'help';
  try {
    parsed = parseFetchArgs(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n`);
    process.stderr.write(FETCH_USAGE);
    return 2;
  }
  if (parsed === 'help') { process.stdout.write(FETCH_USAGE); return 0; }
  const opts = parsed;

  let cfg: Config;
  try {
    cfg = loadConfig(resolve(opts.configPath));
  } catch (e) {
    log.error((e as Error).message);
    return 2;
  }
  if (opts.sinceDaysOverride !== undefined) {
    cfg = { ...cfg, filter: { ...cfg.filter, sinceDays: opts.sinceDaysOverride } };
  }
  if (opts.sinceOverride !== undefined) {
    cfg = { ...cfg, filter: { ...cfg.filter, since: opts.sinceOverride } };
  }
  if (opts.untilOverride !== undefined) {
    cfg = { ...cfg, filter: { ...cfg.filter, until: opts.untilOverride } };
  }
  if (cfg.filter.since && cfg.filter.until && !boundsAreOrdered(cfg.filter.since, cfg.filter.until)) {
    log.error(`filter.since (${cfg.filter.since}) must be <= filter.until (${cfg.filter.until})`);
    return 2;
  }
  const missingCredentials = missingImapCredentials(cfg);
  if (missingCredentials.length > 0) {
    log.error(`尚未配置邮箱：请先在设置中填写 ${missingCredentials.join('、')} 后再抓取邮件。`);
    return 2;
  }
  // --dry-run 不写数据目录，因此不占锁。正式运行按写目标持锁（CORE-01）。
  if (!opts.dryRun && !acquireCommandLock('fetch', { statePath: opts.statePath, configPath: opts.configPath }, cfg)) return 2;

  const outDir = resolve(opts.outDir ?? cfg.paths.samples);
  const indexCsv = join(outDir, 'INDEX.csv');
  if (!opts.dryRun) ensureIndexCsv(indexCsv);
  const indexedMessageIds = readIndexMessageIds(indexCsv);

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
    }
  } catch (e) {
    log.error((e as Error).message);
    return 1;
  }

  let seen = 0;
  let saved = 0;
  let repaired = 0;
  let skippedKnown = 0;

  try {
    for await (const mail of fetchMails(cfg, log)) {
      seen++;
      // CORE-03：把原始字节并入身份，避免重复/缺失 Message-Id 折叠不同邮件。
      const hash = msgIdHash(
        mail.messageId,
        mail.from,
        mail.date.toISOString(),
        mail.subject,
        mail.raw,
      );
      // APP-11：先解析预期的 .eml 目标路径，只有 state 命中**且**文件存在且非空
      // 才跳过。否则换缓存目录 / 删除样本后，state 会谎称邮件已知，新目录永远为空。
      const emlPath = join(outDir, monthDir(mail.date), `${hash}.eml`);
      const cached = fileExistsNonEmpty(emlPath);
      if (store.hasFetched(hash) && cached) {
        skippedKnown++;
        continue;
      }

      if (opts.dryRun) {
        const why = store.hasFetched(hash) ? '(state 已记录但缓存缺失，需要重新抓取)' : '';
        log.info(`[dry-run] would save ${emlPath} (subject="${mail.subject}")${why}`);
        continue;
      }

      if (!cached) {
        if (store.hasFetched(hash)) {
          repaired++;
          log.info(`cached eml missing/empty, re-fetching ${hash}: ${emlPath}`);
        }
        writeEmlAtomic(emlPath, mail.raw);
      } else {
        log.info(`eml exists, skip write: ${emlPath}`);
      }

      // 缓存补写后同样修复 INDEX，避免出现「文件在但索引缺行」的空目录假象。
      const midKey = mail.messageId ?? '';
      if (midKey.length === 0 || !indexedMessageIds.has(midKey)) {
        appendIndexRow(indexCsv, mail);
        if (midKey.length > 0) indexedMessageIds.add(midKey);
      }

      store.addFetched(hash);
      store.checkpoint();
      saved++;
      log.info(`saved ${hash} subject="${mail.subject}"`);
    }
    // 命令结束时显式 flush 并注销，未达阈值的增量才算真正落盘。
    // dry-run 的只读 store 未注册 activeStores，dispose 也是安全的空 flush。
    if (!opts.dryRun) store.dispose();
  } catch (e) {
    // 有界批量 checkpoint 必须在致命错误时显式 flush，否则本次已落盘的 .eml 会
    // 失去对应的 state 记录（CODE-07）。
    if (!opts.dryRun) {
      try {
        store.flush();
      } catch (flushErr) {
        log.error(`state flush failed: ${(flushErr as Error).message}`);
      }
    }
    log.error(`fetch aborted: ${(e as Error).message}`);
    return 1;
  }

  log.info(`done: seen=${seen} saved=${saved} repaired=${repaired} skippedKnown=${skippedKnown} dryRun=${opts.dryRun}`);
  return 0;
}

const RUN_USAGE = `mfh run — process emails and extract invoices

Usage:
  mfh run [options]

Options:
  --config <path>      Path to config.json        (default: ./config.json)
  --state <path>       Path to state.json         (default: ./state.json)
  --only-mail <hash>   Process one msgIdHash, even if already processed
  --concurrency <n>    Process up to N cached emails in parallel (default: 4)
  --force              Re-process cached emails even if state says they were handled
  -h, --help           Show this help
`;

interface RunOpts {
  configPath: string;
  statePath: string;
  onlyMail: string | undefined;
  concurrency: number;
  force: boolean;
}

function parseRunArgs(argv: string[]): RunOpts | 'help' {
  const opts: RunOpts = {
    configPath: './config.json',
    statePath: './state.json',
    onlyMail: undefined,
    concurrency: 4,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--config') { opts.configPath = requireValue(argv, ++i, a); continue; }
    if (a === '--state') { opts.statePath = requireValue(argv, ++i, a); continue; }
    if (a === '--only-mail') { opts.onlyMail = requireValue(argv, ++i, a); continue; }
    if (a === '--force') { opts.force = true; continue; }
    if (a === '--concurrency') {
      const v = Number(requireValue(argv, ++i, a));
      if (!Number.isInteger(v) || v <= 0) throw new Error('--concurrency expects a positive integer');
      opts.concurrency = v;
      continue;
    }
    throw new Error(`unknown option: ${a}`);
  }
  return opts;
}

async function* walkEmls(dir: string): AsyncGenerator<string> {
  if (!existsSync(dir)) return;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkEmls(fullPath);
    } else if (entry.isFile() && entry.name.endsWith('.eml')) {
      yield fullPath;
    }
  }
}

async function collectEmlPaths(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const emlPath of walkEmls(dir)) out.push(emlPath);
  return out;
}

function archivedMessageIdSet(cfg: Config): Set<string> {
  return new Set(readCsvRows(resolve(cfg.output.csv))
    .map((row) => row.messageId ?? '')
    .filter((messageId) => messageId.length > 0));
}

// ---------------------------------------------------------------------------
// 状态重建（APP-18A）：只读缓存与台账，不删除任何业务数据
// ---------------------------------------------------------------------------

/**
 * msgIdHash 输出形态：历史 12 位，或 CORE-03 有 raw 时的 32 位（128 bit）。
 * 真实 Message-Id 必然含 `@`，不会与裸 hash 混淆。
 */
const BARE_HASH_RE = /^[0-9a-f]{12}$|^[0-9a-f]{32}$/;

/**
 * 台账行 -> 运行期身份。pipeline 写 CSV 时 messageId 取 `mail.messageId || hash`，
 * 所以看起来就是裸 hash 的行直接采用，其余按同一个 msgIdHash 重算。
 */
function hashFromLedgerRow(row: Record<string, string>): string {
  const messageId = row.messageId ?? '';
  if (BARE_HASH_RE.test(messageId)) return messageId;
  return msgIdHash(
    messageId.length > 0 ? messageId : undefined,
    row.from ?? '',
    row.date ?? '',
    row.subject ?? '',
  );
}

/**
 * 缓存 .eml 的文件名就是 fetch 身份，因此这是唯一可信的 fetched 证据来源：
 * 文件不在（或为空）就不该记为已抓取，否则又会回到 APP-11 的空目录假象。
 */
async function fetchedHashesFromCache(samplesDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const emlPath of await collectEmlPaths(samplesDir)) {
    if (!fileExistsNonEmpty(emlPath)) continue;
    const hash = basename(emlPath, '.eml');
    if (hash.length > 0) out.push(hash);
  }
  return out;
}

/** 从 invoices.csv（已归档）与 pending.csv（已进入待确认）恢复 processed 身份。 */
function processedHashesFromLedgers(cfg: Config): string[] {
  const out: string[] = [];
  for (const row of readCsvRows(resolve(cfg.output.csv))) out.push(hashFromLedgerRow(row));
  for (const row of readCsvRows(join(resolve(cfg.paths.pending), 'pending.csv'))) {
    out.push(hashFromLedgerRow(row));
  }
  return out.filter((h) => h.length > 0);
}

async function rebuildStateFromDisk(cfg: Config, samplesDir: string): Promise<State> {
  return {
    processedHashes: processedHashesFromLedgers(cfg),
    fetchedHashes: await fetchedHashesFromCache(samplesDir),
  };
}

/**
 * state.json 损坏时的自动恢复：损坏文件已由 StateStore 隔离到带时间戳的备份，
 * 这里再从 INDEX/缓存/invoices.csv 重建可恢复身份，让 fetch/run 能继续跑完。
 */
async function recoverQuarantinedState(store: StateStore, cfg: Config, samplesDir: string): Promise<void> {
  if (!store.quarantine) return;
  log.warn(store.quarantine.message);
  const rebuilt = await rebuildStateFromDisk(cfg, samplesDir);
  store.replaceAll(rebuilt);
  log.info(`state rebuilt from disk: fetched=${store.fetchedCount} processed=${store.processedCount}`);
}

interface RebuildStateOpts {
  configPath: string;
  statePath: string;
  outDir: string | undefined;
  dryRun: boolean;
}

function parseRebuildStateArgs(argv: string[]): RebuildStateOpts | 'help' {
  const opts: RebuildStateOpts = {
    configPath: './config.json',
    statePath: './state.json',
    outDir: undefined,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--dry-run') { opts.dryRun = true; continue; }
    if (a === '--config') { opts.configPath = requireValue(argv, ++i, a); continue; }
    if (a === '--state') { opts.statePath = requireValue(argv, ++i, a); continue; }
    if (a === '--out') { opts.outDir = requireValue(argv, ++i, a); continue; }
    throw new Error(`unknown option: ${a}`);
  }
  return opts;
}

async function cmdRebuildState(argv: string[]): Promise<number> {
  let parsed: RebuildStateOpts | 'help';
  try {
    parsed = parseRebuildStateArgs(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n`);
    process.stderr.write(REBUILD_STATE_USAGE);
    return 2;
  }
  if (parsed === 'help') { process.stdout.write(REBUILD_STATE_USAGE); return 0; }

  let cfg: Config;
  try {
    cfg = loadConfig(resolve(parsed.configPath));
  } catch (e) {
    log.error((e as Error).message);
    return 2;
  }

  const samplesDir = resolve(parsed.outDir ?? cfg.paths.samples);
  const statePath = resolve(parsed.statePath);
  try {
    const rebuilt = await rebuildStateFromDisk(cfg, samplesDir);
    if (parsed.dryRun) {
      log.info(`[dry-run] would rebuild ${statePath}: fetched=${new Set(rebuilt.fetchedHashes).size} processed=${new Set(rebuilt.processedHashes).size}`);
      return 0;
    }
    if (!acquireCommandLock('pipeline', { statePath: parsed.statePath, configPath: parsed.configPath }, cfg)) return 2;
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
    store.dispose();
    return 0;
  } catch (e) {
    log.error(`rebuild-state failed: ${(e as Error).message}`);
    return 1;
  }
}

async function cmdRun(argv: string[]): Promise<number> {
  let parsed: RunOpts | 'help';
  try {
    parsed = parseRunArgs(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n`);
    process.stderr.write(RUN_USAGE);
    return 2;
  }
  if (parsed === 'help') { process.stdout.write(RUN_USAGE); return 0; }
  const opts = parsed;

  let cfg: Config;
  try {
    cfg = loadConfig(resolve(opts.configPath));
  } catch (e) {
    log.error((e as Error).message);
    return 2;
  }

  if (!acquireCommandLock('pipeline', { statePath: opts.statePath, configPath: opts.configPath }, cfg)) return 2;

  try {
    assertArchiveTransactionsRecovered(resolve(cfg.paths.invoices));
  } catch (e) {
    log.error((e as Error).message);
    return 1;
  }

  const statePath = resolve(opts.statePath);
  let store: StateStore;
  try {
    store = StateStore.open(statePath);
    await recoverQuarantinedState(store, cfg, resolve(cfg.paths.samples));
  } catch (e) {
    log.error((e as Error).message);
    return 1;
  }
  const archivedMessageIds = archivedMessageIdSet(cfg);

  let browserInstance: Browser | undefined;
  let browserPromise: Promise<Browser> | undefined;
  const getBrowser = async (): Promise<Browser> => {
    if (!browserInstance) {
      // 当前站点 handler 默认不需要浏览器（EXT-09）；仅惰性启动。
      browserPromise ??= launchBrowser(cfg);
      browserInstance = await browserPromise;
    }
    return browserInstance;
  };

  log.info('Starting run...');

  const rawDir = cfg.paths.samples;
  let processed = 0;
  let skipped = 0;
  let failed = 0;
  // 部分成功的邮件（APP-01：有 artifact 但也有失败候选源）单独计数，避免被
  // processed 掩盖成「完全成功」。
  let partial = 0;
  const networkFailures: ProcessMailResult[] = [];
  const inFlight = new Set<string>();
  // CORE-02：致命错误时 abort 所有 worker，并在归档临界区前再次检查。
  const fatalAbort = new AbortController();
  let fatalError: unknown;

  const handleEml = async (emlPath: string): Promise<void> => {
    if (fatalAbort.signal.aborted) return;

    const raw = readFileSync(emlPath);
    // CORE-03：身份必须绑定原始字节，否则重复/缺失 Message-Id 会折叠不同邮件。
    const contentHashId = msgIdHash(undefined, '', '', '', raw);

    let mail: Awaited<ReturnType<typeof parseMailWithGuards>>;
    try {
      // 缓存的 .eml 同样是不可信输入：沿用抓取侧的大小上限、linkify 关闭与解析超时
      // （APP-09）。超限邮件转入待确认（EXT-05），不能静默 failed 后永久无法补档。
      mail = await parseMailWithGuards(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('mail_too_large_to_parse:')) {
        const hash = contentHashId;
        if (opts.onlyMail !== undefined && hash !== opts.onlyMail) return;
        const reason = '邮件过大无法解析（原始超过 32MB），请在待确认中手动选择发票文件归档';
        log.warn(`mail too large, routing to pending: ${hash} (${msg})`);
        try {
          const pendingDir = resolve(cfg.paths.pending);
          ensureSecureDir(pendingDir);
          const emlOut = join(pendingDir, `${hash}.eml`);
          if (!fileExistsNonEmpty(emlOut)) {
            writeEmlAtomic(emlOut, raw);
          }
          const pendingCsv = join(pendingDir, 'pending.csv');
          ensureCsvSchema(pendingCsv, 'messageId,date,from,subject,reason');
          // 无解析结果时用空 envelope + 稳定 reason；hash 已由内容决定。
          const line = [hash, '', '', basename(emlPath), reason].map(csvCell).join(',') + '\n';
          appendFileSync(pendingCsv, line, 'utf8');
          store.addProcessed(hash);
          store.checkpoint();
          processed++;
          log.info(`pending ${hash} reason=${reason}`);
        } catch (writeErr) {
          failed++;
          log.warn(
            `Failed to queue oversized mail ${emlPath} to pending: `
            + `${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
          );
        }
        return;
      }
      throw err;
    }

    const hash = msgIdHash(
      mail.messageId ?? undefined,
      mail.from?.text ?? '',
      mail.date?.toISOString() ?? '',
      mail.subject ?? '',
      raw,
    );
    // Use the same identity the writer commits to invoices.csv (messageId,
    // falling back to hash) so the archived-message self-heal recognizes emails
    // that have no Message-Id header on restart.
    const messageId = mail.messageId || hash;

    if (opts.onlyMail !== undefined && hash !== opts.onlyMail) {
      return;
    }

    if (inFlight.has(hash)) {
      skipped++;
      return;
    }

    const excludeReason = nonInvoiceReason({
      from: mail.from?.text ?? '',
      subject: mail.subject ?? '',
    });
    if (excludeReason) {
      log.info(`Excluded ${hash}: ${excludeReason}`);
      processed++;
      store.addProcessed(hash);
      store.checkpoint();
      return;
    }

    if (opts.onlyMail === undefined && !opts.force && messageId && archivedMessageIds.has(messageId)) {
      store.addProcessed(hash);
      store.checkpoint();
      skipped++;
      return;
    }

    if (opts.onlyMail === undefined && !opts.force && store.hasProcessed(hash)) {
      skipped++;
      return;
    }

    if (fatalAbort.signal.aborted) return;

    inFlight.add(hash);
    try {
      const taskState: State = {
        // 只带当前邮件的判定所需：pipeline 仅用 `includes(hash)` 判断是否已处理，
        // 全量复制会让每封邮件都付出 O(n) 复制成本（CODE-07）。
        processedHashes: store.hasProcessed(hash) ? [hash] : [],
        // pipeline 不读取 fetchedHashes，无需复制整份集合。
        fetchedHashes: [],
      };
      const taskSaveState = () => {
        for (const item of taskState.processedHashes) store.addProcessed(item);
        store.checkpoint();
      };

      const result = await processMail(mail, cfg, log, taskState, taskSaveState, getBrowser, {
        force: opts.force || opts.onlyMail !== undefined,
        raw,
        signal: fatalAbort.signal,
      });
      if (result.reason === 'aborted') return;
      for (const item of taskState.processedHashes) store.addProcessed(item);
      if (result.outcome === 'pdf' && result.messageId.length > 0) {
        archivedMessageIds.add(result.messageId);
      }
      // 部分成功（APP-01）同样携带 reason，且已写入待确认记录；网络失败统计必须
      // 一并覆盖，否则「一封邮件里一半链接超时」不会出现在 run 末尾的汇总里。
      if ((result.outcome === 'manual' || result.partial === true) && result.reason?.includes('network_retry_failed')) {
        networkFailures.push(result);
      }
      if (result.partial === true) partial++;
      processed++;
    } finally {
      inFlight.delete(hash);
    }
  };

  try {
    const emlPaths = await collectEmlPaths(rawDir);
    let next = 0;
    const workerCount = Math.min(opts.concurrency, Math.max(emlPaths.length, 1));
    log.info(`Queued ${emlPaths.length} cached emails with concurrency=${workerCount}`);

    const worker = async (): Promise<void> => {
      while (true) {
        if (fatalAbort.signal.aborted) return;
        const emlPath = emlPaths[next++];
        if (!emlPath) return;
        try {
          await handleEml(emlPath);
        } catch (err) {
          // Iron rule: state writes and unsafe archive recovery failures must
          // abort the whole run. 用 allSettled 等全部 worker 退出后再离开锁域
          // （CORE-02），不要靠 Promise.all 的提前 reject。
          if (err instanceof StateWriteError || err instanceof ArchiveRecoveryError) {
            if (!fatalError) fatalError = err;
            fatalAbort.abort();
            return;
          }
          failed++;
          log.warn(`Failed to process ${emlPath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };

    await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
    if (fatalError) throw fatalError;
    // 有界批量 checkpoint 之后必须显式 flush 并注销，命令结束时状态才算真正落盘。
    store.dispose();
  } catch (e) {
    try {
      store.flush();
    } catch (flushErr) {
      log.error(`state flush failed: ${(flushErr as Error).message}`);
    }
    log.error(`run aborted: ${(e as Error).message}`);
    return 1;
  } finally {
    if (browserInstance) {
      // Never let a browser-teardown failure turn a successful run into exit 1;
      // the documents are already archived by this point.
      await browserInstance.close().catch((err) => {
        log.warn(`browser close failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  log.info(`Run complete: processed=${processed}, partial=${partial}, skipped=${skipped}, failed=${failed}`);
  if (networkFailures.length > 0) {
    log.warn(`Network retry failures moved to pending: ${networkFailures.length}`);
    for (const failure of networkFailures) {
      log.warn(`pending ${failure.hash} date=${failure.date} from="${failure.from}" subject="${failure.subject}" reason=${failure.reason}`);
    }
  }
  return 0;
}

interface PendingOpts {
  configPath: string;
  json: boolean;
}

function parsePendingArgs(argv: string[]): PendingOpts | 'help' {
  if (argv.length === 0) return 'help';
  const [subcmd, ...rest] = argv;
  if (subcmd === '-h' || subcmd === '--help') return 'help';
  if (subcmd !== 'list') throw new Error(`unknown pending command: ${subcmd}`);

  const opts: PendingOpts = { configPath: './config.json', json: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--config') { opts.configPath = requireValue(rest, ++i, a); continue; }
    if (a === '--json') { opts.json = true; continue; }
    throw new Error(`unknown option: ${a}`);
  }
  return opts;
}

async function cmdPending(argv: string[]): Promise<number> {
  let parsed: PendingOpts | 'help';
  try {
    parsed = parsePendingArgs(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n`);
    process.stderr.write(PENDING_USAGE);
    return 2;
  }
  if (parsed === 'help') { process.stdout.write(PENDING_USAGE); return 0; }

  let cfg: Config;
  try {
    cfg = loadConfig(resolve(parsed.configPath));
  } catch (e) {
    log.error((e as Error).message);
    return 2;
  }

  const summary = summarizePending(cfg);
  if (parsed.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return 0;
  }

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

async function cmdOrganize(argv: string[]): Promise<number> {
  let parsed: OrganizeOpts | 'help';
  try {
    parsed = parseOrganizeArgs(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n`);
    process.stderr.write(ORGANIZE_USAGE);
    return 2;
  }
  if (parsed === 'help') { process.stdout.write(ORGANIZE_USAGE); return 0; }

  let cfg: Config;
  try {
    cfg = loadConfig(resolve(parsed.configPath));
  } catch (e) {
    log.error((e as Error).message);
    return 2;
  }

  if (!acquireCommandLock('organize', { configPath: parsed.configPath }, cfg)) return 2;

  try {
    assertArchiveTransactionsRecovered(resolve(cfg.paths.invoices));
    const summary = organizeFromOcrResults(cfg, log, {
      resultsCsv: parsed.resultsCsv,
      outDir: parsed.outDir,
      applyRename: parsed.applyRename,
    });
    log.info(`Organize complete: scanned=${summary.scanned}, copied=${summary.copied}, skipped=${summary.skipped}, failed=${summary.failed}`);
    return summary.failed > 0 ? 1 : 0;
  } catch (e) {
    log.error((e as Error).message);
    return 1;
  }
}

/**
 * OCR 运行期 PID 记录（APP-16）。
 *
 * Windows 上父进程用 `SIGTERM` 终止本 CLI 时不会执行任何 JS 清理
 * （等价于 TerminateProcess），而托管的 `efapiao serve` 是 unref 的子进程，
 * 因此本进程无法保证自己停掉它。这里把 PID 写入文件并打印一行稳定标记，
 * 让父进程（GUI）可以按 PID 终止整棵进程树。
 */
let activeOcrPidFile: string | undefined;

function writeOcrRuntimePid(cfg: Config): void {
  try {
    const pidPath = join(resolve(cfg.paths.invoices), 'ocr', '.mfh-ocr-cli.pid');
    ensureSecureDir(dirname(pidPath));
    const payload = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      serviceHost: cfg.ocr.serviceHost,
      servicePort: cfg.ocr.servicePort,
    };
    writeFileSync(pidPath, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 });
    secureFileMode(pidPath);
    activeOcrPidFile = pidPath;
    // 稳定前缀，供父进程解析后做进程树终止（Windows 需要 taskkill /T）。
    process.stdout.write(`mfh:ocr-cli-pid ${process.pid}\n`);
  } catch {
    // PID 记录只是辅助手段，失败不应阻断 OCR。
  }
}

function clearOcrRuntimePid(): void {
  const pidPath = activeOcrPidFile;
  activeOcrPidFile = undefined;
  if (!pidPath) return;
  try {
    rmSync(pidPath, { force: true });
  } catch {
    // best-effort
  }
}

async function cmdOcr(argv: string[]): Promise<number> {
  let parsed: OcrOpts | 'help';
  try {
    parsed = parseOcrArgs(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n`);
    process.stderr.write(OCR_USAGE);
    return 2;
  }
  if (parsed === 'help') { process.stdout.write(OCR_USAGE); return 0; }

  let cfg: Config;
  try {
    cfg = loadConfig(resolve(parsed.configPath));
  } catch (e) {
    log.error((e as Error).message);
    return 2;
  }

  // `ocr summary` 只读队列与结果，不占锁；`ocr run` 会写结果 CSV 与队列。
  if (parsed.command === 'run' && !acquireCommandLock('ocr', { configPath: parsed.configPath }, cfg)) return 2;

  try {
    if (parsed.command === 'summary') {
      const summary = summarizeOcr(cfg);
      if (parsed.json) {
        process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
      } else {
        process.stdout.write(`OCR queue: ${summary.total} (${summary.pendingCsv})\n`);
        process.stdout.write(`  recognized=${summary.recognized} failed=${summary.failed} ignored=${summary.ignored} pending=${summary.pending}\n`);
        process.stdout.write(`  results=${summary.resultsCsv}\n`);
        process.stdout.write('By document type:\n');
        for (const group of summary.byDocumentType) process.stdout.write(`  ${group.key}: ${group.count}\n`);
        if (summary.bySupportingReason.length > 0) {
          process.stdout.write('Ignored supporting documents:\n');
          for (const group of summary.bySupportingReason) process.stdout.write(`  ${group.key}: ${group.count}\n`);
        }
        if (summary.byFailureReason.length > 0) {
          process.stdout.write('Failure reasons:\n');
          for (const group of summary.byFailureReason) {
            process.stdout.write(`  ${group.key}: ${group.count}\n`);
            for (const example of group.examples) {
              process.stdout.write(`    ${example.hash} ${example.filename} subject="${example.subject}" reason=${example.reason}\n`);
            }
          }
        }
      }
      return 0;
    }

    assertArchiveTransactionsRecovered(resolve(cfg.paths.invoices));
    writeOcrRuntimePid(cfg);
    const summary = await runOcrPending(cfg, log, {
      force: parsed.force,
      singleItem: parsed.singleItem,
      concurrency: parsed.concurrency,
    });
    log.info(`OCR complete: scanned=${summary.scanned}, parsed=${summary.parsed}, skipped=${summary.skipped}, failed=${summary.failed}, updated=${summary.updated}`);
    if (summary.failed > 0 && !parsed.allowParseFailures) return 1;
    return 0;
  } catch (e) {
    log.error((e as Error).message);
    return 1;
  } finally {
    // Kill any efapiao serve child we started so it does not outlive the CLI.
    stopEfapiaoServices();
    clearOcrRuntimePid();
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(ROOT_USAGE);
    return argv.length === 0 ? 1 : 0;
  }
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'fetch':
        return await cmdFetch(rest);
      case 'run':
        return await cmdRun(rest);
      case 'ocr':
        return await cmdOcr(rest);
      case 'pending':
        return await cmdPending(rest);
      case 'organize':
        return await cmdOrganize(rest);
      case 'rebuild-state':
      case '--rebuild-state':
        return await cmdRebuildState(rest);
      default:
        process.stderr.write(`unknown command: ${cmd}\n\n`);
        process.stderr.write(ROOT_USAGE);
        return 2;
    }
  } finally {
    // 正常结束与异常都要放锁；信号退出由 shutdownManagedServices() 兜底。
    releaseDataDirLock();
  }
}

// The GUI kills this CLI with SIGTERM (and users press Ctrl-C = SIGINT). A signal
// terminates the process without running cmdOcr's `finally`, so an unref'd
// `efapiao serve` child would be orphaned holding its port. Stop it explicitly.
//
// APP-16：Windows 上 `ChildProcess.kill('SIGTERM')` 等价于 TerminateProcess，
// 不会执行下面任何 JS，所以除了信号处理还必须有 `process.on('exit')` 兜底
// （覆盖正常结束与未捕获异常两条路径），并由 writeOcrRuntimePid() 记录 PID，
// 让父进程可以按 PID 终止整棵进程树。
let shuttingDown = false;
function shutdownManagedServices(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  // CODE-07：先把未达 checkpoint 阈值的状态增量同步刷盘，再放锁、再退出。
  // 顺序很重要——刷盘必须发生在仍然持有数据目录锁的时候。
  for (const err of flushActiveStates()) {
    log.error(`state flush failed during shutdown: ${err.message}`);
  }
  stopEfapiaoServices();
  clearOcrRuntimePid();
  // 数据目录锁必须在信号退出路径上也释放，否则会留下一把要等陈旧回收的锁。
  releaseDataDirLock();
}

const SIGNAL_EXIT_CODES: Record<string, number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
  SIGBREAK: 149,
};
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGBREAK'] as const) {
  process.on(signal, () => {
    shutdownManagedServices();
    process.exit(SIGNAL_EXIT_CODES[signal] ?? 143);
  });
}
process.on('exit', () => {
  shutdownManagedServices();
});

main().then(
  (code) => process.exit(code),
  (e) => {
    log.error((e as Error).stack ?? String(e));
    process.exit(1);
  },
);
