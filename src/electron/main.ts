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
import { registerManagedRoots, redactPath, sanitizeText, shortId, type UiError } from './sanitize.js';
import { runManualArchive } from './manualArchive.js';
import { ArchiveRecoveryError, assertArchiveTransactionsRecovered, recoverArchiveTransactions } from '../download/archiveJournal.js';
import { dataDirLockPath } from '../util/dataDirLock.js';

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
  // ELEC-01：只允许导航到本应用 gui-design/pages 下的 file: 页面，并禁止 window.open。
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isCanonicalAppPageUrl(url)) event.preventDefault();
  });
  mainWindow.webContents.on('will-frame-navigate', (event) => {
    // 子 frame 一律拒绝导航到站外；主 frame 同样只允许应用页面。
    if (!isCanonicalAppPageUrl(event.url)) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // 新窗口（含 macOS 从 Dock 重开）需要立刻知道是否已有任务在跑。
  mainWindow.webContents.once('did-finish-load', () => {
    sendToRenderer('op-state', sanitizeOpState(coordinator.state()) as unknown as Record<string, unknown>);
  });
  void mainWindow.loadFile(uiPath('pages', 'dashboard.html'));
}

/** 应用内页面根目录（gui-design/pages）。 */
function appPagesRoot(): string {
  return uiPath('pages');
}

/**
 * 判定 URL 是否为本应用合法 GUI 页面（ELEC-01）。
 * 必须是 file: 且 realpath 落在 gui-design/pages 下的 .html。
 */
function isCanonicalAppPageUrl(url: string): boolean {
  if (typeof url !== 'string' || !url.startsWith('file:')) return false;
  try {
    const filePath = fileURLToPath(url.split('?')[0]!.split('#')[0]!);
    let pagesRoot: string;
    try {
      pagesRoot = fs.realpathSync(appPagesRoot());
    } catch {
      pagesRoot = path.resolve(appPagesRoot());
    }
    let realFile: string;
    try {
      realFile = fs.realpathSync(filePath);
    } catch {
      // 页面文件必须真实存在；失败则拒绝。
      return false;
    }
    const rel = path.relative(pagesRoot, realFile);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
    return rel.toLowerCase().endsWith('.html') && !rel.includes('..');
  } catch {
    return false;
  }
}

/**
 * 只接受主窗口 mainFrame 当前加载的应用页面作为 IPC 调用方（ELEC-01）。
 * - 要求 senderFrame === webContents.mainFrame（拒绝 iframe / 子 frame）
 * - URL 必须是 canonical app page
 * - 在任何 await dialog 之后必须重新调用本函数
 */
function assertTrustedSender(event: ElectronAPI.IpcMainInvokeEvent): boolean {
  try {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return false;
    if (event.sender.isDestroyed()) return false;
    if (event.sender.id !== mainWindow.webContents.id) return false;
    const mainFrame = event.sender.mainFrame;
    if (!mainFrame || event.senderFrame == null || event.senderFrame !== mainFrame) return false;
    const url = event.senderFrame.url || event.sender.getURL();
    if (!isCanonicalAppPageUrl(url)) return false;
    return true;
  } catch {
    return false;
  }
}

const UNTRUSTED_SENDER = {
  ok: false as const,
  code: 'untrusted_sender',
  message: '无权执行此操作。',
  error: '无权执行此操作。',
};

/**
 * 中央 IPC 入口：每个 handler 在执行前强制 trusted-sender 校验（ELEC-01）。
 * 破坏性操作在 await dialog 之后还会再次调用 assertTrustedSender。
 */
function handleTrusted(
  channel: string,
  handler: (event: ElectronAPI.IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>,
): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    if (!assertTrustedSender(event)) return { ...UNTRUSTED_SENDER };
    return handler(event, ...args);
  });
}

/** op-state 只暴露运行态枚举，不把锁文件路径/token 泄漏给 renderer（ELEC-07）。 */
function sanitizeOpState(state: { running: RunningOp | null }): { running: RunningOp | null } {
  if (!state.running) return { running: null };
  return {
    running: {
      kind: state.running.kind,
      jobId: state.running.jobId,
      startedAt: state.running.startedAt,
    },
  };
}

// ---------------------------------------------------------------------------
// 路径规范化与删除/打开 containment（ELEC-01 / ELEC-06）
// ---------------------------------------------------------------------------

/**
 * 解析路径的真实位置：存在则 realpath；不存在则 realpath 最近已存在祖先再拼后缀。
 * 任一环节失败返回 undefined（调用方必须 fail closed）。
 */
function resolveCanonicalPath(target: string): string | undefined {
  const abs = path.resolve(target);
  try {
    return fs.realpathSync(abs);
  } catch {
    // 目标不存在：向上找最近存在的祖先并 realpath。
    let cur = path.dirname(abs);
    const parts: string[] = [path.basename(abs)];
    while (true) {
      try {
        const realAncestor = fs.realpathSync(cur);
        return path.join(realAncestor, ...parts.reverse());
      } catch {
        const parent = path.dirname(cur);
        if (parent === cur) return undefined;
        parts.push(path.basename(cur));
        cur = parent;
      }
    }
  }
}

/** 数据目录的 realpath；失败则 undefined（fail closed）。 */
function realDataDir(): string | undefined {
  try {
    return fs.realpathSync(dataDir);
  } catch {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      return fs.realpathSync(dataDir);
    } catch {
      return undefined;
    }
  }
}

/**
 * 双方已 canonical 的路径段 containment 比较。
 * 用「根 + 分隔符」前缀，避免 `/a/bc` 被当成 `/a/b` 的子路径；
 * 也避免 `path.relative` 对 `..hidden` 这类段名误判。
 * 任一侧为空则 false（fail closed）。
 */
function isPathSegmentInside(candidateCanon: string, rootCanon: string): boolean {
  if (!candidateCanon || !rootCanon) return false;
  const root = path.normalize(rootCanon);
  const cand = path.normalize(candidateCanon);
  if (process.platform === 'win32') {
    const rootLower = root.toLowerCase();
    const candLower = cand.toLowerCase();
    if (candLower === rootLower) return true;
    const prefix = rootLower.endsWith(path.sep) ? rootLower : rootLower + path.sep;
    return candLower.startsWith(prefix);
  }
  if (cand === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return cand.startsWith(prefix);
}

/**
 * 判断 candidate 是否 canonically 位于 root 内部。
 * 双方都用同一套 resolveCanonicalPath（realpath / 最近已存在祖先）；
 * 规范化失败一律 false（fail closed）。macOS 上 `/var`→`/private/var` 两侧对称。
 */
function isCanonicallyInside(candidate: string, root: string): boolean {
  const realRoot = resolveCanonicalPath(root);
  const realCandidate = resolveCanonicalPath(candidate);
  if (!realRoot || !realCandidate) return false;
  return isPathSegmentInside(realCandidate, realRoot);
}

/**
 * 不得作为 open-path 允许根的危险目录（即便配置文件里写成这些值也拒绝）。
 * 家目录的子目录可以（用户常把发票放在 ~/Documents/...）；裸家目录本身不行。
 */
function isDangerousOpenRoot(canonPath: string): boolean {
  if (!canonPath) return true;
  const normalized = path.normalize(canonPath);
  const root = path.parse(normalized).root;
  // 文件系统根（`/` 或 `C:\`）
  if (!root || normalized === root || normalized === path.sep) return true;

  if (process.platform === 'win32') {
    const lower = normalized.toLowerCase();
    const winDir = path.resolve(process.env.SystemRoot || process.env.windir || 'C:\\Windows').toLowerCase();
    const pf = path.resolve(process.env.ProgramFiles || 'C:\\Program Files').toLowerCase();
    const pf86 = path.resolve(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)').toLowerCase();
    if (lower === winDir || lower === pf || lower === pf86) return true;
  } else {
    const blocked = new Set([
      '/etc',
      '/usr',
      '/bin',
      '/sbin',
      '/System',
      '/Applications',
      '/Library',
      // macOS 上 /etc 常是 /private/etc 的 symlink，canonical 后落在 private 下
      '/private/etc',
    ]);
    if (blocked.has(normalized)) return true;
  }

  try {
    const home = fs.realpathSync(os.homedir());
    if (process.platform === 'win32') {
      if (normalized.toLowerCase() === home.toLowerCase()) return true;
    } else if (normalized === home) {
      return true;
    }
  } catch {
    // homedir 解析失败时不因此放行危险根
  }
  return false;
}

/**
 * ELEC-06：open-path 允许根仅由主进程从磁盘配置自行计算，绝不读 IPC payload。
 * = canonical dataDir + 配置的 invoices/pending/samples + 输出 CSV 父目录。
 * 规范化失败的根跳过；危险根（系统目录 / 裸家目录）跳过。
 */
function openPathAllowedRoots(): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined): void => {
    if (!raw) return;
    const canon = resolveCanonicalPath(raw);
    if (!canon) return;
    if (isDangerousOpenRoot(canon)) return;
    const key = process.platform === 'win32' ? canon.toLowerCase() : canon;
    if (seen.has(key)) return;
    seen.add(key);
    roots.push(canon);
  };

  add(realDataDir());
  add(invoicesDirPath());
  add(pendingDirPath());
  add(samplesDirPath());
  // 输出台账 CSV 的父目录（用户可能把它放到归档目录之外）
  try {
    add(path.dirname(ledgerCsvPath()));
  } catch {
    // ledger 路径解析失败则跳过
  }
  return roots;
}

/**
 * 删除前的 containment 检查：目标及其最近祖先都必须落在真实数据目录内。
 * 中间若有指向外部的 symlink/junction，realpath 会逃出，检查失败。
 */
