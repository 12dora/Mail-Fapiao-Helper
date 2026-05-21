import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfigPath, historyPath, loadAppSummary, loadGuiConfig, readRunHistory, type RunHistoryEntry } from './summary.js';

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
    executionMode?: string;
    serviceHost?: string;
    servicePort?: number | string;
    batchSize?: number | string;
    resultsCsv?: string;
    credentials?: Record<string, string>;
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
  void mainWindow.loadFile(uiPath('index.html'));
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
  };
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

function sendProgress(data: Record<string, unknown>): void {
  mainWindow?.webContents.send('mfh:fetch-progress', data);
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
    ['mfh-e2e-invoice', '2026-05-21', '国家电网 <noreply@example.com>', '国家电网电子发票通知', '国家电网-318.42.pdf', 'pdf', 'invoice', 'pending', ''],
    ['mfh-e2e-trip', '2026-05-20', '差旅平台 <travel@example.com>', '行程单通知', '行程单.pdf', 'pdf', 'itinerary', 'pending', ''],
    ['mfh-e2e-supporting', '2026-05-20', '高速通行 <etc@example.com>', '通行费汇总单', '通行费电子票据汇总单.pdf', 'pdf', 'supporting', 'ignored', 'supporting_document'],
  ];
  writeFakeE2eFile(pendingCsv, `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`);
  writeFakeE2eFile(path.join(paths.invoices, '国家电网-318.42.pdf'), '%PDF-1.4\n% fake\n');
  writeFakeE2eFile(path.join(paths.invoices, '行程单.pdf'), '%PDF-1.4\n% fake\n');
  return { code: 0, stdout: 'processed 2 cached mails\n', stderr: '' };
}

