#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
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
import {
  identityMatches,
  isMailHash,
  legacyMsgIdHash,
  resolveMailIdentity,
} from './util/hash.js';
import { ArchiveRecoveryError, assertArchiveTransactionsRecovered } from './download/archiveJournal.js';
import { persistPendingDurable, processMail } from './pipeline.js';
import type { ProcessMailResult } from './pipeline.js';
import { organizeFromOcrResults } from './rename/rename.js';
import { runOcrPending } from './ocr/runner.js';
import { stopEfapiaoServices } from './ocr/efapiao.js';
import { summarizeOcr } from './ocr/summary.js';
import { pendingEmlExists, summarizePending } from './pending/summary.js';
import { readCsvRows, csvCell, ensureCsvSchema } from './util/csv.js';

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
 *
 * CORE-01：可能持有多把按路径排序的 per-target 锁（交集写目标仍互斥）。
 */
let activeDataDirLeases: DataDirLease[] = [];

/**
 * 规范化写目标路径：realpath 消除符号链接/大小写别名；路径尚不存在时
 * 回溯已存在祖先再拼回剩余段，保证同一物理目标得到同一字符串。
 */
function canonicalizePath(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    // 目标尚不存在：规范化已存在的最长祖先。
    let current = abs;
    const missing: string[] = [];
    for (;;) {
      try {
        const real = realpathSync(current);
        return missing.length === 0 ? real : join(real, ...missing.reverse());
      } catch {
        const parent = dirname(current);
        if (parent === current) return abs;
        missing.push(basename(current));
        current = parent;
      }
    }
  }
}

export interface LockTargetOverrides {
  /** fetch --out 覆盖 samples 写目标。 */
  samplesDir?: string;
  /** 显式 state 路径（写入 state.json）。 */
  statePath?: string;
}

/**
 * CORE-01：收集本次命令的全部实际写目标（含 overrides），逐个 canonicalize。
 * 返回按字典序排序的去重列表，供 per-target 加锁或稳定 hash。
 */
