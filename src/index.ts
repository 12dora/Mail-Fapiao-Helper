#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { loadConfig, type Config } from './config.js';
import { fetchMails, missingImapCredentials, parseMailWithGuards, type RawMail } from './mail/fetcher.js';
import { nonInvoiceReason } from './mail/exclude.js';
import { log } from './log.js';
import {
  ensureSecureDir,
  fileExistsNonEmpty,
  secureFileMode,
  StateStore,
  StateWriteError,
  uniqueTempPath,
  type State,
} from './state.js';
import { boundsAreOrdered, isValidDateBound } from './util/dateRange.js';
import { msgIdHash } from './util/hash.js';
import { processMail } from './pipeline.js';
import type { ProcessMailResult } from './pipeline.js';
import { organizeFromOcrResults } from './rename/rename.js';
import { runOcrPending } from './ocr/runner.js';
import { stopEfapiaoServices } from './ocr/efapiao.js';
import { summarizeOcr } from './ocr/summary.js';
import { pendingEmlExists, summarizePending } from './pending/summary.js';
import { readCsvRows, csvCell, parseCsvLine } from './util/csv.js';

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
 * 网页自动下载所用的浏览器（APP-19）。
 *
 * 应用**不会**自动准备或下载浏览器：桌面版优先使用系统已安装的 Chrome / Edge，
 * 开发环境才可能命中 Playwright 自带的 Chromium。`playwright.browserManagement`
 * 仅作兼容读取，不参与这里的决策，也不代表任何「由应用准备」的承诺。
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
    '网页自动下载需要浏览器，但本机没有找到可用的 Chrome 或 Microsoft Edge。'
    + '本应用不会自动下载浏览器，请先安装最新版 Chrome 或 Microsoft Edge 后重试。'
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

const INDEX_HEADER = 'messageId,date,from,subject,mailbox,hasAttachment,bodyLinkCount';

function ensureIndexCsv(path: string): void {
  if (existsSync(path)) return;
  ensureSecureDir(dirname(path));
  // UTF-8 BOM so Excel renders CJK correctly.
  writeFileSync(path, `﻿${INDEX_HEADER}\n`, { encoding: 'utf8', mode: 0o600 });
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

  const outDir = resolve(opts.outDir ?? cfg.paths.samples);
  const indexCsv = join(outDir, 'INDEX.csv');
  if (!opts.dryRun) ensureIndexCsv(indexCsv);
  const indexedMessageIds = readIndexMessageIds(indexCsv);

  const statePath = resolve(opts.statePath);
  let store: StateStore;
  try {
    store = StateStore.open(statePath);
    await recoverQuarantinedState(store, cfg, outDir);
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
      const hash = msgIdHash(
        mail.messageId,
        mail.from,
        mail.date.toISOString(),
        mail.subject,
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
    // 命令结束时显式 flush，未达阈值的增量才算真正落盘。
    store.flush();
  } catch (e) {
    // 有界批量 checkpoint 必须在致命错误时显式 flush，否则本次已落盘的 .eml 会
    // 失去对应的 state 记录（CODE-07）。
    try {
      store.flush();
    } catch (flushErr) {
      log.error(`state flush failed: ${(flushErr as Error).message}`);
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

/** msgIdHash 的输出形态：12 位小写十六进制。真实 Message-Id 必然含 `@`。 */
const BARE_HASH_RE = /^[0-9a-f]{12}$/;

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
      // launchBrowser() 已经给出准确的中文错误（说明需要系统 Chrome/Edge）。
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
  const networkFailures: ProcessMailResult[] = [];
  const inFlight = new Set<string>();

  const handleEml = async (emlPath: string): Promise<void> => {
    const raw = readFileSync(emlPath);
    // 缓存的 .eml 同样是不可信输入：沿用抓取侧的大小上限、linkify 关闭与解析超时
    // （APP-09）。超限/超时的邮件计入 failed 并保留在缓存里，不提交任何状态。
    const mail = await parseMailWithGuards(raw);

    const hash = msgIdHash(
      mail.messageId ?? undefined,
      mail.from?.text ?? '',
      mail.date?.toISOString() ?? '',
      mail.subject ?? '',
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

      const result = await processMail(mail, cfg, log, taskState, taskSaveState, getBrowser, { force: opts.force || opts.onlyMail !== undefined, raw });
      for (const item of taskState.processedHashes) store.addProcessed(item);
      if (result.outcome === 'pdf' && result.messageId.length > 0) {
        archivedMessageIds.add(result.messageId);
      }
      if (result.outcome === 'manual' && result.reason?.includes('network_retry_failed')) {
        networkFailures.push(result);
      }
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

    let aborted = false;
    const worker = async (): Promise<void> => {
      while (true) {
        if (aborted) return;
        const emlPath = emlPaths[next++];
        if (!emlPath) return;
        try {
          await handleEml(emlPath);
        } catch (err) {
          // Iron rule: a state.json write failure is one of the only two
          // conditions that must abort the whole run.
          if (err instanceof StateWriteError) {
            aborted = true;
            throw err;
          }
          failed++;
          log.warn(`Failed to process ${emlPath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    // 有界批量 checkpoint 之后必须显式 flush，命令结束时状态才算真正落盘。
    store.flush();
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

  log.info(`Run complete: processed=${processed}, skipped=${skipped}, failed=${failed}`);
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

  const summary = organizeFromOcrResults(cfg, log, {
    resultsCsv: parsed.resultsCsv,
    outDir: parsed.outDir,
    applyRename: parsed.applyRename,
  });
  log.info(`Organize complete: scanned=${summary.scanned}, copied=${summary.copied}, skipped=${summary.skipped}, failed=${summary.failed}`);
  return summary.failed > 0 ? 1 : 0;
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
  switch (cmd) {
    case 'fetch':
      return cmdFetch(rest);
    case 'run':
      return cmdRun(rest);
    case 'ocr':
      return cmdOcr(rest);
    case 'pending':
      return cmdPending(rest);
    case 'organize':
      return cmdOrganize(rest);
    case 'rebuild-state':
    case '--rebuild-state':
      return cmdRebuildState(rest);
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n`);
      process.stderr.write(ROOT_USAGE);
      return 2;
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
  stopEfapiaoServices();
  clearOcrRuntimePid();
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
