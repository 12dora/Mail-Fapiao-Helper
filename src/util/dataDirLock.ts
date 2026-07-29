import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * 数据目录跨进程锁（APP-05）——**不依赖 Electron** 的共享实现。
 *
 * 协议（GUI 的 `src/electron/opCoordinator.ts` 必须与此完全一致，否则两侧会各锁各的）：
 * - 锁文件路径：`<dataDir>/.mfh-cache/mfh-data.lock`，内容是一行 JSON；
 * - 独占创建：先把完整内容写进唯一临时文件，再 `link()` 到锁路径（原子、且目标已存在
 *   时报 EEXIST）。**不能**用 `open(wx)` 之后再写内容：那会留下一个「文件已存在但还是
 *   空的」窗口，并发读者会把它当成损坏锁抢走，从而出现双持有者（已由并发压测复现）；
 *   不支持硬链接的文件系统退回 `wx`，由 `isStale()` 的宽限期兜底；
 * - payload 字段：`pid` / `host` / `kind` / `jobId` / `startedAt` / `token` /
 *   `heartbeatAt` / `processStartId`；
 * - `token` 是 16 字节随机 hex，是**唯一的所有权凭证**：释放、回收校验、子进程继承
 *   都只认 token，不认 pid；
 * - `processStartId` 是平台进程出生标识，用于区分「PID 仍存活」与「PID 被无关进程
 *   复用」；缺失时退回纯 PID 判定（旧锁兼容）；
 * - 继承租约会做 **handoff**：子进程把 payload 的 pid/processStartId 原子更新为自己，
 *   并接管 heartbeat/release，避免父进程崩溃后锁被误回收（OCR-02）；
 * - 持锁期间每 `HEARTBEAT_INTERVAL_MS` 用「临时文件 + rename」原子刷新 `heartbeatAt`，
 *   刷新前先读回磁盘并校验 token，保留 handoff 写入的字段；
 * - 陈旧判定**绝不使用墙钟超时**：只有「锁文件损坏/读不出」或「同主机且持有者进程
 *   确已死亡/PID 复用」才算陈旧。活着的持有者永远不会被抢锁；跨主机的锁无法证明死亡，
 *   一律视为有效；
 * - 所有 acquire / reclaim 都先持有独立 recovery mutex，消除「rename 搬走新锁」的
 *   空窗（OCR-04）；CAS 恢复失败时保留墓碑，不得静默丢掉别人的锁。
 */

/** 与 opCoordinator 的 `OpKind` 保持完全一致。 */
export type DataOpKind = 'fetch' | 'pipeline' | 'ocr' | 'organize';

export interface DataDirLockPayload {
  pid: number;
  host: string;
  kind: DataOpKind;
  jobId: string;
  startedAt: number;
  /** 所有权凭证；旧协议写的锁没有该字段，读入时为空串。 */
  token: string;
  /** 最近一次心跳刷新时间；旧协议写的锁为 0。 */
  heartbeatAt: number;
  /**
   * 持有者进程出生标识（Linux starttime / macOS lstart / Windows StartTime）。
   * 旧锁为空串；有值时与 pid 一起判定存活，避免 PID 复用误判（OCR-06）。
   */
  processStartId: string;
}

export interface DataDirLease {
  jobId: string;
  /** 本次租约的 token；继承租约时是父进程下发的 token。 */
  token: string;
  /** 锁文件的绝对路径。 */
  lockPath: string;
  /**
   * true 表示锁最初由父进程创建，本进程通过 handoff 接管 ownership。
   * handoff 成功后本进程负责 heartbeat 与 release。
   */
  inherited: boolean;
  /** 磁盘上的锁是否仍然属于本租约。心跳发现被别人接管后会变成 false。 */
  isHeld(): boolean;
  release(): void;
}

export type AcquireDataDirLockResult =
  | { ok: true; lease: DataDirLease }
  | {
    ok: false;
    code: 'data_dir_lock_failed' | 'data_dir_locked_externally';
    message: string;
    holder: DataDirLockPayload | undefined;
  };

