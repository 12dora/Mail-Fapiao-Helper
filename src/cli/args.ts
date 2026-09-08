import { boundsAreOrdered, isValidDateBound } from '../util/dateRange.js';

export interface FetchOpts {
  configPath: string;
  statePath: string;
  outDir: string | undefined;
  sinceDaysOverride: number | undefined;
  sinceOverride: string | undefined;
  untilOverride: string | undefined;
  dryRun: boolean;
}

export interface OrganizeOpts {
  configPath: string;
  resultsCsv: string | undefined;
  outDir: string | undefined;
  applyRename: boolean | undefined;
  includeSupporting: boolean;
}

export interface OcrOpts {
  command: 'run' | 'summary';
  configPath: string;
  force: boolean;
  /** 仅重试 results CSV 中 status=error 的行，保留 success/partial。 */
  retryFailed: boolean;
  singleItem: boolean;
  concurrency: number;
  allowParseFailures: boolean;
  json: boolean;
}

export interface RunOpts {
  configPath: string;
  statePath: string;
  onlyMail: string | undefined;
  concurrency: number;
  force: boolean;
  /**
   * `mfh pending retry`：把待确认目录里的 `.eml` 当作输入源，而不是 samples 缓存。
   * 只由 `cmdPendingRetry` 设置，`mfh run` 的解析器不会产出它。
   */
  pendingRetry?: boolean;
}

export interface DedupeOpts {
  by: 'container' | 'invoice-no' | 'source';
  configPath: string;
  /** 默认 dry-run；只有显式 `--apply` 才动磁盘。 */
  apply: boolean;
  json: boolean;
}

export interface RebuildStateOpts {
  configPath: string;
  statePath: string;
  outDir: string | undefined;
  dryRun: boolean;
}

export interface PendingOpts {
  command: 'list' | 'retry';
  configPath: string;
  json: boolean;
  /** `pending retry` 专用：状态文件与并发度，与 `mfh run` 同义。 */
  statePath: string;
  concurrency: number;
}

export function parseFetchArgs(argv: string[]): FetchOpts | 'help' {
  const opts: FetchOpts = {
    configPath: './config.json', statePath: './state.json', outDir: undefined,
    sinceDaysOverride: undefined, sinceOverride: undefined, untilOverride: undefined, dryRun: false,
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
      opts.sinceDaysOverride = v; continue;
    }
    if (a === '--since') {
      const v = requireValue(argv, ++i, a);
      if (!isValidDateBound(v)) throw new Error(`--since="${v}" is not a parseable date`);
      opts.sinceOverride = v; continue;
    }
    if (a === '--until') {
      const v = requireValue(argv, ++i, a);
      if (!isValidDateBound(v)) throw new Error(`--until="${v}" is not a parseable date`);
      opts.untilOverride = v; continue;
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

export function parseOrganizeArgs(argv: string[]): OrganizeOpts | 'help' {
  const opts: OrganizeOpts = { configPath: './config.json', resultsCsv: undefined, outDir: undefined, applyRename: undefined, includeSupporting: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--config') { opts.configPath = requireValue(argv, ++i, a); continue; }
    if (a === '--results-csv') { opts.resultsCsv = requireValue(argv, ++i, a); continue; }
    if (a === '--out') { opts.outDir = requireValue(argv, ++i, a); continue; }
    if (a === '--apply-rename') { opts.applyRename = true; continue; }
    if (a === '--include-supporting') { opts.includeSupporting = true; continue; }
    if (a === '--no-apply-rename') { opts.applyRename = false; continue; }
    throw new Error(`unknown option: ${a}`);
  }
  return opts;
}

/** 解析单个 OCR 选项；返回消耗后的下标。遇到 --help 返回 'help'。 */
function consumeOcrOption(opts: OcrOpts, rest: string[], i: number): number | 'help' {
  const a = rest[i];
  if (a === '-h' || a === '--help') return 'help';
  if (a === '--force') { opts.force = true; return i; }
  if (a === '--retry-failed') { opts.retryFailed = true; return i; }
  if (a === '--single-item') { opts.singleItem = true; return i; }
  if (a === '--allow-parse-failures') { opts.allowParseFailures = true; return i; }
  if (a === '--json') { opts.json = true; return i; }
  if (a === '--config') {
    opts.configPath = requireValue(rest, i + 1, a);
    return i + 1;
  }
  if (a === '--concurrency') {
    const v = Number(requireValue(rest, i + 1, a));
    if (!Number.isInteger(v) || v <= 0) throw new Error('--concurrency expects a positive integer');
    opts.concurrency = v;
    return i + 1;
  }
  throw new Error(`unknown option: ${a}`);
}

function assertOcrOpts(opts: OcrOpts): void {
  if (opts.retryFailed && opts.force) {
    throw new Error('--retry-failed cannot be combined with --force');
  }
  if (opts.command !== 'summary') return;
  if (opts.force || opts.retryFailed || opts.singleItem || opts.concurrency !== 1 || opts.allowParseFailures) {
    throw new Error('--force, --retry-failed, --single-item, --concurrency and --allow-parse-failures are only valid for mfh ocr run');
  }
}

export function parseOcrArgs(argv: string[]): OcrOpts | 'help' {
  if (argv.length === 0) return 'help';
  const [subcmd, ...rest] = argv;
  if (subcmd === '-h' || subcmd === '--help') return 'help';
  if (subcmd !== 'run' && subcmd !== 'summary') throw new Error(`unknown ocr command: ${subcmd}`);
  const opts: OcrOpts = {
    command: subcmd, configPath: './config.json', force: false, retryFailed: false,
    singleItem: false, concurrency: 1, allowParseFailures: false, json: false,
  };
  for (let i = 0; i < rest.length; i++) {
    const next = consumeOcrOption(opts, rest, i);
    if (next === 'help') return 'help';
    i = next;
  }
  assertOcrOpts(opts);
  return opts;
}

export function parseRunArgs(argv: string[]): RunOpts | 'help' {
  const opts: RunOpts = { configPath: './config.json', statePath: './state.json', onlyMail: undefined, concurrency: 4, force: false };
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
      opts.concurrency = v; continue;
    }
    throw new Error(`unknown option: ${a}`);
  }
  return opts;
}

