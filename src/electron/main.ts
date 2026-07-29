// Electron 42's main-process "electron" module is CJS with dynamic exports —
// ESM named imports fail ("does not provide an export named 'BrowserWindow'")
// and ESM default-import yields the launcher path stub, not the API. Going
// through createRequire forces the proper main-process module.
import { createRequire as _createRequire } from 'node:module';
import type * as ElectronAPI from 'electron';
const _require = _createRequire(import.meta.url);
const { app, BrowserWindow, clipboard, dialog, ipcMain, shell }: typeof ElectronAPI = _require('electron');
type BrowserWindowType = ElectronAPI.BrowserWindow;
import { ImapFlow } from 'imapflow';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultConfigPath,
  historyPath,
  loadAppSummary,
  loadGuiConfig,
  summarizeInbox,
  summarizeLibrary,
  type AppSummary,
  type RunHistoryEntry,
} from './summary.js';
import { migrateRawConfig, validateConfigCandidate } from '../config.js';
import { readCsvRows, csvCell, parseCsv } from '../util/csv.js';
import { msgIdHash } from '../util/hash.js';
import { LineAssembler, LineRingBuffer } from './lineStream.js';
import { OperationCoordinator, type OpKind, type OpLease, type RunningOp } from './opCoordinator.js';
import { killProcessTree, terminateChildren } from './procTree.js';
import { registerManagedRoots, redactPath, sanitizeText, type UiError } from './sanitize.js';
import { runManualArchive } from './manualArchive.js';
import { ArchiveRecoveryError, assertArchiveTransactionsRecovered, recoverArchiveTransactions } from '../download/archiveJournal.js';

interface DateRangePayload {
  from?: string;
  to?: string;
  dryRun?: boolean;
  matchSubject?: boolean;
  matchBody?: boolean;
}

/** 回显给 renderer 的规范化筛选条件（APP-20 / 契约 5）。 */
interface NormalizedFilter {
  matchSubject: boolean;
  matchBody: boolean;
  keywords: string[];
  since?: string;
  until?: string;
}

interface SaveConfigPayload {
  imap?: {
    host?: string;
    port?: number | string;
    user?: string;
    pass?: string;
    tls?: boolean;
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
  };
  network?: {
    retries?: number | string;
    retryDelayMs?: number | string;
  };
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = process.env.MFH_DATA_DIR
  ? path.resolve(process.env.MFH_DATA_DIR)
  : app.getPath('userData');
const bundledConfigPath = path.join(rootDir, 'config.example.json');
const configPath = process.env.MFH_CONFIG_PATH
  ? path.resolve(process.env.MFH_CONFIG_PATH)
  : defaultConfigPath(dataDir);
const statePath = process.env.MFH_STATE_PATH
  ? path.resolve(process.env.MFH_STATE_PATH)
  : path.join(dataDir, 'state.json');

registerManagedRoots({ dataDir, appRoot: rootDir });

let mainWindow: BrowserWindowType | undefined;
// Every CLI subprocess we spawn, so they can be terminated on app quit instead
// of being orphaned (they can in turn hold an efapiao serve child / a port).
const activeChildren = new Set<ChildProcess>();
// OCR 子进程按 jobId 追踪：第二次 OCR 不会覆盖第一次的句柄，「停止」也不会漏掉
// 任何一个进程（APP-05）。
const ocrProcesses = new Map<string, ChildProcess>();
const ocrStopRequested = new Set<string>();
// 本进程创建的临时目录，退出时（含异常路径）必须清掉（APP-22）。
const activeTempDirs = new Set<string>();

const coordinator = new OperationCoordinator(dataDir);

/**
 * 仅在「未打包 + 显式开启」时加载的开发用假后端（CODE-04）。打包后 app.isPackaged
 * 为 true，无论环境变量如何都必须走真实 CLI。
 */
type DevFakeBackend = typeof import('./devFakeBackend.js');
let devBackend: DevFakeBackend | undefined;

function devFakeBackendEnabled(): boolean {
  return !app.isPackaged && process.env.MFH_E2E_FAKE_CLI === '1';
}

function e2eNoGuiMode(): boolean {
  return !app.isPackaged && process.env.MFH_E2E_NO_GUI === '1';
}

async function loadDevFakeBackend(): Promise<void> {
  if (!devFakeBackendEnabled()) return;
  try {
    devBackend = await import('./devFakeBackend.js');
  } catch {
    devBackend = undefined;
  }
}

function uiPath(...parts: string[]): string {
  return path.join(rootDir, 'gui-design', ...parts);
}

function ensureUserDataConfig(): void {
  fs.mkdirSync(dataDir, { recursive: true });
  if (fs.existsSync(configPath)) return;
  fs.copyFileSync(bundledConfigPath, configPath);
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    // Best-effort on platforms that do not preserve POSIX file modes.
  }
}

function createWindow(): void {
  const noGui = e2eNoGuiMode();
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    show: !noGui,
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
  // ELEC-01：拒绝导航到非本机 file 页面，并禁止任意 window.open。
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file:')) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // 新窗口（含 macOS 从 Dock 重开）需要立刻知道是否已有任务在跑。
  mainWindow.webContents.once('did-finish-load', () => {
    sendToRenderer('op-state', coordinator.state() as unknown as Record<string, unknown>);
  });
  void mainWindow.loadFile(uiPath('pages', 'dashboard.html'));
}

/**
 * 只接受主窗口当前的 file: 页面作为 IPC 调用方（ELEC-01）。
 * 破坏性操作与写路径在 handler 内强制调用。
 */
function assertTrustedSender(event: ElectronAPI.IpcMainInvokeEvent): boolean {
  try {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return false;
    if (event.sender.id !== mainWindow.webContents.id) return false;
    if (event.sender.isDestroyed()) return false;
    const url = event.sender.getURL();
    if (!url.startsWith('file:')) return false;
    return true;
  } catch {
    return false;
  }
}

async function openPathForUser(target: string): Promise<string> {
  if (e2eNoGuiMode()) return '';
  return shell.openPath(target);
}

function showItemInFolderForUser(target: string): void {
  if (e2eNoGuiMode()) return;
  shell.showItemInFolder(target);
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
    matchSubject: typeof raw.matchSubject === 'boolean' ? raw.matchSubject : undefined,
    matchBody: typeof raw.matchBody === 'boolean' ? raw.matchBody : undefined,
  };
}

// ---------------------------------------------------------------------------
// 配置读写（APP-08 / 契约 4）
// ---------------------------------------------------------------------------

type ConfigRead =
  | { ok: true; raw: Record<string, unknown> }
  | { ok: false; message: string };

/** 读取真实配置；损坏时如实报错，绝不静默替换成 example。 */
function readConfigStrict(): ConfigRead {
  const source = fs.existsSync(configPath) ? configPath : bundledConfigPath;
  try {
    const parsed = JSON.parse(fs.readFileSync(source, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, message: '配置文件内容不是一个 JSON 对象。' };
    }
    return { ok: true, raw: parsed as Record<string, unknown> };
  } catch (err) {
    return { ok: false, message: sanitizeText(err instanceof Error ? err.message : String(err)) };
  }
}

/**
 * 仅用于「解析目录位置」的宽松读取：目录创建、摘要刷新等只读路径在配置损坏时
 * 仍需要一组可用路径。任何写盘路径都不得使用它。
 */