function collectWriteTargets(cfg: Config, overrides: LockTargetOverrides = {}): string[] {
  const samples = overrides.samplesDir ?? cfg.paths.samples;
  const statePath = overrides.statePath;
  const targets = [
    samples,
    cfg.paths.invoices,
    cfg.paths.pending,
    dirname(resolve(cfg.output.csv)),
    join(cfg.paths.invoices, 'ocr'),
  ];
  if (statePath && statePath.length > 0) {
    targets.push(dirname(resolve(statePath)));
  }
  const canon = targets.map((t) => canonicalizePath(t));
  return [...new Set(canon)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 从完整规范写目标集合推导稳定锁根：
 * - `MFH_DATA_DIR` 优先（与 GUI 对齐）
 * - 否则对排序后的目标集做 sha256，在「字典序最小目标」下挂 `.mfh-cache/scope-<hash12>`
 *   作为唯一锁目录——同一目标集永远同一把锁；目标集相交但不全等时，
 *   仍通过下方 per-target 锁覆盖交集。
 */
function scopeLockDir(targets: string[]): string {
  const fromEnv = process.env.MFH_DATA_DIR;
  if (fromEnv && fromEnv.length > 0) return canonicalizePath(fromEnv);
  if (targets.length === 0) return process.cwd();
  const digest = createHash('sha256').update(targets.join('\0')).digest('hex').slice(0, 12);
  // 锁落在字典序最小目标旁，避免依赖公共祖先（公共祖先会随「其它」路径漂移）。
  const anchor = targets[0]!;
  return join(anchor, '.mfh-cache', `scope-${digest}`);
}

/**
 * 会写数据目录的命令入口统一走这里。拿不到锁时只打印中文提示，由调用方返回
 * 退出码 2，不抛栈。只读命令与 `--dry-run` 不需要调用本函数。
 *
 * 已加载 config 时必须传入 `cfg`，以便 CORE-01 按写目标持锁。
 */
function acquireCommandLock(
  kind: DataOpKind,
  hints: DataDirHints,
  cfg?: Config,
  overrides: LockTargetOverrides = {},
): boolean {
  if (!cfg) {
    const dataDir = resolveDataDir(hints);
    const result = acquireDataDirLock(dataDir, kind);
    if (!result.ok) {
      log.error(result.message);
      return false;
    }
    activeDataDirLeases = [result.lease];
    if (result.lease.inherited) {
      log.debug(`data dir lock inherited from parent process (${result.lease.lockPath})`);
    }
    return true;
  }

  const statePath = overrides.statePath ?? hints.statePath;
  const targets = collectWriteTargets(cfg, {
    samplesDir: overrides.samplesDir,
    statePath,
  });
  // 稳定 scope 锁 + 每个写目标各一把，均按路径排序获取，避免死锁。
  // scope 保证「相同完整目标集」互斥；per-target 保证「交集写路径」互斥。
  const lockDirs = [...new Set([scopeLockDir(targets), ...targets])].sort((a, b) =>
    (a < b ? -1 : a > b ? 1 : 0));

  const acquired: DataDirLease[] = [];
  for (const dir of lockDirs) {
    const result = acquireDataDirLock(dir, kind);
    if (!result.ok) {
      for (const lease of acquired) {
        try { lease.release(); } catch { /* best-effort */ }
      }
      log.error(result.message);
      return false;
    }
    acquired.push(result.lease);
    if (result.lease.inherited) {
      log.debug(`data dir lock inherited from parent process (${result.lease.lockPath})`);
    }
  }
  activeDataDirLeases = acquired;
  return true;
}

/** 幂等释放；正常结束、异常与信号退出三条路径都会走到。 */
function releaseDataDirLock(): void {
  const leases = activeDataDirLeases;
  activeDataDirLeases = [];
  // 逆序释放。
  for (let i = leases.length - 1; i >= 0; i--) {
    try {
      leases[i]!.release();
    } catch {
      // best-effort：释放失败会留下一把锁，下次由陈旧回收清理。
    }
  }
}

const INDEX_HEADER = 'mailHash,messageId,date,from,subject,mailbox,hasAttachment,bodyLinkCount';
const INDEX_LEGACY_HEADERS = [
  'messageId,date,from,subject,mailbox,hasAttachment,bodyLinkCount',
];

function ensureIndexCsv(path: string): void {
  // CORE-05：空文件也要写表头，不能只判断 exists。
  // OCR-03：ensureCsvSchema 自身 fsync；mode 0600。
  ensureSecureDir(dirname(path));
  ensureCsvSchema(path, INDEX_HEADER, {
    upgradeFrom: INDEX_LEGACY_HEADERS,
    upgradeRow: (row) => {
      if (row.mailHash && isMailHash(row.mailHash)) return row;
      const mid = row.messageId ?? '';
      const legacy = isMailHash(mid)
        ? mid.toLowerCase()
        : legacyMsgIdHash(
          mid.length > 0 ? mid : undefined,
          row.from ?? '',
          row.date ?? '',
          row.subject ?? '',
        );
      return { ...row, mailHash: legacy };
    },
  });
  secureFileMode(path);
}

/**
 * 一次性读出 INDEX.csv 已有的 mailHash 集合（兼容旧表：无 mailHash 时退回 legacy）。
 */
function readIndexMailHashes(path: string): Set<string> {
  const out = new Set<string>();
  for (const row of readCsvRows(path)) {
    const h = (row.mailHash ?? '').trim();
    if (h && isMailHash(h)) {
      out.add(h.toLowerCase());
      continue;
    }
    const mid = row.messageId ?? '';
    if (isMailHash(mid)) {
      out.add(mid.toLowerCase());
      continue;
    }
    if (mid.length > 0 || (row.from ?? '') || (row.date ?? '') || (row.subject ?? '')) {
      out.add(legacyMsgIdHash(
        mid.length > 0 ? mid : undefined,
        row.from ?? '',
        row.date ?? '',
        row.subject ?? '',
      ));
    }
  }
  return out;
}

function appendIndexRow(path: string, m: RawMail, mailHash: string): void {
  const row = [
    csvCell(mailHash),
    csvCell(m.messageId ?? ''),
    csvCell(m.date.toISOString()),
    csvCell(m.from),
    csvCell(m.subject),
    csvCell(m.mailbox),
    m.hasAttachment ? '1' : '0',
    String(m.bodyLinkCount),
  ].join(',');
  appendFileSync(path, `${row}\n`, 'utf8');
  secureFileMode(path);
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
  const outDir = resolve(opts.outDir ?? cfg.paths.samples);
  // --dry-run 不写数据目录，因此不占锁。正式运行按写目标持锁（CORE-01，含 --out）。
  if (!opts.dryRun && !acquireCommandLock(
    'fetch',
    { statePath: opts.statePath, configPath: opts.configPath },
    cfg,
    { samplesDir: outDir, statePath: opts.statePath },
  )) return 2;

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
      // CORE-03：内容绑定 primary + legacy 别名；绝不单靠 Message-Id 跳过。
      const identity = resolveMailIdentity({
        messageId: mail.messageId,
        from: mail.from,
        date: mail.date.toISOString(),
        subject: mail.subject,
        raw: mail.raw,
      });
      const hash = identity.primary;
      // APP-11：primary 与 legacy 文件名任一存在且非空即视为已缓存。
      const month = monthDir(mail.date);
      const primaryPath = join(outDir, month, `${hash}.eml`);
      const legacyPath = identity.legacy !== hash
        ? join(outDir, month, `${identity.legacy}.eml`)
        : undefined;
      const cachedPrimary = fileExistsNonEmpty(primaryPath);
      const cachedLegacy = legacyPath ? fileExistsNonEmpty(legacyPath) : false;
      const cached = cachedPrimary || cachedLegacy;
      const emlPath = cachedPrimary ? primaryPath : (cachedLegacy && legacyPath ? legacyPath : primaryPath);

      if (store.hasFetchedAny(identity.aliases) && cached) {
        // 读侧任意别名命中即跳过；不回写多别名（非对称读写）。
        skippedKnown++;
        continue;
      }

      if (opts.dryRun) {
        const why = store.hasFetchedAny(identity.aliases) ? '(state 已记录但缓存缺失，需要重新抓取)' : '';
        log.info(`[dry-run] would save ${emlPath} (subject="${mail.subject}")${why}`);
        continue;
      }

      if (!cached) {
        if (store.hasFetchedAny(identity.aliases)) {
          repaired++;
          log.info(`cached eml missing/empty, re-fetching ${hash}: ${primaryPath}`);
        }
        writeEmlAtomic(primaryPath, mail.raw);
      } else {
        log.info(`eml exists, skip write: ${emlPath}`);
      }

      // INDEX 按 mailHash 去重，禁止 Message-Id 单独充当「已索引」证据。
      if (!identity.aliases.some((a) => indexedMailHashes.has(a))) {
        appendIndexRow(indexCsv, mail, hash);
        for (const a of identity.aliases) indexedMailHashes.add(a);
      }

      // CORE-03 非对称写：只记 primary 一条。
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

// ---------------------------------------------------------------------------
// 状态重建（APP-18A）：只读缓存与台账，不删除任何业务数据
// ---------------------------------------------------------------------------

/**
 * 台账行 -> 显式 mailHash（优先）或可安全推导的身份。
 * CORE-03c：绝不能只靠展示列重算而丢掉已持久化的 32 位键。
 */
function hashesFromLedgerRow(row: Record<string, string>): string[] {
  const out = new Set<string>();
  const explicit = (row.mailHash ?? row.hash ?? '').trim();
  if (explicit && isMailHash(explicit)) out.add(explicit.toLowerCase());

  const messageId = row.messageId ?? '';
  if (isMailHash(messageId)) out.add(messageId.toLowerCase());

  // 真实 Message-Id / 展示列 → legacy 12 位别名（与升级前 .eml 文件名对齐）。
  if (!isMailHash(messageId)) {
    out.add(legacyMsgIdHash(
      messageId.length > 0 ? messageId : undefined,
      row.from ?? '',
      row.date ?? '',
      row.subject ?? '',
    ));
  }
  return [...out].filter((h) => h.length > 0);
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
  for (const row of readCsvRows(resolve(cfg.output.csv))) {
    out.push(...hashesFromLedgerRow(row));
  }
  for (const row of readCsvRows(join(resolve(cfg.paths.pending), 'pending.csv'))) {
    out.push(...hashesFromLedgerRow(row));
  }
  // OCR 队列的 hash 列即 mailHash。
  const ocrPending = join(resolve(cfg.paths.invoices), 'ocr', 'ocr-pending.csv');
  for (const row of readCsvRows(ocrPending)) {
    out.push(...hashesFromLedgerRow(row));
  }
  return [...new Set(out.filter((h) => h.length > 0))];
}

async function rebuildStateFromDisk(cfg: Config, samplesDir: string): Promise<State> {
  return {
    processedHashes: processedHashesFromLedgers(cfg),
    fetchedHashes: await fetchedHashesFromCache(samplesDir),
  };
}

/**
 * CORE-03：把台账（invoices.csv 等）里的显式 mailHash 幂等回填进 processed。
 *
 * 不再扫描 .eml 并把全部别名 bulk 写入 state——那会让集合基数 ≠ 邮件数。
 * 升级兼容靠**读侧** `hasProcessedAny(aliases)` / `hasFetchedAny(aliases)`：
 * 旧 state 只含 12 位时，aliases 仍含 legacy，命中即跳过，无需回写 32 位。
 */
function backfillProcessedFromLedgers(store: StateStore, cfg: Config): void {
  let added = 0;
  for (const h of processedHashesFromLedgers(cfg)) {
    if (!store.hasProcessed(h)) {
      store.addProcessed(h);
      added++;
    }
  }
  if (added > 0) {
    store.checkpoint();
    store.flush();
    log.info(`mailHash 台账回填：新增 ${added} 条 processed 身份`);
  }
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
    if (!acquireCommandLock(
      'pipeline',
      { statePath: parsed.statePath, configPath: parsed.configPath },
      cfg,
      { statePath: parsed.statePath },
    )) return 2;
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

  if (!acquireCommandLock(
    'pipeline',
    { statePath: opts.statePath, configPath: opts.configPath },
    cfg,
    { statePath: opts.statePath },
  )) return 2;

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
    // CORE-03：台账 mailHash 回填；读侧 aliases 覆盖旧 12 位，不 bulk 写别名。
    backfillProcessedFromLedgers(store, cfg);
  } catch (e) {
    log.error((e as Error).message);
    return 1;
  }

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
    // CORE-03e：缓存文件名即 fetch 时身份；超大邮件解析失败时必须沿用它。
    const fileHash = basename(emlPath, '.eml');

    let mail: Awaited<ReturnType<typeof parseMailWithGuards>>;
    try {
      // 缓存的 .eml 同样是不可信输入：沿用抓取侧的大小上限、linkify 关闭与解析超时
      // （APP-09）。超限邮件转入待确认（EXT-05），不能静默 failed 后永久无法补档。
      mail = await parseMailWithGuards(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('mail_too_large_to_parse:')) {
        // CORE-03e：沿用 .eml 文件名上的 fetch 身份，禁止 content-only 重算分叉。
        const identity = resolveMailIdentity({
          from: '',
          date: '',
          subject: '',
          fileHash: isMailHash(fileHash) ? fileHash : undefined,
          raw: isMailHash(fileHash) ? undefined : raw,
        });
        const hash = identity.primary;
        if (opts.onlyMail !== undefined && !identityMatches(opts.onlyMail, identity)) return;
        const reason = 'mail_too_large_to_parse';
        log.warn(`mail too large, routing to pending: ${hash} (${msg})`);
        try {
          // EXT-05 / item 10：走 durable pending 原语，保留 fetch 时身份。
          persistPendingDurable({
            cfg,
            mailHash: hash,
            reason: '邮件过大无法解析（原始超过 32MB），请在待确认中手动选择发票文件归档',
            raw,
            messageId: '',
            date: '',
            from: '',
            subject: basename(emlPath),
          });
          store.addProcessed(hash);
          store.checkpoint();
          processed++;
          log.info(`pending ${hash} reason=${reason}`);
        } catch (writeErr) {
          // item 9：StateWriteError 必须传播到 abort，不能被吞掉。
          if (writeErr instanceof StateWriteError) {
            if (!fatalError) fatalError = writeErr;
            fatalAbort.abort();
            throw writeErr;
          }
          // item 10：pending 写失败 = 可重试失败，计 failed，最终非 0 退出。
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

    const identity = resolveMailIdentity({
      messageId: mail.messageId ?? undefined,
      from: mail.from?.text ?? '',
      date: mail.date?.toISOString() ?? '',
      subject: mail.subject ?? '',
      raw,
      fileHash: isMailHash(fileHash) ? fileHash : undefined,
    });
    const hash = identity.primary;
    // invoices 行的 messageId 展示字段：真实 Message-Id，否则 primary hash。
    const messageId = mail.messageId || hash;

    // CORE-03f：--only-mail 接受 12/32 位，匹配任意别名。
    if (opts.onlyMail !== undefined && !identityMatches(opts.onlyMail, identity)) {
      return;
    }

    if (identity.aliases.some((a) => inFlight.has(a)) || inFlight.has(hash)) {
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

    // CORE-03a：禁止仅凭 Message-Id 判定已处理；读侧用别名匹配旧 12 位 state。
    if (opts.onlyMail === undefined && !opts.force && store.hasProcessedAny(identity.aliases)) {
      skipped++;
      return;
    }

    if (fatalAbort.signal.aborted) return;

    inFlight.add(hash);
    for (const a of identity.aliases) inFlight.add(a);
    try {
      const already = store.hasProcessedAny(identity.aliases);
      const taskState: State = {
        // 只带当前邮件的判定所需：pipeline 用 aliases∩state 判断是否已处理。
        // 已处理时 seed primary 即可（primary ∈ aliases）；写回也只记 primary。
        processedHashes: already ? [hash] : [],
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
        fileHash: isMailHash(fileHash) ? fileHash : undefined,
      });
      if (result.reason === 'aborted') return;
      for (const item of taskState.processedHashes) store.addProcessed(item);
      // 部分成功（APP-01）同样携带 reason，且已写入待确认记录；网络失败统计必须
      // 一并覆盖，否则「一封邮件里一半链接超时」不会出现在 run 末尾的汇总里。
      if ((result.outcome === 'manual' || result.partial === true) && result.reason?.includes('network_retry_failed')) {
        networkFailures.push(result);
      }
      if (result.partial === true) partial++;
      // pending 写失败不得算作成功处理。
      if (result.reason?.includes('pending_write_failed')) {
        failed++;
      } else {
        processed++;
      }
    } finally {
      inFlight.delete(hash);
      for (const a of identity.aliases) inFlight.delete(a);
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
  // item 10：存在可重试失败时非 0 退出。
  return failed > 0 ? 1 : 0;
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