/** 父进程下发租约用的环境变量名，Electron 侧 spawn 子进程时必须设置这两个。 */
export const LOCK_TOKEN_ENV = 'MFH_LOCK_TOKEN';
export const LOCK_JOB_ID_ENV = 'MFH_LOCK_JOB_ID';

/** 心跳刷新间隔。 */
const HEARTBEAT_INTERVAL_MS = 30_000;
/** 心跳过期阈值：仅用于 pid 不可用（<=0）这类无法探测存活的旧锁。 */
const HEARTBEAT_STALE_MS = 10 * 60_000;
/** 锁文件内容不可解析时的宽限期：短于它一律当成「别人正在创建」而不是损坏。 */
const CORRUPT_LOCK_GRACE_MS = 10_000;
/** 获取锁的最多重试轮数（每轮可能包含一次 CAS 回收）。 */
const MAX_ACQUIRE_ATTEMPTS = 5;
/** recovery mutex 争用时的短暂退避上限（毫秒）。 */
const RECOVERY_MUTEX_BACKOFF_MS = 30;

const OP_LABEL: Record<DataOpKind, string> = {
  fetch: '获取邮件',
  pipeline: '处理缓存邮件',
  ocr: '识别文件',
  organize: '整理输出文件',
};

export function dataOpLabel(kind: DataOpKind): string {
  return OP_LABEL[kind] ?? '后台任务';
}

const CACHE_DIR_NAME = '.mfh-cache';

/** 锁文件路径，必须与 opCoordinator 完全一致。 */
export function dataDirLockPath(dataDir: string): string {
  return join(resolve(dataDir), CACHE_DIR_NAME, 'mfh-data.lock');
}

/**
 * 把「数据目录内部的某个子目录」归一化回数据目录本身。
 *
 * GUI 跑 OCR 时传的是 `<dataDir>/.mfh-cache/tmp/ocr-<pid>-<rand>/ocr-run-config.json`
 * 这样的最小化临时配置，直接取其父目录会得到临时目录而不是数据目录；这里按
 * `.mfh-cache` 段回溯，保证仍然落在 GUI 用的同一把锁上。
 */
function normalizeToDataDir(dir: string): string {
  const full = resolve(dir);
  const parts = full.split(sep);
  const idx = parts.lastIndexOf(CACHE_DIR_NAME);
  if (idx > 0) return parts.slice(0, idx).join(sep) || sep;
  return full;
}

export interface DataDirHints {
  /** `--state` 的取值（fetch/run/rebuild-state）。 */
  statePath?: string | undefined;
  /** `--config` 的取值（所有命令）。 */
  configPath?: string | undefined;
}

/**
 * CLI 侧的数据目录解析，目标是与 GUI 的 `dataDir` 落在同一个目录上：
 * 1. `MFH_DATA_DIR`（GUI 显式指定数据目录时会随环境变量传给子进程）；
 * 2. `--state` 所在目录（GUI 调 fetch/run 时传 `--state <dataDir>/state.json`）；
 * 3. `--config` 所在目录（GUI 调 organize 时传 `<dataDir>/config.json`；OCR 的临时
 *    配置在 `<dataDir>/.mfh-cache/...` 里，由 normalizeToDataDir 回溯到 dataDir）；
 * 4. 当前工作目录（GUI 用 `cwd: dataDir` 启动 CLI；命令行直接在项目目录里跑时
 *    也正是 `./config.json` / `./state.json` 所在目录）。
 */