function readConfigForPaths(): Record<string, unknown> {
  const result = readConfigStrict();
  if (result.ok) return result.raw;
  try {
    return JSON.parse(fs.readFileSync(bundledConfigPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
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
    network: payload.network,
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

export interface SaveConfigOutcome {
  ok: boolean;
  configPath: string;
  config?: Record<string, unknown>;
  fieldErrors?: { path: string; message: string }[];
  configError?: { message: string; backupPath?: string };
  /** 显式修复损坏配置时，被隔离备份的旧文件（已脱敏）。 */
  repairedFrom?: string;
}

function writeConfigAtomic(candidate: Record<string, unknown>): void {
  // Atomic tmp+rename so a crash mid-write can never leave a truncated
  // config.json (which holds the IMAP password) on disk.
  const tmpPath = `${configPath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, configPath);
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    // Best-effort on platforms that do not preserve POSIX file modes.
  }
}

/**
 * 合并 → 用正式 schema 校验完整候选配置 → 原子替换。校验不通过时返回字段级错误，
 * 磁盘上的旧配置保持不变（APP-08）。
 */
function saveConfig(payload: unknown, opts: { repairCorrupt?: boolean } = {}): SaveConfigOutcome {
  let base: Record<string, unknown>;
  let backupPath: string | undefined;
  const current = readConfigStrict();
  if (current.ok) {
    base = current.raw;
  } else if (!opts.repairCorrupt) {
    return {
      ok: false,
      configPath,
      configError: { message: `配置文件已损坏，无法保存：${current.message}` },
    };
  } else {
    // 显式修复：先把损坏文件隔离备份，再以内置示例为基线重建。
    const backup = `${configPath}.corrupt-${Date.now()}.json`;
    try {
      if (fs.existsSync(configPath)) fs.copyFileSync(configPath, backup);
      backupPath = redactPath(backup);
    } catch {
      backupPath = undefined;
    }
    try {
      base = JSON.parse(fs.readFileSync(bundledConfigPath, 'utf8')) as Record<string, unknown>;
    } catch {
      return { ok: false, configPath, configError: { message: '内置示例配置不可读，无法修复配置文件。', ...(backupPath ? { backupPath } : {}) } };
    }
  }

  const merged = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  mergeDefined(merged, normalizeSavePayload(payload));
  // 先迁移（补 schemaVersion 与新版默认值），再用正式 schema 校验完整候选配置。
  const candidate = migrateRawConfig(merged).raw;

  const validated = validateConfigCandidate(candidate);
  if (!validated.ok) {
    return { ok: false, configPath, fieldErrors: validated.errors };
  }

  try {
    writeConfigAtomic(candidate);
  } catch (err) {
    return {
      ok: false,
      configPath,
      configError: {
        message: '无法写入配置文件，请确认数据目录可写。',
        ...(backupPath ? { backupPath } : {}),
      },
    };
  }
  return { ok: true, configPath, config: redactConfig(candidate), ...(backupPath ? { repairedFrom: backupPath } : {}) };
}

/** 屏蔽所有 secret 形态的字段后再交给 renderer。 */
function redactConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const isSecretKey = (k: string): boolean => /secret|key|token|pass/i.test(k);
  const imap = { ...asObject(raw.imap), pass: '' };
  const ocrSrc = asObject(raw.ocr);
  const creds = asObject(ocrSrc.credentials);
  const ocr = {
    ...ocrSrc,
    credentials: Object.fromEntries(Object.entries(creds).map(([k, v]) => [k, isSecretKey(k) ? '' : v])),
  };
  return { ...raw, imap, ocr };
}

// ---------------------------------------------------------------------------
// 临时文件与 OCR run config（APP-22）
// ---------------------------------------------------------------------------

function tempRoot(): string {
  return path.join(dataDir, '.mfh-cache', 'tmp');
}

/** 创建一个仅当前用户可读写的唯一临时目录。 */
function createTempDir(prefix: string): string {
  const dir = path.join(tempRoot(), `${prefix}-${process.pid}-${randomBytes(6).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // 非 POSIX 平台忽略。
  }
  activeTempDirs.add(dir);
  return dir;
}

function removeTempDir(dir: string): void {
  activeTempDirs.delete(dir);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function cleanupAllTempDirs(): void {
  for (const dir of Array.from(activeTempDirs)) removeTempDir(dir);
}

/**
 * 启动时清理上次崩溃/强退遗留的临时配置：持有者进程已经不存在的目录，以及旧版本
 * 写在可预测路径上的 `ocr-run-config.json`。
 */
function cleanupStaleTempDirs(): void {
  try {
    fs.rmSync(path.join(dataDir, '.mfh-cache', 'ocr-run-config.json'), { force: true });
  } catch {
    // best-effort
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(tempRoot(), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const match = /^[a-z]+-(\d+)-[0-9a-f]+$/.exec(entry.name);
    const pid = match ? Number(match[1]) : NaN;
    if (Number.isInteger(pid) && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        continue; // 持有者仍在运行，留给它自己清理。
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EPERM') continue;
      }
    }
    try {
      fs.rmSync(path.join(tempRoot(), entry.name), { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

/**
 * 只生成 OCR 真正需要的最小配置：保留 `ocr` 与 `paths`，其余字段用占位值填满
 * schema。IMAP 授权码与 LLM API key 不会出现在这个临时文件里（APP-22）。
 */
function buildMinimalOcrConfig(current: Record<string, unknown>, concurrency: number): Record<string, unknown> {
  const ocr = asObject(current.ocr);
  const paths = asObject(current.paths);
  const rename = asObject(current.rename);
  const host = typeof ocr.serviceHost === 'string' && ocr.serviceHost ? ocr.serviceHost : '127.0.0.1';
  const basePort = Number(ocr.servicePort ?? 8000) || 8000;
  const port = concurrency > 1 ? basePort + concurrency - 1 : basePort;
  const str = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value.length > 0 ? value : fallback;

  return {
    // 占位的邮箱配置：仅用于通过 schema 校验，OCR 流程不会读取它们。
    imap: { host: 'localhost', port: 993, user: 'ocr-run', pass: 'unused', tls: true, mailbox: ['INBOX'] },
    filter: { keywords: ['发票'], matchSubject: true, matchBody: true, sinceDays: 30 },
    paths: {
      samples: str(paths.samples, './samples/raw'),
      invoices: str(paths.invoices, './invoices'),
      pending: str(paths.pending, './pending'),
    },
    output: { csv: './invoices/invoices.csv' },
    rename: {
      rule: str(rename.rule, '{date}_{seller}_{amount}'),
      fallback: str(rename.fallback, '{hash}_{index}'),
      avoidConflictBeforeOcr: rename.avoidConflictBeforeOcr !== false,
      applyAfterOcr: false,
      organizeByType: false,
    },
    ocr: {
      ...ocr,
      serviceWorkers: concurrency,
      servicePort: port,
      serviceUrl: `http://${host}:${port}`,
    },
    playwright: { headless: true, timeoutMs: 30000 },
    network: { retries: 3, retryDelayMs: 1000 },
  };
}

function writeOcrRunConfig(concurrency: number): { dir: string; file: string } {
  const current = readConfigStrict();
  if (!current.ok) throw new Error(current.message);
  const dir = createTempDir('ocr');
  const file = path.join(dir, 'ocr-run-config.json');
  const minimal = buildMinimalOcrConfig(current.raw, concurrency);
  fs.writeFileSync(file, `${JSON.stringify(minimal, null, 2)}\n`, { mode: 0o600 });
  return { dir, file };
}

// ---------------------------------------------------------------------------
// 事件广播（COPY-01：统一脱敏后再进 IPC）
// ---------------------------------------------------------------------------

type ProgressSink = (data: Record<string, unknown>) => void;

function sendToRenderer(channel: string, data: Record<string, unknown>): void {
  // A CLI subprocess keeps streaming progress after the user closes the window
  // (on macOS the app stays alive). Sending to a destroyed webContents throws
  // "Object has been destroyed" from inside a stream 'data' listener and would
  // crash the main process, so guard every send.
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    win.webContents.send(channel, data);
  }
}

const sendProgress: ProgressSink = (data) => sendToRenderer('mfh:fetch-progress', data);
const sendOperationProgress: ProgressSink = (data) => sendToRenderer('mfh:operation-progress', data);
const sendFileProgress: ProgressSink = (data) => sendToRenderer('mfh:file-progress', data);

/**
 * 终态事件只允许发一次（APP-23）：解析到 `done: true` 之后的后续事件全部丢弃，
 * 这样 exit result 补发的终态不会和行解析出的终态重复。
 */
function terminalGuard(send: ProgressSink): ProgressSink {
  let done = false;
  return (data) => {
    if (done) return;
    if (data.done === true) done = true;
    send(data);
  };
}

/** 去掉 CLI 日志行首的 `[info] 2026-.. ` 前缀，再统一脱敏。 */
function logText(line: string): string {
  return sanitizeText(line.replace(/^\[(info|warn|error|debug)\]\s+\S+\s+/, ''), { maxLength: 240 });
}

/**
 * 从 `key=value` 形态的 CLI 汇总行里按字段名取数。CLI 会在汇总行里增删字段
 * （例如 fetch 新增了 `repaired=`、run 新增了 `partial=`），逐字段解析可以避免
 * 「多了一个字段就整条终态行不再匹配」——那正好会让 APP-23 修好的终态事件重新丢失。
 */
function numField(text: string, key: string): number | undefined {
  const match = new RegExp(`\\b${key}=(\\d+)\\b`).exec(text);
  return match ? Number(match[1]) : undefined;
}

/**
 * CLI 日志里的邮件身份（HASH-WIDTH / CORE-03）：
 * - 历史 12 位 sha1 前缀（无 raw）
 * - 有 raw 时 32 位 sha256 前缀（128 bit）
 * 这些行是主进程能拿到的、逐封邮件的**真实**信号，用来拼「本次抓取 / 本次运行」
 * 的批次明细（APP-20）——而不是去 INDEX 里取最后 N 行。
 */
const MAIL_HASH_BODY = '([0-9a-f]{12}|[0-9a-f]{32})';
const SAVED_MAIL_RE = new RegExp(`\\bsaved ${MAIL_HASH_BODY}\\b`);
const PROCESSED_MAIL_RE = new RegExp(`\\bProcessed ${MAIL_HASH_BODY}:`);
const MANUAL_MAIL_RE = new RegExp(`\\bManual ${MAIL_HASH_BODY}:`);
/** IPC / 路径拼接用的裸 hash 校验：只接受 12 或 32 位小写十六进制（ELEC-06）。 */
const BARE_MAIL_HASH_RE = /^[0-9a-f]{12}$|^[0-9a-f]{32}$/;

function parseMailHash(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const hash = value.trim().toLowerCase();
  if (!BARE_MAIL_HASH_RE.test(hash)) return undefined;
  return hash;
}

interface FetchProgressState {
  seen: number;
  saved: number;
  skipped: number;
  repaired: number;
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
  /** 已知待处理总数（来自 Queued N）；未知时为 0，不发假 percent（FE-12-BACKEND）。 */
  total: number;
  processed: number;
  skipped: number;
  failed: number;
  partial: number;
}

function parseFetchLine(line: string, current: FetchProgressState, emit: ProgressSink): void {
  if (line.includes('done: seen=')) {
    current.seen = numField(line, 'seen') ?? current.seen;
    current.saved = numField(line, 'saved') ?? current.saved;
    current.skipped = numField(line, 'skippedKnown') ?? current.skipped;
    current.repaired = numField(line, 'repaired') ?? current.repaired;
    const dryRun = /\bdryRun=true\b/.test(line);
    const repairedNote = current.repaired > 0 ? `，修复 ${current.repaired} 封缓存缺失的邮件` : '';
    emit({
      percent: 100,
      matched: current.seen,
      saved: current.saved,
      skipped: current.skipped,
      repaired: current.repaired,
      dryRun,
      step: '完成',
      code: dryRun ? 'fetch_preview_done' : 'fetch_done',
      message: dryRun
        ? `预览完成：命中 ${current.seen} 封邮件，本次没有写入本机（预览模式）。`
        : `已保存 ${current.saved} 封新邮件，跳过 ${current.skipped} 封已缓存邮件${repairedNote}。`,
      kind: 'ok',
      done: true,
    });
    return;
  }
  if (SAVED_MAIL_RE.test(line)) {
    current.saved++;
    current.seen = Math.max(current.seen, current.saved + current.skipped);
    emit({
      percent: Math.min(92, 20 + current.saved * 3),
      matched: current.seen,
      saved: current.saved,
      skipped: current.skipped,
      step: '保存',
      code: 'fetch_saved',
      message: '已保存一封相关邮件到本机缓存。',
    });
  }
}

function parseOcrLine(line: string, current: OcrProgressState, emit: ProgressSink): void {
  const text = line.trim();
  if (!text) return;
  const complete = /OCR complete: scanned=(\d+), parsed=(\d+), skipped=(\d+), failed=(\d+), updated=(\d+)/.exec(text);
  if (complete) {
    current.total = Number(complete[1]);
    current.parsed = Number(complete[2]);
    current.skipped = Number(complete[3]);
    current.failed = Number(complete[4]);
    current.processed = current.parsed + current.skipped + current.failed;
    emit({
      operation: 'ocr',
      phase: '识别完成',
      percent: 100,
      total: current.total,
      processed: current.processed,
      parsed: current.parsed,
      skipped: current.skipped,
      failed: current.failed,
      code: 'ocr_done',
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
    emit({
      operation: 'ocr',
      phase: '正在识别',
      percent: current.total > 0 ? Math.min(96, Math.round((current.processed / current.total) * 100)) : undefined,
      total: current.total,
      processed: current.processed,
      parsed: current.parsed,
      skipped: current.skipped,
      failed: current.failed,
      code: 'ocr_item_ok',
      message: `识别成功：${sanitizeText(parsed[1] ?? '', { maxLength: 120 })}`,
      kind: 'ok',
    });
    return;
  }

  const failed = /OCR failed (.+?)(?:: (.*))?$/.exec(text);
  if (failed) {
    current.failed++;
    current.processed++;
    const detail = failed[2] ? sanitizeText(failed[2], { maxLength: 200 }) : '';
    emit({
      operation: 'ocr',
      phase: '正在识别',
      percent: current.total > 0 ? Math.min(96, Math.round((current.processed / current.total) * 100)) : undefined,
      total: current.total,
      processed: current.processed,
      parsed: current.parsed,
      skipped: current.skipped,
      failed: current.failed,
      code: 'ocr_item_failed',
      message: `识别失败：${sanitizeText(failed[1] ?? '', { maxLength: 120 })}`,
      detail,
      kind: 'warn',
    });
    return;
  }

  emit({
    operation: 'ocr',
    phase: '识别日志',
    total: current.total,
    processed: current.processed,
    parsed: current.parsed,
    skipped: current.skipped,
    failed: current.failed,
    code: 'ocr_log',
    message: logText(text),
    kind: text.includes('[error]') ? 'err' : text.includes('[warn]') ? 'warn' : '',
  });
}

function sendOcrPhase(message: string, emit: ProgressSink, current?: Partial<OcrProgressState>, kind = ''): void {
  emit({
    operation: 'ocr',
    phase: '准备识别',
    percent: 3,
    total: current?.total ?? 0,
    processed: current?.processed ?? 0,
    parsed: current?.parsed ?? 0,
    skipped: current?.skipped ?? 0,
    failed: current?.failed ?? 0,
    code: 'ocr_phase',
    message,
    kind,
  });
}

/** 有 total 时给真实 percent；未知 total 时不发 percent，让 renderer 走不确定进度（FE-12）。 */
function fileProgressPercent(current: FileProgressState): number | undefined {
  if (current.total <= 0) return undefined;
  const done = current.processed + current.skipped + current.failed;
  return Math.min(95, Math.max(1, Math.round((done / current.total) * 100)));
}

function parseFileLine(line: string, current: FileProgressState, emit: ProgressSink): void {
  const text = line.trim();
  if (!text) return;
  if (text.includes('Run complete:')) {
    current.processed = numField(text, 'processed') ?? current.processed;
    current.skipped = numField(text, 'skipped') ?? current.skipped;
    current.failed = numField(text, 'failed') ?? current.failed;
    current.partial = numField(text, 'partial') ?? current.partial;
    const partialNote = current.partial > 0 ? `，部分成功 ${current.partial} 封` : '';
    emit({
      operation: 'files',
      phase: '获取完成',
      percent: 100,
      total: current.total > 0 ? current.total : current.processed + current.skipped + current.failed,
      processed: current.processed,
      skipped: current.skipped,
      failed: current.failed,
      partial: current.partial,
      code: 'files_done',
      message: `获取完成：处理 ${current.processed} 封${partialNote}，跳过 ${current.skipped} 封，失败 ${current.failed} 封。`,
      kind: current.failed > 0 || current.partial > 0 ? 'warn' : 'ok',
      done: true,
    });
    return;
  }

  // CLI：`Queued N cached emails with concurrency=...` —— 已知总数时发 real total。
  const queued = /Queued (\d+) cached emails/.exec(text);
  if (queued) {
    current.total = Number(queued[1]) || 0;
    emit({
      operation: 'files',
      phase: '正在获取',
      ...(current.total > 0 ? { total: current.total, percent: 1 } : {}),
      processed: current.processed,
      skipped: current.skipped,
      failed: current.failed,
      code: 'files_queued',
      message: current.total > 0
        ? `准备处理 ${current.total} 封已保存邮件。`
        : '准备处理已保存的邮件。',
    });
    return;
  }

  if (text.includes('Processed ')) {
    current.processed++;
    const percent = fileProgressPercent(current);
    emit({
      operation: 'files',
      phase: '正在获取',
      ...(percent !== undefined ? { percent } : {}),
      ...(current.total > 0 ? { total: current.total } : {}),
      processed: current.processed,
      skipped: current.skipped,
      failed: current.failed,
      code: 'files_item_ok',
      message: '已从一封邮件取得发票文件。',
      kind: 'ok',
    });
    return;
  }

  if (text.includes('Skipped ')) {
    current.skipped++;
    const percent = fileProgressPercent(current);
    emit({
      operation: 'files',
      phase: '正在获取',
      ...(percent !== undefined ? { percent } : {}),
      ...(current.total > 0 ? { total: current.total } : {}),
      processed: current.processed,
      skipped: current.skipped,
      failed: current.failed,
      code: 'files_item_skipped',
      message: '跳过一封此前已处理的邮件。',
    });
    return;
  }

  if (MANUAL_MAIL_RE.test(text)) {
    // 降级到待确认也算处理进度的一部分，但不增加 processed。
    emit({
      operation: 'files',
      phase: '需要确认',
      ...(current.total > 0 ? { total: current.total } : {}),
      processed: current.processed,
      skipped: current.skipped,
      failed: current.failed,
      code: 'files_item_manual',
      message: '一封邮件暂时无法自动取得发票，已加入「待确认」。',
      kind: 'warn',
    });
    return;
  }

  // 未识别的原始 CLI 行不进普通进度（COPY-06 / ELEC-07）；只保留结构化消息。
  if (text.includes('[error]') || text.includes('[warn]')) {
    emit({
      operation: 'files',
      phase: text.includes('[warn]') ? '需要确认' : '获取日志',
      ...(current.total > 0 ? { total: current.total } : {}),
      processed: current.processed,
      skipped: current.skipped,
      failed: current.failed,
      code: 'files_log',
      message: logText(text),
      kind: text.includes('[error]') ? 'err' : 'warn',
    });
  }
}

function sendFilePhase(message: string, emit: ProgressSink, current?: Partial<FileProgressState>, kind = ''): void {
  emit({
    operation: 'files',
    phase: '准备获取',
    percent: 3,
    ...(current?.total && current.total > 0 ? { total: current.total } : {}),
    processed: current?.processed ?? 0,
    skipped: current?.skipped ?? 0,
    failed: current?.failed ?? 0,
    code: 'files_phase',
    message,
    kind,
  });
}

// ---------------------------------------------------------------------------
// CLI 子进程
// ---------------------------------------------------------------------------

interface RunCliOptions {
  progress?: boolean;
  operation?: 'ocr' | 'files';
  initialTotal?: number;
  jobId?: string;
}

/**
 * 本次运行真正触达的邮件身份（APP-20）。逐行流式收集，而不是事后从 stdout tail
 * 里回捞——诊断输出是有界 ring buffer，长任务会把早期的 `saved/Processed` 行挤掉。
 */
interface RunCliMails {
  /** fetch：本次新写入本机缓存的邮件。 */
  saved: string[];
  /** run：本次真正归档成功的邮件。 */
  processed: string[];
  /** run：本次被降级到待确认队列的邮件。 */
  manual: string[];
}

interface RunCliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** 子进程是否成功启动（spawn 失败时为 false，供 APP-17 判断是否回滚）。 */
  started: boolean;
  spawnError?: UiError;
  mails: RunCliMails;
}

function runCli(command: string, args: string[], opts: RunCliOptions = {}): Promise<RunCliResult> {
  return new Promise((resolve) => {
    const emitFetch = terminalGuard(sendProgress);
    const emitOcr = terminalGuard(sendOperationProgress);
    const emitFiles = terminalGuard(sendFileProgress);
    const current: FetchProgressState = { seen: 0, saved: 0, skipped: 0, repaired: 0 };
    const ocrCurrent: OcrProgressState = { total: opts.initialTotal ?? 0, parsed: 0, failed: 0, skipped: 0, processed: 0, initialized: false };
    const fileCurrent: FileProgressState = { total: 0, processed: 0, skipped: 0, failed: 0, partial: 0 };
    const savedMails = new Set<string>();
    const processedMails = new Set<string>();
    const manualMails = new Set<string>();
    const mails = (): RunCliMails => ({
      saved: Array.from(savedMails),
      processed: Array.from(processedMails),
      manual: Array.from(manualMails),
    });

    const handleLine = (line: string): void => {
      if (!line.trim()) return;
      const saved = SAVED_MAIL_RE.exec(line);
      if (saved?.[1]) savedMails.add(saved[1]);
      const processed = PROCESSED_MAIL_RE.exec(line);
      if (processed?.[1]) processedMails.add(processed[1]);
      const manual = MANUAL_MAIL_RE.exec(line);
      if (manual?.[1]) manualMails.add(manual[1]);
      if (opts.progress) parseFetchLine(line, current, emitFetch);
      if (opts.operation === 'ocr') parseOcrLine(line, ocrCurrent, emitOcr);
      if (opts.operation === 'files') parseFileLine(line, fileCurrent, emitFiles);
    };

    if (devBackend) {
      const fake = devBackend.runFakeCli(command, args, { dataDir, readConfig: readConfigForPaths });
      if (opts.progress) {
        emitFetch({ percent: 8, matched: 0, saved: 0, skipped: 0, step: '邮箱', code: 'fetch_phase', message: '正在连接邮箱并搜索邮件。' });
      } else if (opts.operation === 'ocr') {
        ocrCurrent.initialized = true;
        sendOcrPhase('正在调用本机识别引擎。', emitOcr, ocrCurrent);
      } else if (opts.operation === 'files') {
        sendFilePhase('正在从本地邮件中获取发票文件。', emitFiles, fileCurrent);
      }
      for (const line of `${fake.stdout}\n${fake.stderr}`.split(/\r?\n/)) handleLine(line);
      resolve({ ...fake, started: true, mails: mails() });
      return;
    }

    const env = {
      ...process.env,
      MFH_APP_ROOT: rootDir,
      MFH_RESOURCE_ROOT: process.resourcesPath,
      // 当前数据目录租约的凭证：子进程凭 token 与磁盘锁文件比对来判定「继承租约」，
      // 而不是凭 ppid（APP-05）。
      ...coordinator.leaseEnv(),
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    };
    // ELEC-04：POSIX 上以独立进程组启动，终止时才能对负 PGID 杀掉 efapiao serve 孙进程。
    const child = spawn(process.execPath, [path.join(rootDir, 'dist', 'index.js'), command, ...args], {
      cwd: dataDir,
      env,
      detached: process.platform !== 'win32',
    });
    activeChildren.add(child);
    // 有界的诊断输出：只保留最后 500 行，长任务不再让主进程内存无限增长。
    const stdoutTail = new LineRingBuffer(500);
    const stderrTail = new LineRingBuffer(500);
    const stdoutLines = new LineAssembler();
    const stderrLines = new LineAssembler();

    if (opts.operation === 'ocr' && opts.jobId) {
      // 不覆盖已有句柄：协调器保证同一时刻只有一个 OCR，这里再兜一层。
      ocrProcesses.set(opts.jobId, child);
    }

    if (opts.progress) {
      emitFetch({ percent: 8, matched: 0, saved: 0, skipped: 0, step: '邮箱', code: 'fetch_phase', message: '正在连接邮箱并搜索邮件。' });
    } else if (opts.operation === 'ocr') {
      ocrCurrent.initialized = true;
      sendOcrPhase('正在调用本机识别引擎。', emitOcr, ocrCurrent);
    } else if (opts.operation === 'files') {
      sendFilePhase('正在从本地邮件中获取发票文件。', emitFiles, fileCurrent);
    }

    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of stdoutLines.push(chunk)) {
        stdoutTail.push(line);
        handleLine(line);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      for (const line of stderrLines.push(chunk)) {
        stderrTail.push(line);
        if (opts.operation === 'ocr' || opts.operation === 'files') handleLine(line);
      }
    });

    let settled = false;
    child.on('error', (err) => {
      activeChildren.delete(child);
      if (opts.jobId) ocrProcesses.delete(opts.jobId);
      if (settled) return;
      settled = true;
      const spawnError: UiError = {
        code: 'cli_spawn_failed',
        message: '无法启动后台任务，请重新打开应用后重试。',
        detail: sanitizeText(err.message),
      };
      if (opts.progress) {
        emitFetch({ percent: 100, step: '失败', ...spawnError, kind: 'err', done: true });
      } else if (opts.operation === 'ocr') {
        emitOcr({ operation: 'ocr', phase: '识别失败', percent: 100, ...spawnError, kind: 'err', done: true });
      } else if (opts.operation === 'files') {
        emitFiles({ operation: 'files', phase: '获取失败', percent: 100, ...spawnError, kind: 'err', done: true });
      }
      resolve({ code: null, stdout: '', stderr: spawnError.detail ?? '', started: false, spawnError, mails: mails() });
    });

    child.on('close', (code) => {
      activeChildren.delete(child);
      if (opts.jobId) ocrProcesses.delete(opts.jobId);
      if (settled) return;
      settled = true;
      // 关闭时把 carry 里的半行交给解析器，终态行不会因 chunk 边界丢失。
      for (const line of stdoutLines.flush()) {
        stdoutTail.push(line);
        handleLine(line);
      }
      for (const line of stderrLines.flush()) {
        stderrTail.push(line);
        if (opts.operation === 'ocr' || opts.operation === 'files') handleLine(line);
      }

      const out = stdoutTail.toString();
      const err = stderrTail.toString();
      const detail = sanitizeText(err.trim() || out.trim(), { maxLength: 400 });
      const stopped = opts.jobId ? ocrStopRequested.has(opts.jobId) : false;

      if (opts.operation === 'ocr' && stopped) {
        emitOcr({
          operation: 'ocr',
          phase: '已停止',
          percent: 100,
          total: ocrCurrent.total,
          processed: ocrCurrent.processed,
          parsed: ocrCurrent.parsed,
          skipped: ocrCurrent.skipped,
          failed: ocrCurrent.failed,
          code: 'ocr_stopped',
          message: '识别已停止。',
          kind: 'warn',
          done: true,
        });
      }
      if (opts.progress && code !== 0) {
        emitFetch({
          percent: 100,
          matched: current.seen,
          saved: current.saved,
          skipped: current.skipped,
          step: '失败',
          code: 'fetch_failed',
          message: '抓取失败，请检查邮箱配置后重试。',
          detail,
          kind: 'err',
          done: true,
        });
      }
      if (opts.operation === 'ocr' && code !== 0 && !stopped) {
        emitOcr({
          operation: 'ocr',
          phase: '识别失败',
          percent: 100,
          total: ocrCurrent.total,
          processed: ocrCurrent.processed,
          parsed: ocrCurrent.parsed,
          skipped: ocrCurrent.skipped,
          failed: ocrCurrent.failed,
          code: 'ocr_failed',
          // COPY-10
          message: '无法完成识别。请确认磁盘空间充足，并在「邮箱与保存」中重新选择发票保存位置后重试。',
          detail,
          kind: 'err',
          done: true,
        });
      }
      if (opts.operation === 'files' && code !== 0) {
        emitFiles({
          operation: 'files',
          phase: '获取失败',
          percent: 100,
          ...(fileCurrent.total > 0 ? { total: fileCurrent.total } : {}),
          processed: fileCurrent.processed,
          skipped: fileCurrent.skipped,
          failed: fileCurrent.failed,
          code: 'files_failed',
          // COPY-10
          message: '获取发票文件没有完成。请先重试；如果仍失败，请确认发票保存位置可用，再展开「查看技术详情」。',
          detail,
          kind: 'err',
          done: true,
        });
      }
      resolve({ code, stdout: out, stderr: err, started: true, mails: mails() });
    });
  });
}

// ---------------------------------------------------------------------------
// 诊断输出（COPY-01：原始日志只落到主进程受限的诊断文件，绝不进 IPC 返回值）
// ---------------------------------------------------------------------------

/** 保留的诊断文件数量上限，避免原始日志长期堆积在磁盘上。 */
const DIAGNOSTICS_KEEP = 20;

function diagnosticsDir(): string {
  return path.join(dataDir, '.mfh-cache', 'diagnostics');
}

function pruneDiagnostics(dir: string): void {
  try {
    const files = fs.readdirSync(dir)
      .filter((name) => name.endsWith('.log'))
      .sort();
    for (const name of files.slice(0, Math.max(0, files.length - DIAGNOSTICS_KEEP))) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
  } catch {
    // best-effort
  }
}

/**
 * 把子进程原始 stdout/stderr 写进 0600 的诊断文件，返回**相对 dataDir** 的引用。
 * renderer 只拿到这个引用，可以经 `mfh:open-path`（有目录包含性校验）让用户显式
 * 打开；原始内容不会出现在 bridge 返回值、toast、剪贴板或运行历史里。
 */
function writeDiagnostics(action: string, jobId: string, result: { stdout: string; stderr: string }): string | undefined {
  const raw = `${result.stdout}\n${result.stderr}`.trim();
  if (!raw) return undefined;
  try {
    const dir = diagnosticsDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `${action}-${stamp}-${jobId}.log`);
    const body = [
      `# action=${action} job=${jobId} time=${new Date().toISOString()}`,
      '# 本文件保留子进程原始输出，可能包含下载链接、令牌和本机路径，请勿直接分享。',
      '',
      '[stdout]',
      result.stdout,
      '',
      '[stderr]',
      result.stderr,
      '',
    ].join('\n');
    fs.writeFileSync(file, body, { encoding: 'utf8', mode: 0o600 });
    pruneDiagnostics(dir);
    return path.relative(dataDir, file).split(path.sep).join('/');
  } catch {
    return undefined;
  }
}

/** IPC 返回值里与子进程结果相关的字段：只有 code / 已脱敏 detail / 诊断引用。 */
interface CliReport {
  code: string;
  exitCode: number | null;
  detail?: string;
  diagnosticsRef?: string;
}

function reportFor(
  action: string,
  jobId: string,
  result: RunCliResult,
  codes: { ok: string; failed: string },
): CliReport {
  if (result.code === 0) return { code: codes.ok, exitCode: result.code };
  const detail = sanitizeText(result.stderr.trim() || result.stdout.trim(), { maxLength: 400 });
  const diagnosticsRef = writeDiagnostics(action, jobId, result);
  return {
    code: codes.failed,
    exitCode: result.code,
    ...(detail ? { detail } : {}),
    ...(diagnosticsRef ? { diagnosticsRef } : {}),
  };
}

function ocrRunMessage(result: { stdout: string; stderr: string }): string {
  const output = `${result.stdout}\n${result.stderr}`;
  const match = /OCR complete: scanned=(\d+), parsed=(\d+), skipped=(\d+), failed=(\d+), updated=(\d+)/.exec(output);
  if (!match) return '已尝试识别本地文件。';
  const [, scanned, parsed, skipped, failed] = match;
  if (Number(scanned) === 0) {
    return '没有等待识别的文件。请到「开始处理」，先完成「获取邮件」和「获取发票文件」，再开始识别。';
  }
  return `已扫描 ${scanned} 个文件，识别成功 ${parsed} 个，跳过 ${skipped} 个，失败 ${failed} 个。`;
}

// ---------------------------------------------------------------------------
// GUI 运行历史（APP-18B：best-effort + 原子写，绝不覆盖真实操作结果）
// ---------------------------------------------------------------------------

function readHistorySafely(file: string): RunHistoryEntry[] {
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) throw new Error('history is not an array');
    return parsed as RunHistoryEntry[];
  } catch {
    // 损坏的历史文件隔离备份后重建，而不是让整个操作失败。
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // best-effort
      }
    }
    return [];
  }
}

function appendHistory(entry: Omit<RunHistoryEntry, 'id' | 'time'>): string | undefined {
  try {
    const file = historyPath(dataDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const next: RunHistoryEntry = {
      id: `${Date.now()}-${randomBytes(4).toString('hex')}`,
      time: new Date().toISOString(),
      ...entry,
    };
    const history = [next, ...readHistorySafely(file)].slice(0, 30);
    const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, `${JSON.stringify(history, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return undefined;
  } catch {
    return '本次运行记录没有写入历史（不影响操作结果）。';
  }
}

/** 记录一条运行历史，返回非致命告警文案（写失败时）。 */
function recordHistory(
  action: string,
  title: string,
  startedAt: number,
  result: { code: number | null; stdout: string; stderr: string },
): string | undefined {
  const output = sanitizeText(`${result.stdout}\n${result.stderr}`.trim(), { maxLength: 500 });
  const status: RunHistoryEntry['status'] = result.code === 0 ? 'success' : 'failed';
  return appendHistory({
    action,
    title,
    status,
    message: status === 'success' ? '已完成' : '运行失败',
    detail: output || (status === 'success' ? '命令已完成。' : '没有收到错误详情。'),
    durationMs: Date.now() - startedAt,
  });
}

// ---------------------------------------------------------------------------
// 目录与摘要
// ---------------------------------------------------------------------------

function resolvedPath(section: 'paths' | 'ocr' | 'rename' | 'output', key: string, fallback: string): string {
  const cfg = readConfigForPaths();
  const block = asObject(cfg[section]);
  const value = block[key];
  return path.resolve(dataDir, typeof value === 'string' && value.length > 0 ? value : fallback);
}

function pendingDirPath(): string {
  return resolvedPath('paths', 'pending', './pending');
}

function invoicesDirPath(): string {
  return resolvedPath('paths', 'invoices', './invoices');
}

function samplesDirPath(): string {
  return resolvedPath('paths', 'samples', './samples/raw');
}

function ocrPendingCsvPath(): string {
  return path.join(invoicesDirPath(), 'ocr', 'ocr-pending.csv');
}

function ocrResultsCsvPath(): string {
  return resolvedPath('ocr', 'resultsCsv', './invoices/ocr/ocr-results.csv');
}

function ledgerCsvPath(): string {
  return resolvedPath('output', 'csv', './invoices/invoices.csv');
}

const archiveRecoveryFailures = new Map<string, UiError>();

function archiveRecoveryBlockedError(): UiError {
  return {
    code: 'archive_recovery_blocked',
    // COPY-10：可执行动作，不用「台账 / 数据目录」等内部术语。
    message: '上次保存发票时中断，当前无法继续。如有表格程序正在打开发票清单，请先关闭，然后重新打开应用再试。',
    detail: '归档事务恢复未完成或仍有未解决的 journal，写入已停止。',
  };
}

/** OCR-05：恢复后若仍残留 journal，说明有 unresolved/损坏事务，必须阻断后续写入。 */
function hasResidualArchiveJournals(invoicesDir: string): boolean {
  const dir = path.join(invoicesDir, '.journal');
  try {
    return fs.readdirSync(dir).some((name) => name.endsWith('.json'));
  } catch {
    return false;
  }
}

function ensureArchiveRecoveryReady(): UiError | undefined {
  const key = path.resolve(invoicesDirPath());
  try {
    assertArchiveTransactionsRecovered(key);
    if (hasResidualArchiveJournals(key)) {
      const error = archiveRecoveryBlockedError();
      archiveRecoveryFailures.set(key, error);
      return error;
    }
    archiveRecoveryFailures.delete(key);
    return undefined;
  } catch {
    const error = archiveRecoveryBlockedError();
    archiveRecoveryFailures.set(key, error);
    return error;
  }
}

interface SummaryPageOptions {
  inboxLimit?: number;
  inboxOffset?: number;
  libraryLimit?: number;
  libraryOffset?: number;
}

function asSummaryOptions(value: unknown): SummaryPageOptions | undefined {
  const raw = asObject(value);
  const num = (v: unknown): number | undefined => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
  };
  const opts: SummaryPageOptions = {
    inboxLimit: num(raw.inboxLimit),
    inboxOffset: num(raw.inboxOffset),
    libraryLimit: num(raw.libraryLimit),
    libraryOffset: num(raw.libraryOffset),
  };
  return Object.values(opts).some((v) => v !== undefined) ? opts : undefined;
}

/**
 * 给 renderer 的可打开路径：优先 dataDir 相对路径（open-path 能 resolve）；
 * 位于可接受外部管理根下的保留绝对路径；其它绝对路径不外泄（ELEC-07）。
 */
function rendererOpenablePath(abs: string): string {
  if (!abs) return '';
  const resolved = path.resolve(abs);
  const rel = path.relative(dataDir, resolved);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    return rel.split(path.sep).join('/') || '.';
  }
  for (const root of openPathAllowedRoots()) {
    const r = path.relative(root, resolved);
    if (r === '' || (!r.startsWith('..') && !path.isAbsolute(r))) return resolved;
  }
  return '';
}

/**
 * ELEC-07：摘要进 renderer 前脱敏内部 CSV 路径与原始错误；
 * filePath 改为可打开的安全形态，业务展示字段（发件人/主题）保留。
 */
function sanitizeAppSummary(summary: AppSummary): AppSummary {
  return {
    ...summary,
    configPath: redactPath(summary.configPath),
    configError: summary.configError ? sanitizeText(summary.configError) : '',
    library: {
      ...summary.library,
      pendingCsv: summary.library.pendingCsv ? redactPath(summary.library.pendingCsv) : '',
      resultsCsv: summary.library.resultsCsv ? redactPath(summary.library.resultsCsv) : '',
      rows: summary.library.rows.map((row) => ({
        ...row,
        filePath: row.filePath ? rendererOpenablePath(row.filePath) : '',
        error: row.error ? sanitizeText(row.error, { maxLength: 200 }) : row.error,
      })),
      ocr: summary.library.ocr,
    },
    inbox: {
      ...summary.inbox,
      indexCsv: summary.inbox.indexCsv ? redactPath(summary.inbox.indexCsv) : '',
    },
    pending: {
      ...summary.pending,
      csvPath: summary.pending.csvPath ? redactPath(summary.pending.csvPath) : '',
      groups: summary.pending.groups.map((group) => ({
        ...group,
        rows: group.rows.map((row) => ({
          ...row,
          reason: row.reason ? sanitizeText(row.reason, { maxLength: 200 }) : row.reason,
          machineReason: row.machineReason
            ? sanitizeText(row.machineReason, { maxLength: 200 })
            : row.machineReason,
        })),
      })),
    },
    history: summary.history.map((entry) => ({
      ...entry,
      detail: entry.detail ? sanitizeText(entry.detail, { maxLength: 500 }) : entry.detail,
      message: entry.message ? sanitizeText(entry.message, { maxLength: 200 }) : entry.message,
    })),
  };
}

/** 契约 7：分页参数透传给 summary 模块；没有分页参数时保持原行为。 */
function appSummary(opts?: SummaryPageOptions): AppSummary {
  const base = loadAppSummary(configPath, dataDir, bundledConfigPath);
  if (!opts) return sanitizeAppSummary(base);
  const { cfg } = loadGuiConfig(configPath, bundledConfigPath);
  return sanitizeAppSummary({
    ...base,
    inbox: summarizeInbox(cfg, dataDir, { limit: opts.inboxLimit, offset: opts.inboxOffset }),
    library: summarizeLibrary(cfg, dataDir, { limit: opts.libraryLimit, offset: opts.libraryOffset }),
  });
}

function rewritePendingCsv(filter: (row: Record<string, string>) => boolean): { removed: number; remaining: number } {
  const pendingCsv = path.join(pendingDirPath(), 'pending.csv');
  if (!fs.existsSync(pendingCsv)) return { removed: 0, remaining: 0 };
  const text = fs.readFileSync(pendingCsv, 'utf8');
  const bom = text.startsWith('﻿') ? '﻿' : '';
  const records = parseCsv(text.replace(/^﻿/, ''));
  const header = records[0] ?? [];
  if (header.length === 0) return { removed: 0, remaining: 0 };
  const out = [`${bom}${header.map(csvCell).join(',')}`];
  let removed = 0;
  let remaining = 0;
  for (let r = 1; r < records.length; r++) {
    const cols = records[r] ?? [];
    const row: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) {
      const key = header[i];
      if (!key) continue;
      row[key] = cols[i] ?? '';
    }
    if (filter(row)) {
      out.push(header.map((_, i) => csvCell(cols[i] ?? '')).join(','));
      remaining++;
    } else {
      removed++;
    }
  }
  // 原子替换：live CSV 不再有被写坏成半截的机会。
  const tmp = `${pendingCsv}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, `${out.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, pendingCsv);
  return { removed, remaining };
}

function pendingRowHash(row: Record<string, string>): string {
  return msgIdHash(row.messageId || undefined, row.from ?? '', row.date ?? '', row.subject ?? '');
}

/** 行是否对应该 hash：重算 12 位、messageId 列即为裸 hash、或两者之一匹配（HASH-WIDTH）。 */
function pendingRowMatchesHash(row: Record<string, string>, hash: string): boolean {
  if (pendingRowHash(row) === hash) return true;
  const mid = (row.messageId ?? '').trim().toLowerCase();
  if (mid === hash) return true;
  return false;
}

function findPendingRow(hash: string): Record<string, string> | undefined {
  const pendingCsv = path.join(pendingDirPath(), 'pending.csv');
  for (const row of readCsvRows(pendingCsv)) {
    if (pendingRowMatchesHash(row, hash)) return row;
  }
  return undefined;
}

/**
 * 在 pending 目录内解析 `${hash}.eml`：先校验 hash 形态，再 resolve + 前缀包含性检查
 * （ELEC-06），禁止 `../` 路径穿越。
 */
function pendingEmlPathForHash(hash: string): string | undefined {
  if (!BARE_MAIL_HASH_RE.test(hash)) return undefined;
  const root = path.resolve(pendingDirPath());
  const candidate = path.resolve(root, `${hash}.eml`);
  const rel = path.relative(root, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return candidate;
}

function ensureBaseDirectories(): void {
  const cfg = readConfigForPaths();
  const paths = asObject(cfg.paths);
  const ocr = asObject(cfg.ocr);
  const rename = asObject(cfg.rename);
  const ensure = (value: unknown, fallback: string) => {
    const v = typeof value === 'string' && value.length > 0 ? value : fallback;
    fs.mkdirSync(path.resolve(dataDir, v), { recursive: true });
  };
  ensure(paths.samples, './samples/raw');
  ensure(paths.invoices, './invoices');
  ensure(paths.pending, './pending');
  if (typeof ocr.resultsCsv === 'string' && ocr.resultsCsv.length > 0) {
    fs.mkdirSync(path.dirname(path.resolve(dataDir, ocr.resultsCsv)), { recursive: true });
  }
  if (typeof rename.organizedDir === 'string' && rename.organizedDir.length > 0) {
    fs.mkdirSync(path.resolve(dataDir, rename.organizedDir), { recursive: true });
  }
  fs.mkdirSync(path.join(dataDir, '.mfh-cache'), { recursive: true });
  fs.mkdirSync(tempRoot(), { recursive: true });
}

function isInsideDataDir(target: string): boolean {
  const base = dataDir.endsWith(path.sep) ? dataDir : dataDir + path.sep;
  return target.startsWith(base);
}

// ---------------------------------------------------------------------------
// 「重新识别」的可恢复准备（APP-17）
// ---------------------------------------------------------------------------

interface OcrRerunPlan {
  /** 成功后丢弃备份。 */
  discard(): void;
  /** 失败时把结果 CSV 与队列恢复到重跑之前。 */
  restore(): void;
  resultsCsv: string;
}

type PrepareRerunResult =
  | { ok: true; plan: OcrRerunPlan }
  | { ok: false; error: UiError };

/**
 * 先准备并校验全部替代物，再把旧结果「移动到备份」（而不是直接删除），最后原子
 * 安装新队列。任何一步失败都可以完整恢复。
 */
function prepareOcrRerun(): PrepareRerunResult {
  const resultsCsv = ocrResultsCsvPath();
  const pendingCsv = ocrPendingCsvPath();

  // dataDir 之外的绝对 results 路径是**明确支持**的：旧实现会静默跳过删除却仍以
  // `--force` 追加，让外部 CSV 不断堆积重复历史。这里改成「移动到同目录备份」，
  // 既不静默跳过，也不会真正删除任何用户文件（失败时还能原样恢复）。唯一拒绝的
  // 情况是配置指向了一个目录——那说明配置本身写错了。
  if (fs.existsSync(resultsCsv) && !fs.statSync(resultsCsv).isFile()) {
    return {
      ok: false,
      error: {
        code: 'ocr_results_not_a_file',
        message: '识别结果的保存位置不是一个文件，请在设置中检查「识别结果」路径。',
        detail: redactPath(resultsCsv),
      },
    };
  }

  // 先在内存里算出新队列内容并校验，确保替代物可用。
  let nextQueue: string | undefined;
  if (fs.existsSync(pendingCsv)) {
    try {
      const text = fs.readFileSync(pendingCsv, 'utf8');
      const bom = text.startsWith('﻿') ? '﻿' : '';
      const records = parseCsv(text.replace(/^﻿/, ''));
      const header = records[0] ?? [];
      const statusIndex = header.indexOf('status');
      const reasonIndex = header.indexOf('reason');
      const documentTypeIndex = header.indexOf('documentType');
      if (statusIndex === -1) {
        return {
          ok: false,
          error: { code: 'ocr_queue_malformed', message: '识别队列文件格式不正确，无法重新识别。' },
        };
      }
      const out = [`${bom}${header.map(csvCell).join(',')}`];
      for (let r = 1; r < records.length; r++) {
        const cols = records[r] ?? [];
        const docType = documentTypeIndex >= 0 ? (cols[documentTypeIndex] ?? '') : '';
        if (docType === 'supporting') {
          cols[statusIndex] = 'ignored';
          if (reasonIndex >= 0) cols[reasonIndex] = cols[reasonIndex] || 'supporting_document';
        } else {
          cols[statusIndex] = 'pending';
          if (reasonIndex >= 0) cols[reasonIndex] = '';
        }
        out.push(header.map((_, index) => csvCell(cols[index] ?? '')).join(','));
      }
      nextQueue = `${out.join('\n')}\n`;
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'ocr_queue_unreadable',
          message: '无法读取识别队列文件，重新识别已取消。',
          detail: sanitizeText(err instanceof Error ? err.message : String(err)),
        },
      };
    }
  }

  const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const resultsBackup = `${resultsCsv}.rerun-backup-${stamp}`;
  const queueBackup = `${pendingCsv}.rerun-backup-${stamp}`;
  let resultsMoved = false;
  let queueMoved = false;

  try {
    if (fs.existsSync(resultsCsv)) {
      fs.renameSync(resultsCsv, resultsBackup);
      resultsMoved = true;
    }
    if (nextQueue !== undefined && fs.existsSync(pendingCsv)) {
      fs.copyFileSync(pendingCsv, queueBackup);
      queueMoved = true;
    }
    if (nextQueue !== undefined) {
      const tmp = `${pendingCsv}.tmp-${stamp}`;
      fs.writeFileSync(tmp, nextQueue, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, pendingCsv);
    }
  } catch (err) {
    // 准备阶段失败：立即还原，旧结果一个都不丢。
    try {
      if (resultsMoved) fs.renameSync(resultsBackup, resultsCsv);
      if (queueMoved) fs.copyFileSync(queueBackup, pendingCsv);
    } catch {
      // best-effort
    }
    try {
      fs.rmSync(queueBackup, { force: true });
    } catch {
      // best-effort
    }
    return {
      ok: false,
      error: {
        code: 'ocr_rerun_prepare_failed',
        message: '重新识别的准备工作失败，已保留原有识别结果。',
        detail: sanitizeText(err instanceof Error ? err.message : String(err)),
      },
    };
  }

  return {
    ok: true,
    plan: {
      resultsCsv,
      discard: () => {
        for (const file of [resultsBackup, queueBackup]) {
          try {
            fs.rmSync(file, { force: true });
          } catch {
            // best-effort
          }
        }
      },
      restore: () => {
        try {
          if (resultsMoved) {
            fs.rmSync(resultsCsv, { force: true });
            fs.renameSync(resultsBackup, resultsCsv);
          }
          if (queueMoved) fs.copyFileSync(queueBackup, pendingCsv);
        } catch {
          // best-effort
        }
        try {
          fs.rmSync(queueBackup, { force: true });
        } catch {
          // best-effort
        }
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 操作协调（APP-05）
// ---------------------------------------------------------------------------

interface BusyResponse {
  ok: false;
  code: string;
  message: string;
  detail?: string;
  running: RunningOp | null;
  summary: AppSummary;
}

function acquireOperation(kind: OpKind): { ok: true; lease: OpLease } | { ok: false; response: BusyResponse } {
  const begin = coordinator.begin(kind);
  if (begin.ok) return { ok: true, lease: begin.lease };
  return {
    ok: false,
    response: {
      ok: false,
      code: begin.code,
      message: begin.message,
      ...(begin.detail ? { detail: begin.detail } : {}),
      running: begin.running,
      summary: appSummary(),
    },
  };
}

function normalizedFilterFrom(range?: DateRangePayload): NormalizedFilter {
  const cfg = readConfigForPaths();
  const filter = asObject(cfg.filter);
  const keywords = Array.isArray(filter.keywords)
    ? filter.keywords.filter((item): item is string => typeof item === 'string')
    : [];
  const since = range?.from || (typeof filter.since === 'string' ? filter.since : undefined);
  const until = range?.to || (typeof filter.until === 'string' ? filter.until : undefined);
  return {
    matchSubject: filter.matchSubject !== false,
    matchBody: filter.matchBody !== false,
    keywords,
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
  };
}

// ---------------------------------------------------------------------------
// 「本次抓取 / 本次运行」批次明细（APP-20）
// ---------------------------------------------------------------------------

/** 与 inbox 摘要行同形，renderer 可以直接复用同一套渲染。 */
interface BatchRow {
  messageId: string;
  date: string;
  from: string;
  subject: string;
  mailbox: string;
  hasAttachment: boolean;
  bodyLinkCount: number;
}

interface RunBatch {
  rows: BatchRow[];
  total: number;
}

/** 批次明细的展示上限；`total` 始终是本次真实条数，不受这个上限影响。 */
const BATCH_ROW_LIMIT = 200;

/**
 * 读 INDEX.csv 并按邮件身份 hash 建索引。
 * - 12 位：无 raw 的历史 msgIdHash（台账重算路径）
 * - 另按 messageId 建索引，便于 32 位 runtime hash 经 .eml 反查（HASH-WIDTH）
 */
function indexRowsByHash(): { byHash: Map<string, BatchRow>; byMessageId: Map<string, BatchRow> } {
  const byHash = new Map<string, BatchRow>();
  const byMessageId = new Map<string, BatchRow>();
  for (const row of readCsvRows(path.join(samplesDirPath(), 'INDEX.csv'))) {
    const messageId = row.messageId ?? '';
    const date = row.date ?? '';
    const from = row.from ?? '';
    const subject = row.subject ?? '';
    const batchRow: BatchRow = {
      messageId,
      date,
      from,
      subject,
      mailbox: row.mailbox ?? '',
      hasAttachment: (row.hasAttachment ?? '') === '1',
      bodyLinkCount: Number(row.bodyLinkCount ?? 0) || 0,
    };
    const hash = msgIdHash(messageId.length > 0 ? messageId : undefined, from, date, subject);
    if (!byHash.has(hash)) byHash.set(hash, batchRow);
    // messageId 列本身可能是裸 hash（mail.messageId || hash）
    if (messageId && BARE_MAIL_HASH_RE.test(messageId.toLowerCase()) && !byHash.has(messageId.toLowerCase())) {
      byHash.set(messageId.toLowerCase(), batchRow);
    }
    if (messageId && !byMessageId.has(messageId)) byMessageId.set(messageId, batchRow);
  }
  return { byHash, byMessageId };
}

/** 在 samples 目录下查找 `${hash}.eml`（HASH-WIDTH：12 或 32 位文件名）。 */
function findSampleEmlByHash(hash: string): string | undefined {
  if (!BARE_MAIL_HASH_RE.test(hash)) return undefined;
  const root = samplesDirPath();
  const direct = path.join(root, `${hash}.eml`);
  if (fs.existsSync(direct)) return direct;
  try {
    const walk = (dir: string, depth: number): string | undefined => {
      if (depth > 4) return undefined;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name === `${hash}.eml`) return path.join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const hit = walk(path.join(dir, entry.name), depth + 1);
          if (hit) return hit;
        }
      }
      return undefined;
    };
    return walk(root, 0);
  } catch {
    return undefined;
  }
}

/**
 * 由本次运行真实触达的邮件 hash 构造批次。**不是**「取 INDEX 最后 N 行」——
 * 那正是 APP-20 的原始缺陷；这里的 hash 全部来自本次子进程的逐封日志。
 */
function batchFromHashes(hashes: string[]): RunBatch {
  if (hashes.length === 0) return { rows: [], total: 0 };
  const { byHash, byMessageId } = indexRowsByHash();
  const rows: BatchRow[] = [];
  for (const hash of hashes) {
    let row = byHash.get(hash);
    if (!row) {
      // 32 位 runtime hash：用 .eml 文件名命中缓存，再尝试从文件头取 Message-Id 反查 INDEX。
      const eml = findSampleEmlByHash(hash);
      if (eml) {
        try {
          const head = fs.readFileSync(eml, { encoding: 'utf8' }).slice(0, 16 * 1024);
          const mid = /^message-id:\s*<?([^>\r\n]+)>?/im.exec(head)?.[1]?.trim();
          if (mid) row = byMessageId.get(mid) ?? byMessageId.get(`<${mid}>`);
        } catch {
          // ignore
        }
        if (!row) {
          row = {
            messageId: hash,
            date: '',
            from: '',
            subject: '',
            mailbox: '',
            hasAttachment: false,
            bodyLinkCount: 0,
          };
        }
      }
    }
    if (row) rows.push(row);
  }
  rows.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  return { rows: rows.slice(0, BATCH_ROW_LIMIT), total: hashes.length };
}

function fetchArgs(payload: DateRangePayload): string[] {
  const args = ['--config', configPath, '--state', statePath];
  args.push('--out', samplesDirPath());
  if (payload.from) args.push('--since', payload.from);
  if (payload.to) args.push('--until', payload.to);
  if (payload.dryRun) args.push('--dry-run');
  return args;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle('mfh:get-summary', (_event, payload: unknown) => appSummary(asSummaryOptions(payload)));

ipcMain.handle('mfh:get-op-state', () => coordinator.state());

/**
 * About 页的版本与发布通道（COPY-07B）。全部由运行时真实数据推导：`app.getVersion()`
 * 取的是安装包/package.json 的版本，channel 由「是否已打包」和版本号里的预发布
 * 标识判定，不再是写死的「本地预览版 / v0.1.0」。
 */
ipcMain.handle('mfh:get-app-info', () => {
  const version = app.getVersion();
  const prerelease = /^\d+\.\d+\.\d+-([0-9A-Za-z.-]+)$/.exec(version)?.[1];
  const major = Number(version.split('.')[0]);
  const channel = !app.isPackaged
    ? '开发版（未打包）'
    : prerelease
      ? `预览版（${prerelease}）`
      : Number.isFinite(major) && major === 0
        ? '预览版'
        : '正式版';
  return {
    version,
    channel,
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron ?? '',
  };
});

ipcMain.handle('mfh:get-config', () => {
  const { cfg, error } = loadGuiConfig(configPath, bundledConfigPath);
  // Redact secrets so they never reach the renderer process. We still report whether each
  // secret is populated so the UI can show "已保存（留空则不修改）" placeholders.
  const ocrSrc = (cfg as { ocr?: Record<string, unknown> }).ocr ?? {};
  const credsSrc = asObject((ocrSrc as Record<string, unknown>).credentials);
  const redactedConfig = redactConfig(cfg as unknown as Record<string, unknown>);
  const secrets = {
    imapPass: Boolean(cfg.imap?.pass),
    tencentSecretId: Boolean(credsSrc.tencentSecretId || credsSrc.secretId),
    tencentSecretKey: Boolean(credsSrc.tencentSecretKey || credsSrc.secretKey),
    ocrApiKey: Boolean(credsSrc.apiKey),
  };
  return {
    // ELEC-07：绝对路径不进 renderer；仅提供脱敏展示串。
    configPath: redactPath(configPath),
    configExists: fs.existsSync(configPath),
    // 保留原字段名（renderer 已在读取），同时新增结构化版本。
    configError: error ? sanitizeText(error) : '',
    configErrorInfo: error ? { message: sanitizeText(error) } : undefined,
    config: redactedConfig,
    secrets,
    dataDir: redactPath(dataDir),
  };
});

ipcMain.handle('mfh:save-config', (_event, payload: unknown) => {
  // ELEC-02：配置写入与 CLI 任务互斥，避免运行中改写 paths/ocr 造成交错。
  const begin = coordinator.begin('pipeline', { silent: true });
  if (!begin.ok) {
    return {
      ok: false,
      configPath,
      configError: { message: begin.message },
    };
  }
  try {
    const raw = asObject(payload);
    return saveConfig(payload, { repairCorrupt: raw.repairCorrupt === true });
  } finally {
    begin.lease.release();
  }
});

ipcMain.handle('mfh:start-fetch', async (_event, payload: unknown) => {
  const range = asDateRange(payload);

  // APP-20：不再悄悄把 matchSubject 恢复为 true；两个条件都关掉时如实拒绝。
  if (range.matchSubject === false && range.matchBody === false) {
    return {
      ok: false,
      code: 'filter_no_match_target',
      message: '请至少选择「匹配主题」或「匹配正文」中的一项。',
      normalizedFilter: normalizedFilterFrom(range),
      summary: appSummary(),
    };
  }

  // ELEC-02：先占锁再写配置，避免被拒绝的请求仍改写后续任务使用的筛选条件。
  const gate = acquireOperation('fetch');
  if (!gate.ok) return { ...gate.response, normalizedFilter: normalizedFilterFrom(range) };

  const startedAt = Date.now();
  try {
    if (typeof range.matchSubject === 'boolean' || typeof range.matchBody === 'boolean') {
      const filterPatch: Record<string, boolean> = {};
      if (typeof range.matchSubject === 'boolean') filterPatch.matchSubject = range.matchSubject;
      if (typeof range.matchBody === 'boolean') filterPatch.matchBody = range.matchBody;
      const saved = saveConfig({ filter: filterPatch });
      if (!saved.ok) {
        return {
          ok: false,
          code: 'config_invalid',
          message: '筛选条件没有保存成功，请先在设置页修正配置。',
          fieldErrors: saved.fieldErrors,
          configError: saved.configError,
          normalizedFilter: normalizedFilterFrom(range),
          summary: appSummary(),
        };
      }
    }

    const args = fetchArgs(range);
    devBackend?.recordTestGlobal(mainWindow, '__mfhLastFetchArgs', args);
    const result = await runCli('fetch', args, { progress: true, jobId: gate.lease.jobId });
    const warning = recordHistory('fetch', range.dryRun ? '预览邮件' : '获取邮件', startedAt, result);
    // 预览（--dry-run）不写缓存也不写 INDEX，没有可回显的逐封明细，因此不带
    // `batch` 字段——让 renderer 显示「没有返回明细」，而不是谎称「本次新增 0 封」。
    const batch = range.dryRun ? undefined : batchFromHashes(result.mails.saved);
    const report = reportFor('fetch', gate.lease.jobId, result, { ok: 'fetch_done', failed: 'fetch_failed' });
    return {
      ok: result.code === 0,
      ...report,
      message: result.code === 0
        ? (range.dryRun ? '预览完成。' : '获取邮件完成。')
        : '获取邮件失败，请检查邮箱设置后重试。',
      jobId: gate.lease.jobId,
      normalizedFilter: normalizedFilterFrom(range),
      ...(batch ? { batch } : {}),
      ...(warning ? { warning } : {}),
      summary: appSummary(),
    };
  } finally {
    gate.lease.release();
  }
});

ipcMain.handle('mfh:run-pipeline', async (_event, payload: unknown) => {
  const raw = asObject(payload);
  const concurrency = Number(raw.concurrency ?? 4);

  // ELEC-02：先占锁再写配置。
  const gate = acquireOperation('pipeline');
  if (!gate.ok) return { ...gate.response, normalizedFilter: normalizedFilterFrom() };

  const startedAt = Date.now();
  try {
    if (typeof raw.avoidConflictBeforeOcr === 'boolean') {
      const saved = saveConfig({ rename: { avoidConflictBeforeOcr: raw.avoidConflictBeforeOcr } });
      if (!saved.ok) {
        return {
          ok: false,
          code: 'config_invalid',
          message: '命名设置没有保存成功，请先在设置页修正配置。',
          fieldErrors: saved.fieldErrors,
          configError: saved.configError,
          normalizedFilter: normalizedFilterFrom(),
          summary: appSummary(),
        };
      }
    }

    const recoveryError = ensureArchiveRecoveryReady();
    if (recoveryError) {
      return { ok: false, ...recoveryError, normalizedFilter: normalizedFilterFrom(), summary: appSummary() };
    }
    const args = ['--config', configPath, '--state', statePath, '--concurrency', String(concurrency)];
    // HASH-WIDTH：只接受合法 12/32 位 hash，防止 --only-mail 注入奇怪参数。
    if (typeof raw.onlyMail === 'string') {
      const onlyHash = parseMailHash(raw.onlyMail);
      if (onlyHash) args.push('--only-mail', onlyHash);
    }
    if (raw.force === true) args.push('--force');
    const result = await runCli('run', args, { operation: 'files', jobId: gate.lease.jobId });
    const warning = recordHistory('pipeline', raw.onlyMail ? '重新处理单封邮件' : '处理缓存邮件', startedAt, result);
    // 本次运行真正处理掉的邮件：归档成功的 + 降级到待确认的。仅被跳过（此前已处理）
    // 的邮件不算，否则又变成「展示全量最近行」。
    const batch = batchFromHashes([...result.mails.processed, ...result.mails.manual]);
    const report = reportFor('pipeline', gate.lease.jobId, result, { ok: 'pipeline_done', failed: 'pipeline_failed' });
    return {
      ok: result.code === 0,
      ...report,
      message: result.code === 0
        ? `处理完成，本次处理 ${batch.total} 封邮件。`
        : '处理缓存邮件失败，请查看诊断信息后重试。',
      jobId: gate.lease.jobId,
      normalizedFilter: normalizedFilterFrom(),
      batch,
      ...(warning ? { warning } : {}),
      summary: appSummary(),
    };
  } finally {
    gate.lease.release();
  }
});

function pendingOcrWorkCount(summary = appSummary()): number {
  const rows = readCsvRows(ocrPendingCsvPath());
  if (rows.length === 0) return 0;
  if (summary.library.total > 0) return summary.library.total;
  return rows.filter((row) => row.status !== 'ignored' && row.documentType !== 'supporting').length;
}

ipcMain.handle('mfh:run-ocr', async (_event, payload: unknown) => {
  const raw = asObject(payload);
  const summary = appSummary();
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
      code: 'ocr_no_work',
      message: '没有等待识别的文件。请到「开始处理」，先完成「获取邮件」和「获取发票文件」，再开始识别。',
      kind: 'warn',
      done: true,
    });
    return {
      ok: false,
      code: 'ocr_no_work',
      exitCode: 0,
      message: '没有等待识别的文件。请到「开始处理」，先完成「获取邮件」和「获取发票文件」，再开始识别。',
      summary,
    };
  }

  const gate = acquireOperation('ocr');
  if (!gate.ok) return gate.response;
  const jobId = gate.lease.jobId;

  const concurrency = Math.max(1, Math.floor(Number(raw.concurrency ?? 1) || 1));
  let plan: OcrRerunPlan | undefined;
  let ocrTemp: { dir: string; file: string } | undefined;

  try {
    const recoveryError = ensureArchiveRecoveryReady();
    if (recoveryError) {
      sendOperationProgress({ operation: 'ocr', phase: '识别失败', percent: 100, ...recoveryError, kind: 'err', done: true });
      return { ok: false, ...recoveryError, summary: appSummary() };
    }
    if (raw.resetResults === true || raw.force === true) {
      const prepared = prepareOcrRerun();
      if (!prepared.ok) {
        sendOperationProgress({
          operation: 'ocr',
          phase: '识别失败',
          percent: 100,
          total: pendingTotal,
          processed: 0,
          parsed: 0,
          skipped: 0,
          failed: 0,
          ...prepared.error,
          kind: 'err',
          done: true,
        });
        return { ok: false, ...prepared.error, summary: appSummary() };
      }
      plan = prepared.plan;
    }

    try {
      ocrTemp = writeOcrRunConfig(concurrency);
    } catch (err) {
      plan?.restore();
      const error: UiError = {
        code: 'ocr_config_write_failed',
        // COPY-10
        message: '无法开始识别。请确认磁盘空间充足，并在「邮箱与保存」中重新选择发票保存位置。',
        detail: sanitizeText(err instanceof Error ? err.message : String(err)),
      };
      sendOperationProgress({ operation: 'ocr', phase: '识别失败', percent: 100, ...error, kind: 'err', done: true });
      return { ok: false, ...error, summary: appSummary() };
    }

    const args = ['run', '--config', ocrTemp.file, '--allow-parse-failures'];
    if (raw.force === true) args.push('--force');
    if (concurrency > 1) {
      args.push('--concurrency', String(concurrency));
    } else {
      args.push('--single-item');
    }
    const startedAt = Date.now();
    devBackend?.recordTestGlobal(mainWindow, '__mfhLastOcrArgs', args);
    sendOperationProgress({
      operation: 'ocr',
      phase: '开始识别',
      percent: 5,
      total: pendingTotal,
      processed: 0,
      parsed: 0,
      skipped: 0,
      failed: 0,
      code: 'ocr_start',
      message: `发现 ${pendingTotal} 个待识别文件，正在启动识别。当前并行数：${concurrency}。`,
    });

    const result = await runCli('ocr', args, { operation: 'ocr', initialTotal: pendingTotal, jobId });
    const stopped = ocrStopRequested.has(jobId) || result.code === 130;

    if (plan) {
      // ELEC-03：只有完整成功才丢弃备份；停止或非零退出一律恢复整份旧结果，
      // 绝不能用「新结果文件非空」当作事务成功判据。
      if (result.started && result.code === 0 && !stopped) plan.discard();
      else plan.restore();
    }

    const warning = recordHistory('ocr', raw.force === true ? '开始识别文件' : '识别文件', startedAt, result);
    if (stopped) {
      return {
        ok: false,
        stopped: true,
        code: 'ocr_stopped',
        exitCode: result.code,
        jobId,
        message: '识别已停止。',
        ...(warning ? { warning } : {}),
        summary: appSummary(),
      };
    }
    const report = reportFor('ocr', jobId, result, { ok: 'ocr_done', failed: 'ocr_failed' });
    return {
      ok: result.code === 0,
      ...report,
      jobId,
      message: result.code === 0
        ? ocrRunMessage(result)
        : '无法完成识别。请确认磁盘空间充足，并在「邮箱与保存」中重新选择发票保存位置后重试。',
      ...(warning ? { warning } : {}),
      summary: appSummary(),
    };
  } finally {
    // 临时 run config 是明文；无论正常结束还是异常路径都必须删除。
    if (ocrTemp) removeTempDir(ocrTemp.dir);
    ocrStopRequested.delete(jobId);
    ocrProcesses.delete(jobId);
    gate.lease.release();
  }
});

ipcMain.handle('mfh:organize', async (_event, payload: unknown) => {
  const raw = asObject(payload);
  const applyRename = raw.applyRename === true;
  const gate = acquireOperation('organize');
  if (!gate.ok) return gate.response;

  const startedAt = Date.now();
  try {
    const recoveryError = ensureArchiveRecoveryReady();
    if (recoveryError) {
      return { ok: false, ...recoveryError, summary: appSummary() };
    }
    const cliArgs = ['--config', configPath];
    if (applyRename) cliArgs.push('--apply-rename');
    const result = await runCli('organize', cliArgs, { jobId: gate.lease.jobId });
    const warning = recordHistory('organize', applyRename ? '一键改名整理' : '整理输出文件', startedAt, result);
    const output = `${result.stdout}\n${result.stderr}`;
    const scannedMatch = /Organize complete: scanned=(\d+)/.exec(output);
    const scanned = scannedMatch ? Number(scannedMatch[1]) : NaN;
    const baseLabel = applyRename ? '改名' : '整理';
    const message = Number.isFinite(scanned) && scanned === 0
      ? '目前没有可整理的识别结果。请先抓取邮件并完成识别后再试。'
      : Number.isFinite(scanned)
        ? `${baseLabel}完成，处理 ${scanned} 条识别结果。`
        : `${baseLabel}完成。`;
    const report = reportFor('organize', gate.lease.jobId, result, { ok: 'organize_done', failed: 'organize_failed' });
    return {
      ok: result.code === 0,
      ...report,
      jobId: gate.lease.jobId,
      message: result.code === 0 ? message : `${baseLabel}没有完成，请查看诊断信息了解详情。`,
      ...(Number.isFinite(scanned) ? { scanned } : {}),
      ...(warning ? { warning } : {}),
      summary: appSummary(),
    };
  } finally {
    gate.lease.release();
  }
});

ipcMain.handle('mfh:stop-ocr', () => {
  if (ocrProcesses.size === 0) return { ok: false, code: 'ocr_not_running', message: '当前没有正在运行的识别任务。' };
  const details: string[] = [];
  let treeIncomplete = false;
  for (const [jobId, child] of ocrProcesses) {
    ocrStopRequested.add(jobId);
    // Windows 上必须终止整棵进程树，否则 efapiao serve 会继续占用端口（APP-16）。
    const outcome = killProcessTree(child);
    if (!outcome.treeTerminated) treeIncomplete = true;
    if (outcome.detail) details.push(outcome.detail);
  }
  if (treeIncomplete) {
    return {
      ok: true,
      code: 'ocr_stopping_partial',
      message: '正在停止识别。本机识别服务可能需要多等几秒才会完全退出。',
      detail: sanitizeText(details.join('；'), { maxLength: 200 }),
    };
  }
  return { ok: true, code: 'ocr_stopping', message: '正在停止识别。' };
});

function isContainedPath(resolved: string, bases: string[]): boolean {
  return bases.some((base) => {
    const rel = path.relative(path.resolve(base), resolved);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

/**
 * ELEC-06：open-path 允许根只由主进程从当前配置推导，并拒绝文件系统根 / 用户主目录
 * 等过宽根。renderer 改写 paths.invoices=`/` 不能再打开任意路径。
 */
function isAcceptableManagedRoot(dir: string): boolean {
  const resolved = path.resolve(dir);
  const { root } = path.parse(resolved);
  if (resolved === root) return false;
  if (resolved === path.resolve(os.homedir())) return false;
  const rel = path.relative(root, resolved);
  if (!rel || rel === '') return false;
  return true;
}

function openPathAllowedRoots(): string[] {
  const roots = new Set<string>([path.resolve(dataDir)]);
  for (const candidate of [invoicesDirPath(), pendingDirPath(), samplesDirPath(), diagnosticsDir()]) {
    const resolved = path.resolve(candidate);
    if (!isAcceptableManagedRoot(resolved)) continue;
    roots.add(resolved);
  }
  return Array.from(roots);
}

/** 解析真实路径（存在时 realpath，防符号链接逃逸）；不存在则解析父目录。 */
function resolveForOpen(target: string): string {
  const abs = path.resolve(dataDir, target);
  try {
    return fs.realpathSync(abs);
  } catch {
    try {
      const parent = fs.realpathSync(path.dirname(abs));
      return path.join(parent, path.basename(abs));
    } catch {
      return abs;
    }
  }
}

ipcMain.handle('mfh:open-path', async (event, payload: unknown) => {
  if (!assertTrustedSender(event)) {
    return { ok: false, code: 'untrusted_sender', error: '无权打开该路径。', message: '无权打开该路径。' };
  }
  const raw = asObject(payload);
  const target = typeof raw.path === 'string' ? raw.path : dataDir;
  // 拒绝把占位脱敏串当路径打开。
  if (target.includes('<') || target.includes('>')) {
    return { ok: false, code: 'path_invalid', error: '路径无效。', message: '路径无效。' };
  }
  const resolved = resolveForOpen(target);
  const allowedBases = openPathAllowedRoots().map((base) => {
    try {
      return fs.realpathSync(base);
    } catch {
      return path.resolve(base);
    }
  });
  if (!isContainedPath(resolved, allowedBases)) {
    return { ok: false, code: 'path_outside_data_dir', error: '路径不在允许的目录范围内。', message: '路径不在允许的目录范围内。' };
  }
  if (raw.reveal === true) {
    // shell.showItemInFolder silently does nothing when the path is missing, which
    // leaves the renderer thinking the operation succeeded. Verify first.
    if (!fs.existsSync(resolved)) {
      return { ok: false, code: 'path_missing', error: '文件已不存在，可能被移动或删除。请重新归档。', message: '文件已不存在，可能被移动或删除。请重新归档。' };
    }
    showItemInFolderForUser(resolved);
    return { ok: true, error: '' };
  }
  const error = await openPathForUser(resolved);
  return {
    ok: !error,
    // 保留 error 字段名，但内容脱敏后再交给 UI。
    error: error ? sanitizeText(error, { maxLength: 200 }) : '',
    ...(error ? { code: 'path_open_failed', message: '无法打开该文件，请确认它仍然存在且有对应的应用程序。' } : {}),
  };
});

ipcMain.handle('mfh:copy-text', (_event, payload: unknown) => {
  const raw = asObject(payload);
  clipboard.writeText(typeof raw.text === 'string' ? raw.text : '');
  return { ok: true };
});

/** 连接测试/文件夹列举共用的 IMAP 参数解析（保存失败时回退到用户刚输入的值）。 */
function imapParamsFor(payload: unknown, saved: boolean): {
  ok: boolean;
  message?: string;
  host: string;
  port: number;
  user: string;
  pass: string;
  tls: boolean;
  mailbox: unknown;
} {
  const cfg = readConfigForPaths();
  const disk = asObject(cfg.imap);
  const typed = asObject(asObject(payload).imap);
  const pick = (key: string): unknown => (saved ? disk[key] : (typed[key] ?? disk[key]));
  const host = stringField(pick('host'));
  const port = numberField(pick('port'));
  const user = stringField(pick('user'));
  const pass = stringField(pick('pass')) || stringField(disk.pass);
  const tls = pick('tls') !== false;
  if (!host || !Number.isFinite(port) || port <= 0 || !user || !pass) {
    return { ok: false, message: '请先填写邮箱主机、端口、账号和授权码。', host, port, user, pass, tls, mailbox: pick('mailbox') };
  }
  return { ok: true, host, port, user, pass, tls, mailbox: pick('mailbox') };
}

ipcMain.handle('mfh:test-connection', async (_event, payload: unknown) => {
  // ELEC-02：配置落盘必须占锁；忙时仍可用表单值测连，但不写盘。
  let saved = false;
  if (payload && typeof payload === 'object') {
    const begin = coordinator.begin('fetch', { silent: true });
    if (begin.ok) {
      try {
        saved = saveConfig(payload).ok;
      } finally {
        begin.lease.release();
      }
    }
  }
  if (devBackend) return devBackend.fakeConnectionResult();
  const params = imapParamsFor(payload, saved);
  if (!params.ok) return { ok: false, code: 'imap_incomplete', message: params.message };
  try {
    const client = new ImapFlow({
      host: params.host,
      port: params.port,
      secure: params.tls,
      auth: { user: params.user, pass: params.pass },
      logger: false,
    });
    await client.connect();
    try {
      const configured = params.mailbox;
      const mailbox = Array.isArray(configured) && typeof configured[0] === 'string' && configured[0]
        ? configured[0]
        : 'INBOX';
      let fallbackMailbox = '';
      try {
        await client.mailboxOpen(mailbox);
      } catch {
        const boxes = await client.list();
        if (boxes.length > 0) {
          fallbackMailbox = boxes[0]!.path;
          await client.mailboxOpen(fallbackMailbox);
        }
      }
      if (fallbackMailbox) {
        return {
          ok: true,
          kind: 'warn',
          code: 'imap_mailbox_fallback',
          message: `邮箱连接正常，但找不到配置的文件夹「${mailbox}」，已临时打开「${fallbackMailbox}」。请在配置中重新选择目标文件夹。`,
        };
      }
      return { ok: true, code: 'imap_ok', message: '邮箱连接正常，可以获取邮件。' };
    } finally {
      // Always tear down the socket + keepalive timers, even on a secondary failure.
      await client.logout().catch(() => { try { client.close(); } catch { /* ignore */ } });
    }
  } catch (err) {
    return {
      ok: false,
      code: 'imap_connect_failed',
      message: '邮箱连接失败，请检查主机、端口、账号和授权码。',
      detail: sanitizeText(err instanceof Error ? err.message : String(err), { maxLength: 200 }),
    };
  }
});

ipcMain.handle('mfh:list-mailboxes', async (_event, payload: unknown) => {
  let saved = false;
  if (payload && typeof payload === 'object') {
    const begin = coordinator.begin('fetch', { silent: true });
    if (begin.ok) {
      try {
        saved = saveConfig(payload).ok;
      } finally {
        begin.lease.release();
      }
    }
  }
  if (devBackend) return { ok: true, mailboxes: devBackend.fakeMailboxes() };
  const params = imapParamsFor(payload, saved);
  if (!params.ok) return { ok: false, code: 'imap_incomplete', message: params.message, mailboxes: [] };
  try {
    const client = new ImapFlow({
      host: params.host,
      port: params.port,
      secure: params.tls,
      auth: { user: params.user, pass: params.pass },
      logger: false,
    });
    await client.connect();
    try {
      const boxes = await client.list();
      return { ok: true, mailboxes: boxes.map((b) => b.path).filter(Boolean) };
    } finally {
      await client.logout().catch(() => { try { client.close(); } catch { /* ignore */ } });
    }
  } catch (err) {
    return {
      ok: false,
      code: 'imap_list_failed',
      message: '读取邮箱文件夹失败，请检查邮箱配置。',
      detail: sanitizeText(err instanceof Error ? err.message : String(err), { maxLength: 200 }),
      mailboxes: [],
    };
  }
});

ipcMain.handle('mfh:pending-ignore', (_event, payload: unknown) => {
  const raw = asObject(payload);
  const hash = parseMailHash(raw.hash);
  if (!hash) return { ok: false, code: 'pending_missing_hash', message: '缺少待忽略邮件的标识。' };
  // ELEC-02：pending.csv 重写与 pipeline 互斥，必须占锁。
  const gate = acquireOperation('pipeline');
  if (!gate.ok) return gate.response;
  try {
    const result = rewritePendingCsv((row) => !pendingRowMatchesHash(row, hash));
    if (result.removed === 0) {
      return {
        ok: false,
        code: 'pending_row_not_found',
        message: '没有找到对应的待确认邮件，可能已经处理过。',
        summary: appSummary(),
      };
    }
    return {
      ok: true,
      code: 'pending_ignored',
      message: '已从待确认队列中移除该邮件。',
      removed: result.removed,
      summary: appSummary(),
    };
  } finally {
    gate.lease.release();
  }
});

ipcMain.handle('mfh:pending-refresh-link', async (_event, payload: unknown) => {
  const raw = asObject(payload);
  const hash = parseMailHash(raw.hash);
  if (!hash) return { ok: false, code: 'pending_missing_hash', message: '缺少邮件标识。' };
  const row = findPendingRow(hash);
  const emlPath = pendingEmlPathForHash(hash);
  const fallback = samplesDirPath();
  if (emlPath && fs.existsSync(emlPath)) {
    const error = await openPathForUser(emlPath);
    if (!error) {
      return { ok: true, code: 'pending_mail_opened', message: '已尝试打开原始邮件，请在邮件中点击下载链接刷新授权后重新抓取。' };
    }
    showItemInFolderForUser(emlPath);
    return { ok: true, code: 'pending_mail_revealed', message: '已在文件管理器中定位原始邮件，请打开后刷新链接。' };
  }
  const error = await openPathForUser(fallback);
  return {
    ok: !error,
    code: row ? 'pending_mail_missing_local_copy' : 'pending_row_not_found',
    message: row
      ? '没有找到本地副本，已打开邮件缓存目录，请手动查找原始邮件并刷新链接。'
      : '没有找到对应邮件。',
    error: error ? sanitizeText(error, { maxLength: 200 }) : undefined,
  };
});

ipcMain.handle('mfh:pending-manual-archive', async (event, payload: unknown) => {
  if (!assertTrustedSender(event)) {
    return { ok: false, code: 'untrusted_sender', message: '无权执行归档。', canceled: false };
  }
  const raw = asObject(payload);
  const hash = parseMailHash(raw.hash);
  if (!hash) return { ok: false, code: 'pending_missing_hash', message: '缺少邮件标识。', canceled: false };

  const testSources = !app.isPackaged && process.env.MFH_TEST_MANUAL_ARCHIVE_SOURCES
    ? process.env.MFH_TEST_MANUAL_ARCHIVE_SOURCES.split(path.delimiter).filter(Boolean)
    : undefined;
  const dialogResult = testSources
    ? { canceled: false, filePaths: testSources }
    : await dialog.showOpenDialog({
      title: '选择要归档的发票文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        // 不提供 zip：压缩包无法直接归档也无法识别，旧实现会把任意 PK 容器当成 OFD
        // 塞进队列。用户仍可用「全部文件」选到压缩包，此时 runManualArchive 会明确拒绝。
        { name: '发票文件', extensions: ['pdf', 'ofd', 'png', 'jpg', 'jpeg'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    });
  if (dialogResult.canceled || dialogResult.filePaths.length === 0) {
    return { ok: false, canceled: true, code: 'manual_archive_canceled', message: '已取消归档。' };
  }

  // 手动导入与自动归档写同一批文件，必须走同一把操作锁。
  const gate = acquireOperation('pipeline');
  if (!gate.ok) return { ...gate.response, canceled: false };

  try {
    const recoveryError = ensureArchiveRecoveryReady();
    if (recoveryError) {
      return { ok: false, canceled: false, ...recoveryError, files: [], duplicates: [], summary: appSummary() };
    }
    const pendingRow = findPendingRow(hash);
    let result;
    try {
      result = runManualArchive({
        sources: dialogResult.filePaths,
        invoicesDir: invoicesDirPath(),
        ledgerCsv: ledgerCsvPath(),
        ocrPendingCsv: ocrPendingCsvPath(),
        hash,
        pendingRow,
        removePendingRow: () => rewritePendingCsv((row) => !pendingRowMatchesHash(row, hash)).removed,
      });
    } catch (err) {
      if (err instanceof ArchiveRecoveryError) {
        const error = archiveRecoveryBlockedError();
        archiveRecoveryFailures.set(path.resolve(invoicesDirPath()), error);
        return { ok: false, canceled: false, ...error, files: [], duplicates: [], summary: appSummary() };
      }
      throw err;
    }

    if (!result.ok) {
      return {
        ok: false,
        canceled: false,
        code: result.code ?? 'manual_archive_failed',
        message: result.message ?? '归档失败。',
        ...(result.detail ? { detail: result.detail } : {}),
        files: [],
        duplicates: result.duplicates,
        summary: appSummary(),
      };
    }

    const skipped = result.duplicates.length > 0 ? `，跳过 ${result.duplicates.length} 个已归档文件` : '';
    return {
      ok: true,
      canceled: false,
      code: result.code ?? 'manual_archive_done',
      message: result.message ?? `已归档 ${result.files.length} 个文件并加入识别队列${skipped}，已从待确认队列移除。`,
      files: result.files.map((file) => file.filename),
      duplicates: result.duplicates,
      summary: appSummary(),
    };
  } finally {
    gate.lease.release();
  }
});

/**
 * ELEC-01：破坏性 reset 的授权在**主进程**用原生对话框完成。
 * renderer 侧 confirm 可被脚本绕过；此处无主进程确认则绝不删除。
 * 同时占操作锁（ELEC-02），busy 时拒绝而非边跑边删。
 */
async function performDeveloperReset(event: ElectronAPI.IpcMainInvokeEvent): Promise<Record<string, unknown>> {
  if (!assertTrustedSender(event)) {
    return { ok: false, code: 'untrusted_sender', message: '无权执行重置。', removed: [], skippedExternal: [] };
  }

  if (coordinator.current()) {
    const running = coordinator.current();
    return {
      ok: false,
      code: 'operation_busy',
      message: running
        ? `当前正在${running.kind === 'fetch' ? '获取邮件' : running.kind === 'pipeline' ? '处理邮件' : running.kind === 'ocr' ? '识别文件' : '整理文件'}，请等待完成后再重置。`
        : '当前有任务正在运行，请等待完成后再重置。',
      running,
      removed: [],
      skippedExternal: [],
      summary: appSummary(),
    };
  }

  if (!e2eNoGuiMode()) {
    const first = await dialog.showMessageBox(mainWindow!, {
      type: 'warning',
      buttons: ['取消', '继续删除'],
      defaultId: 0,
      cancelId: 0,
      title: '清空应用管理的数据',
      message: '清空应用管理的数据（保留邮箱与保存设置）',
      detail: [
        '会永久删除应用内部保存的邮件、发票和行程单、待确认记录、识别结果及处理记录。',
        '邮箱与保存设置不会删除；你另选文件夹中的文件也不会删除。',
        '',
        '此操作不能撤销。',
      ].join('\n'),
    });
    if (first.response !== 1) {
      return { ok: false, code: 'reset_cancelled', message: '已取消重置。', removed: [], skippedExternal: [] };
    }
    const second = await dialog.showMessageBox(mainWindow!, {
      type: 'warning',
      buttons: ['取消', '确定删除'],
      defaultId: 0,
      cancelId: 0,
      title: '再次确认',
      message: '再次确认：已归档的发票原件会被删除。',
      detail: '请先自行备份需要保留的文件。确定要删除吗？',
    });
    if (second.response !== 1) {
      return { ok: false, code: 'reset_cancelled', message: '已取消重置。', removed: [], skippedExternal: [] };
    }
  }

  const gate = acquireOperation('pipeline');
  if (!gate.ok) {
    return { ...gate.response, removed: [], skippedExternal: [] };
  }

  try {
    const cfg = readConfigForPaths();
    const paths = asObject(cfg.paths);
    const output = asObject(cfg.output);
    const ocr = asObject(cfg.ocr);
    const rename = asObject(cfg.rename);
    const candidates: { label: string; value: unknown }[] = [
      { label: '邮件缓存', value: paths.samples },
      { label: '归档发票', value: paths.invoices },
      { label: '待确认队列', value: paths.pending },
      { label: '归档台账', value: output.csv },
      { label: '识别结果', value: ocr.resultsCsv },
      { label: '整理输出目录', value: rename.organizedDir },
      { label: '运行状态', value: statePath },
      { label: '运行记录', value: historyPath(dataDir) },
      { label: '应用缓存', value: '.mfh-cache' },
    ];
    const removed: string[] = [];
    // APP-21：位于 dataDir 之外的配置路径被保留，而且必须如实回报。
    const skippedExternal: string[] = [];
    for (const candidate of candidates) {
      const value = candidate.value;
      if (typeof value !== 'string' || value.length === 0) continue;
      const target = path.resolve(dataDir, value);
      if (target === dataDir) continue;
      if (target === configPath) continue;
      if (!isInsideDataDir(target)) {
        if (fs.existsSync(target)) skippedExternal.push(`${candidate.label}：${redactPath(target)}`);
        continue;
      }
      try {
        fs.rmSync(target, { recursive: true, force: true });
        removed.push(path.relative(dataDir, target) || target);
      } catch {
        skippedExternal.push(`${candidate.label}：删除失败，请手动清理`);
      }
    }
    ensureBaseDirectories();
    return {
      ok: true,
      removed: Array.from(new Set(removed)),
      skippedExternal: Array.from(new Set(skippedExternal)),
      message: skippedExternal.length > 0
        ? '已重置应用管理的数据；配置指向应用目录之外的位置未被清理。'
        : '已重置应用管理的数据。',
      summary: appSummary(),
    };
  } finally {
    gate.lease.release();
  }
}

ipcMain.handle('mfh:developer-reset', async (event) => performDeveloperReset(event));

// ---------------------------------------------------------------------------
// 应用生命周期
// ---------------------------------------------------------------------------

// ELEC-05：打包应用始终申请单实例锁。仅未打包 + 显式 E2E 隔离数据目录时才跳过。
const isolatedTestInstance = !app.isPackaged
  && process.env.MFH_E2E_NO_GUI === '1'
  && Boolean(process.env.MFH_DATA_DIR);
const hasSingleInstanceLock = isolatedTestInstance ? true : app.requestSingleInstanceLock();
if (e2eNoGuiMode() && process.platform === 'darwin') {
  try {
    app.dock?.hide();
  } catch {
    // Test-only best effort: hidden windows are the primary no-GUI contract.
  }
}
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

coordinator.setBroadcast((payload) => {
  sendToRenderer('op-state', payload as unknown as Record<string, unknown>);
});

/**
 * 回滚上次崩溃/强退留下的半成品归档事务（APP-04）。自动归档与手工归档共用同一份
 * journal，所以这里一次调用就能把两边的残留一起清掉。
 */
function recoverPendingArchives(): void {
  try {
    recoverArchiveTransactions(invoicesDirPath());
  } catch {
    // 启动恢复只做 best-effort；真正写入前会走 strict gate 并返回可见错误。
  }
}

/** ELEC-14：启动失败时给用户可操作的中文说明，而不是无窗口挂起。 */
function fatalStartupError(err: unknown): void {
  const detail = sanitizeText(err instanceof Error ? err.message : String(err), { maxLength: 300 });
  const body = [
    '应用无法完成启动初始化。',
    '',
    `数据位置：${redactPath(dataDir)}`,
    detail ? `原因：${detail}` : '',
    '',
    '请确认磁盘空间充足、数据目录可写后重新打开应用。',
  ].filter(Boolean).join('\n');
  try {
    if (!e2eNoGuiMode()) {
      dialog.showErrorBox('发票助手无法启动', body);
    }
  } catch {
    // ignore
  }
  try {
    cleanupAllTempDirs();
    coordinator.dispose();
  } catch {
    // ignore
  }
  app.exit(1);
}

async function bootstrapApp(): Promise<void> {
  if (!hasSingleInstanceLock) return;
  ensureUserDataConfig();
  cleanupStaleTempDirs();
  recoverPendingArchives();
  await loadDevFakeBackend();
  createWindow();
}

app.whenReady().then(() => {
  void bootstrapApp().catch(fatalStartupError);
});

let quitCleanupStarted = false;
/** ELEC-04：终止失败时保留锁，exit 钩子也不得 dispose。 */
let preserveDataDirLockOnExit = false;
app.on('before-quit', (event) => {
  cleanupAllTempDirs();
  if (quitCleanupStarted || activeChildren.size === 0) {
    if (!preserveDataDirLockOnExit) coordinator.dispose();
    return;
  }
  // 等待 tracked children（及其 efapiao serve 孙进程）真正退出后再放行退出。
  quitCleanupStarted = true;
  event.preventDefault();
  void terminateChildren(activeChildren).then((summary) => {
    activeChildren.clear();
    // ELEC-04：仍有子进程存活时不得假装清理成功并释放数据锁。
    if (summary.remaining > 0) {
      preserveDataDirLockOnExit = true;
      try {
        if (!e2eNoGuiMode()) {
          dialog.showErrorBox(
            '无法完全停止后台任务',
            `仍有 ${summary.remaining} 个后台进程未退出。为保护数据，本次不会释放数据目录锁。请稍后重新打开应用。`,
          );
        }
      } catch {
        // ignore
      }
      cleanupAllTempDirs();
      // 不调用 coordinator.dispose()，避免新实例在旧写者仍存活时立刻抢锁。
      app.exit(1);
      return;
    }
    coordinator.dispose();
    cleanupAllTempDirs();
    app.quit();
  });
});

process.on('exit', () => {
  cleanupAllTempDirs();
  if (!preserveDataDirLockOnExit) {
    try {
      coordinator.dispose();
    } catch {
      // ignore
    }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (e2eNoGuiMode()) return;
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