function fakeOcr(): { code: number; stdout: string; stderr: string } {
  const paths = readFakeConfigPaths();
  const pendingRows = [
    ['hash', 'date', 'from', 'subject', 'filename', 'format', 'documentType', 'status', 'reason'],
    ['mfh-e2e-invoice', '2026-05-21', '国家电网 <noreply@example.com>', '国家电网电子发票通知', '国家电网-318.42.pdf', 'pdf', 'invoice', 'recognized', ''],
    ['mfh-e2e-trip', '2026-05-20', '差旅平台 <travel@example.com>', '行程单通知', '行程单.pdf', 'pdf', 'itinerary', 'recognized', ''],
    ['mfh-e2e-supporting', '2026-05-20', '高速通行 <etc@example.com>', '通行费汇总单', '通行费电子票据汇总单.pdf', 'pdf', 'supporting', 'ignored', 'supporting_document'],
  ];
  writeFakeE2eFile(path.join(paths.invoices, 'ocr', 'ocr-pending.csv'), `${pendingRows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`);
  const rows = [
    ['filename', 'dateValue', 'date', 'seller', 'invoiceNo', 'amount', 'transport', 'status', 'documentType', 'invoiceType', 'error'],
    ['国家电网-318.42.pdf', '2026-05-21', '2026-05-21', '国家电网有限公司', '1234567890', '318.42', 'http', 'ok', 'invoice', '电子发票', ''],
    ['行程单.pdf', '2026-05-20', '2026-05-20', '差旅平台', 'TRIP-20260520', '88.00', 'http', 'ok', 'itinerary', '行程单', ''],
  ];
  writeFakeE2eFile(paths.resultsCsv, `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`);
  const manualRows = [
    ['messageId', 'date', 'from', 'subject', 'reason'],
    ['<mfh-e2e-link@example.com>', '2026-05-20T12:00:00.000Z', '服务商 <vendor@example.com>', '发票下载链接已过期', 'http_403'],
  ];
  writeFakeE2eFile(path.join(paths.pending, 'pending.csv'), `${manualRows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`);
  fs.mkdirSync(paths.organizedDir, { recursive: true });
  return { code: 0, stdout: 'OCR complete: scanned=3, parsed=2, skipped=1, failed=0, updated=2\n', stderr: '' };
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

function parseFetchLine(line: string, current: { seen: number; saved: number; skipped: number }): void {
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

function runCli(command: string, args: string[], opts: { progress?: boolean } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const fake = runFakeCli(command);
    if (fake) {
      const current = { seen: 0, saved: 0, skipped: 0 };
      if (opts.progress) {
        sendProgress({ percent: 8, matched: 0, saved: 0, skipped: 0, step: '邮箱', message: '正在连接邮箱并搜索邮件。' });
        for (const line of fake.stdout.split(/\r?\n/)) {
          if (line.trim()) parseFetchLine(line, current);
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
    const current = { seen: 0, saved: 0, skipped: 0 };

    if (opts.progress) {
      sendProgress({ percent: 8, matched: 0, saved: 0, skipped: 0, step: '邮箱', message: '正在连接邮箱并搜索邮件。' });
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
      if (!opts.progress) return;
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) parseFetchLine(line, current);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
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
  const result = await runCli('fetch', fetchArgs(asDateRange(payload)), { progress: true });
  historyEntry('fetch', '抓取邮件', startedAt, result);
  if (result.code !== 0) return { ok: false, ...result, summary: loadAppSummary(configPath, rootDir) };

  const pipelineStartedAt = Date.now();
  const pipelineResult = await runCli('run', ['--config', configPath, '--state', statePath, '--concurrency', '4']);
  historyEntry('pipeline', '处理缓存邮件', pipelineStartedAt, pipelineResult);
  return {
    ok: pipelineResult.code === 0,
    ...result,
    pipeline: pipelineResult,
    summary: loadAppSummary(configPath, rootDir),
  };
});

ipcMain.handle('mfh:run-pipeline', async (_event, payload: unknown) => {
  const raw = asObject(payload);
  const concurrency = Number(raw.concurrency ?? 4);
  const args = ['--config', configPath, '--state', statePath, '--concurrency', String(concurrency)];
  if (typeof raw.onlyMail === 'string' && raw.onlyMail) args.push('--only-mail', raw.onlyMail);
  const startedAt = Date.now();
  const result = await runCli('run', args);
  historyEntry('pipeline', raw.onlyMail ? '重新处理单封邮件' : '处理缓存邮件', startedAt, result);
  return { ok: result.code === 0, ...result, summary: loadAppSummary(configPath, rootDir) };
});

ipcMain.handle('mfh:run-ocr', async (_event, payload: unknown) => {
  const raw = asObject(payload);
  const pipelineArgs = ['--config', configPath, '--state', statePath, '--concurrency', '4'];
  const pipelineStartedAt = Date.now();
  const pipelineResult = await runCli('run', pipelineArgs);
  historyEntry('pipeline', '处理缓存邮件', pipelineStartedAt, pipelineResult);
  if (pipelineResult.code !== 0) {
    return {
      ok: false,
      ...pipelineResult,
      message: pipelineResult.stderr || pipelineResult.stdout || '处理本地缓存邮件失败。',
      summary: loadAppSummary(configPath, rootDir),
    };
  }

  let summary = loadAppSummary(configPath, rootDir);
  if (summary.library.total === 0 && summary.inbox.total > 0) {
    const recoverStartedAt = Date.now();
    const recoverResult = await runCli('run', [...pipelineArgs, '--force']);
    historyEntry('pipeline', '重建待识别清单', recoverStartedAt, recoverResult);
    if (recoverResult.code !== 0) {
      return {
        ok: false,
        ...recoverResult,
        message: recoverResult.stderr || recoverResult.stdout || '重建待识别清单失败。',
        summary: loadAppSummary(configPath, rootDir),
      };
    }
    summary = loadAppSummary(configPath, rootDir);
  }

  if (summary.library.total === 0) {
    return {
      ok: false,
      code: 0,
      stdout: '',
      stderr: '',
      message: '没有待识别文件。请先抓取邮件，或确认本地缓存里有发票附件。',
      summary,
    };
  }

  const args = ['run', '--config', configPath, '--allow-parse-failures'];
  if (raw.force === true) args.push('--force');
  const startedAt = Date.now();
  const result = await runCli('ocr', args);
  historyEntry('ocr', raw.force === true ? '开始识别文件' : '识别文件', startedAt, result);
  return { ok: result.code === 0, ...result, message: ocrRunMessage(result), summary: loadAppSummary(configPath, rootDir) };
});

ipcMain.handle('mfh:organize', async () => {
  const startedAt = Date.now();
  const result = await runCli('organize', ['--config', configPath]);
  historyEntry('organize', '整理输出文件', startedAt, result);
  return { ok: result.code === 0, ...result, summary: loadAppSummary(configPath, rootDir) };
});

ipcMain.handle('mfh:open-path', async (_event, payload: unknown) => {
  const raw = asObject(payload);
  const target = typeof raw.path === 'string' ? raw.path : rootDir;
  const error = await shell.openPath(path.resolve(rootDir, target));
  return { ok: !error, error };
});

ipcMain.handle('mfh:copy-text', (_event, payload: unknown) => {
  const raw = asObject(payload);
  clipboard.writeText(typeof raw.text === 'string' ? raw.text : '');
  return { ok: true };
});

ipcMain.handle('mfh:test-connection', async () => {
  try {
    loadGuiConfig(configPath);
    return { ok: true, message: '配置文件可以读取。抓取邮件时会实际连接邮箱。' };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
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