export function parseRebuildStateArgs(argv: string[]): RebuildStateOpts | 'help' {
  const opts: RebuildStateOpts = { configPath: './config.json', statePath: './state.json', outDir: undefined, dryRun: false };
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

export function parsePendingArgs(argv: string[]): PendingOpts | 'help' {
  if (argv.length === 0) return 'help';
  const [subcmd, ...rest] = argv;
  if (subcmd === '-h' || subcmd === '--help') return 'help';
  if (subcmd !== 'list' && subcmd !== 'retry') throw new Error(`unknown pending command: ${subcmd}`);
  const opts: PendingOpts = {
    command: subcmd, configPath: './config.json', json: false,
    statePath: './state.json', concurrency: 4,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--config') { opts.configPath = requireValue(rest, ++i, a); continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--state') { opts.statePath = requireValue(rest, ++i, a); continue; }
    if (a === '--concurrency') {
      const v = Number(requireValue(rest, ++i, a));
      if (!Number.isInteger(v) || v <= 0) throw new Error('--concurrency expects a positive integer');
      opts.concurrency = v; continue;
    }
    throw new Error(`unknown option: ${a}`);
  }
  if (opts.command === 'list' && (opts.statePath !== './state.json' || opts.concurrency !== 4)) {
    throw new Error('--state and --concurrency are only valid for mfh pending retry');
  }
  return opts;
}

export function parseDedupeArgs(argv: string[]): DedupeOpts | 'help' {
  const opts: DedupeOpts = { configPath: './config.json', apply: false, json: false, by: 'container' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--config') { opts.configPath = requireValue(argv, ++i, a); continue; }
    if (a === '--by') {
      const by = requireValue(argv, ++i, a);
      if (by !== 'container' && by !== 'invoice-no' && by !== 'source') {
        throw new Error('--by must be container or invoice-no or source');
      }
      opts.by = by;
      continue;
    }
    if (a === '--apply') { opts.apply = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    throw new Error(`unknown option: ${a}`);
  }
  return opts;
}

function requireValue(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined || v.startsWith('-')) throw new Error(`${flag} requires a value`);
  return v;
}
