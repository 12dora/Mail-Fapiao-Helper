import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface State {
  processedHashes: string[];
  fetchedHashes: string[];
}

/**
 * Thrown when persisting state.json fails. Per the IRON RULE this is one of the
 * only two conditions that must abort the whole run, so callers can distinguish
 * it from ordinary per-email failures and rethrow instead of swallowing.
 */
export class StateWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateWriteError';
  }
}

/** state.json 损坏时的隔离结果（APP-18A）。 */
export interface StateQuarantine {
  /** 损坏文件被移动到的带时间戳备份路径。 */
  backupPath: string;
  /** 面向用户的中文说明。 */
  message: string;
}

const isWindows = process.platform === 'win32';

/** POSIX 上把目录收紧到 0700；Windows 上跳过且不报错（APP-22）。 */
export function ensureSecureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (isWindows) return;
  try {
    chmodSync(dir, 0o700);
  } catch {
    // 目录可能由其他用户创建；权限收紧失败不应中断业务流程。
  }
}

/** POSIX 上把敏感文件收紧到 0600；Windows 上跳过且不报错（APP-22）。 */
export function secureFileMode(file: string): void {
  if (isWindows) return;
  try {
    chmodSync(file, 0o600);
  } catch {
    // 同上：best-effort。
  }
}

/**
 * 唯一临时文件名。固定的 `<path>.tmp` 在多进程/多实例并发写同一数据目录时会互相
 * 覆盖（APP-05 / APP-22），因此每次写入都用进程号 + 随机后缀。
 */
export function uniqueTempPath(target: string): string {
  return `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
}

export function loadState(path: string): State {
  if (!existsSync(path)) {
    return { processedHashes: [], fetchedHashes: [] };
  }
  const text = readFileSync(path, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`state at ${path} is not valid JSON: ${(e as Error).message}`);
  }
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`state at ${path} must be a JSON object`);
  }
  const r = raw as Record<string, unknown>;
  const processed = r.processedHashes;
  const fetched = r.fetchedHashes;
  return {
    processedHashes: Array.isArray(processed) ? processed.filter((x): x is string => typeof x === 'string') : [],
    fetchedHashes: Array.isArray(fetched) ? fetched.filter((x): x is string => typeof x === 'string') : [],
  };
}

export function saveState(path: string, state: State): void {
  const tmp = uniqueTempPath(path);
  try {
    ensureSecureDir(dirname(path));
    writeFileSync(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
    secureFileMode(path);
  } catch (e) {
    throw new StateWriteError(`failed to persist state at ${path}: ${(e as Error).message}`);
  }
}

/**
 * 把损坏的 state.json 移到带时间戳的备份文件，让后续流程可以从空状态继续，
 * 而不是每次重试都被同一个派生文件永久阻断（APP-18A）。
 */
export function quarantineCorruptState(path: string, reason: string): StateQuarantine {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${path}.corrupt-${stamp}.bak`;
  try {
    renameSync(path, backupPath);
  } catch (e) {
    throw new StateWriteError(
      `状态文件 ${path} 已损坏且无法隔离备份：${(e as Error).message}。请手动删除或修复该文件后重试。`,
    );
  }
  return {
    backupPath,
    message: `状态文件已损坏（${reason}），原文件已备份到 ${backupPath}，本次将从可恢复的身份重建状态。`,
  };
}

export interface StateStoreOptions {
  /** 累计多少条新增后落盘一次；默认 50。 */
  batchSize?: number;
  /** 距上次落盘超过多少毫秒后落盘一次；默认 2000。 */
  intervalMs?: number;
}

/**
 * Set 支撑的状态存储（CODE-07）。
 *
 * - 成员判定用 `Set`，取代旧代码里对完整数组的线性 `includes`；
 * - 写盘采用有界批量 checkpoint（条数或时间任一达到阈值），命令结束或致命错误
 *   时必须显式 `flush()`；
 * - 写盘失败仍抛 `StateWriteError`，保持 IRON RULE 语义不变。
 */
export class StateStore {
  private readonly processed: Set<string>;
  private readonly fetched: Set<string>;
  private dirty = false;
  private pendingChanges = 0;
  private lastFlushAt = Date.now();
  private readonly batchSize: number;
  private readonly intervalMs: number;

  private constructor(
    readonly path: string,
    state: State,
    options: StateStoreOptions,
    readonly quarantine: StateQuarantine | undefined,
  ) {
    this.processed = new Set(state.processedHashes);
    this.fetched = new Set(state.fetchedHashes);
    this.batchSize = Math.max(1, options.batchSize ?? 50);
    this.intervalMs = Math.max(0, options.intervalMs ?? 2000);
  }

  /**
   * 打开状态文件。JSON 损坏时不再直接抛错阻断 fetch/run，而是隔离备份并以空状态
   * 继续（调用方随后可以用 `replaceAll()` 写入重建结果）。
   */
  static open(path: string, options: StateStoreOptions = {}): StateStore {
    try {
      return new StateStore(path, loadState(path), options, undefined);
    } catch (e) {
      const quarantine = quarantineCorruptState(path, (e as Error).message);
      return new StateStore(path, { processedHashes: [], fetchedHashes: [] }, options, quarantine);
    }
  }

  hasProcessed(hash: string): boolean {
    return this.processed.has(hash);
  }

  hasFetched(hash: string): boolean {
    return this.fetched.has(hash);
  }

  addProcessed(hash: string): void {
    if (hash.length === 0 || this.processed.has(hash)) return;
    this.processed.add(hash);
    this.markChanged();
  }

  addFetched(hash: string): void {
    if (hash.length === 0 || this.fetched.has(hash)) return;
    this.fetched.add(hash);
    this.markChanged();
  }

  get processedCount(): number {
    return this.processed.size;
  }

  get fetchedCount(): number {
    return this.fetched.size;
  }

  snapshot(): State {
    return {
      processedHashes: Array.from(this.processed),
      fetchedHashes: Array.from(this.fetched),
    };
  }

  /** 用重建结果整体替换状态（`--rebuild-state`），并立即落盘。 */
  replaceAll(state: State): void {
    this.processed.clear();
    this.fetched.clear();
    for (const h of state.processedHashes) if (h.length > 0) this.processed.add(h);
    for (const h of state.fetchedHashes) if (h.length > 0) this.fetched.add(h);
    this.dirty = true;
    this.pendingChanges = 0;
    this.flush();
  }

  private markChanged(): void {
    this.dirty = true;
    this.pendingChanges++;
  }

  /** 达到批量阈值才落盘；未达到阈值时是纯内存操作。 */
  checkpoint(): void {
    if (!this.dirty) return;
    const dueByCount = this.pendingChanges >= this.batchSize;
    const dueByTime = Date.now() - this.lastFlushAt >= this.intervalMs;
    if (!dueByCount && !dueByTime) return;
    this.flush();
  }

  /** 强制落盘（命令结束、致命错误、信号退出时必须调用）。 */
  flush(): void {
    if (!this.dirty) return;
    saveState(this.path, this.snapshot());
    this.dirty = false;
    this.pendingChanges = 0;
    this.lastFlushAt = Date.now();
  }
}

/** 文件存在且非空（APP-11 判定缓存 .eml 是否真的可用）。 */
export function fileExistsNonEmpty(path: string): boolean {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}