export function resolveDataDir(hints: DataDirHints = {}): string {
  const fromEnv = process.env.MFH_DATA_DIR;
  if (fromEnv && fromEnv.length > 0) return resolve(fromEnv);
  if (hints.statePath && hints.statePath.length > 0) {
    return normalizeToDataDir(dirname(resolve(hints.statePath)));
  }
  if (hints.configPath && hints.configPath.length > 0) {
    return normalizeToDataDir(dirname(resolve(hints.configPath)));
  }
  return process.cwd();
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM 表示进程存在但不属于当前用户，仍算存活。
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 读取平台进程出生标识，用于把「PID 存活」与「PID 被无关进程复用」区分开（OCR-06）。
 * 取不到时返回空串，调用方退回纯 PID 判定。
 */
export function readProcessStartId(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) return '';
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // comm 可能含空格/括号：以最后一个 ')' 为界，其后字段从 state 起算。
      const close = stat.lastIndexOf(')');
      if (close < 0) return '';
      const rest = stat.slice(close + 2).split(' ');
      // /proc/pid/stat 字段 22 = starttime → 在 rest 中下标 19。
      const starttime = rest[19];
      return typeof starttime === 'string' && starttime.length > 0 ? starttime : '';
    }
    if (process.platform === 'darwin') {
      const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return out;
    }
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
        ],
        {
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      ).trim();
      return out;
    }
  } catch {
    return '';
  }
  return '';
}

/**
 * 判断记录中的 pid + processStartId 是否仍指向同一进程。
 * - PID 已死 → false
 * - 有 startId 且与当前不符 → PID 复用 → false
 * - 取不到当前 startId 时保守认为仍存活（避免误抢活锁）
 */
export function isSameProcessAlive(pid: number, processStartId: string | undefined): boolean {
  if (!isProcessAlive(pid)) return false;
  if (!processStartId || processStartId.length === 0) return true;
  const current = readProcessStartId(pid);
  // 取不到当前标识时保守：按存活处理，宁可阻塞也不双持有。
  if (!current) return true;
  return current === processStartId;
}

interface LockSnapshot {
  /** 锁文件是否存在（读失败但存在也算 present）。 */
  present: boolean;
  /** 解析成功的 payload；文件损坏时为 undefined。 */
  payload: DataDirLockPayload | undefined;
  /** 原始文本，CAS 回收失败时用来把别人的锁原样放回去。 */
  raw: string | undefined;
}

function parseLockPayload(text: string): DataDirLockPayload | undefined {
  try {
    const raw = JSON.parse(text) as Partial<DataDirLockPayload>;
    if (typeof raw.pid !== 'number' || typeof raw.jobId !== 'string') return undefined;
    return {
      pid: raw.pid,
      host: typeof raw.host === 'string' ? raw.host : '',
      kind: (raw.kind ?? 'fetch') as DataOpKind,
      jobId: raw.jobId,
      startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0,
      token: typeof raw.token === 'string' ? raw.token : '',
      heartbeatAt: typeof raw.heartbeatAt === 'number' ? raw.heartbeatAt : 0,
      processStartId: typeof raw.processStartId === 'string' ? raw.processStartId : '',
    };
  } catch {
    return undefined;
  }
}

function readLockSnapshot(lockPath: string): LockSnapshot {
  let text: string;
  try {
    text = readFileSync(lockPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { present: false, payload: undefined, raw: undefined };
    }
    // 存在但读不了（权限/瞬时 I/O）：当作「有锁且无法判定」，绝不当成没锁。
    return { present: true, payload: undefined, raw: undefined };
  }
  return { present: true, payload: parseLockPayload(text), raw: text };
}

export function readDataDirLock(lockPath: string): DataDirLockPayload | undefined {
  return readLockSnapshot(lockPath).payload;
}

