import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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

/**
 * state.json 的**内容**已损坏（不是合法 JSON、不是对象、字段类型不对）。
 *
 * 只有这一类错误才允许隔离备份；`EACCES` / `EIO` 这类 I/O 故障必须原样上报，
 * 否则会把一个内容完全有效的状态文件改名搬走（APP-18A）。
 */
export class StateCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateCorruptionError';
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

/**
 * 确保目录存在，并且**只对本次新建的目录**收紧到 0700（APP-22）。
 *
 * 用户可能把 `--state`、缓存或 INDEX 指向一个既有的共享/组目录；无条件 chmod 会在
 * 后台移走其他用户和组的访问权限。`mkdirSync(recursive)` 返回本次创建的最外层目录，
 * 从它到目标目录这一段才是我们新建的，其余一律不碰（与 download/downloader.ts 的
 * 同名实现保持同一规则）。
 */
export function ensureSecureDir(dir: string): void {
  const firstCreated = mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (isWindows || firstCreated === undefined) return;
  const target = resolve(dir);
  const created = resolve(firstCreated);
  // 从最外层新建目录逐级向下收紧，直到目标目录本身。
  let current = target;
  for (;;) {
    try {
      chmodSync(current, 0o700);
    } catch {
      // 新建目录理论上属于当前用户；失败也不应中断业务流程。
    }
    if (current === created) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
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

/**
 * 严格校验一个哈希数组字段：必须存在、必须是数组、每一项都必须是字符串。
 * 不符合就是内容损坏（要备份），而不是静默转成空数组——静默转空会让下一次保存
 * 在没有任何备份的情况下覆盖掉原状态（APP-18A）。
 */
function requireHashArray(value: unknown, path: string, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new StateCorruptionError(`state at ${path}: ${field} must be an array of strings`);
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'string') {
      throw new StateCorruptionError(`state at ${path}: ${field}[${i}] must be a string`);
    }
  }
  return value as string[];
}

export function loadState(path: string): State {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    // 文件不存在＝还没有状态，属于正常起点；其余 I/O 错误（EACCES/EIO/EISDIR…）
    // 必须原样上报，绝不能被当成 corruption 而把有效文件改名搬走。
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { processedHashes: [], fetchedHashes: [] };
    }
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new StateCorruptionError(`state at ${path} is not valid JSON: ${(e as Error).message}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new StateCorruptionError(`state at ${path} must be a JSON object`);
  }
  const r = raw as Record<string, unknown>;
  return {
    processedHashes: requireHashArray(r.processedHashes, path, 'processedHashes'),
    fetchedHashes: requireHashArray(r.fetchedHashes, path, 'fetchedHashes'),
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
 * 当前进程里所有打开着的 state store。信号退出路径（SIGINT/SIGTERM 等）拿不到命令
 * 内部的局部变量，必须靠这个注册表在 `process.exit()` 之前把未达阈值的增量刷盘，
 * 否则有界 checkpoint 会丢掉「每封邮件落盘」的崩溃安全语义（CODE-07）。
 */
const activeStores = new Set<StateStore>();

/**
 * 同步刷新所有活动 store。用于信号处理器与 `process.on('exit')`：这里不能抛异常，
 * 失败只回报给调用方去打日志。返回未能落盘的错误列表。
 */
export function flushActiveStates(): Error[] {
  const errors: Error[] = [];
  for (const store of activeStores) {
    try {
      store.flush();
    } catch (e) {
      errors.push(e as Error);
    }
  }
  return errors;
}

/**
 * Set 支撑的状态存储（CODE-07）。
 *
 * - 成员判定用 `Set`，取代旧代码里对完整数组的线性 `includes`；
 * - 写盘采用有界批量 checkpoint（条数或时间任一达到阈值），命令结束、致命错误
 *   与信号退出时必须显式 `flush()`（信号路径见 `flushActiveStates()`）；
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
   * 打开状态文件。**内容损坏**时不再直接抛错阻断 fetch/run，而是隔离备份并以空状态
   * 继续（调用方随后可以用 `replaceAll()` 写入重建结果）；权限/瞬时 I/O 错误则原样
   * 抛出，绝不隔离一个内容其实有效的文件（APP-18A）。
   */
  static open(path: string, options: StateStoreOptions = {}): StateStore {
    let state: State;
    try {
      state = loadState(path);
    } catch (e) {
      if (!(e instanceof StateCorruptionError)) throw e;
      const quarantine = quarantineCorruptState(path, e.message);
      const store = new StateStore(path, { processedHashes: [], fetchedHashes: [] }, options, quarantine);
      activeStores.add(store);
      return store;
    }
    const store = new StateStore(path, state, options, undefined);
    activeStores.add(store);
    return store;
  }

  /**
   * CORE-06：只读打开。内容损坏时**绝不** quarantine / 重写磁盘，只报告原因；
   * 供 `--dry-run` 使用（帮助文案承诺「Do not write files」）。
   */
  static openReadOnly(path: string, options: StateStoreOptions = {}): StateStore {
    let state: State;
    let quarantine: StateQuarantine | undefined;
    try {
      state = loadState(path);
    } catch (e) {
      if (!(e instanceof StateCorruptionError)) throw e;
      // 不隔离、不重写：返回空内存状态 + 说明，正式运行时才会 quarantine。
      state = { processedHashes: [], fetchedHashes: [] };
      quarantine = {
        backupPath: '',
        message: `状态文件已损坏（${e.message}），--dry-run 不会修改磁盘；正式运行时将隔离并重建。`,
      };
    }
    // 不加入 activeStores：只读路径不应被信号处理器 flush 回写。
    return new StateStore(path, state, options, quarantine);
  }

  hasProcessed(hash: string): boolean {
    return this.processed.has(hash);
  }

  hasFetched(hash: string): boolean {
    return this.fetched.has(hash);
  }

  /** CORE-03：primary / legacy 任一命中即视为已处理。 */
  hasProcessedAny(hashes: readonly string[]): boolean {
    for (const h of hashes) {
      if (h.length > 0 && this.processed.has(h)) return true;
    }
    return false;
  }

  /** CORE-03：primary / legacy 任一命中即视为已抓取。 */
  hasFetchedAny(hashes: readonly string[]): boolean {
    for (const h of hashes) {
      if (h.length > 0 && this.fetched.has(h)) return true;
    }
    return false;
  }

  /**
   * 写入**一条** processed 身份（CORE-03 非对称读写：写 primary，读 aliases）。
   * 调用方应传入 `identity.primary`，禁止把全部别名灌进集合。
   */
  addProcessed(hash: string): void {
    if (hash.length === 0 || this.processed.has(hash)) return;
    this.processed.add(hash);
    this.markChanged();
  }

  /**
   * 写入**一条** fetched 身份（CORE-03 非对称读写：写 primary，读 aliases）。
   * 调用方应传入 `identity.primary`，禁止把全部别名灌进集合。
   */
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

  /** 落盘并从活动注册表移除；命令正常结束时调用。 */
  dispose(): void {
    try {
      this.flush();
    } finally {
      activeStores.delete(this);
    }
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
