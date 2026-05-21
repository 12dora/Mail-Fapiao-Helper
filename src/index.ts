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

const ROOT_USAGE = `mfh — Mail Fapiao Helper

Usage:
  mfh <command> [options]

Commands:
  fetch    Fetch matching mails as .eml into samples/raw/
  run      Process emails and extract invoices
  pending  Inspect manual processing queue

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
  -h, --help           Show this help
`;

interface RunOpts {
  configPath: string;
  statePath: string;
  onlyMail: string | undefined;
}

function parseRunArgs(argv: string[]): RunOpts | 'help' {
  const opts: RunOpts = {
    configPath: './config.json',
    statePath: './state.json',
    onlyMail: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--config') { opts.configPath = requireValue(argv, ++i, a); continue; }
    if (a === '--state') { opts.statePath = requireValue(argv, ++i, a); continue; }
    if (a === '--only-mail') { opts.onlyMail = requireValue(argv, ++i, a); continue; }
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

  const saveStateFn = () => saveState(statePath, state);
  let browserInstance: Browser | undefined;
  const getBrowser = async (): Promise<Browser> => {
    if (!browserInstance) {
      browserInstance = await chromium.launch({
        headless: cfg.playwright.headless,
        timeout: cfg.playwright.timeoutMs,
      });
    }
    return browserInstance;
  };

  log.info('Starting run...');

  const rawDir = cfg.paths.samples;
  let processed = 0;
  let skipped = 0;
  const networkFailures: ProcessMailResult[] = [];

  try {
    for await (const emlPath of walkEmls(rawDir)) {
      const raw = readFileSync(emlPath);
      const mail = await simpleParser(raw);

      const hash = msgIdHash(
        mail.messageId ?? undefined,
        mail.from?.text ?? '',
        mail.date?.toISOString() ?? '',
        mail.subject ?? '',
      );

      if (opts.onlyMail !== undefined && hash !== opts.onlyMail) {
        continue;
      }

      const excludeReason = nonInvoiceReason({
        from: mail.from?.text ?? '',
        subject: mail.subject ?? '',
      });
      if (excludeReason) {
        log.info(`Excluded ${hash}: ${excludeReason}`);
        processed++;
        if (!state.processedHashes.includes(hash)) state.processedHashes.push(hash);
        saveState(statePath, state);
        continue;
      }

      if (opts.onlyMail === undefined && state.processedHashes.includes(hash)) {
        skipped++;
        continue;
      }

      const result = await processMail(mail, cfg, log, state, saveStateFn, getBrowser, { force: opts.onlyMail !== undefined });
      if (result.outcome === 'manual' && result.reason?.includes('network_retry_failed')) {
        networkFailures.push(result);
      }
      processed++;
    }
  } catch (e) {
    log.error(`run aborted: ${(e as Error).message}`);
    return 1;
  } finally {
    if (browserInstance) {
      await browserInstance.close();
    }
  }

  log.info(`Run complete: processed=${processed}, skipped=${skipped}`);
  if (networkFailures.length > 0) {
    log.warn(`Network retry failures moved to pending: ${networkFailures.length}`);
    for (const failure of networkFailures) {
      log.warn(`pending ${failure.hash} date=${failure.date} from="${failure.from}" subject="${failure.subject}" reason=${failure.reason}`);
    }
  }
  return 0;
}

interface PendingRow {
  messageId: string;
  date: string;
  from: string;
  subject: string;
  reason: string;
}

interface PendingOpts {
  configPath: string;
}

function parsePendingArgs(argv: string[]): PendingOpts | 'help' {
  if (argv.length === 0) return 'help';
  const [subcmd, ...rest] = argv;
  if (subcmd === '-h' || subcmd === '--help') return 'help';
  if (subcmd !== 'list') throw new Error(`unknown pending command: ${subcmd}`);

  const opts: PendingOpts = { configPath: './config.json' };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--config') { opts.configPath = requireValue(rest, ++i, a); continue; }
    throw new Error(`unknown option: ${a}`);
  }
  return opts;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function readPendingRows(csvPath: string): PendingRow[] {
  if (!existsSync(csvPath)) return [];
  const text = readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  const rows: PendingRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i] ?? '');
    rows.push({
      messageId: cols[0] ?? '',
      date: cols[1] ?? '',
      from: cols[2] ?? '',
      subject: cols[3] ?? '',
      reason: cols[4] ?? '',
    });
  }
  return rows;
}

function printPendingGroup(title: string, rows: PendingRow[]): void {
  if (rows.length === 0) return;
  process.stdout.write(`${title}: ${rows.length}\n`);
  for (const row of rows) {
    const hash = msgIdHash(row.messageId || undefined, row.from, row.date, row.subject);
    process.stdout.write(`  ${hash} date=${row.date} from="${row.from}" subject="${row.subject}" reason=${row.reason}\n`);
  }
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

  const csvPath = join(resolve(cfg.paths.pending), 'pending.csv');
  const rows = readPendingRows(csvPath);
  const networkRows = rows.filter((row) => row.reason.includes('network_retry_failed'));
  const manualRows = rows.filter((row) => !row.reason.includes('network_retry_failed'));

  process.stdout.write(`Pending queue: ${rows.length} (${csvPath})\n`);
  printPendingGroup('Network retry failures', networkRows);
  printPendingGroup('Manual', manualRows);
  return 0;
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
    case 'pending':
      return cmdPending(rest);
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