function lockFileAgeMs(lockPath: string): number | undefined {
  try {
    return Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * 陈旧判定。**不使用墙钟超时**：长时间运行的合法任务永远不会被抢锁。
 */
function isStale(lockPath: string, snapshot: LockSnapshot): boolean {
  if (!snapshot.present) return true;
  const holder = snapshot.payload;
  if (!holder) {
    // 文件在但内容读不出/解析不了。可能是另一个仍在用 `wx` + 后写内容的实现刚创建
    // 完还没写入的瞬间（例如尚未升级的 opCoordinator），此时抢锁会造成双持有者。
    // 给一个宽限期：只有长时间保持不可解析才认定为真正损坏。
    const age = lockFileAgeMs(lockPath);
    return age !== undefined && age > CORRUPT_LOCK_GRACE_MS;
  }
  const sameHost = !holder.host || holder.host === hostname();
  // 跨主机（共享目录）无法探测对方进程，绝不回收。
  if (!sameHost) return false;
  if (isSameProcessAlive(holder.pid, holder.processStartId)) return false;
  // 进程确已死亡或 PID 已被复用。pid 本身不可用时再要求心跳也过期，避免误判刚写入的锁。
  if (holder.pid <= 0) {
    const last = holder.heartbeatAt > 0 ? holder.heartbeatAt : holder.startedAt;
    return last <= 0 || Date.now() - last > HEARTBEAT_STALE_MS;
  }
  return true;
}

/** 两次观察到的是否是同一把锁。 */
function sameLock(a: DataDirLockPayload | undefined, b: DataDirLockPayload | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.token.length > 0 || b.token.length > 0) return a.token === b.token;
  return a.pid === b.pid && a.jobId === b.jobId && a.startedAt === b.startedAt;
}

function sameObservedLock(a: LockSnapshot, b: LockSnapshot): boolean {
  if (!a.present || !b.present) return a.present === b.present;
  if (a.payload || b.payload) return sameLock(a.payload, b.payload);
  return a.raw !== undefined && b.raw !== undefined && a.raw === b.raw;
}

/**
 * 继承租约判定：父进程通过 `MFH_LOCK_TOKEN` 下发凭证（见 `leaseEnvForChild()`），
 * 只有环境变量 token 与磁盘锁文件里的 token 一致才算继承。
 *
 * **绝不能**退回「持有者 pid == 自己的父进程 pid」这类判据：父进程异常退出后仍在
 * 工作的子进程不再体现在锁 ownership 里，新实例会回收这把锁并与旧子进程并发写同一
 * 份数据目录。没有凭证就老老实实报「被占用」。
 */
function inheritedFromParent(holder: DataDirLockPayload | undefined): boolean {
  if (!holder) return false;
  if (holder.host && holder.host !== hostname()) return false;
  if (holder.token.length === 0) return false;
  const envToken = process.env[LOCK_TOKEN_ENV];
  return typeof envToken === 'string' && envToken.length > 0 && envToken === holder.token;
}

function busyMessage(holder: DataDirLockPayload | undefined): string {
  if (!holder) return '数据目录正被另一个任务占用，请稍后重试。';
  const label = dataOpLabel(holder.kind);
  return `数据目录正被另一个发票助手实例或命令行任务占用（正在${label}，进程 ${holder.pid}），`
    + '请等待它结束后再试。';
}

/**
 * 独占地把**完整内容**放到锁路径上。
 *
 * 不能直接 `openSync(lockPath,'wx')` 然后再写：那样在 open 与 write 之间锁文件是
 * **空文件**，并发读者会把它解析失败当成「损坏 ⇒ 陈旧」并抢锁，于是出现双持有者
 * （已由并发压测复现）。这里先把内容写进唯一临时文件，再用 `link()` 把它挂到锁路径：
 * `link` 既是原子的，也在目标已存在时报 EEXIST，因此读者只可能看到完整内容。
 * 某些文件系统不支持硬链接，此时退回 `wx` 路径，并由 `isStale()` 的宽限期兜底。
 */
function createLockExclusive(lockPath: string, text: string, token: string): 'ok' | 'exists' | 'error' {
  const staging = `${lockPath}.new-${token}`;
  try {
    writeFileSync(staging, text, { encoding: 'utf8', mode: 0o600 });
  } catch {
    return 'error';
  }
  try {
    linkSync(staging, lockPath);
    return 'ok';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return 'exists';
    // 文件系统不支持 link（EPERM/ENOSYS/EXDEV/EOPNOTSUPP…）：退回 wx。
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try {
        writeFileSync(fd, text);
      } finally {
        closeSync(fd);
      }
      return 'ok';
    } catch (fallbackErr) {
      return (fallbackErr as NodeJS.ErrnoException).code === 'EEXIST' ? 'exists' : 'error';
    }
  } finally {
    try {
      rmSync(staging, { force: true });
    } catch {
      // best-effort
    }
  }
}