function assertSafeToDeleteInsideDataDir(target: string): string | undefined {
  const base = realDataDir();
  if (!base) return undefined;
  if (!isCanonicallyInside(target, base)) return undefined;
  // 再校验最近已存在祖先也在数据目录内（防止删除时路径段穿越）。
  let cur = path.resolve(target);
  for (let i = 0; i < 64; i++) {
    try {
      const real = fs.realpathSync(cur);
      if (!isCanonicallyInside(real, base)) return undefined;
      break;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return undefined;
      cur = parent;
    }
  }
  return resolveCanonicalPath(target);
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
  configError?: { message: string; detail?: string; backupPath?: string; backupCreated?: boolean };
  /** 显式修复损坏配置时，被隔离备份的旧文件（已脱敏）。 */
  repairedFrom?: string;
  /** COPY-02：旧配置是否成功另存为备份。 */
  backupCreated?: boolean;
  /** 备份路径（已脱敏）；仅 backupCreated 为 true 时有意义。 */
  backupPath?: string;
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
  let backupCreated = false;
  const current = readConfigStrict();
  if (current.ok) {
    base = current.raw;
  } else if (!opts.repairCorrupt) {
    return {
      ok: false,
      configPath: redactPath(configPath),
      configError: { message: `配置文件已损坏，无法保存：${current.message}` },
    };
  } else {
    // 显式修复：先把损坏文件隔离备份，再以内置示例为基线重建。
    const backup = `${configPath}.corrupt-${Date.now()}.json`;
    try {
      if (fs.existsSync(configPath)) {
        fs.copyFileSync(configPath, backup);
        backupPath = redactPath(backup);
        backupCreated = true;
      }
    } catch {
      backupPath = undefined;
      backupCreated = false;
    }
    try {
      base = JSON.parse(fs.readFileSync(bundledConfigPath, 'utf8')) as Record<string, unknown>;
    } catch {
      return {
        ok: false,
        configPath: redactPath(configPath),
        configError: {
          message: '内置示例配置不可读，无法修复配置文件。',
          backupCreated,
          ...(backupPath ? { backupPath } : {}),
        },
        backupCreated,
        ...(backupPath ? { backupPath } : {}),
      };
    }
  }

  const merged = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  mergeDefined(merged, normalizeSavePayload(payload));
  // 先迁移（补 schemaVersion 与新版默认值），再用正式 schema 校验完整候选配置。
  const candidate = migrateRawConfig(merged).raw;

  const validated = validateConfigCandidate(candidate);
  if (!validated.ok) {
    return { ok: false, configPath: redactPath(configPath), fieldErrors: validated.errors };
  }

  try {
    writeConfigAtomic(candidate);
  } catch (err) {
    return {
      ok: false,
      // ELEC-07：不向 renderer 泄漏原始 configPath。
      configPath: redactPath(configPath),
      configError: {
        // COPY-10：配置写失败不等于「数据目录」问题；指向可见的设置操作。
        message: '无法保存设置。请确认应用有写入权限后重试；若仍失败，请在「邮箱与保存」中检查保存位置。',
        detail: sanitizeText(err instanceof Error ? err.message : String(err), { maxLength: 200 }),
        backupCreated,
        ...(backupPath ? { backupPath } : {}),
      },
      backupCreated,
      ...(backupPath ? { backupPath } : {}),
    };
  }
  return {
    ok: true,
    configPath: redactPath(configPath),
    config: redactConfig(candidate),
    backupCreated,
    ...(backupPath ? { repairedFrom: backupPath, backupPath } : {}),
  };
}

/**
 * 屏蔽 secret 与内部诊断路径后再交给 renderer（ELEC-07）。
 *
 * `paths.invoices/pending/samples` 与 `output.csv` 是用户可配置的「保存位置」：
 * 配置表单要能回显并重新保存，且 shell 的 openPath({ path }) 要用真实路径打开。
 * 打开时主进程仍只信任磁盘配置算出的 allow-list（ELEC-06），不会被 IPC 扩权。
 * OCR resultsCsv / organizedDir 等内部路径继续脱敏。
 */
function redactConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const isSecretKey = (k: string): boolean => /secret|key|token|pass/i.test(k);
  const redactMaybePath = (value: unknown): unknown => {
    if (typeof value !== 'string' || value.length === 0) return value;
    // 绝对路径、盘符路径、UNC 一律脱敏；相对路径保留（便于 UI 展示配置）。
    if (
      path.isAbsolute(value)
      || /^[A-Za-z]:[\\/]/.test(value)
      || value.startsWith('\\\\')
      || value.startsWith('//')
    ) {
      return redactPath(value);
    }
    return value;
  };
  const imap = { ...asObject(raw.imap), pass: '' };
  const ocrSrc = asObject(raw.ocr);
  const creds = asObject(ocrSrc.credentials);
  const ocr = {
    ...ocrSrc,
    resultsCsv: redactMaybePath(ocrSrc.resultsCsv),
    credentials: Object.fromEntries(Object.entries(creds).map(([k, v]) => [k, isSecretKey(k) ? '' : v])),
  };
  const pathsSrc = asObject(raw.paths);
  // 用户保存位置：不脱敏，供配置表单回显/保存与 openPath({ path }) 使用。
  const paths = {
    ...pathsSrc,
    samples: pathsSrc.samples,
    invoices: pathsSrc.invoices,
    pending: pathsSrc.pending,
  };
  const outputSrc = asObject(raw.output);
  const output = {
    ...outputSrc,
    csv: outputSrc.csv,
  };
  const renameSrc = asObject(raw.rename);
  const rename = {
    ...renameSrc,
    organizedDir: redactMaybePath(renameSrc.organizedDir),
  };
  return { ...raw, imap, ocr, paths, output, rename };
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
  /** handled = archived + pending（兼容旧 processed 字段）。 */
  processed: number;
  archived: number;
  pending: number;
  skipped: number;
  failed: number;
  /** archived 子集：有票落盘但仍有待确认。 */
  partial: number;
}

/** CLI `Run complete:` 结构化计数（簇 C 契约）。 */
interface RunTerminalCounts {
  archived: number;
  pending: number;
  skipped: number;
  failed: number;
  /** archived 子集。 */
  partial: number;
  /** archived + pending（兼容旧 processed=）。 */
  processed: number;
}

function emptyRunCounts(): RunTerminalCounts {
  return { archived: 0, pending: 0, skipped: 0, failed: 0, partial: 0, processed: 0 };
}

/** 从 stdout/stderr 解析 `Run complete: archived=…`（也兼容旧 processed=）。 */
function parseRunCompleteCounts(output: string): RunTerminalCounts | undefined {
  const line = output.split(/\r?\n/).find((l) => l.includes('Run complete:'));
  if (!line) return undefined;
  const archived = numField(line, 'archived');
  const pending = numField(line, 'pending');
  const skipped = numField(line, 'skipped') ?? 0;
  const failed = numField(line, 'failed') ?? 0;
  const partial = numField(line, 'partial') ?? 0;
  const processedField = numField(line, 'processed');
  // 新格式优先；旧格式只有 processed= 时把它当作 archived+pending 合计。
  if (archived !== undefined || pending !== undefined) {
    const a = archived ?? 0;
    const p = pending ?? 0;
    return {
      archived: a,
      pending: p,
      skipped,
      failed,
      partial,
      processed: processedField ?? (a + p),
    };
  }
  if (processedField !== undefined) {
    return {
      archived: processedField,
      pending: 0,
      skipped,
      failed,
      partial,
      processed: processedField,
    };
  }
  return undefined;
}

function parseOcrCompleteCounts(output: string): {
  scanned: number;
  parsed: number;
  skipped: number;
  failed: number;
  updated: number;
} | undefined {
  const match = /OCR complete: scanned=(\d+), parsed=(\d+), skipped=(\d+), failed=(\d+), updated=(\d+)/.exec(output);
  if (!match) return undefined;
  return {
    scanned: Number(match[1]),
    parsed: Number(match[2]),
    skipped: Number(match[3]),
    failed: Number(match[4]),
    updated: Number(match[5]),
  };
}

/**
 * 运行历史 / IPC 终态：success | partial | failed。
 * - 有成功侧也有失败 → partial
 * - 仅失败 / 未启动 / 非 0 且无成功 → failed
 * - 仅成功（含 skipped）→ success
 */
