import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron';
import { ImapFlow } from 'imapflow';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfigPath, historyPath, loadAppSummary, loadGuiConfig, readRunHistory, type RunHistoryEntry } from './summary.js';
import { readCsvRows } from '../util/csv.js';

interface DateRangePayload {
  from?: string;
  to?: string;
  dryRun?: boolean;
}

interface SaveConfigPayload {
  imap?: {
    host?: string;
    port?: number | string;
    user?: string;
    pass?: string;
    mailbox?: string[];
  };
  filter?: {
    keywords?: string[];
    since?: string;
    until?: string;
    sinceDays?: number | string;
    matchSubject?: boolean;
    matchBody?: boolean;
  };
  paths?: {
    samples?: string;
    invoices?: string;
    pending?: string;
  };
  output?: {
    csv?: string;
  };
  rename?: {
    avoidConflictBeforeOcr?: boolean;
    rule?: string;
    fallback?: string;
    applyAfterOcr?: boolean;
    organizeByType?: boolean;
    typeDirRule?: string;
    organizedDir?: string;
  };
  ocr?: {
    enabled?: boolean;
    provider?: string;
    ocrMode?: string;
    executionMode?: string;
    serviceHost?: string;
    servicePort?: number | string;
    serviceWorkers?: number | string;
    batchSize?: number | string;
    resultsCsv?: string;
    credentials?: Record<string, string>;
  };
  playwright?: {
    headless?: boolean;
    timeoutMs?: number | string;
    browserManagement?: string;
  };
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const configPath = process.env.MFH_CONFIG_PATH
  ? path.resolve(process.env.MFH_CONFIG_PATH)
  : defaultConfigPath(rootDir);
const statePath = process.env.MFH_STATE_PATH
  ? path.resolve(process.env.MFH_STATE_PATH)
  : path.join(rootDir, 'state.json');
let mainWindow: BrowserWindow | undefined;
let activeOcrProcess: ChildProcess | undefined;
let activeOcrStopRequested = false;

function uiPath(...parts: string[]): string {
  return path.join(rootDir, 'gui-design', ...parts);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    title: '发票助手',
    backgroundColor: '#f6f7f9',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(rootDir, 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  void mainWindow.loadFile(uiPath('pages', 'dashboard.html'));
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function asDateRange(value: unknown): DateRangePayload {
  const raw = asObject(value);
  return {
    from: typeof raw.from === 'string' ? raw.from : undefined,
    to: typeof raw.to === 'string' ? raw.to : undefined,
    dryRun: raw.dryRun === true,
  };
}

function readMutableConfig(): Record<string, unknown> {
  const source = fs.existsSync(configPath)
    ? configPath
    : path.join(rootDir, 'config.example.json');
  return JSON.parse(fs.readFileSync(source, 'utf8')) as Record<string, unknown>;
}

function readConfigForPaths(): Record<string, unknown> {
  try {
    return readMutableConfig();
  } catch {
    return JSON.parse(fs.readFileSync(path.join(rootDir, 'config.example.json'), 'utf8')) as Record<string, unknown>;
  }
}

function mergeDefined(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const child = asObject(target[key]);
      target[key] = child;
      mergeDefined(child, value as Record<string, unknown>);
    } else {
      target[key] = value;
    }
  }
}

function normalizeSavePayload(value: unknown): Record<string, unknown> {
  const payload = asObject(value) as SaveConfigPayload;
  const ocrCredentials = {
    ...(payload.ocr?.credentials ?? {}),
  };
  const legacy = asObject(value);
  if (typeof legacy.tencentSecretId === 'string') ocrCredentials.tencentSecretId = legacy.tencentSecretId;
  if (typeof legacy.tencentSecretKey === 'string') ocrCredentials.tencentSecretKey = legacy.tencentSecretKey;
  if (typeof legacy.tencentRegion === 'string') ocrCredentials.tencentRegion = legacy.tencentRegion;
  const ocrProvider = typeof legacy.ocrVendor === 'string' ? legacy.ocrVendor : payload.ocr?.provider;

  return {
    imap: payload.imap,
    filter: payload.filter,
    paths: payload.paths,
    output: payload.output,
    rename: payload.rename,
    ocr: {
      ...payload.ocr,
      provider: ocrProvider === 'none' ? 'efapiao' : ocrProvider,
      enabled: ocrProvider === 'none' ? false : payload.ocr?.enabled,
      credentials: ocrCredentials,
    },
    playwright: payload.playwright,
  };
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberField(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  return NaN;
}

function writeConfig(payload: unknown): void {
  const current = readMutableConfig();
  mergeDefined(current, normalizeSavePayload(payload));
  fs.writeFileSync(configPath, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    // Best-effort on platforms that do not preserve POSIX file modes.
  }
}

function writeOcrRunConfig(concurrency: number): string {
  const current = readMutableConfig();
  const ocr = asObject(current.ocr);
  const host = typeof ocr.serviceHost === 'string' && ocr.serviceHost ? ocr.serviceHost : '127.0.0.1';
  const basePort = Number(ocr.servicePort ?? 8000) || 8000;
  const port = concurrency > 1 ? basePort + concurrency - 1 : basePort;
  current.ocr = {
    ...ocr,
    serviceWorkers: concurrency,
    servicePort: port,
    serviceUrl: `http://${host}:${port}`,
  };
  const tmpPath = path.join(rootDir, '.mfh-cache', 'ocr-run-config.json');
  fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
  fs.writeFileSync(tmpPath, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  return tmpPath;
}

function sendProgress(data: Record<string, unknown>): void {
  mainWindow?.webContents.send('mfh:fetch-progress', data);
}

function sendOperationProgress(data: Record<string, unknown>): void {
  mainWindow?.webContents.send('mfh:operation-progress', data);
}

function sendFileProgress(data: Record<string, unknown>): void {
  mainWindow?.webContents.send('mfh:file-progress', data);
}

function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function readFakeConfigPaths(): { samples: string; invoices: string; pending: string; resultsCsv: string; organizedDir: string } {
  const cfg = readConfigForPaths();
  const paths = asObject(cfg.paths);
  const ocr = asObject(cfg.ocr);
  const rename = asObject(cfg.rename);
  return {
    samples: path.resolve(rootDir, typeof paths.samples === 'string' ? paths.samples : './samples/raw'),
    invoices: path.resolve(rootDir, typeof paths.invoices === 'string' ? paths.invoices : './invoices'),
    pending: path.resolve(rootDir, typeof paths.pending === 'string' ? paths.pending : './pending'),
    resultsCsv: path.resolve(rootDir, typeof ocr.resultsCsv === 'string' ? ocr.resultsCsv : './invoices/ocr/ocr-results.csv'),
    organizedDir: path.resolve(rootDir, typeof rename.organizedDir === 'string' ? rename.organizedDir : './invoices/organized'),
  };
}

function writeFakeE2eFile(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
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

function clearOcrResultsAndResetQueue(): void {
  const cfg = readConfigForPaths();
  const ocr = asObject(cfg.ocr);
  const paths = asObject(cfg.paths);
  const target = path.resolve(rootDir, typeof ocr.resultsCsv === 'string' ? ocr.resultsCsv : './invoices/ocr/ocr-results.csv');
  const pendingCsv = path.resolve(
    rootDir,
    typeof paths.invoices === 'string' ? paths.invoices : './invoices',
    'ocr',
    'ocr-pending.csv',
  );
  fs.rmSync(target, { force: true });
  if (!fs.existsSync(pendingCsv)) return;

  const text = fs.readFileSync(pendingCsv, 'utf8');
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const header = parseCsvLine(lines[0] ?? '');
  const statusIndex = header.indexOf('status');
  const reasonIndex = header.indexOf('reason');
  const documentTypeIndex = header.indexOf('documentType');
  if (statusIndex === -1) return;

  const out = [`${bom}${header.map(csvCell).join(',')}`];
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const cols = parseCsvLine(line);
    const docType = cols[documentTypeIndex] ?? '';
    if (docType === 'supporting') {
      cols[statusIndex] = 'ignored';
      if (reasonIndex >= 0) cols[reasonIndex] = cols[reasonIndex] || 'supporting_document';
    } else {
      cols[statusIndex] = 'pending';
      if (reasonIndex >= 0) cols[reasonIndex] = '';
    }
    out.push(header.map((_, index) => csvCell(cols[index] ?? '')).join(','));
  }
  fs.writeFileSync(pendingCsv, `${out.join('\n')}\n`, 'utf8');
}

function fakeFetch(): { code: number; stdout: string; stderr: string } {
  const paths = readFakeConfigPaths();
  const indexCsv = path.join(paths.samples, 'INDEX.csv');
  const rows = [
    ['messageId', 'date', 'from', 'subject', 'mailbox', 'hasAttachment', 'bodyLinkCount'],
    ['<mfh-e2e-invoice@example.com>', '2026-05-21T09:30:00.000Z', '国家电网 <noreply@example.com>', '国家电网电子发票通知', 'INBOX', '1', '2'],
    ['<mfh-e2e-link@example.com>', '2026-05-20T12:00:00.000Z', '服务商 <vendor@example.com>', '发票下载链接已过期', 'INBOX', '0', '1'],
  ];
  writeFakeE2eFile(indexCsv, `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`);
  writeFakeE2eFile(path.join(paths.samples, '2026-05', 'mfh-e2e-invoice.eml'), 'Subject: 国家电网电子发票通知\n\nfake invoice mail\n');
  return { code: 0, stdout: 'saved mfh-e2e-invoice.eml\ndone: seen=2 saved=2 skippedKnown=0\n', stderr: '' };
}

function fakePipeline(): { code: number; stdout: string; stderr: string } {
  const paths = readFakeConfigPaths();
  const pendingCsv = path.join(paths.invoices, 'ocr', 'ocr-pending.csv');
  const rows = [
    ['hash', 'date', 'from', 'subject', 'filename', 'format', 'documentType', 'status', 'reason'],
    ['mfh-e2e-invoice', '2026-05-21', '国家电网 <noreply@example.com>', '国家电网电子发票通知', '0001.pdf', 'pdf', 'invoice', 'pending', ''],
    ['mfh-e2e-trip', '2026-05-20', '差旅平台 <travel@example.com>', '行程单通知', '0002.pdf', 'pdf', 'itinerary', 'pending', ''],
    ['mfh-e2e-supporting', '2026-05-20', '高速通行 <etc@example.com>', '通行费汇总单', '通行费电子票据汇总单.pdf', 'pdf', 'supporting', 'ignored', 'supporting_document'],
  ];
  writeFakeE2eFile(pendingCsv, `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`);
  writeFakeE2eFile(path.join(paths.invoices, '0001.pdf'), '%PDF-1.4\n% fake\n');
  writeFakeE2eFile(path.join(paths.invoices, '0002.pdf'), '%PDF-1.4\n% fake\n');
  return {
    code: 0,
    stdout: [
      'Processed mfh-e2e-invoice: 2 documents',
      'Processed mfh-e2e-link: 1 documents',
      'Run complete: processed=2, skipped=0, failed=0',
      '',
    ].join('\n'),
    stderr: '',
  };
}

function fakeOcr(): { code: number; stdout: string; stderr: string } {
  const paths = readFakeConfigPaths();
  const pendingRows = [
    ['hash', 'date', 'from', 'subject', 'filename', 'source', 'format', 'documentType', 'status', 'reason'],
    ['mfh-e2e-invoice', '2026-05-21', '国家电网 <noreply@example.com>', '国家电网电子发票通知', '0001.pdf', '0001.pdf', 'pdf', 'invoice', 'recognized', ''],
    ['mfh-e2e-trip', '2026-05-20', '差旅平台 <travel@example.com>', '行程单通知', '0002.pdf', '0002.pdf', 'pdf', 'itinerary', 'recognized', ''],
    ['mfh-e2e-supporting', '2026-05-20', '高速通行 <etc@example.com>', '通行费汇总单', '通行费电子票据汇总单.pdf', '通行费电子票据汇总单.pdf', 'pdf', 'supporting', 'ignored', 'supporting_document'],
  ];
  writeFakeE2eFile(path.join(paths.invoices, 'ocr', 'ocr-pending.csv'), `${pendingRows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`);
  const rows = [
    ['filename', 'dateValue', 'date', 'seller', 'invoiceNo', 'amount', 'transport', 'status', 'documentType', 'invoiceType', 'error'],
    ['0001.pdf', '2026-05-21', '2026-05-21', '国家电网有限公司', '1234567890', '318.42', 'http', 'ok', 'invoice', '电子发票', ''],
    ['0002.pdf', '2026-05-20', '2026-05-20', '差旅平台', 'TRIP-20260520', '88.00', 'http', 'ok', 'itinerary', '行程单', ''],
  ];
  writeFakeE2eFile(paths.resultsCsv, `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`);
  const manualRows = [
    ['messageId', 'date', 'from', 'subject', 'reason'],
    ['<mfh-e2e-link@example.com>', '2026-05-20T12:00:00.000Z', '服务商 <vendor@example.com>', '发票下载链接已过期', 'http_403'],
  ];
  writeFakeE2eFile(path.join(paths.pending, 'pending.csv'), `${manualRows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`);
  fs.mkdirSync(paths.organizedDir, { recursive: true });
  return {
    code: 0,
    stdout: [
      'OCR parsed 0001.pdf',
      'OCR parsed 0002.pdf',
      'OCR complete: scanned=3, parsed=2, skipped=1, failed=0, updated=2',
      '',
    ].join('\n'),
    stderr: '',
  };
}

function runFakeCli(command: string): { code: number; stdout: string; stderr: string } | undefined {
  if (process.env.MFH_E2E_FAKE_CLI !== '1') return undefined;
  if (command === 'fetch') return fakeFetch();
  if (command === 'run') return fakePipeline();
  if (command === 'ocr') return fakeOcr();
  if (command === 'organize') {
    const paths = readFakeConfigPaths();
    fs.mkdirSync(paths.organizedDir, { recursive: true });
    return { code: 0, stdout: `organized into ${paths.organizedDir}\n`, stderr: '' };
  }
  return { code: 1, stdout: '', stderr: `unsupported fake command: ${command}` };
}

interface FetchProgressState {
  seen: number;
  saved: number;
  skipped: number;
}

interface OcrProgressState {
  total: number;
  parsed: number;
  failed: number;
  skipped: number;
  processed: number;
  initialized: boolean;
}

interface FileProgressState {
  processed: number;
  skipped: number;
  failed: number;
}

function parseFetchLine(line: string, current: FetchProgressState): void {
  const done = /done: seen=(\d+) saved=(\d+) skippedKnown=(\d+)/.exec(line);
  if (done) {
    current.seen = Number(done[1]);
    current.saved = Number(done[2]);
    current.skipped = Number(done[3]);
    sendProgress({
      percent: 100,
      matched: current.seen,
      saved: current.saved,
      skipped: current.skipped,
      step: '完成',
      message: `已保存 ${current.saved} 封新邮件，跳过 ${current.skipped} 封已缓存邮件。`,
      kind: 'ok',
      done: true,
    });
    return;
  }
  if (line.includes('saved ')) {
    current.saved++;
    current.seen = Math.max(current.seen, current.saved + current.skipped);
    sendProgress({
      percent: Math.min(92, 20 + current.saved * 3),
      matched: current.seen,
      saved: current.saved,
      skipped: current.skipped,
      step: '保存',
      message: '已保存一封相关邮件到本机缓存。',
    });
  }
}

function parseOcrLine(line: string, current: OcrProgressState): void {
  const text = line.trim();
  if (!text) return;
  const complete = /OCR complete: scanned=(\d+), parsed=(\d+), skipped=(\d+), failed=(\d+), updated=(\d+)/.exec(text);
  if (complete) {
    current.total = Number(complete[1]);
    current.parsed = Number(complete[2]);
    current.skipped = Number(complete[3]);
    current.failed = Number(complete[4]);
    current.processed = current.parsed + current.skipped + current.failed;
    sendOperationProgress({
      operation: 'ocr',
      phase: '识别完成',
      percent: 100,
      total: current.total,
      processed: current.processed,
      parsed: current.parsed,
      skipped: current.skipped,
      failed: current.failed,
      message: current.total === 0
        ? '没有待识别文件。'
        : `识别完成：成功 ${current.parsed} 个，跳过 ${current.skipped} 个，失败 ${current.failed} 个。`,
      kind: current.failed > 0 ? 'warn' : 'ok',
      done: true,
    });
    return;
  }

  const parsed = /OCR parsed (.+)$/.exec(text);
  if (parsed) {
    current.parsed++;
    current.processed++;
    sendOperationProgress({
      operation: 'ocr',
      phase: '正在识别',
      percent: current.total > 0 ? Math.min(96, Math.round((current.processed / current.total) * 100)) : undefined,
      total: current.total,
      processed: current.processed,
      parsed: current.parsed,
      skipped: current.skipped,
      failed: current.failed,
      message: `识别成功：${parsed[1]}`,
      kind: 'ok',
    });
    return;
  }

  const failed = /OCR failed (.+?)(?:: (.*))?$/.exec(text);
  if (failed) {
    current.failed++;
    current.processed++;
    sendOperationProgress({
      operation: 'ocr',
      phase: '正在识别',
      percent: current.total > 0 ? Math.min(96, Math.round((current.processed / current.total) * 100)) : undefined,
      total: current.total,
      processed: current.processed,
      parsed: current.parsed,
      skipped: current.skipped,
      failed: current.failed,
      message: `识别失败：${failed[1]}${failed[2] ? `，${failed[2]}` : ''}`,
      kind: 'warn',
    });
    return;
  }

  sendOperationProgress({
    operation: 'ocr',
    phase: '识别日志',
    total: current.total,
    processed: current.processed,
    parsed: current.parsed,
    skipped: current.skipped,
    failed: current.failed,
    message: text.replace(/^\[(info|warn|error|debug)\]\s+\S+\s+/, ''),
    kind: text.includes('[error]') ? 'err' : text.includes('[warn]') ? 'warn' : '',
  });
}

function sendOcrPhase(message: string, current?: Partial<OcrProgressState>, kind = ''): void {
  sendOperationProgress({
    operation: 'ocr',
    phase: '准备识别',
    percent: 3,
    total: current?.total ?? 0,
    processed: current?.processed ?? 0,
    parsed: current?.parsed ?? 0,
    skipped: current?.skipped ?? 0,
    failed: current?.failed ?? 0,
    message,
    kind,
  });
}

function parseFileLine(line: string, current: FileProgressState): void {
  const text = line.trim();
  if (!text) return;
  const complete = /Run complete: processed=(\d+), skipped=(\d+), failed=(\d+)/.exec(text);
  if (complete) {
    current.processed = Number(complete[1]);
    current.skipped = Number(complete[2]);
    current.failed = Number(complete[3]);
    sendFileProgress({
      operation: 'files',
      phase: '获取完成',
      percent: 100,
      processed: current.processed,
      skipped: current.skipped,
      failed: current.failed,
      message: `获取完成：处理 ${current.processed} 封，跳过 ${current.skipped} 封，失败 ${current.failed} 封。`,
      kind: current.failed > 0 ? 'warn' : 'ok',
      done: true,
    });
    return;
  }

  if (text.includes('Processed ')) {
    current.processed++;
    sendFileProgress({
      operation: 'files',
      phase: '正在获取',
      percent: Math.min(95, 12 + current.processed * 4),
      processed: current.processed,
      skipped: current.skipped,
      failed: current.failed,
      message: text.replace(/^\[(info|warn|error|debug)\]\s+\S+\s+/, ''),
      kind: 'ok',
    });
    return;
  }

  if (text.includes('Skipped ')) {
    current.skipped++;
    sendFileProgress({
      operation: 'files',
      phase: '正在获取',
      percent: Math.min(95, 12 + (current.processed + current.skipped) * 4),
      processed: current.processed,
      skipped: current.skipped,
      failed: current.failed,
      message: text.replace(/^\[(info|warn|error|debug)\]\s+\S+\s+/, ''),
    });
    return;
  }

  sendFileProgress({
    operation: 'files',
    phase: text.includes('[warn]') ? '需要确认' : '获取日志',
    processed: current.processed,
    skipped: current.skipped,
    failed: current.failed,
    message: text.replace(/^\[(info|warn|error|debug)\]\s+\S+\s+/, ''),
    kind: text.includes('[error]') ? 'err' : text.includes('[warn]') ? 'warn' : '',
  });
}

function sendFilePhase(message: string, current?: Partial<FileProgressState>, kind = ''): void {
  sendFileProgress({
    operation: 'files',
    phase: '准备获取',
    percent: 3,
    processed: current?.processed ?? 0,
    skipped: current?.skipped ?? 0,
    failed: current?.failed ?? 0,
    message,
    kind,
  });
}

function runCli(command: string, args: string[], opts: { progress?: boolean; operation?: 'ocr' | 'files'; initialTotal?: number } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const fake = runFakeCli(command);
    if (fake) {
      const current = { seen: 0, saved: 0, skipped: 0 };
      if (opts.progress) {
        sendProgress({ percent: 8, matched: 0, saved: 0, skipped: 0, step: '邮箱', message: '正在连接邮箱并搜索邮件。' });
        for (const line of fake.stdout.split(/\r?\n/)) {
          if (line.trim()) parseFetchLine(line, current);
        }
      } else if (opts.operation === 'ocr') {
        const ocrCurrent: OcrProgressState = { total: opts.initialTotal ?? 0, parsed: 0, failed: 0, skipped: 0, processed: 0, initialized: true };
        sendOcrPhase('正在调用本机识别引擎。', ocrCurrent);
        for (const line of `${fake.stdout}\n${fake.stderr}`.split(/\r?\n/)) {
          if (line.trim()) parseOcrLine(line, ocrCurrent);
        }
      } else if (opts.operation === 'files') {
        const fileCurrent: FileProgressState = { processed: 0, skipped: 0, failed: 0 };
        sendFilePhase('正在从本地邮件中获取发票文件。', fileCurrent);
        for (const line of `${fake.stdout}\n${fake.stderr}`.split(/\r?\n/)) {
          if (line.trim()) parseFileLine(line, fileCurrent);
        }
      }
      resolve(fake);
      return;
    }
    const env = {
      ...process.env,
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    };
    const child = spawn(process.execPath, [path.join(rootDir, 'dist', 'index.js'), command, ...args], {
      cwd: rootDir,
      env,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const current: FetchProgressState = { seen: 0, saved: 0, skipped: 0 };
    const ocrCurrent: OcrProgressState = { total: opts.initialTotal ?? 0, parsed: 0, failed: 0, skipped: 0, processed: 0, initialized: false };
    const fileCurrent: FileProgressState = { processed: 0, skipped: 0, failed: 0 };

    if (opts.operation === 'ocr') {
      activeOcrProcess = child;
      activeOcrStopRequested = false;
    }

    if (opts.progress) {
      sendProgress({ percent: 8, matched: 0, saved: 0, skipped: 0, step: '邮箱', message: '正在连接邮箱并搜索邮件。' });
    } else if (opts.operation === 'ocr') {
      ocrCurrent.initialized = true;
      sendOcrPhase('正在调用本机识别引擎。', ocrCurrent);
    } else if (opts.operation === 'files') {
      sendFilePhase('正在从本地邮件中获取发票文件。', fileCurrent);
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        if (opts.progress) parseFetchLine(line, current);
        if (opts.operation === 'ocr') parseOcrLine(line, ocrCurrent);
        if (opts.operation === 'files') parseFileLine(line, fileCurrent);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
      if (opts.operation !== 'ocr' && opts.operation !== 'files') return;
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        if (opts.operation === 'ocr') parseOcrLine(line, ocrCurrent);
        if (opts.operation === 'files') parseFileLine(line, fileCurrent);
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (opts.operation === 'ocr' && activeOcrProcess === child) {
        activeOcrProcess = undefined;
      }
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      if (opts.operation === 'ocr' && activeOcrStopRequested) {
        sendOperationProgress({
          operation: 'ocr',
          phase: '已停止',
          percent: 100,
          total: ocrCurrent.total,
          processed: ocrCurrent.processed,
          parsed: ocrCurrent.parsed,
          skipped: ocrCurrent.skipped,
          failed: ocrCurrent.failed,
          message: '识别已停止。',
          kind: 'warn',
          done: true,
        });
      }
      if (opts.progress && code !== 0) {
        sendProgress({
          percent: 100,
          matched: current.seen,
          saved: current.saved,
          skipped: current.skipped,
          step: '失败',
          message: err.trim() || out.trim() || '抓取失败，请检查邮箱配置。',
          kind: 'err',
          done: true,
        });
      }
      if (opts.operation === 'ocr' && code !== 0 && !activeOcrStopRequested) {
        sendOperationProgress({
          operation: 'ocr',
          phase: '识别失败',
          percent: 100,
          total: ocrCurrent.total,
          processed: ocrCurrent.processed,
          parsed: ocrCurrent.parsed,
          skipped: ocrCurrent.skipped,
          failed: ocrCurrent.failed,
          message: err.trim() || out.trim() || '识别失败，请检查识别服务配置。',
          kind: 'err',
          done: true,
        });
      }
      if (opts.operation === 'files' && code !== 0) {
        sendFileProgress({
          operation: 'files',
          phase: '获取失败',
          percent: 100,
          processed: fileCurrent.processed,
          skipped: fileCurrent.skipped,
          failed: fileCurrent.failed,
          message: err.trim() || out.trim() || '获取发票文件失败，请检查本地邮件缓存。',
          kind: 'err',
          done: true,
        });
      }
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

function ocrRunMessage(result: { stdout: string; stderr: string }): string {
  const output = `${result.stdout}\n${result.stderr}`;
  const match = /OCR complete: scanned=(\d+), parsed=(\d+), skipped=(\d+), failed=(\d+), updated=(\d+)/.exec(output);
  if (!match) return '已尝试识别本地文件。';
  const [, scanned, parsed, skipped, failed] = match;
  if (Number(scanned) === 0) return '没有待识别文件。请先抓取邮件，或确认本地缓存里有发票附件。';
  return `已扫描 ${scanned} 个文件，识别成功 ${parsed} 个，跳过 ${skipped} 个，失败 ${failed} 个。`;
}

function appendHistory(entry: Omit<RunHistoryEntry, 'id' | 'time'>): RunHistoryEntry {
  const file = historyPath(rootDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next: RunHistoryEntry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    time: new Date().toISOString(),
    ...entry,
  };
  const history = [next, ...readRunHistory(rootDir)].slice(0, 30);
  fs.writeFileSync(file, `${JSON.stringify(history, null, 2)}\n`, { mode: 0o600 });
  return next;
}

function historyEntry(action: string, title: string, startedAt: number, result: { code: number | null; stdout: string; stderr: string }): RunHistoryEntry {
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const status: RunHistoryEntry['status'] = result.code === 0 ? 'success' : 'failed';
  const message = status === 'success' ? '已完成' : '运行失败';
  return appendHistory({
    action,
    title,
    status,
    message,
    detail: output.slice(-500) || (status === 'success' ? '命令已完成。' : '没有收到错误详情。'),
    durationMs: Date.now() - startedAt,
  });
}

function fetchArgs(payload: DateRangePayload): string[] {
  const args = ['--config', configPath, '--state', statePath];
  const cfg = readConfigForPaths();
  const paths = asObject(cfg.paths);
  const samples = typeof paths.samples === 'string' && paths.samples.length > 0 ? paths.samples : './samples/raw';
  args.push('--out', path.resolve(rootDir, samples));
  if (payload.from) args.push('--since', payload.from);
  if (payload.to) args.push('--until', payload.to);
  if (payload.dryRun) args.push('--dry-run');
  return args;
}

ipcMain.handle('mfh:get-summary', () => loadAppSummary(configPath, rootDir));

ipcMain.handle('mfh:get-config', () => {
  const { cfg, error } = loadGuiConfig(configPath);
  return { configPath, configExists: fs.existsSync(configPath), configError: error, config: cfg };
});

ipcMain.handle('mfh:save-config', (_event, payload: unknown) => {
  writeConfig(payload);
  return { ok: true, configPath };
});

ipcMain.handle('mfh:start-fetch', async (_event, payload: unknown) => {
  const startedAt = Date.now();
  const args = fetchArgs(asDateRange(payload));
  mainWindow?.webContents.executeJavaScript(`window.__mfhLastFetchArgs = ${JSON.stringify(args)}`).catch(() => {});
  const result = await runCli('fetch', args, { progress: true });
  historyEntry('fetch', '获取邮件', startedAt, result);
  return { ok: result.code === 0, ...result, summary: loadAppSummary(configPath, rootDir) };
});

ipcMain.handle('mfh:run-pipeline', async (_event, payload: unknown) => {
  const raw = asObject(payload);
  const concurrency = Number(raw.concurrency ?? 4);
  if (typeof raw.avoidConflictBeforeOcr === 'boolean') {
    writeConfig({ rename: { avoidConflictBeforeOcr: raw.avoidConflictBeforeOcr } });
  }
  const args = ['--config', configPath, '--state', statePath, '--concurrency', String(concurrency)];
  if (typeof raw.onlyMail === 'string' && raw.onlyMail) args.push('--only-mail', raw.onlyMail);
  if (raw.force === true) args.push('--force');
  const startedAt = Date.now();
  const result = await runCli('run', args, { operation: 'files' });
  historyEntry('pipeline', raw.onlyMail ? '重新处理单封邮件' : '处理缓存邮件', startedAt, result);
  return { ok: result.code === 0, ...result, summary: loadAppSummary(configPath, rootDir) };
});

function pendingOcrWorkCount(summary = loadAppSummary(configPath, rootDir)): number {
  const cfg = readConfigForPaths();
  const paths = asObject(cfg.paths);
  const invoicesDir = path.resolve(rootDir, typeof paths.invoices === 'string' ? paths.invoices : './invoices');
  const pendingCsv = path.join(invoicesDir, 'ocr', 'ocr-pending.csv');
  const rows = readCsvRows(pendingCsv);
  if (rows.length === 0) return 0;
  if (summary.library.total > 0) return summary.library.total;
  return rows.filter((row) => row.status !== 'ignored' && row.documentType !== 'supporting').length;
}

ipcMain.handle('mfh:run-ocr', async (_event, payload: unknown) => {
  const raw = asObject(payload);
  const summary = loadAppSummary(configPath, rootDir);
  const pendingTotal = pendingOcrWorkCount(summary);
  if (pendingTotal === 0) {
    sendOperationProgress({
      operation: 'ocr',
      phase: '没有文件',
      percent: 100,
      total: 0,
      processed: 0,
      parsed: 0,
      skipped: 0,
      failed: 0,
      message: '没有待识别文件。请先抓取邮件，或确认本地缓存里有发票附件。',
      kind: 'warn',
      done: true,
    });
    return {
      ok: false,
      code: 0,
      stdout: '',
      stderr: '',
      message: '没有待识别文件。请先抓取邮件，或确认本地缓存里有发票附件。',
      summary,
    };
  }

  const concurrency = Math.max(1, Math.floor(Number(raw.concurrency ?? 1) || 1));
  if (raw.resetResults === true || raw.force === true) {
    clearOcrResultsAndResetQueue();
  }
  const ocrConfigPath = writeOcrRunConfig(concurrency);
  const args = ['run', '--config', ocrConfigPath, '--allow-parse-failures'];
  if (raw.force === true) args.push('--force');
  if (concurrency > 1) {
    args.push('--concurrency', String(concurrency));
  } else {
    args.push('--single-item');
  }
  const startedAt = Date.now();
  mainWindow?.webContents.executeJavaScript(`window.__mfhLastOcrArgs = ${JSON.stringify(args)}`).catch(() => {});
  sendOperationProgress({
    operation: 'ocr',
    phase: '开始识别',
    percent: 5,
    total: pendingTotal,
    processed: 0,
    parsed: 0,
    skipped: 0,
    failed: 0,
    message: `发现 ${pendingTotal} 个待识别文件，正在启动识别。当前并行数：${concurrency}。`,
  });
  const result = await runCli('ocr', args, { operation: 'ocr', initialTotal: pendingTotal });
  historyEntry('ocr', raw.force === true ? '开始识别文件' : '识别文件', startedAt, result);
  const stopped = activeOcrStopRequested || result.code === 130;
  if (stopped) {
    activeOcrStopRequested = false;
    return { ok: false, stopped: true, ...result, message: '识别已停止。', summary: loadAppSummary(configPath, rootDir) };
  }
  activeOcrStopRequested = false;
  return { ok: result.code === 0, ...result, message: ocrRunMessage(result), summary: loadAppSummary(configPath, rootDir) };
});

ipcMain.handle('mfh:organize', async () => {
  const startedAt = Date.now();
  const result = await runCli('organize', ['--config', configPath]);
  historyEntry('organize', '整理输出文件', startedAt, result);
  return { ok: result.code === 0, ...result, summary: loadAppSummary(configPath, rootDir) };
});

ipcMain.handle('mfh:stop-ocr', () => {
  if (!activeOcrProcess) return { ok: false, message: '当前没有正在运行的识别任务。' };
  activeOcrStopRequested = true;
  activeOcrProcess.kill('SIGTERM');
  return { ok: true, message: '正在停止识别。' };
});

ipcMain.handle('mfh:open-path', async (_event, payload: unknown) => {
  const raw = asObject(payload);
  const target = typeof raw.path === 'string' ? raw.path : rootDir;
  const resolved = path.resolve(rootDir, target);
  if (raw.reveal === true) {
    shell.showItemInFolder(resolved);
    return { ok: true, error: '' };
  }
  const error = await shell.openPath(resolved);
  return { ok: !error, error };
});

ipcMain.handle('mfh:copy-text', (_event, payload: unknown) => {
  const raw = asObject(payload);
  clipboard.writeText(typeof raw.text === 'string' ? raw.text : '');
  return { ok: true };
});

ipcMain.handle('mfh:test-connection', async (_event, payload: unknown) => {
  try {
    if (payload && typeof payload === 'object') writeConfig(payload);
  } catch {
    // Ignore write failures here and still attempt a live connection.
  }
  if (process.env.MFH_E2E_FAKE_CLI === '1') {
    return { ok: true, message: '邮箱连接正常，可以获取邮件。' };
  }
  try {
    const cfg = readMutableConfig();
    const imap = asObject(cfg.imap);
    const host = stringField(imap.host);
    const port = numberField(imap.port);
    const user = stringField(imap.user);
    const pass = stringField(imap.pass);
    const tls = imap.tls !== false;
    if (!host || !Number.isFinite(port) || port <= 0 || !user || !pass) {
      return { ok: false, message: '请先填写邮箱主机、端口、账号和授权码。' };
    }
    const client = new ImapFlow({
      host,
      port,
      secure: tls,
      auth: { user, pass },
      logger: false,
    });
    await client.connect();
    const configured = asObject(cfg.imap).mailbox;
    const mailbox = Array.isArray(configured) && typeof configured[0] === 'string' && configured[0]
      ? configured[0]
      : 'INBOX';
    await client.mailboxOpen(mailbox).catch(async () => {
      const boxes = await client.list();
      if (boxes.length > 0) await client.mailboxOpen(boxes[0]!.path);
    });
    await client.logout().catch(() => undefined);
    return { ok: true, message: '邮箱连接正常，可以获取邮件。' };
  } catch (err) {
    return { ok: false, message: `邮箱连接失败：${err instanceof Error ? err.message : String(err)}` };
  }
});

ipcMain.handle('mfh:developer-reset', () => {
  const cfg = readConfigForPaths();
  const paths = asObject(cfg.paths);
  const output = asObject(cfg.output);
  const ocr = asObject(cfg.ocr);
  const rename = asObject(cfg.rename);
  const candidates = [
    paths.samples,
    paths.invoices,
    paths.pending,
    output.csv,
    output.dir,
    output.pendingDir,
    ocr.resultsCsv,
    rename.organizedDir,
    statePath,
    historyPath(rootDir),
  ];
  const removed: string[] = [];
  for (const value of candidates) {
    if (typeof value !== 'string' || value.length === 0) continue;
    const target = path.resolve(rootDir, value);
    if (!target.startsWith(rootDir)) continue;
    if (target === configPath) continue;
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(path.relative(rootDir, target) || target);
  }
  fs.mkdirSync(path.join(rootDir, '.mfh-cache'), { recursive: true });
  return { ok: true, removed: Array.from(new Set(removed)), summary: loadAppSummary(configPath, rootDir) };
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