function writeLockExclusive(lockPath: string, payload: DataDirLockPayload): 'ok' | 'exists' | 'error' {
  return createLockExclusive(lockPath, `${JSON.stringify(payload)}\n`, payload.token);
}

/**
 * recovery mutex payload：持有者进程身份 + token，崩溃后可按 PID/startId 回收（OCR-04）。
 * 若 mutex 只有 token/时间戳、没有进程身份，崩溃会永久卡死数据目录——比原 bug 更糟。
 */
interface RecoveryMutexPayload {
  token: string;
  pid: number;
  processStartId: string;
  startedAt: number;
}

function recoveryMutexPath(lockPath: string): string {
  return `${lockPath}.recovery`;
}

function parseRecoveryMutex(text: string): RecoveryMutexPayload | undefined {
  try {
    const raw = JSON.parse(text.trim()) as Partial<RecoveryMutexPayload>;
    if (typeof raw.token !== 'string' || raw.token.length === 0) return undefined;
    if (typeof raw.pid !== 'number' || !Number.isInteger(raw.pid)) return undefined;
    return {
      token: raw.token,
      pid: raw.pid,
      processStartId: typeof raw.processStartId === 'string' ? raw.processStartId : '',
      startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0,
    };
  } catch {
    // 兼容旧格式 `token\ntimestamp\n`：无进程身份，视为陈旧可回收，避免永久死锁。
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines[0] && lines[0].length > 0) {
      return {
        token: lines[0],
        pid: -1,
        processStartId: '',
        startedAt: Number(lines[1]) || 0,
      };
    }
    return undefined;
  }
}

function readRecoveryMutex(lockPath: string): RecoveryMutexPayload | undefined {
  try {
    return parseRecoveryMutex(readFileSync(recoveryMutexPath(lockPath), 'utf8'));
  } catch {
    return undefined;
  }
}

function isRecoveryMutexStale(holder: RecoveryMutexPayload): boolean {
  // 旧格式 / 无效 pid：一律可回收（崩溃遗留的无身份 mutex 不得永久阻塞）。
  if (holder.pid <= 0) return true;
  return !isSameProcessAlive(holder.pid, holder.processStartId);
}

/**
 * 独立 recovery mutex：所有 acquire / reclaim / payload 改写必须先持有它。
 * - 消除「A rename 走 B 的新锁…」双持有者窗口（OCR-04）
 * - 持有者崩溃后按 pid+processStartId 回收，禁止永久死锁（OCR-04 rework）
 * - handoff 与 heartbeat 共享同一临界区，避免父心跳覆盖子 handoff（OCR-02）
 */
function tryAcquireRecoveryMutex(lockPath: string, token: string): boolean {
  const mutexPath = recoveryMutexPath(lockPath);
  const payload: RecoveryMutexPayload = {
    token,
    pid: process.pid,
    processStartId: readProcessStartId(process.pid),
    startedAt: Date.now(),
  };
  const text = `${JSON.stringify(payload)}\n`;
  const created = createLockExclusive(mutexPath, text, token);
  if (created === 'ok') return true;
  if (created !== 'exists') return false;

  // 目标已存在：仅当持有者确已死亡时 CAS 回收。
  let existingText: string;
  try {
    existingText = readFileSync(mutexPath, 'utf8');
  } catch {
    return false;
  }
  const existing = parseRecoveryMutex(existingText);
  // 损坏/无身份：超过宽限期才抢；刚创建的空窗交给下次重试。
  if (!existing) {
    const age = lockFileAgeMs(mutexPath);
    if (age === undefined || age <= CORRUPT_LOCK_GRACE_MS) return false;
  } else if (!isRecoveryMutexStale(existing)) {
    return false;
  }

  const graveyard = `${mutexPath}.stale-${token}`;
  try {
    renameSync(mutexPath, graveyard);
  } catch {
    return false;
  }
  // 确认搬走的仍是我们判定为陈旧的那一份。
  let movedText: string | undefined;
  try {
    movedText = readFileSync(graveyard, 'utf8');
  } catch {
    movedText = undefined;
  }
  const moved = movedText !== undefined ? parseRecoveryMutex(movedText) : undefined;
  const same =
    existing && moved
      ? existing.token === moved.token && existing.pid === moved.pid && existing.startedAt === moved.startedAt
      : existingText === movedText;
  if (!same) {
    // 不是预期的陈旧 mutex：尽力放回，失败则保留墓碑。
    if (movedText !== undefined) {
      const put = createLockExclusive(mutexPath, movedText, `restore-mtx-${token}`);
      if (put === 'ok') {
        try { rmSync(graveyard, { force: true }); } catch { /* best-effort */ }
      }
    } else {
      try { renameSync(graveyard, mutexPath); } catch { /* keep graveyard */ }
    }
    return false;
  }
  try { rmSync(graveyard, { force: true }); } catch { /* best-effort */ }

  const recreated = createLockExclusive(mutexPath, text, token);
  return recreated === 'ok';
}