function deriveRunStatus(opts: {
  code: number | null;
  started?: boolean;
  succeeded: number;
  failed: number;
  mailNotFound?: boolean;
}): RunHistoryEntry['status'] {
  if (opts.started === false) return 'failed';
  if (opts.mailNotFound) return 'failed';
  if (opts.failed > 0 && opts.succeeded > 0) return 'partial';
  if (opts.failed > 0) return 'failed';
  if (opts.code !== 0 && opts.code !== null) return 'failed';
  return 'success';
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
    const status = deriveRunStatus({
      code: current.failed > 0 ? 1 : 0,
      succeeded: current.parsed + current.skipped,
      failed: current.failed,
    });
    let message: string;
    let kind: string;
    let phase: string;
    if (current.total === 0) {
      phase = '没有文件';
      kind = 'warn';
      message = '没有等待识别的文件。请到「开始处理」，先完成「获取邮件」和「获取发票文件」，再开始识别。';
    } else if (status === 'success') {
      phase = '识别完成';
      kind = 'ok';
      message = `识别完成：成功 ${current.parsed} 个，跳过 ${current.skipped} 个。`;
    } else if (status === 'partial') {
      phase = '部分完成';
      kind = 'warn';
      message = `识别部分完成：成功 ${current.parsed} 个，失败 ${current.failed} 个，跳过 ${current.skipped} 个。`;
    } else {
      phase = '识别失败';
      kind = 'err';
      message = `识别没有完成：失败 ${current.failed} 个。请稍后重试；若仍失败，请到「设置」检查识别选项。`;
    }
    emit({
      operation: 'ocr',
      phase,
      percent: 100,
      total: current.total,
      processed: current.processed,
      parsed: current.parsed,
      skipped: current.skipped,
      failed: current.failed,
      status,
      code: status === 'success' ? 'ocr_done' : status === 'partial' ? 'ocr_partial' : 'ocr_failed',
      message,
      kind,
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

  // COPY-06：未映射的原始 CLI 行不进普通识别日志；仅发稳定 code。
  if (text.includes('[error]') || text.includes('[warn]')) {
    emit({
      operation: 'ocr',
      phase: '识别日志',
      total: current.total,
      processed: current.processed,
      parsed: current.parsed,
      skipped: current.skipped,
      failed: current.failed,
      code: text.includes('[error]') ? 'ocr_log_error' : 'ocr_log_warn',
      message: text.includes('[error]')
        ? '识别过程中出现错误，详情见技术诊断。'
        : '识别过程中出现警告，详情见技术诊断。',
      kind: text.includes('[error]') ? 'err' : 'warn',
    });
  }
}

/** FE-12：未知 total 时不发假 percent。 */
function sendOcrPhase(message: string, emit: ProgressSink, current?: Partial<OcrProgressState>, kind = ''): void {
  const total = current?.total ?? 0;
  emit({
    operation: 'ocr',
    phase: '准备识别',
    ...(total > 0 ? { total, percent: 1 } : { total: 0 }),
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
    const counts = parseRunCompleteCounts(text);
    if (counts) {
      current.archived = counts.archived;
      current.pending = counts.pending;
      current.processed = counts.processed;
      current.skipped = counts.skipped;
      current.failed = counts.failed;
      current.partial = counts.partial;
    } else {
      current.processed = numField(text, 'processed') ?? current.processed;
      current.skipped = numField(text, 'skipped') ?? current.skipped;
      current.failed = numField(text, 'failed') ?? current.failed;
      current.partial = numField(text, 'partial') ?? current.partial;
    }
    const status = deriveRunStatus({
      code: current.failed > 0 ? 1 : 0,
      succeeded: current.archived + current.pending + current.skipped,
      failed: current.failed,
    });
    const partialNote = current.partial > 0 ? `，其中 ${current.partial} 封仍有待确认` : '';
    const pendingNote = current.pending > 0 ? `，待确认 ${current.pending} 封` : '';
    let message: string;
    let kind: string;
    let phase: string;
    if (status === 'success') {
      phase = '获取完成';
      kind = 'ok';
      message = `处理完成：成功 ${current.archived} 封${pendingNote}${partialNote}，跳过 ${current.skipped} 封。`;
    } else if (status === 'partial') {
      phase = '部分完成';
      kind = 'warn';
      message = `已处理 ${current.archived + current.pending} 封邮件，其中 ${current.failed} 封没有完成${pendingNote}${partialNote}。请点击「重新获取」；如仍失败，请展开「查看技术详情」。`;
    } else {
      phase = '获取失败';
      kind = 'err';
      message = current.failed > 0
        ? `处理没有完成：失败 ${current.failed} 封。请先重试；如仍失败，请展开「查看技术详情」。`
        : '处理没有完成。请先重试；如仍失败，请展开「查看技术详情」。';
    }
    emit({
      operation: 'files',
      phase,
      percent: 100,
      total: current.total > 0
        ? current.total
        : current.archived + current.pending + current.skipped + current.failed,
      processed: current.processed,
      archived: current.archived,
      pending: current.pending,
      skipped: current.skipped,
      failed: current.failed,
      partial: current.partial,
      status,
      code: status === 'success' ? 'files_done' : status === 'partial' ? 'files_partial' : 'files_failed',
      message,
      kind,
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
    // 降级到待确认：计为进度完成的一部分，并推进 percent（FE-12）。
    current.processed++;
    const percent = fileProgressPercent(current);
    emit({
      operation: 'files',
      phase: '需要确认',
      ...(percent !== undefined ? { percent } : {}),
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

  // 未识别的原始 CLI 行不进普通进度（COPY-06 / ELEC-07）；只保留稳定 code。
  // 原始内容只进诊断文件，不进 IPC。
  if (text.includes('[error]') || text.includes('[warn]')) {
    emit({
      operation: 'files',
      phase: text.includes('[warn]') ? '需要确认' : '获取日志',
      ...(current.total > 0 ? { total: current.total } : {}),
      processed: current.processed,
      skipped: current.skipped,
      failed: current.failed,
      code: text.includes('[error]') ? 'files_log_error' : 'files_log_warn',
      message: text.includes('[error]')
        ? '处理过程中出现错误，详情见技术诊断。'
        : '处理过程中出现警告，详情见技术诊断。',
      kind: text.includes('[error]') ? 'err' : 'warn',
    });
  }
}

/** FE-12：未知 total 时不发 percent（不确定进度）；已知 total 时才带真实 percent。 */
function sendFilePhase(message: string, emit: ProgressSink, current?: Partial<FileProgressState>, kind = ''): void {
  const total = current?.total ?? 0;
  emit({
    operation: 'files',
    phase: '准备获取',
    ...(total > 0 ? { total, percent: 1 } : {}),
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
  /** pipeline `Run complete:` 结构化计数；无终态行时为 undefined。 */
  runCounts?: RunTerminalCounts;
  /** OCR `OCR complete:` 结构化计数。 */
  ocrCounts?: ReturnType<typeof parseOcrCompleteCounts>;
}

function runCli(command: string, args: string[], opts: RunCliOptions = {}): Promise<RunCliResult> {
  return new Promise((resolve) => {
    const emitFetch = terminalGuard(sendProgress);
    const emitOcr = terminalGuard(sendOperationProgress);
    const emitFiles = terminalGuard(sendFileProgress);
    const current: FetchProgressState = { seen: 0, saved: 0, skipped: 0, repaired: 0 };
    const ocrCurrent: OcrProgressState = { total: opts.initialTotal ?? 0, parsed: 0, failed: 0, skipped: 0, processed: 0, initialized: false };
    const fileCurrent: FileProgressState = {
      total: 0, processed: 0, archived: 0, pending: 0, skipped: 0, failed: 0, partial: 0,
    };
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
      const combined = `${fake.stdout}\n${fake.stderr}`;
      for (const line of combined.split(/\r?\n/)) handleLine(line);
      resolve({
        ...fake,
        started: true,
        mails: mails(),
        runCounts: parseRunCompleteCounts(combined),
        ocrCounts: parseOcrCompleteCounts(combined),
      });
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
      resolve({
        code: null,
        stdout: '',
        stderr: spawnError.detail ?? '',
        started: false,
        spawnError,
        mails: mails(),
      });
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
      const combined = `${out}\n${err}`;
      const runCounts = parseRunCompleteCounts(combined);
      const ocrCounts = parseOcrCompleteCounts(combined);
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
          // COPY-10：识别失败原因多样（服务/凭据/解析），勿默认归咎磁盘。
          message: '无法完成识别。请稍后重试；若连续失败，请到「设置」检查识别相关选项，并展开「查看技术详情」。',
          detail,
          kind: 'err',
          done: true,
        });
      }
      // 非 0 且未收到 Run complete 终态时补发失败事件（有终态时 parseFileLine 已发）。
      if (opts.operation === 'files' && code !== 0 && !runCounts) {
        emitFiles({
          operation: 'files',
          phase: '获取失败',
          percent: 100,
          ...(fileCurrent.total > 0 ? { total: fileCurrent.total } : {}),
          processed: fileCurrent.processed,
          skipped: fileCurrent.skipped,
          failed: fileCurrent.failed,
          code: 'files_failed',
          // COPY-10：勿默认说成保存位置问题。
          message: '获取发票文件没有完成。请先重试；若仍失败，请展开「查看技术详情」或检查网络与邮箱设置。',
          detail,
          kind: 'err',
          done: true,
        });
      }
      resolve({
        code,
        stdout: out,
        stderr: err,
        started: true,
        mails: mails(),
        ...(runCounts ? { runCounts } : {}),
        ...(ocrCounts ? { ocrCounts } : {}),
      });
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
  codes: { ok: string; failed: string; partial?: string },
  status: RunHistoryEntry['status'] = result.code === 0 ? 'success' : 'failed',
): CliReport {
  if (status === 'success') return { code: codes.ok, exitCode: result.code };
  const detail = sanitizeText(result.stderr.trim() || result.stdout.trim(), { maxLength: 400 });
  const diagnosticsRef = writeDiagnostics(action, jobId, result);
  const code = status === 'partial' && codes.partial
    ? codes.partial
    : codes.failed;
  return {
    code,
    exitCode: result.code,
    ...(detail ? { detail } : {}),
    ...(diagnosticsRef ? { diagnosticsRef } : {}),
  };
}

function ocrRunMessage(result: RunCliResult): string {
  const counts = result.ocrCounts ?? parseOcrCompleteCounts(`${result.stdout}\n${result.stderr}`);
  if (!counts) return '已尝试识别本地文件。';
  if (counts.scanned === 0) {
    return '没有等待识别的文件。请到「开始处理」，先完成「获取邮件」和「获取发票文件」，再开始识别。';
  }
  if (counts.failed > 0 && counts.parsed > 0) {
    return `识别部分完成：成功 ${counts.parsed} 个，失败 ${counts.failed} 个，跳过 ${counts.skipped} 个。`;
  }
  if (counts.failed > 0) {
    return `识别没有完成：失败 ${counts.failed} 个，跳过 ${counts.skipped} 个。`;
  }
  return `已扫描 ${counts.scanned} 个文件，识别成功 ${counts.parsed} 个，跳过 ${counts.skipped} 个。`;
}

function pipelineRunMessage(
  counts: RunTerminalCounts,
  status: RunHistoryEntry['status'],
  onlyMail: boolean,
  mailNotFound: boolean,
): string {
  if (mailNotFound) {
    return onlyMail
      ? '没有找到这封待处理邮件。请刷新「待确认」列表后再试。'
      : '没有找到要处理的邮件。';
  }
  if (status === 'success') {
    if (onlyMail) {
      if (counts.pending > 0) return '这封邮件已重新处理，仍需在「待确认」中处理。';
      if (counts.archived > 0) return '这封邮件已重新处理。';
      if (counts.skipped > 0) return '这封邮件此前已处理，本次已跳过。';
      return '这封邮件已重新处理。';
    }
    const pendingNote = counts.pending > 0 ? `，其中 ${counts.pending} 封进入待确认` : '';
    return `处理完成，本次处理 ${counts.archived + counts.pending} 封邮件${pendingNote}。`;
  }
  if (status === 'partial') {
    return `已处理 ${counts.archived + counts.pending} 封邮件，其中 ${counts.failed} 封没有完成。请点击「重新获取」；如仍失败，请展开「查看技术详情」。`;
  }
  if (onlyMail) {
    return '这封邮件没有处理完成。请稍后重试；如仍失败，请展开「查看技术详情」。';
  }
  return '处理缓存邮件没有完成。请先重试；如仍失败，请展开「查看技术详情」。';
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

/** 记录一条运行历史，返回非致命告警文案（写失败时）。status 必须由调用方按结构化计数推导（ELEC-12）。 */
function recordHistory(
  action: string,
  title: string,
  startedAt: number,
  result: { code: number | null; stdout: string; stderr: string; started?: boolean },
  status: RunHistoryEntry['status'],
  message?: string,
): string | undefined {
  const output = sanitizeText(`${result.stdout}\n${result.stderr}`.trim(), { maxLength: 500 });
  const defaultMessage = status === 'success'
    ? '已完成'
    : status === 'partial'
      ? '部分完成'
      : '运行失败';
  return appendHistory({
    action,
    title,
    status,
    message: message ?? defaultMessage,
    detail: output || (status === 'success' ? '命令已完成。' : '没有收到错误详情。'),
    durationMs: Date.now() - startedAt,
  });
}

/** best-effort 摘要：失败时不覆盖已提交的操作结果（ELEC-08）。 */
function tryAppSummary(): { summary?: AppSummary; summaryUnavailable?: boolean; warning?: string } {
  try {
    return { summary: appSummary() };
  } catch (err) {
    return {
      summaryUnavailable: true,
      warning: '操作已完成，但本地列表暂时无法刷新。请点击「刷新列表」。',
      // detail kept out of renderer-facing field; message is user-safe.
      ...(err instanceof Error ? {} : {}),
    };
  }
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

/** journal 目录检查结果：缺席 / 有残留 / 无法判定（读错误）。 */
type JournalPresence =
  | { kind: 'absent' }
  | { kind: 'residual'; names: string[] }
  | { kind: 'unreadable'; detail: string };

function archiveRecoveryBlockedError(extra?: string): UiError {
  return {
    code: 'archive_recovery_blocked',
    // COPY-10：可执行动作；并提供隔离恢复指引（OCR-05 rework）。
    message: '上次保存发票时中断，当前无法继续修改。请先关闭可能占用发票清单的表格程序，然后重新打开应用。若仍无法继续，请在「设置 → 关于」查看数据位置，将其中 invoices 下的 .journal 文件夹改名为 .journal-quarantine 后再打开应用（改名前请勿删除）。',
    detail: extra
      ? sanitizeText(extra, { maxLength: 300 })
      : '归档事务恢复未完成或仍有未解决的 journal，写入已停止。',
  };
}

/**
 * OCR-05 rework：journal 目录读错误 ≠ 无残留（fail closed）。
 * 只有确认目录不存在（ENOENT）才算 absent。
 */
function inspectArchiveJournals(invoicesDir: string): JournalPresence {
  const dir = path.join(invoicesDir, '.journal');
  try {
    const names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
    return names.length === 0 ? { kind: 'absent' } : { kind: 'residual', names };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'absent' };
    return {
      kind: 'unreadable',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 仅隔离**确认损坏**（无法 JSON 解析）的 journal 条目，保留可解析条目供恢复。
 * 整目录搬迁会丢掉仍可用于回滚的证据，故只挪损坏文件（OCR-05 rework）。
 */
function quarantineCorruptArchiveJournals(invoicesDir: string): {
  quarantined: number;
  remaining: number;
  dest?: string;
  detail?: string;
} {
  const dir = path.join(invoicesDir, '.journal');
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { quarantined: 0, remaining: 0 };
    }
    return {
      quarantined: 0,
      remaining: -1,
      detail: sanitizeText(err instanceof Error ? err.message : String(err), { maxLength: 200 }),
    };
  }
  const corrupt: string[] = [];
  for (const name of names) {
    try {
      JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      corrupt.push(name);
    }
  }
  if (corrupt.length === 0) {
    return { quarantined: 0, remaining: names.length };
  }
  const dest = path.join(invoicesDir, `.journal-quarantine-${Date.now()}`);
  try {
    fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
    for (const name of corrupt) {
      fs.renameSync(path.join(dir, name), path.join(dest, name));
    }
    return {
      quarantined: corrupt.length,
      remaining: names.length - corrupt.length,
      dest: redactPath(dest),
    };
  } catch (err) {
    return {
      quarantined: 0,
      remaining: names.length,
      detail: sanitizeText(err instanceof Error ? err.message : String(err), { maxLength: 200 }),
    };
  }
}

function ensureArchiveRecoveryReady(): UiError | undefined {
  const key = path.resolve(invoicesDirPath());
  try {
    assertArchiveTransactionsRecovered(key);
  } catch (err) {
    const error = archiveRecoveryBlockedError(
      err instanceof Error ? err.message : String(err),
    );
    archiveRecoveryFailures.set(key, error);
    return error;
  }

  const presence = inspectArchiveJournals(key);
  if (presence.kind === 'unreadable') {
    // fail closed：读错误 ≠ 无残留
    const error = archiveRecoveryBlockedError(`无法读取归档恢复记录：${presence.detail}`);
    archiveRecoveryFailures.set(key, error);
    return error;
  }
  if (presence.kind === 'residual') {
    // 先隔离确认损坏的条目，再重试恢复。
    const q = quarantineCorruptArchiveJournals(key);
    if (q.remaining < 0) {
      const error = archiveRecoveryBlockedError(q.detail);
      archiveRecoveryFailures.set(key, error);
      return error;
    }
    try {
      assertArchiveTransactionsRecovered(key);
    } catch (err) {
      const error = archiveRecoveryBlockedError(
        err instanceof Error ? err.message : String(err),
      );
      archiveRecoveryFailures.set(key, error);
      return error;
    }
    const again = inspectArchiveJournals(key);
    if (again.kind === 'unreadable') {
      const error = archiveRecoveryBlockedError(`无法读取归档恢复记录：${again.detail}`);
      archiveRecoveryFailures.set(key, error);
      return error;
    }
    if (again.kind === 'residual') {
      // 仍有可解析但无法自动清理的 journal：阻断写入，指引人工隔离（不自动丢证据）。
      const error = archiveRecoveryBlockedError(
        `仍有 ${again.names.length} 条未解决的归档恢复记录`
        + (q.dest ? `；已隔离 ${q.quarantined} 条损坏记录到 ${q.dest}` : ''),
      );
      archiveRecoveryFailures.set(key, error);
      return error;
    }
  }
  archiveRecoveryFailures.delete(key);
  return undefined;
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
 * 给 renderer 的可打开路径：dataDir 内用相对路径；配置允许根（如外部归档目录）
 * 内也可用相对 dataDir 失败时的 opaque `ext:` 句柄（ELEC-06 / ELEC-07）。
 * open-path 会用主进程磁盘配置的 allow-list 做 containment，不信任 renderer 扩权。
 */
function rendererOpenablePath(abs: string): string {
  if (!abs) return '';
  const canon = resolveCanonicalPath(abs);
  if (!canon) return '';
  const base = realDataDir();
  if (base && isPathSegmentInside(canon, base)) {
    const rel = path.relative(base, canon);
    return rel.split(path.sep).join('/') || '.';
  }
  // dataDir 外：即便落在用户配置的 invoices 等根下，也不把绝对路径交给 renderer。
  return registerExternalFileHandle(canon);
}

/** 主进程签发的外部文件 opaque 句柄（renderer 不可伪造路径）。 */
const externalFileHandles = new Map<string, string>();

function registerExternalFileHandle(canonicalPath: string): string {
  for (const [id, p] of externalFileHandles) {
    if (p === canonicalPath) return id;
  }
  const id = `ext:${randomBytes(12).toString('hex')}`;
  externalFileHandles.set(id, canonicalPath);
  // 防止无限增长：超过 500 个时丢掉最旧的一半。
  if (externalFileHandles.size > 500) {
    const keys = Array.from(externalFileHandles.keys()).slice(0, 250);
    for (const k of keys) externalFileHandles.delete(k);
  }
  return id;
}

function resolveExternalFileHandle(id: string): string | undefined {
  if (typeof id !== 'string' || !id.startsWith('ext:')) return undefined;
  return externalFileHandles.get(id);
}

/**
 * ELEC-07：摘要进 renderer 前脱敏内部 CSV 路径与原始错误；
 * filePath 改为可打开的安全形态；nested library.ocr 也必须脱敏。
 */
function sanitizeAppSummary(summary: AppSummary): AppSummary {
  const sanitizeOcrSummary = (ocr: AppSummary['library']['ocr']): AppSummary['library']['ocr'] => ({
    ...ocr,
    pendingCsv: ocr.pendingCsv ? redactPath(ocr.pendingCsv) : '',
    resultsCsv: ocr.resultsCsv ? redactPath(ocr.resultsCsv) : '',
    byDocumentType: (ocr.byDocumentType ?? []).map((g) => ({
      ...g,
      examples: (g.examples ?? []).map((ex) => ({
        ...ex,
        hash: ex.hash ? shortId(ex.hash) : ex.hash,
        from: ex.from ? sanitizeText(ex.from, { maxLength: 80 }) : ex.from,
        subject: ex.subject ? '<主题已隐藏>' : ex.subject,
        reason: ex.reason ? sanitizeText(ex.reason, { maxLength: 120 }) : ex.reason,
      })),
    })),
    bySupportingReason: (ocr.bySupportingReason ?? []).map((g) => ({
      ...g,
      examples: (g.examples ?? []).map((ex) => ({
        ...ex,
        hash: ex.hash ? shortId(ex.hash) : ex.hash,
        subject: ex.subject ? '<主题已隐藏>' : ex.subject,
        reason: ex.reason ? sanitizeText(ex.reason, { maxLength: 120 }) : ex.reason,
      })),
    })),
    byFailureReason: (ocr.byFailureReason ?? []).map((g) => ({
      ...g,
      key: g.key ? sanitizeText(g.key, { maxLength: 80 }) : g.key,
      examples: (g.examples ?? []).map((ex) => ({
        ...ex,
        hash: ex.hash ? shortId(ex.hash) : ex.hash,
        subject: ex.subject ? '<主题已隐藏>' : ex.subject,
        reason: ex.reason ? sanitizeText(ex.reason, { maxLength: 120 }) : ex.reason,
      })),
    })),
  });

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
      ocr: sanitizeOcrSummary(summary.library.ocr),
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

/**
 * 取行上持久化的邮件身份（HASH-WIDTH / NEW-DEFECT 5）。
 * 优先 `mailHash`（并发 agent 写入的 INDEX/pending/invoices 列），其次合法的 `hash` 列，
 * 再次 messageId 本身已是裸 hash；旧行才回退到 msgIdHash 重算。
 */
function persistedMailHash(row: Record<string, string>): string | undefined {
  for (const key of ['mailHash', 'hash'] as const) {
    const raw = (row[key] ?? '').trim().toLowerCase();
    if (BARE_MAIL_HASH_RE.test(raw)) return raw;
  }
  const mid = (row.messageId ?? '').trim().toLowerCase();
  if (BARE_MAIL_HASH_RE.test(mid)) return mid;
  return undefined;
}

function pendingRowHashLegacy(row: Record<string, string>): string {
  return msgIdHash(row.messageId || undefined, row.from ?? '', row.date ?? '', row.subject ?? '');
}

/** 行是否对应该 hash：优先持久化字段，旧行才重算（HASH-WIDTH）。 */
function pendingRowMatchesHash(row: Record<string, string>, hash: string): boolean {
  const want = hash.trim().toLowerCase();
  if (!BARE_MAIL_HASH_RE.test(want)) return false;
  const persisted = persistedMailHash(row);
  if (persisted) return persisted === want;
  // 旧行无 mailHash/hash：仅对 12 位历史键做遗留重算，避免把 32 位键误配到 sha1 前缀。
  if (want.length === 12 && pendingRowHashLegacy(row) === want) return true;
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
 * 在 pending 目录内解析 `${hash}.eml`：先校验 hash 形态，再 canonical containment
 * （ELEC-06），禁止 symlink 逃逸与 `../` 路径穿越。
 */
function pendingEmlPathForHash(hash: string): string | undefined {
  if (!BARE_MAIL_HASH_RE.test(hash)) return undefined;
  // 文件名只允许裸 hash，杜绝路径段注入。
  if (hash.includes('/') || hash.includes('\\') || hash.includes('..')) return undefined;
  const root = pendingDirPath();
  const candidate = path.join(root, `${hash}.eml`);
  if (!isCanonicallyInside(candidate, root)) return undefined;
  if (!isCanonicallyInside(candidate, dataDir) && !isCanonicallyInside(root, dataDir)) {
    // pending 在 dataDir 外时，仍要求最终路径落在 pending 根内。
    if (!isCanonicallyInside(candidate, root)) return undefined;
  }
  return resolveCanonicalPath(candidate) ?? candidate;
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

// ---------------------------------------------------------------------------
// 「重新识别」的可恢复准备（APP-17 / ELEC-03）
// ---------------------------------------------------------------------------

interface OcrRerunPlan {
  /** 成功且 durable 验证后丢弃备份。 */
  discard(): void;
  /** 失败时把结果 CSV 与队列恢复到重跑之前；失败会抛出。 */
  restore(): void;
  resultsCsv: string;
  journalPath: string;
}

type PrepareRerunResult =
  | { ok: true; plan: OcrRerunPlan }
  | { ok: false; error: UiError };

interface OcrRerunJournal {
  version: 1;
  stage: 'prepared' | 'committed' | 'rolled_back';
  resultsCsv: string;
  pendingCsv: string;
  resultsBackup: string;
  queueBackup: string;
  resultsMoved: boolean;
  queueMoved: boolean;
  createdAt: number;
  pid: number;
}

function ocrRerunJournalDir(): string {
  return path.join(dataDir, '.mfh-cache', 'ocr-rerun');
}

function writeOcrRerunJournal(file: string, record: OcrRerunJournal): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try {
    const dirFd = fs.openSync(path.dirname(file), 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    // Windows 可能不支持目录 fsync。
  }
}

function readOcrRerunJournal(file: string): OcrRerunJournal | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<OcrRerunJournal>;
    if (raw.version !== 1) return undefined;
    if (typeof raw.resultsCsv !== 'string' || typeof raw.resultsBackup !== 'string') return undefined;
    return raw as OcrRerunJournal;
  } catch {
    return undefined;
  }
}

function restoreFromOcrRerunJournal(journal: OcrRerunJournal): void {
  const errors: string[] = [];
  if (journal.resultsMoved && fs.existsSync(journal.resultsBackup)) {
    try {
      if (fs.existsSync(journal.resultsCsv)) fs.rmSync(journal.resultsCsv, { force: true });
      fs.renameSync(journal.resultsBackup, journal.resultsCsv);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (journal.queueMoved && fs.existsSync(journal.queueBackup)) {
    try {
      fs.copyFileSync(journal.queueBackup, journal.pendingCsv);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (errors.length > 0) {
    throw new Error(`ocr_rerun_restore_failed:${errors.join(';')}`);
  }
}

/**
 * 启动时恢复未完成的 OCR 重跑事务：有 journal 且非 committed → 回滚到备份。
 */
function recoverOcrRerunJournals(): void {
  const dir = ocrRerunJournalDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    // 读失败 fail closed：不静默吞掉，留给 ensure 路径处理。
    return;
  }
  for (const name of entries) {
    const file = path.join(dir, name);
    const journal = readOcrRerunJournal(file);
    if (!journal) continue;
    if (journal.stage === 'committed' || journal.stage === 'rolled_back') {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // ignore
      }
      continue;
    }
    try {
      restoreFromOcrRerunJournal(journal);
      journal.stage = 'rolled_back';
      writeOcrRerunJournal(file, journal);
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // keep journal if delete fails
      }
      // 备份可在确认 restore 成功后删除。
      for (const bak of [journal.resultsBackup, journal.queueBackup]) {
        try {
          if (bak && fs.existsSync(bak)) fs.rmSync(bak, { force: true });
        } catch {
          // best-effort
        }
      }
    } catch {
      // 保留 journal，阻断后续重跑直到人工处理。
    }
  }
}

/**
 * 先准备并校验全部替代物，再把旧结果「移动到备份」（而不是直接删除），最后原子
 * 安装新队列。全程写 durable journal；任何一步失败都可以完整恢复（ELEC-03）。
 */
function prepareOcrRerun(): PrepareRerunResult {
  const resultsCsv = ocrResultsCsvPath();
  const pendingCsv = ocrPendingCsvPath();

  // dataDir 之外的绝对 results 路径是**明确支持**的：改成「移动到同目录备份」，
  // 既不静默跳过，也不会真正删除任何用户文件（失败时还能原样恢复）。
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
  const journalPath = path.join(ocrRerunJournalDir(), `rerun-${stamp}.json`);
  let resultsMoved = false;
  let queueMoved = false;

  const journal: OcrRerunJournal = {
    version: 1,
    stage: 'prepared',
    resultsCsv,
    pendingCsv,
    resultsBackup,
    queueBackup,
    resultsMoved: false,
    queueMoved: false,
    createdAt: Date.now(),
    pid: process.pid,
  };

  try {
    // 先落 journal（空操作意图），再移动文件。
    writeOcrRerunJournal(journalPath, journal);
    if (fs.existsSync(resultsCsv)) {
      fs.renameSync(resultsCsv, resultsBackup);
      resultsMoved = true;
      journal.resultsMoved = true;
      writeOcrRerunJournal(journalPath, journal);
    }
    if (nextQueue !== undefined && fs.existsSync(pendingCsv)) {
      fs.copyFileSync(pendingCsv, queueBackup);
      queueMoved = true;
      journal.queueMoved = true;
      writeOcrRerunJournal(journalPath, journal);
    }
    if (nextQueue !== undefined) {
      const tmp = `${pendingCsv}.tmp-${stamp}`;
      fs.writeFileSync(tmp, nextQueue, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, pendingCsv);
    }
  } catch (err) {
    // 准备阶段失败：立即还原，旧结果一个都不丢；还原失败必须上报。
    try {
      restoreFromOcrRerunJournal({ ...journal, resultsMoved, queueMoved });
      journal.stage = 'rolled_back';
      writeOcrRerunJournal(journalPath, journal);
      try {
        fs.rmSync(journalPath, { force: true });
      } catch {
        // keep
      }
    } catch (restoreErr) {
      return {
        ok: false,
        error: {
          code: 'ocr_rerun_restore_failed',
          message: '重新识别准备失败，且无法自动恢复原有识别结果。请重新打开应用；若仍异常，请勿继续识别并保留备份文件。',
          detail: sanitizeText(
            `${err instanceof Error ? err.message : String(err)}; restore: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`,
          ),
        },
      };
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

  let discarded = false;
  let restored = false;

  return {
    ok: true,
    plan: {
      resultsCsv,
      journalPath,
      discard: () => {
        if (discarded || restored) return;
        // 提交前验证：备份仍在，结果路径可写——然后 durable 标记 committed。
        try {
          journal.stage = 'committed';
          writeOcrRerunJournal(journalPath, journal);
          for (const file of [resultsBackup, queueBackup]) {
            try {
              fs.rmSync(file, { force: true });
            } catch {
              // 备份删不掉不回滚成功态，但 journal 保留到删干净。
            }
          }
          // 确认备份已不在后才删 journal。
          const bakLeft = [resultsBackup, queueBackup].some((f) => {
            try {
              return fs.existsSync(f);
            } catch {
              return true;
            }
          });
          if (!bakLeft) {
            try {
              fs.rmSync(journalPath, { force: true });
            } catch {
              // ignore
            }
          }
          discarded = true;
        } catch {
          // discard 失败：保留 journal + 备份，下次启动可再处理。
        }
      },
      restore: () => {
        if (discarded || restored) return;
        restoreFromOcrRerunJournal(journal);
        journal.stage = 'rolled_back';
        writeOcrRerunJournal(journalPath, journal);
        for (const file of [resultsBackup, queueBackup]) {
          try {
            fs.rmSync(file, { force: true });
          } catch {
            // 备份删除失败时保留 journal
          }
        }
        try {
          fs.rmSync(journalPath, { force: true });
        } catch {
          // keep
        }
        restored = true;
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
 * 优先持久化 `mailHash` 列；旧行才遗留重算 12 位（HASH-WIDTH / NEW-DEFECT 5）。
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
    const persisted = persistedMailHash(row);
    if (persisted && !byHash.has(persisted)) byHash.set(persisted, batchRow);
    else if (!persisted) {
      // 旧 INDEX 无 mailHash：仅用遗留 12 位算法。
      const legacy = msgIdHash(messageId.length > 0 ? messageId : undefined, from, date, subject);
      if (!byHash.has(legacy)) byHash.set(legacy, batchRow);
    }
    if (messageId && !byMessageId.has(messageId)) byMessageId.set(messageId, batchRow);
  }
  return { byHash, byMessageId };
}

/**
 * 在 samples 目录下有界查找 `${hash}.eml`（HASH-WIDTH / NEW-DEFECT 5）。
 * - 优先直接路径与一级子目录
 * - 限制遍历文件数，避免主进程被大样本树拖垮
 * - 读取 Message-Id 时只读前 16 KiB，且使用 open/read 同一句柄
 */
function findSampleEmlByHash(hash: string): string | undefined {
  if (!BARE_MAIL_HASH_RE.test(hash)) return undefined;
  if (hash.includes('/') || hash.includes('\\') || hash.includes('..')) return undefined;
  const root = samplesDirPath();
  const direct = path.join(root, `${hash}.eml`);
  if (fs.existsSync(direct) && isCanonicallyInside(direct, root)) return direct;

  const MAX_ENTRIES = 400;
  let seen = 0;
  try {
    // 仅扫 root 与一层子目录（常见按月/邮箱分桶），禁止无界递归。
    const queue: string[] = [root];
    let depth0 = true;
    while (queue.length > 0 && seen < MAX_ENTRIES) {
      const dir = queue.shift()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (seen >= MAX_ENTRIES) break;
        seen++;
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isFile() && entry.name === `${hash}.eml`) {
          if (isCanonicallyInside(full, root)) return full;
        }
        if (depth0 && entry.isDirectory()) {
          queue.push(full);
        }
      }
      depth0 = false;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** 只读 EML 文件头前 maxBytes 字节（同一 fd）。 */
function readEmlHeader(emlPath: string, maxBytes = 16 * 1024): string {
  const fd = fs.openSync(emlPath, 'r');
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
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
  // 限制 fallback 扫描次数，防止主进程被拖垮。
  let fallbackReads = 0;
  const MAX_FALLBACK_READS = 32;
  for (const hash of hashes) {
    let row = byHash.get(hash);
    if (!row && fallbackReads < MAX_FALLBACK_READS) {
      const eml = findSampleEmlByHash(hash);
      if (eml) {
        fallbackReads++;
        try {
          const head = readEmlHeader(eml, 16 * 1024);
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
// IPC（全部经 handleTrusted 中央校验，ELEC-01）
// ---------------------------------------------------------------------------

handleTrusted('mfh:get-summary', (_event, payload: unknown) => appSummary(asSummaryOptions(payload)));

handleTrusted('mfh:get-op-state', () => sanitizeOpState(coordinator.state()));

/**
 * About 页的版本与发布通道（COPY-07B）。全部由运行时真实数据推导：`app.getVersion()`
 * 取的是安装包/package.json 的版本，channel 由「是否已打包」和版本号里的预发布
 * 标识判定，不再是写死的「本地预览版 / v0.1.0」。
 */
handleTrusted('mfh:get-app-info', () => {
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

handleTrusted('mfh:get-config', () => {
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

handleTrusted('mfh:save-config', (_event, payload: unknown) => {
  // ELEC-02：配置写入与 CLI 任务互斥，避免运行中改写 paths/ocr 造成交错。
  const begin = coordinator.begin('pipeline', { silent: true });
  if (!begin.ok) {
    return {
      ok: false,
      configPath: redactPath(configPath),
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

handleTrusted('mfh:start-fetch', async (_event, payload: unknown) => {
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
    // ELEC-08：CLI 一旦返回，操作结果即最终；后续 enrich 失败不得伪装成「本地数据没有变化」。
    const status = deriveRunStatus({
      code: result.code,
      started: result.started,
      succeeded: result.code === 0 ? 1 : 0,
      failed: result.code === 0 ? 0 : 1,
    });
    const ok = status === 'success';
    const message = ok
      ? (range.dryRun ? '预览完成。' : '获取邮件完成。')
      : '获取邮件失败，请检查邮箱设置后重试。';
    const historyWarning = recordHistory(
      'fetch',
      range.dryRun ? '预览邮件' : '获取邮件',
      startedAt,
      result,
      status,
      ok ? '已完成' : '运行失败',
    );
    let batch: RunBatch | undefined;
    let enrichWarning: string | undefined;
    if (!range.dryRun) {
      try {
        batch = batchFromHashes(result.mails.saved);
      } catch {
        enrichWarning = '邮件已保存，但本次列表明细暂时无法展示。请到「邮件记录」查看。';
      }
    }
    const report = reportFor('fetch', gate.lease.jobId, result, { ok: 'fetch_done', failed: 'fetch_failed' }, status);
    const summaryPart = tryAppSummary();
    const warning = [historyWarning, enrichWarning, summaryPart.warning].filter(Boolean).join(' ') || undefined;
    return {
      ok,
      status,
      started: result.started,
      ...report,
      message,
      jobId: gate.lease.jobId,
      normalizedFilter: normalizedFilterFrom(range),
      ...(batch ? { batch } : {}),
      ...(warning ? { warning } : {}),
      ...(summaryPart.summary ? { summary: summaryPart.summary } : {}),
      ...(summaryPart.summaryUnavailable ? { summaryUnavailable: true } : {}),
    };
  } finally {
    gate.lease.release();
  }
});

handleTrusted('mfh:run-pipeline', async (_event, payload: unknown) => {
  const raw = asObject(payload);
  const concurrency = Number(raw.concurrency ?? 4);

  // NEW-DEFECT 3：非空但非法的 onlyMail 必须拒绝，绝不能静默变成全量管线。
  let onlyHash: string | undefined;
  if (raw.onlyMail !== undefined && raw.onlyMail !== null && raw.onlyMail !== '') {
    if (typeof raw.onlyMail !== 'string') {
      return {
        ok: false,
        code: 'invalid_only_mail',
        message: '单封邮件标识无效，请从待确认列表重新选择。',
        normalizedFilter: normalizedFilterFrom(),
        summary: appSummary(),
      };
    }
    onlyHash = parseMailHash(raw.onlyMail);
    if (!onlyHash) {
      return {
        ok: false,
        code: 'invalid_only_mail',
        message: '单封邮件标识无效，请从待确认列表重新选择。',
        normalizedFilter: normalizedFilterFrom(),
        summary: appSummary(),
      };
    }
  }

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
    if (onlyHash) args.push('--only-mail', onlyHash);
    if (raw.force === true) args.push('--force');
    const result = await runCli('run', args, { operation: 'files', jobId: gate.lease.jobId });

    // ELEC-08 / 簇 C：以结构化终态计数为准，不用裸 exit code 单独判定成功。
    const counts = result.runCounts
      ?? parseRunCompleteCounts(`${result.stdout}\n${result.stderr}`)
      ?? emptyRunCounts();
    const mailNotFound = /mail_not_found/.test(`${result.stdout}\n${result.stderr}`)
      || (Boolean(onlyHash) && counts.archived + counts.pending + counts.skipped + counts.failed === 0 && result.code !== 0);
    const status = deriveRunStatus({
      code: result.code,
      started: result.started,
      succeeded: counts.archived + counts.pending + counts.skipped,
      failed: counts.failed + (mailNotFound ? 1 : 0),
      mailNotFound,
    });
    const message = pipelineRunMessage(counts, status, Boolean(onlyHash), mailNotFound);
    // 操作结果在 runCli 返回时即最终；history / batch / summary 均为 best-effort。
    const historyWarning = recordHistory(
      'pipeline',
      onlyHash ? '重新处理单封邮件' : '处理缓存邮件',
      startedAt,
      result,
      status,
      status === 'success' ? '已完成' : status === 'partial' ? '部分完成' : '运行失败',
    );
    let batch: RunBatch = { rows: [], total: counts.archived + counts.pending };
    let enrichWarning: string | undefined;
    try {
      batch = batchFromHashes([...result.mails.processed, ...result.mails.manual]);
    } catch {
      enrichWarning = '邮件已处理，但本次列表明细暂时无法展示。请刷新列表。';
    }
    const report = reportFor(
      'pipeline',
      gate.lease.jobId,
      result,
      { ok: 'pipeline_done', failed: 'pipeline_failed', partial: 'pipeline_partial' },
      status,
    );
    const summaryPart = tryAppSummary();
    const warning = [historyWarning, enrichWarning, summaryPart.warning].filter(Boolean).join(' ') || undefined;
    return {
      ok: status === 'success',
      status,
      started: result.started,
      ...report,
      message,
      counts: {
        archived: counts.archived,
        pending: counts.pending,
        skipped: counts.skipped,
        failed: counts.failed,
        partial: counts.partial,
      },
      jobId: gate.lease.jobId,
      normalizedFilter: normalizedFilterFrom(),
      batch,
      ...(warning ? { warning } : {}),
      ...(summaryPart.summary ? { summary: summaryPart.summary } : {}),
      ...(summaryPart.summaryUnavailable ? { summaryUnavailable: true } : {}),
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

handleTrusted('mfh:run-ocr', async (_event, payload: unknown) => {
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
      try {
        plan?.restore();
      } catch (restoreErr) {
        const error: UiError = {
          code: 'ocr_rerun_restore_failed',
          message: '无法开始识别，且原有识别结果未能自动恢复。请重新打开应用后再试。',
          detail: sanitizeText(restoreErr instanceof Error ? restoreErr.message : String(restoreErr)),
        };
        sendOperationProgress({ operation: 'ocr', phase: '识别失败', percent: 100, ...error, kind: 'err', done: true });
        return { ok: false, ...error, summary: appSummary() };
      }
      const error: UiError = {
        code: 'ocr_config_write_failed',
        // COPY-10：配置写失败不一定是磁盘问题。
        message: '无法开始识别。请稍后重试；若仍失败，请到「设置」检查识别选项。',
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
      ...(pendingTotal > 0 ? { percent: 5, total: pendingTotal } : { total: 0 }),
      processed: 0,
      parsed: 0,
      skipped: 0,
      failed: 0,
      code: 'ocr_start',
      message: `发现 ${pendingTotal} 个待识别文件，正在启动识别。当前并行数：${concurrency}。`,
    });

    const result = await runCli('ocr', args, { operation: 'ocr', initialTotal: pendingTotal, jobId });
    const stopped = ocrStopRequested.has(jobId) || result.code === 130;
    // ELEC-03：`--allow-parse-failures` 可在部分解析失败时仍 exit 0。
    // 只有「已启动 + exit 0 + 未停止 + 输出含 OCR complete 终态」才提交丢弃备份。
    const ocrCompletedCleanly = result.started
      && result.code === 0
      && !stopped
      && /OCR complete:\s*scanned=\d+/.test(`${result.stdout}\n${result.stderr}`);

    if (plan) {
      try {
        if (ocrCompletedCleanly) plan.discard();
        else plan.restore();
      } catch (txErr) {
        const error: UiError = {
          code: 'ocr_rerun_restore_failed',
          message: '识别结束后无法可靠处理备份。请重新打开应用；若识别结果异常，请勿继续操作。',
          detail: sanitizeText(txErr instanceof Error ? txErr.message : String(txErr)),
        };
        return { ok: false, ...error, jobId, summary: appSummary() };
      }
    }

    // ELEC-12：历史状态看结构化 OCR 计数，不把 --allow-parse-failures 的 exit 0 当成全成功。
    const ocrCounts = result.ocrCounts
      ?? parseOcrCompleteCounts(`${result.stdout}\n${result.stderr}`);
    const ocrStatus = stopped
      ? 'failed' as const
      : deriveRunStatus({
        code: result.code,
        started: result.started,
        succeeded: (ocrCounts?.parsed ?? 0) + (ocrCounts?.skipped ?? 0),
        failed: (ocrCounts?.failed ?? 0) + (ocrCompletedCleanly ? 0 : (ocrCounts ? 0 : 1)),
      });
    // 有解析失败时即使 exit 0 也标 partial/failed。
    const statusWithParseFails: RunHistoryEntry['status'] = stopped
      ? 'failed'
      : ocrCounts && ocrCounts.failed > 0 && ocrCounts.parsed > 0
        ? 'partial'
        : ocrCounts && ocrCounts.failed > 0 && ocrCounts.parsed === 0
          ? 'failed'
          : ocrCompletedCleanly
            ? 'success'
            : ocrStatus;
    const historyWarning = recordHistory(
      'ocr',
      raw.force === true ? '开始识别文件' : '识别文件',
      startedAt,
      result,
      statusWithParseFails,
      statusWithParseFails === 'success'
        ? '已完成'
        : statusWithParseFails === 'partial'
          ? '部分完成'
          : stopped
            ? '已停止'
            : '运行失败',
    );
    if (stopped) {
      const summaryPart = tryAppSummary();
      return {
        ok: false,
        status: 'failed' as const,
        started: result.started,
        stopped: true,
        code: 'ocr_stopped',
        exitCode: result.code,
        jobId,
        message: '识别已停止。',
        ...(historyWarning ? { warning: historyWarning } : {}),
        ...(summaryPart.summary ? { summary: summaryPart.summary } : {}),
        ...(summaryPart.summaryUnavailable ? { summaryUnavailable: true } : {}),
        ...(summaryPart.warning && !historyWarning ? { warning: summaryPart.warning } : {}),
      };
    }
    const report = reportFor(
      'ocr',
      jobId,
      result,
      { ok: 'ocr_done', failed: 'ocr_failed', partial: 'ocr_partial' },
      statusWithParseFails,
    );
    const ok = statusWithParseFails === 'success';
    const message = statusWithParseFails === 'success' || statusWithParseFails === 'partial'
      ? ocrRunMessage(result)
      : '无法完成识别。请稍后重试；若仍失败，请到「设置」检查识别选项并查看技术详情。';
    const summaryPart = tryAppSummary();
    const warning = [historyWarning, summaryPart.warning].filter(Boolean).join(' ') || undefined;
    return {
      ok,
      status: statusWithParseFails,
      started: result.started,
      ...report,
      code: statusWithParseFails === 'success'
        ? report.code
        : statusWithParseFails === 'partial'
          ? 'ocr_partial'
          : (result.code === 0 ? 'ocr_incomplete' : report.code),
      jobId,
      message,
      ...(ocrCounts
        ? {
          counts: {
            scanned: ocrCounts.scanned,
            parsed: ocrCounts.parsed,
            skipped: ocrCounts.skipped,
            failed: ocrCounts.failed,
          },
        }
        : {}),
      ...(warning ? { warning } : {}),
      ...(summaryPart.summary ? { summary: summaryPart.summary } : {}),
      ...(summaryPart.summaryUnavailable ? { summaryUnavailable: true } : {}),
    };
  } finally {
    // 临时 run config 是明文；无论正常结束还是异常路径都必须删除。
    if (ocrTemp) removeTempDir(ocrTemp.dir);
    ocrStopRequested.delete(jobId);
    ocrProcesses.delete(jobId);
    gate.lease.release();
  }
});

handleTrusted('mfh:organize', async (_event, payload: unknown) => {
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
    const status = deriveRunStatus({
      code: result.code,
      started: result.started,
      succeeded: result.code === 0 ? 1 : 0,
      failed: result.code === 0 ? 0 : 1,
    });
    const historyWarning = recordHistory(
      'organize',
      applyRename ? '一键改名整理' : '整理输出文件',
      startedAt,
      result,
      status,
    );
    const output = `${result.stdout}\n${result.stderr}`;
    const scannedMatch = /Organize complete: scanned=(\d+)/.exec(output);
    const scanned = scannedMatch ? Number(scannedMatch[1]) : NaN;
    const baseLabel = applyRename ? '改名' : '整理';
    const message = status !== 'success'
      ? `${baseLabel}没有完成，请查看诊断信息了解详情。`
      : Number.isFinite(scanned) && scanned === 0
        ? '目前没有可整理的识别结果。请先抓取邮件并完成识别后再试。'
        : Number.isFinite(scanned)
          ? `${baseLabel}完成，处理 ${scanned} 条识别结果。`
          : `${baseLabel}完成。`;
    const report = reportFor(
      'organize',
      gate.lease.jobId,
      result,
      { ok: 'organize_done', failed: 'organize_failed' },
      status,
    );
    const summaryPart = tryAppSummary();
    const warning = [historyWarning, summaryPart.warning].filter(Boolean).join(' ') || undefined;
    return {
      ok: status === 'success',
      status,
      started: result.started,
      ...report,
      jobId: gate.lease.jobId,
      message,
      ...(Number.isFinite(scanned) ? { scanned } : {}),
      ...(warning ? { warning } : {}),
      ...(summaryPart.summary ? { summary: summaryPart.summary } : {}),
      ...(summaryPart.summaryUnavailable ? { summaryUnavailable: true } : {}),
    };
  } finally {
    gate.lease.release();
  }
});

handleTrusted('mfh:stop-ocr', () => {
  if (ocrProcesses.size === 0) return { ok: false, code: 'ocr_not_running', message: '当前没有正在运行的识别任务。' };
  const details: string[] = [];
  let treeIncomplete = false;
  for (const [jobId, child] of ocrProcesses) {
    ocrStopRequested.add(jobId);
    // Windows 上必须终止整棵进程树，否则 efapiao serve 会继续占用端口（APP-16）。
    const outcome = killProcessTree(child);
    if (!outcome.treeSignalled) treeIncomplete = true;
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

/**
 * ELEC-06：解析 open-path 目标。
 *
 * 允许根由主进程从磁盘配置自行计算（dataDir + paths.invoices/pending/samples +
 * 输出 CSV 父目录 + 主进程签发的 opaque `ext:…` 句柄），**绝不**采信 IPC payload
 * 里的额外 root。两侧路径用同一套 resolveCanonicalPath 后再做路径段 containment。
 * 规范化失败一律拒绝（fail closed）。
 */
function resolveOpenTarget(target: string): { ok: true; path: string } | { ok: false; code: string; message: string } {
  if (!target || target.includes('<') || target.includes('>') || target.includes('\0')) {
    return { ok: false, code: 'path_invalid', message: '路径无效。' };
  }
  // 主进程签发的 opaque 外部句柄（renderer 不可伪造路径）
  if (target.startsWith('ext:')) {
    const external = resolveExternalFileHandle(target);
    if (!external) {
      return { ok: false, code: 'path_handle_unknown', message: '文件引用已失效，请刷新列表后重试。' };
    }
    const canon = resolveCanonicalPath(external);
    if (!canon) {
      return { ok: false, code: 'path_canonicalization_failed', message: '无法确认文件位置，已拒绝打开。' };
    }
    return { ok: true, path: canon };
  }

  const allowed = openPathAllowedRoots();
  if (allowed.length === 0) {
    return { ok: false, code: 'path_canonicalization_failed', message: '无法确认数据目录，已拒绝打开。' };
  }

  // 相对路径锚定到 dataDir（若 dataDir 规范化失败则用模块级 dataDir 词法路径）
  const base = realDataDir() ?? dataDir;
  const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(base, target);
  const canon = resolveCanonicalPath(abs);
  if (!canon) {
    return { ok: false, code: 'path_canonicalization_failed', message: '无法确认文件位置，已拒绝打开。' };
  }

  // 目标与每一个允许根都已经过同一套 canonical 化；用路径段前缀比较。
  for (const root of allowed) {
    if (isPathSegmentInside(canon, root)) {
      return { ok: true, path: canon };
    }
  }
  return { ok: false, code: 'path_outside_data_dir', message: '路径不在允许的目录范围内。' };
}

handleTrusted('mfh:open-path', async (_event, payload: unknown) => {
  const raw = asObject(payload);
  const target = typeof raw.path === 'string' ? raw.path : '.';
  const resolved = resolveOpenTarget(target);
  if (!resolved.ok) {
    return { ok: false, code: resolved.code, error: resolved.message, message: resolved.message };
  }
  if (raw.reveal === true) {
    if (!fs.existsSync(resolved.path)) {
      return {
        ok: false,
        code: 'path_missing',
        error: '文件已不存在，可能被移动或删除。请重新归档。',
        message: '文件已不存在，可能被移动或删除。请重新归档。',
      };
    }
    showItemInFolderForUser(resolved.path);
    return { ok: true, error: '' };
  }
  const error = await openPathForUser(resolved.path);
  return {
    ok: !error,
    error: error ? sanitizeText(error, { maxLength: 200 }) : '',
    ...(error ? { code: 'path_open_failed', message: '无法打开该文件，请确认它仍然存在且有对应的应用程序。' } : {}),
  };
});

handleTrusted('mfh:copy-text', (_event, payload: unknown) => {
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

handleTrusted('mfh:test-connection', async (_event, payload: unknown) => {
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

handleTrusted('mfh:list-mailboxes', async (_event, payload: unknown) => {
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

handleTrusted('mfh:pending-ignore', (_event, payload: unknown) => {
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

handleTrusted('mfh:pending-refresh-link', async (_event, payload: unknown) => {
  const raw = asObject(payload);
  const hash = parseMailHash(raw.hash);
  if (!hash) return { ok: false, code: 'pending_missing_hash', message: '缺少邮件标识。' };
  const row = findPendingRow(hash);
  const emlPath = pendingEmlPathForHash(hash);
  // ELEC-06：与 open-path 相同 containment；禁止直接 shell.openPath 绕过校验。
  if (emlPath && fs.existsSync(emlPath)) {
    const opened = resolveOpenTarget(emlPath);
    if (!opened.ok) {
      // 尝试 dataDir 相对路径
      const base = realDataDir();
      const rel = base ? path.relative(base, emlPath) : emlPath;
      const openedRel = resolveOpenTarget(rel);
      if (!openedRel.ok) {
        return { ok: false, code: openedRel.code, message: openedRel.message };
      }
      const error = await openPathForUser(openedRel.path);
      if (!error) {
        return {
          ok: true,
          opened: 'mail' as const,
          code: 'pending_mail_opened',
          message: '已打开原始邮件。请到开票平台重新下载发票，然后回到这里选择文件归档。',
        };
      }
      showItemInFolderForUser(openedRel.path);
      return {
        ok: true,
        opened: 'mail' as const,
        code: 'pending_mail_revealed',
        message: '已在文件管理器中定位原始邮件。请打开后到开票平台重新下载发票，再回来选择文件归档。',
      };
    }
    const error = await openPathForUser(opened.path);
    if (!error) {
      return {
        ok: true,
        opened: 'mail' as const,
        code: 'pending_mail_opened',
        message: '已打开原始邮件。请到开票平台重新下载发票，然后回到这里选择文件归档。',
      };
    }
    showItemInFolderForUser(opened.path);
    return {
      ok: true,
      opened: 'mail' as const,
      code: 'pending_mail_revealed',
      message: '已在文件管理器中定位原始邮件。请打开后到开票平台重新下载发票，再回来选择文件归档。',
    };
  }
  // 回退：打开邮件缓存目录。与 open-path 共用 resolveOpenTarget（含用户配置的
  // samples 根，不要求必须在 dataDir 内），禁止直接 shell.openPath 绕过。
  const fallback = resolveOpenTarget(samplesDirPath());
  if (!fallback.ok) {
    return {
      ok: false,
      opened: 'none' as const,
      code: row ? 'pending_mail_missing_local_copy' : 'pending_row_not_found',
      message: row
        ? '没有找到这封邮件的本地副本，且无法打开邮件缓存文件夹。'
        : '没有找到这封邮件。',
    };
  }
  const error = await openPathForUser(fallback.path);
  if (error) {
    return {
      ok: false,
      opened: 'none' as const,
      code: row ? 'pending_mail_missing_local_copy' : 'pending_row_not_found',
      message: row ? '没有找到这封邮件的本地副本。' : '没有找到这封邮件。',
      error: sanitizeText(error, { maxLength: 200 }),
    };
  }
  // COPY-05：打开的是文件夹，不是原始邮件本身。
  return {
    ok: true,
    opened: 'folder' as const,
    code: row ? 'pending_mail_folder_opened' : 'pending_row_not_found',
    message: row
      ? '没有找到原始邮件文件，已打开已保存邮件文件夹，请手动查找后再到开票平台重新下载。'
      : '没有找到这封邮件，已打开已保存邮件文件夹。',
  };
});

handleTrusted('mfh:pending-manual-archive', async (event, payload: unknown) => {
  const raw = asObject(payload);
  const hash = parseMailHash(raw.hash);
  if (!hash) return { ok: false, code: 'pending_missing_hash', message: '缺少邮件标识。', canceled: false };

  const testSources = !app.isPackaged && process.env.MFH_TEST_MANUAL_ARCHIVE_SOURCES
    ? process.env.MFH_TEST_MANUAL_ARCHIVE_SOURCES.split(path.delimiter).filter(Boolean)
    : undefined;
  const dialogOpts = {
    title: '选择要归档的发票文件',
    properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
    filters: [
      // 不提供 zip：压缩包无法直接归档也无法识别，旧实现会把任意 PK 容器当成 OFD
      // 塞进队列。用户仍可用「全部文件」选到压缩包，此时 runManualArchive 会明确拒绝。
      { name: '发票文件', extensions: ['pdf', 'ofd', 'png', 'jpg', 'jpeg'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  };
  const dialogResult = testSources
    ? { canceled: false, filePaths: testSources }
    : mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, dialogOpts)
      : await dialog.showOpenDialog(dialogOpts);
  // ELEC-01：await dialog 后重新校验 sender。
  if (!assertTrustedSender(event)) {
    return { ok: false, code: 'untrusted_sender', message: '无权执行归档。', canceled: false };
  }
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
      // COPY-18：文件已存在 / 全部重复不是「归档失败」，用专用 code 与文案。
      const isDup = result.code === 'manual_archive_all_duplicates';
      const summaryPart = tryAppSummary();
      return {
        ok: false,
        canceled: false,
        code: result.code ?? 'manual_archive_failed',
        message: result.message
          ?? (isDup ? '选择的文件都已经归档过了，没有新增内容。' : '文件没有归档成功，待确认记录保持不变。'),
        ...(result.detail ? { detail: result.detail } : {}),
        files: [],
        duplicates: result.duplicates,
        pendingRemoved: result.pendingRemoved ?? 0,
        ...(summaryPart.summary ? { summary: summaryPart.summary } : {}),
        ...(summaryPart.summaryUnavailable ? { summaryUnavailable: true } : {}),
      };
    }

    const pendingRemoved = result.pendingRemoved ?? 0;
    const skipped = result.duplicates.length > 0 ? `，跳过 ${result.duplicates.length} 个已归档文件` : '';
    // COPY-04：明确区分「记录是否已从待确认移除」。
    let message: string;
    if (result.message) {
      message = result.message;
    } else if (pendingRemoved > 0) {
      message = `文件已保存，并已从「待确认」移除${skipped}。`;
    } else {
      message = `文件已保存，并会在下次识别时处理；但这封邮件仍在「待确认」中${skipped}。请刷新列表后重试移除。`;
    }
    const summaryPart = tryAppSummary();
    return {
      ok: true,
      canceled: false,
      code: result.code
        ?? (pendingRemoved > 0 ? 'manual_archive_done' : 'manual_archive_pending_not_updated'),
      message,
      files: result.files.map((file) => file.filename),
      duplicates: result.duplicates,
      pendingRemoved,
      ...(summaryPart.summary ? { summary: summaryPart.summary } : {}),
      ...(summaryPart.summaryUnavailable ? { summaryUnavailable: true } : {}),
      ...(summaryPart.warning ? { warning: summaryPart.warning } : {}),
    };
  } finally {
    gate.lease.release();
  }
});

/**
 * 数据目录是否可证明为可丢弃的测试存储（E2E）。
 * 仅当未打包且数据目录位于系统临时目录下时，才允许跳过确认对话框。
 */
function isDisposableTestStorage(): boolean {
  if (app.isPackaged) return false;
  if (process.env.MFH_E2E_ALLOW_DESTRUCTIVE === '1' && process.env.MFH_DATA_DIR) {
    const base = realDataDir();
    if (!base) return false;
    try {
      const tmp = fs.realpathSync(os.tmpdir());
      return isCanonicallyInside(base, tmp);
    } catch {
      return false;
    }
  }
  if (!e2eNoGuiMode() || !process.env.MFH_DATA_DIR) return false;
  const base = realDataDir();
  if (!base) return false;
  try {
    const tmp = fs.realpathSync(os.tmpdir());
    return isCanonicallyInside(base, tmp);
  } catch {
    return false;
  }
}

/**
 * 清空 `.mfh-cache` 的内容，但**保留**当前持有的数据目录锁与 recovery 相关文件
 * （NEW-DEFECT 1 / ELEC-02），避免 reset 过程中其它实例抢锁并发写。
 */
function clearMfhCachePreservingLocks(): { removed: boolean; detail?: string } {
  const cacheDir = path.join(dataDir, '.mfh-cache');
  const lockPath = dataDirLockPath(dataDir);
  const preserveNames = new Set<string>();
  try {
    const lockReal = resolveCanonicalPath(lockPath);
    if (lockReal) preserveNames.add(path.basename(lockReal));
  } catch {
    preserveNames.add(path.basename(lockPath));
  }
  // recovery mutex、墓碑、心跳临时文件都带锁文件名前缀。
  const lockBase = path.basename(lockPath);
  try {
    if (!fs.existsSync(cacheDir)) return { removed: false };
    for (const entry of fs.readdirSync(cacheDir, { withFileTypes: true })) {
      const name = entry.name;
      if (
        name === lockBase
        || name.startsWith(`${lockBase}.`)
        || name === `${lockBase}.recovery`
        || name.startsWith(`${lockBase}.stale-`)
        || name.startsWith(`${lockBase}.new-`)
        || name.startsWith(`${lockBase}.rw-`)
      ) {
        continue;
      }
      const full = path.join(cacheDir, name);
      const safe = assertSafeToDeleteInsideDataDir(full);
      if (!safe) continue;
      try {
        fs.rmSync(safe, { recursive: true, force: true });
      } catch {
        // best-effort per entry
      }
    }
    return { removed: true };
  } catch (err) {
    return {
      removed: false,
      detail: sanitizeText(err instanceof Error ? err.message : String(err), { maxLength: 200 }),
    };
  }
}

interface ResetDeletionPlan {
  items: { label: string; target: string; relative: string }[];
  skippedExternal: string[];
  dataDirReal: string;
  configPathReal: string | undefined;
}

/**
 * 在持锁后冻结不可变的规范删除计划（ELEC-01 rework 2）。
 * 路径全部 canonical；不在真实 dataDir 内的跳过。
 */
function freezeResetDeletionPlan(): ResetDeletionPlan | { error: UiError } {
  const dataDirReal = realDataDir();
  if (!dataDirReal) {
    return {
      error: {
        code: 'reset_data_dir_unresolvable',
        message: '无法确认数据目录的真实位置，已取消重置以保护文件。',
      },
    };
  }
  const configPathReal = resolveCanonicalPath(configPath);
  const cfg = readConfigForPaths();
  const paths = asObject(cfg.paths);
  const output = asObject(cfg.output);
  const ocr = asObject(cfg.ocr);
  const rename = asObject(cfg.rename);
  const candidates: { label: string; value: unknown; special?: 'mfh-cache' }[] = [
    { label: '邮件缓存', value: paths.samples },
    { label: '归档发票', value: paths.invoices },
    { label: '待确认队列', value: paths.pending },
    { label: '归档台账', value: output.csv },
    { label: '识别结果', value: ocr.resultsCsv },
    { label: '整理输出目录', value: rename.organizedDir },
    { label: '运行状态', value: statePath },
    { label: '运行记录', value: historyPath(dataDir) },
    { label: '应用缓存', value: '.mfh-cache', special: 'mfh-cache' },
  ];
  const items: ResetDeletionPlan['items'] = [];
  const skippedExternal: string[] = [];
  for (const candidate of candidates) {
    const value = candidate.value;
    if (typeof value !== 'string' || value.length === 0) continue;
    const target = path.resolve(dataDir, value);
    const canon = resolveCanonicalPath(target);
    if (!canon) {
      skippedExternal.push(`${candidate.label}：无法确认路径，已跳过`);
      continue;
    }
    if (canon === dataDirReal) continue;
    if (configPathReal && canon === configPathReal) continue;
    if (!isCanonicallyInside(canon, dataDirReal)) {
      if (fs.existsSync(canon)) skippedExternal.push(`${candidate.label}：${redactPath(canon)}`);
      continue;
    }
    // mfh-cache 特殊处理：删除时保留锁文件，用 relative 标记。
    items.push({
      label: candidate.label,
      target: candidate.special === 'mfh-cache' ? '__mfh_cache_preserve_lock__' : canon,
      relative: path.relative(dataDirReal, canon) || candidate.label,
    });
  }
  return { items, skippedExternal, dataDirReal, configPathReal };
}

/**
 * ELEC-01：破坏性 reset 的授权在**主进程**用原生对话框完成。
 * - 先占锁并冻结删除计划，再弹确认（防止对话框期间 config IPC 改路径）
 * - 确认后重新校验 sender 与计划
 * - 删除使用 realpath containment
 * - no-GUI 仅在可丢弃测试存储上跳过确认
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
      running: running ? { kind: running.kind, jobId: running.jobId, startedAt: running.startedAt } : null,
      removed: [],
      skippedExternal: [],
      summary: appSummary(),
    };
  }

  // MUST-REWORK 2：先占锁并冻结计划，再弹确认。
  const gate = acquireOperation('pipeline');
  if (!gate.ok) {
    return { ...gate.response, removed: [], skippedExternal: [] };
  }

  try {
    const frozen = freezeResetDeletionPlan();
    if ('error' in frozen) {
      return { ok: false, ...frozen.error, removed: [], skippedExternal: [] };
    }
    const planSnapshot = JSON.stringify(frozen.items.map((i) => i.target).sort());

    const skipConfirm = isDisposableTestStorage();
    if (!skipConfirm) {
      if (e2eNoGuiMode()) {
        return {
          ok: false,
          code: 'reset_confirmation_required',
          message: '无界面模式下拒绝清空数据：当前数据目录不是可证明的临时测试目录。',
          removed: [],
          skippedExternal: [],
        };
      }
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
      // 对话框后重新校验 sender（ELEC-01）。
      if (!assertTrustedSender(event)) {
        return { ok: false, code: 'untrusted_sender', message: '无权执行重置。', removed: [], skippedExternal: [] };
      }
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
      if (!assertTrustedSender(event)) {
        return { ok: false, code: 'untrusted_sender', message: '无权执行重置。', removed: [], skippedExternal: [] };
      }
      if (second.response !== 1) {
        return { ok: false, code: 'reset_cancelled', message: '已取消重置。', removed: [], skippedExternal: [] };
      }
    }

    // 对话框期间 config 可能被改：重新冻结并与快照比对。
    const revalidated = freezeResetDeletionPlan();
    if ('error' in revalidated) {
      return { ok: false, ...revalidated.error, removed: [], skippedExternal: [] };
    }
    const planNow = JSON.stringify(revalidated.items.map((i) => i.target).sort());
    if (planNow !== planSnapshot) {
      return {
        ok: false,
        code: 'reset_plan_changed',
        message: '等待确认期间保存位置发生了变化，已取消重置以保护文件。请重新操作。',
        removed: [],
        skippedExternal: [],
      };
    }

    const removed: string[] = [];
    const skippedExternal = [...revalidated.skippedExternal];
    for (const item of revalidated.items) {
      if (item.target === '__mfh_cache_preserve_lock__') {
        const cleared = clearMfhCachePreservingLocks();
        if (cleared.removed) removed.push(item.relative);
        else if (cleared.detail) skippedExternal.push(`${item.label}：清理失败`);
        continue;
      }
      const safe = assertSafeToDeleteInsideDataDir(item.target);
      if (!safe) {
        skippedExternal.push(`${item.label}：路径校验失败，已跳过`);
        continue;
      }
      // 再次确认仍在冻结的 dataDir 内。
      if (!isCanonicallyInside(safe, revalidated.dataDirReal)) {
        skippedExternal.push(`${item.label}：${redactPath(safe)}`);
        continue;
      }
      try {
        fs.rmSync(safe, { recursive: true, force: true });
        removed.push(item.relative);
      } catch {
        skippedExternal.push(`${item.label}：删除失败，请手动清理`);
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

handleTrusted('mfh:developer-reset', async (event) => performDeveloperReset(event));

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
  sendToRenderer('op-state', sanitizeOpState(payload) as unknown as Record<string, unknown>);
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
  try {
    recoverOcrRerunJournals();
  } catch {
    // OCR 重跑 journal 恢复失败时保留现场，写入前 ensure 会再处理。
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
    // ELEC-04 / NEW-DEFECT 4：remaining>0 **或** treeIncomplete 都必须保留锁。
    // 树级信号失败时孙进程（efapiao serve）可能仍存活，即使直接子进程已退出。
    if (summary.remaining > 0 || summary.treeIncomplete) {
      preserveDataDirLockOnExit = true;
      try {
        if (!e2eNoGuiMode()) {
          const detail = summary.remaining > 0
            ? `仍有 ${summary.remaining} 个后台进程未退出。`
            : '后台进程树可能未完全终止。';
          dialog.showErrorBox(
            '无法完全停止后台任务',
            `${detail}为保护数据，本次不会释放数据目录锁。请稍后重新打开应用。`,
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
