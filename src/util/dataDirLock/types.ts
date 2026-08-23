import { dirname, join, resolve, sep } from 'node:path';

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
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** 心跳过期阈值：仅用于 pid 不可用（<=0）这类无法探测存活的旧锁。 */
export const HEARTBEAT_STALE_MS = 10 * 60_000;
/** 锁文件内容不可解析时的宽限期：短于它一律当成「别人正在创建」而不是损坏。 */
export const CORRUPT_LOCK_GRACE_MS = 10_000;
/** 获取锁的最多重试轮数（每轮可能包含一次 CAS 回收）。 */
export const MAX_ACQUIRE_ATTEMPTS = 5;
/** recovery mutex 争用时的短暂退避上限（毫秒）。 */
export const RECOVERY_MUTEX_BACKOFF_MS = 30;

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