/** 仅当磁盘 mutex 仍是本 token 时删除；防止误删别人刚拿到的 mutex。 */
function releaseRecoveryMutex(lockPath: string, token: string): void {
  const mutexPath = recoveryMutexPath(lockPath);
  try {
    const holder = readRecoveryMutex(lockPath);
    if (holder && holder.token.length > 0 && holder.token !== token) return;
    rmSync(mutexPath, { force: true });
  } catch {
    // best-effort
  }
}

function sleepSync(ms: number): void {
  // 获取锁路径上允许极短同步退避；避免空转烧 CPU。
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // spin
    }
  }
}

/**
 * CAS 方式回收陈旧锁。**必须在持有 recovery mutex 时调用**。
 * `rename` 是原子的；若搬走的不是观察到的那把，必须尝试原样放回，且恢复失败时
 * **保留墓碑**供诊断，绝不能静默删除导致别人的 token 消失（OCR-04）。
 */
function reclaimStaleLock(lockPath: string, observed: LockSnapshot, token: string): boolean {
  const graveyard = `${lockPath}.stale-${token}`;
  try {
    renameSync(lockPath, graveyard);
  } catch {
    // 别人已经先一步回收，或持有者正好释放了：重新读一次即可。
    return false;
  }

  const moved = readLockSnapshot(graveyard);
  if (!sameObservedLock(observed, moved)) {
    // 搬走的不是我们判定为陈旧的那一把（中途换了持有者）：原样放回去。
    let restored = false;
    if (moved.raw !== undefined) {
      const put = createLockExclusive(lockPath, moved.raw, `restore-${token}`);
      restored = put === 'ok';
      if (!restored && put === 'exists') {
        // 锁路径上已有别人的新锁：绝不能覆盖。保留墓碑以便人工/下次诊断。
        restored = false;
      }
    } else {
      try {
        renameSync(graveyard, lockPath);
        restored = true;
      } catch {
        restored = false;
      }
    }
    if (restored) {
      try {
        rmSync(graveyard, { force: true });
      } catch {
        // best-effort
      }
    }
    // 恢复失败：保留墓碑，返回 false 让调用方整体获取失败，不得假装成功。
    return false;
  }

  try {
    rmSync(graveyard, { force: true });
  } catch {
    // 墓碑文件残留不影响正确性，下次回收会覆盖同名文件。
  }
  return true;
}

function ownsLock(lockPath: string, token: string): boolean {
  const holder = readLockSnapshot(lockPath).payload;
  return holder !== undefined && holder.token.length > 0 && holder.token === token;
}

/**
 * 假定调用方已持有 recovery mutex：原子改写锁 payload。
 * handoff（在 acquire 临界区内）与 heartbeat（自行取 mutex）共用，
 * 避免「父心跳读旧 payload → 子 handoff → 父 rename 覆盖」竞态（OCR-02）。
 */
