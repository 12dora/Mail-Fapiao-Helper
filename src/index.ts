#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { simpleParser } from 'mailparser';
import { chromium, type Browser } from 'playwright';
import { loadConfig, type Config } from './config.js';
import { fetchMails, type RawMail } from './mail/fetcher.js';
import { nonInvoiceReason } from './mail/exclude.js';
import { log } from './log.js';
import { loadState, saveState, type State } from './state.js';
import { msgIdHash } from './util/hash.js';
import { processMail } from './pipeline.js';
import type { ProcessMailResult } from './pipeline.js';
import { organizeFromOcrResults } from './rename/rename.js';
import { runOcrPending } from './ocr/runner.js';
import { summarizeOcr } from './ocr/summary.js';
import { pendingEmlExists, summarizePending } from './pending/summary.js';
import { readCsvRows } from './util/csv.js';

const ROOT_USAGE = `mfh — Mail Fapiao Helper

Usage:
  mfh <command> [options]

Commands:
  fetch    Fetch matching mails as .eml into samples/raw/
  run      Process emails and extract invoices
  ocr      Run OCR for archived documents
  pending  Inspect manual processing queue
  organize Copy archived invoices into optional OCR-based names/folders

Options:
  -h, --help    Show this help

Run 'mfh <command> --help' for command-specific options.
`;

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
  --out <dir>          Output dir for samples     (default: ./samples/raw)
  --since-days <n>     Use a rolling N-day window (overrides config.filter.sinceDays)
  --since <date>       Lower bound, inclusive     (YYYY-MM-DD or ISO 8601)
  --until <date>       Upper bound, inclusive     (YYYY-MM-DD or ISO 8601)
  --dry-run            Do not write files; only log what would happen
  -h, --help           Show this help

Notes:
  * --since / --until take precedence over --since-days (and the corresponding
    config fields). You can use either bound alone.
  * Both bounds accept whole-day dates (YYYY-MM-DD) or full ISO timestamps.