function rewriteLockPayloadUnlocked(
  lockPath: string,
  token: string,
  mutate: (current: DataDirLockPayload) => DataDirLockPayload | null,
): DataDirLockPayload | undefined {
  if (!token) return undefined;
  const tmp = `${lockPath}.rw-${token}.tmp`;
  try {
    const current = readLockSnapshot(lockPath).payload;
    if (!current || current.token.length === 0 || current.token !== token) return undefined;
    const next = mutate(current);
    if (!next) return undefined;
    // 所有权凭证不可被 mutate 篡改。
    next.token = token;
    writeFileSync(tmp, `${JSON.stringify(next)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, lockPath);
    // 读回校验：token 仍属于我们，且关键身份与写入一致。
    const verified = readLockSnapshot(lockPath).payload;
    if (!verified || verified.token !== token) return undefined;
    if (verified.pid !== next.pid || verified.processStartId !== next.processStartId) return undefined;
    return verified;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort
    }
    return undefined;
  }
}

/**
 * 自行获取 recovery mutex 后改写 payload（心跳路径）。
 * mutex token 使用锁 token，与 handoff/acquire 串行化。
 */
function rewriteLockPayload(
  lockPath: string,
  token: string,
  mutate: (current: DataDirLockPayload) => DataDirLockPayload | null,
): DataDirLockPayload | undefined {
  if (!token) return undefined;
  if (!tryAcquireRecoveryMutex(lockPath, token)) return undefined;
  try {
    return rewriteLockPayloadUnlocked(lockPath, token, mutate);
  } finally {
    releaseRecoveryMutex(lockPath, token);
  }
}

/**
 * 继承 handoff：必须在已持有 recovery mutex 时调用（acquire 临界区）。
 * 把锁 payload 的 pid/processStartId 更新为当前进程，token 不变。
 */
function handoffOwnership(lockPath: string, holder: DataDirLockPayload): DataDirLockPayload | undefined {
  if (!holder.token) return undefined;
  return rewriteLockPayloadUnlocked(lockPath, holder.token, (current) => ({
    ...current,
    pid: process.pid,
    processStartId: readProcessStartId(process.pid),
    heartbeatAt: Date.now(),
    host: hostname(),
  }));
}

/**
 * 心跳刷新：在 mutex 内读回磁盘，只更新 heartbeatAt，**保留** handoff 写入的 worker 身份。
 * 父进程在子 handoff 之后的刷新不得把 pid 写回父进程（OCR-02）。
 */
function refreshHeartbeat(lockPath: string, payload: DataDirLockPayload): boolean {
  if (!payload.token) return false;
  const verified = rewriteLockPayload(lockPath, payload.token, (current) => ({
    ...current,
    heartbeatAt: Date.now(),
  }));
  if (!verified) return false;
  payload.heartbeatAt = verified.heartbeatAt;
  payload.pid = verified.pid;
  payload.processStartId = verified.processStartId;
  payload.host = verified.host;
  payload.kind = verified.kind;
  payload.jobId = verified.jobId;
  payload.startedAt = verified.startedAt;
  return true;
}

function makeOwnedLease(lockPath: string, payload: DataDirLockPayload, inherited: boolean): DataDirLease {
  let released = false;
  let held = true;
  const timer = setInterval(() => {
    if (released) return;
    if (!refreshHeartbeat(lockPath, payload)) held = false;
  }, HEARTBEAT_INTERVAL_MS);
  // 心跳绝不能让进程无法自然退出。
  timer.unref();

  return {
    jobId: payload.jobId,
    token: payload.token,
    lockPath,
    inherited,
    isHeld: () => held && !released && ownsLock(lockPath, payload.token),
    release: () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      // 继承租约：handoff 后子进程负责 heartbeat，但删除锁文件仍归父进程/supervisor
      // （opCoordinator 在子进程退出后 release）。子进程若删除，父进程仍显示
      // running 时会出现无锁窗口（OCR-02 相关）。
      if (inherited) return;
      // 只删 token 属于自己的锁：pid 相同也可能是回收后别人重新拿到的锁。
      if (!ownsLock(lockPath, payload.token)) return;
      try {
        rmSync(lockPath, { force: true });
      } catch {
        // best-effort
      }
    },
  };
}

/**
 * 获取数据目录锁。返回的 lease 必须在命令结束、异常与信号退出路径上释放。
 */
export function acquireDataDirLock(
  dataDir: string,
  kind: DataOpKind,
  jobId: string = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
): AcquireDataDirLockResult {
  const lockPath = dataDirLockPath(dataDir);

  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch (e) {
    return {
      ok: false,
      code: 'data_dir_lock_failed',
      message: `无法在数据目录上加锁，请确认数据目录可写后重试。原始错误：${(e as Error).message}`,
      holder: undefined,
    };
  }

  const payload: DataDirLockPayload = {
    pid: process.pid,
    host: hostname(),
    kind,
    jobId,
    startedAt: Date.now(),
    token: randomBytes(16).toString('hex'),
    heartbeatAt: Date.now(),
    processStartId: readProcessStartId(process.pid),
  };

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    // 整个观察/回收/创建临界区必须持有 recovery mutex（OCR-04）。
    if (!tryAcquireRecoveryMutex(lockPath, payload.token)) {
      sleepSync(RECOVERY_MUTEX_BACKOFF_MS);
      continue;
    }
    try {
      const snapshot = readLockSnapshot(lockPath);

      if (snapshot.payload && inheritedFromParent(snapshot.payload)) {
        // 显式 handoff：子进程接管 ownership，父崩溃后锁仍显示子 PID 存活（OCR-02）。
        const handed = handoffOwnership(lockPath, snapshot.payload);
        if (handed) {
          // jobId 优先用环境变量里父进程下发的值。
          const envJob = process.env[LOCK_JOB_ID_ENV];
          if (envJob && envJob.length > 0) handed.jobId = envJob;
          return { ok: true, lease: makeOwnedLease(lockPath, handed, true) };
        }
        // handoff 失败：token 仍匹配时不能抢锁，报占用。
        return {
          ok: false,
          code: 'data_dir_locked_externally',
          message: busyMessage(snapshot.payload),
          holder: snapshot.payload,
        };
      }

      if (!snapshot.present) {
        const created = writeLockExclusive(lockPath, payload);
        if (created === 'error') {
          return {
            ok: false,
            code: 'data_dir_lock_failed',
            message: '无法在数据目录上写入锁文件，请确认数据目录可写后重试。',
            holder: undefined,
          };
        }
        if (created === 'exists') continue; // 被抢先，重新观察
        // CAS 读回校验：确认磁盘上的确实是自己的 token。
        if (ownsLock(lockPath, payload.token)) {
          return { ok: true, lease: makeOwnedLease(lockPath, payload, false) };
        }
        continue;
      }

      if (!isStale(lockPath, snapshot)) {
        return {
          ok: false,
          code: 'data_dir_locked_externally',
          message: busyMessage(snapshot.payload),
          holder: snapshot.payload,
        };
      }

      // 陈旧锁：在 mutex 内 CAS 回收后，同轮继续创建。
      if (!reclaimStaleLock(lockPath, snapshot, payload.token)) {
        continue;
      }
      const created = writeLockExclusive(lockPath, payload);
      if (created === 'ok' && ownsLock(lockPath, payload.token)) {
        return { ok: true, lease: makeOwnedLease(lockPath, payload, false) };
      }
    } finally {
      releaseRecoveryMutex(lockPath, payload.token);
    }
  }

  const finalSnapshot = readLockSnapshot(lockPath);
  return {
    ok: false,
    code: 'data_dir_locked_externally',
    message: busyMessage(finalSnapshot.payload),
    holder: finalSnapshot.payload,
  };
}

/**
 * 父进程给子进程下发租约时应该注入的环境变量。Electron 侧 spawn CLI 时用它，
 * 子进程就能凭 token 判定继承，而不再依赖 `process.ppid`。
 */
export function leaseEnvForChild(lease: Pick<DataDirLease, 'token' | 'jobId'>): Record<string, string> {
  return {
    [LOCK_TOKEN_ENV]: lease.token,
    [LOCK_JOB_ID_ENV]: lease.jobId,
  };
}