`;

interface FetchOpts {
  configPath: string;
  statePath: string;
  outDir: string;
  sinceDaysOverride: number | undefined;
  sinceOverride: string | undefined;
  untilOverride: string | undefined;
  dryRun: boolean;
}

interface OrganizeOpts {
  configPath: string;
  resultsCsv: string | undefined;
  outDir: string | undefined;
}

interface OcrOpts {
  command: 'run' | 'summary';
  configPath: string;
  force: boolean;
  allowParseFailures: boolean;
  json: boolean;
}

function parseFetchArgs(argv: string[]): FetchOpts | 'help' {
  const opts: FetchOpts = {
    configPath: './config.json',
    statePath: './state.json',
    outDir: './samples/raw',
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
      if (!Number.isFinite(Date.parse(v))) throw new Error(`--since="${v}" is not a parseable date`);
      opts.sinceOverride = v;
      continue;
    }
    if (a === '--until') {
      const v = requireValue(argv, ++i, a);
      if (!Number.isFinite(Date.parse(v))) throw new Error(`--until="${v}" is not a parseable date`);
      opts.untilOverride = v;
      continue;
    }
    throw new Error(`unknown option: ${a}`);
  }
  if (opts.sinceOverride && opts.untilOverride
      && Date.parse(opts.sinceOverride) > Date.parse(opts.untilOverride)) {
    throw new Error(`--since must be <= --until`);
  }
  return opts;
}

function parseOrganizeArgs(argv: string[]): OrganizeOpts | 'help' {
  const opts: OrganizeOpts = {
    configPath: './config.json',
    resultsCsv: undefined,
    outDir: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--config') { opts.configPath = requireValue(argv, ++i, a); continue; }
    if (a === '--results-csv') { opts.resultsCsv = requireValue(argv, ++i, a); continue; }
    if (a === '--out') { opts.outDir = requireValue(argv, ++i, a); continue; }
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
    allowParseFailures: false,
    json: false,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--force') { opts.force = true; continue; }
    if (a === '--allow-parse-failures') { opts.allowParseFailures = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--config') { opts.configPath = requireValue(rest, ++i, a); continue; }
    throw new Error(`unknown option: ${a}`);
  }
  if (opts.command === 'summary' && (opts.force || opts.allowParseFailures)) {
    throw new Error('--force and --allow-parse-failures are only valid for mfh ocr run');
  }
  return opts;
}

function requireValue(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined || v.startsWith('-')) throw new Error(`${flag} requires a value`);
  return v;
}

function csvCell(v: string): string {
  if (/[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

const INDEX_HEADER = 'messageId,date,from,subject,mailbox,hasAttachment,bodyLinkCount';

function ensureIndexCsv(path: string): void {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  // UTF-8 BOM so Excel renders CJK correctly.
  writeFileSync(path, `﻿${INDEX_HEADER}\n`, 'utf8');
}

function indexContainsMessageId(path: string, messageId: string): boolean {
  if (!existsSync(path) || messageId.length === 0) return false;
  const text = readFileSync(path, 'utf8');
  const needle = csvCell(messageId);
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const firstComma = line.indexOf(',');
    const first = firstComma === -1 ? line : line.slice(0, firstComma);
    if (first === needle) return true;
  }
  return false;
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
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
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
  if (cfg.filter.since && cfg.filter.until
      && Date.parse(cfg.filter.since) > Date.parse(cfg.filter.until)) {
    log.error(`filter.since (${cfg.filter.since}) must be <= filter.until (${cfg.filter.until})`);
    return 2;
  }

  const statePath = resolve(opts.statePath);
  const state: State = loadState(statePath);
  const fetched = new Set(state.fetchedHashes);

  const outDir = resolve(opts.outDir);
  const indexCsv = join(outDir, 'INDEX.csv');
  if (!opts.dryRun) ensureIndexCsv(indexCsv);

  let seen = 0;
  let saved = 0;
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
      if (fetched.has(hash)) {
        skippedKnown++;
        continue;
      }
      const emlPath = join(outDir, monthDir(mail.date), `${hash}.eml`);

      if (opts.dryRun) {
        log.info(`[dry-run] would save ${emlPath} (subject="${mail.subject}")`);
        continue;
      }

      if (!existsSync(emlPath)) {
        writeEmlAtomic(emlPath, mail.raw);
      } else {
        log.info(`eml exists, skip write: ${emlPath}`);
      }

      const midKey = mail.messageId ?? '';
      if (midKey.length === 0 || !indexContainsMessageId(indexCsv, midKey)) {
        appendIndexRow(indexCsv, mail);
      }

      fetched.add(hash);
      state.fetchedHashes = Array.from(fetched);
      saveState(statePath, state);
      saved++;
      log.info(`saved ${hash} subject="${mail.subject}"`);
    }
  } catch (e) {
    log.error(`fetch aborted: ${(e as Error).message}`);
    return 1;
  }

  log.info(`done: seen=${seen} saved=${saved} skippedKnown=${skippedKnown} dryRun=${opts.dryRun}`);
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
  const state: State = loadState(statePath);
  const processedHashes = new Set(state.processedHashes);
  const archivedMessageIds = archivedMessageIdSet(cfg);

  const saveStateFn = () => {
    state.processedHashes = Array.from(processedHashes);
    saveState(statePath, state);
  };
  let browserInstance: Browser | undefined;
  let browserPromise: Promise<Browser> | undefined;
  const getBrowser = async (): Promise<Browser> => {
    if (!browserInstance) {
      browserPromise ??= chromium.launch({
        headless: cfg.playwright.headless,
        timeout: cfg.playwright.timeoutMs,
      });
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
    const mail = await simpleParser(raw);

    const hash = msgIdHash(
      mail.messageId ?? undefined,
      mail.from?.text ?? '',
      mail.date?.toISOString() ?? '',
      mail.subject ?? '',
    );
    const messageId = mail.messageId ?? '';

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
      processedHashes.add(hash);
      saveStateFn();
      return;
    }

    if (opts.onlyMail === undefined && !opts.force && messageId && archivedMessageIds.has(messageId)) {
      processedHashes.add(hash);
      saveStateFn();
      skipped++;
      return;
    }

    if (opts.onlyMail === undefined && !opts.force && processedHashes.has(hash)) {
      skipped++;
      return;
    }

    inFlight.add(hash);
    try {
      const taskState: State = {
        processedHashes: Array.from(processedHashes),
        fetchedHashes: state.fetchedHashes,
      };
      const taskSaveState = () => {
        for (const item of taskState.processedHashes) processedHashes.add(item);
        saveStateFn();
      };

      const result = await processMail(mail, cfg, log, taskState, taskSaveState, getBrowser, { force: opts.force || opts.onlyMail !== undefined, raw });
      for (const item of taskState.processedHashes) processedHashes.add(item);
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

    const worker = async (): Promise<void> => {
      while (true) {
        const emlPath = emlPaths[next++];
        if (!emlPath) return;
        try {
          await handleEml(emlPath);
        } catch (err) {
          failed++;
          log.warn(`Failed to process ${emlPath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  } catch (e) {
    log.error(`run aborted: ${(e as Error).message}`);
    return 1;
  } finally {
    if (browserInstance) {
      await browserInstance.close();
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
  });
  log.info(`Organize complete: scanned=${summary.scanned}, copied=${summary.copied}, skipped=${summary.skipped}, failed=${summary.failed}`);
  return summary.failed > 0 ? 1 : 0;
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

    const summary = await runOcrPending(cfg, log, { force: parsed.force });
    log.info(`OCR complete: scanned=${summary.scanned}, parsed=${summary.parsed}, skipped=${summary.skipped}, failed=${summary.failed}, updated=${summary.updated}`);
    if (summary.failed > 0 && !parsed.allowParseFailures) return 1;
    return 0;
  } catch (e) {
    log.error((e as Error).message);
    return 1;
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
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n`);
      process.stderr.write(ROOT_USAGE);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    log.error((e as Error).stack ?? String(e));
    process.exit(1);
  },
);
