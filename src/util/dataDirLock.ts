import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * 数据目录跨进程锁（APP-05）——**不依赖 Electron** 的共享实现。
 *
 * 与 `src/electron/opCoordinator.ts` 里的实现共用同一套协议，两侧必须互认同一把锁：
 * - 锁文件路径：`<dataDir>/.mfh-cache/mfh-data.lock`；
 * - 独占创建：`openSync(lockPath, 'wx', 0o600)`，内容是一行 JSON；
 * - payload 字段：`pid` / `host` / `kind` / `jobId` / `startedAt`；
 * - 陈旧判定：读不出 payload、或「同主机且持有者进程已死」、或 `startedAt` 距今
 *   超过 6 小时；回收时只删自己判定为陈旧的锁，随后重试一次；
 * - 释放：只删 `pid` 等于自己的锁，避免误删陈旧回收后别人重新拿到的锁。
 *
 * 任何一侧修改协议都必须同步另一侧，否则 GUI 与 CLI 会各锁各的。
 */

/** 与 opCoordinator 的 `OpKind` 保持完全一致。 */
export type DataOpKind = 'fetch' | 'pipeline' | 'ocr' | 'organize';

export interface DataDirLockPayload {
  pid: number;
  host: string;
  kind: DataOpKind;
  jobId: string;
  startedAt: number;
}

export interface DataDirLease {
  jobId: string;
  /** 锁文件的绝对路径。 */
  lockPath: string;
  /**
   * true 表示锁由父进程（GUI 的操作协调器）持有，本进程只是在它的租约内运行，
   * 因此既不重复加锁也不会删除锁文件。
   */
  inherited: boolean;
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

/** 超过这个时长且持有者仍在的锁也视为陈旧（进程卡死时不至于永远锁死）。 */
const STALE_LOCK_MS = 6 * 60 * 60 * 1000;

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

function readLock(lockPath: string): DataDirLockPayload | undefined {
  try {
    const raw = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<DataDirLockPayload>;
    if (typeof raw.pid !== 'number' || typeof raw.jobId !== 'string') return undefined;
    return {
      pid: raw.pid,
      host: typeof raw.host === 'string' ? raw.host : '',
      kind: (raw.kind ?? 'fetch') as DataOpKind,
      jobId: raw.jobId,
      startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0,
    };
  } catch {
    return undefined;
  }
}

function isStale(holder: DataDirLockPayload | undefined): boolean {
  const sameHost = !holder?.host || holder.host === hostname();
  return !holder
    || (sameHost && !isProcessAlive(holder.pid))
    || (holder.startedAt > 0 && Date.now() - holder.startedAt > STALE_LOCK_MS);
}

/**
 * 父进程（GUI）已经为本次任务加过锁时，子进程不能再抢同一把锁，否则 GUI 触发的
 * 每个 CLI 任务都会被自己挡住。这里按「锁持有者 pid == 自己的父进程 pid 且同主机」
 * 判定为继承租约。
 */
function inheritedFromParent(holder: DataDirLockPayload | undefined): boolean {
  if (!holder) return false;
  if (holder.host && holder.host !== hostname()) return false;
  return holder.pid === process.ppid;
}

function busyMessage(holder: DataDirLockPayload | undefined): string {
  if (!holder) return '数据目录正被另一个任务占用，请稍后重试。';
  const label = dataOpLabel(holder.kind);
  return `数据目录正被另一个发票助手实例或命令行任务占用（正在${label}，进程 ${holder.pid}），`
    + '请等待它结束后再试。';
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

  // 父进程已经持锁（GUI 启动的子任务）：直接在它的租约内运行。
  const preexisting = readLock(lockPath);
  if (inheritedFromParent(preexisting)) {
    return {
      ok: true,
      lease: {
        jobId: preexisting?.jobId ?? jobId,
        lockPath,
        inherited: true,
        release: () => {
          // 锁属于父进程，子进程不得删除。
        },
      },
    };
  }

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
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(payload)}\n`);
      } finally {
        closeSync(fd);
      }
      let released = false;
      return {
        ok: true,
        lease: {
          jobId,
          lockPath,
          inherited: false,
          release: () => {
            if (released) return;
            released = true;
            const holder = readLock(lockPath);
            // 只删自己写的锁，避免误删陈旧回收后别人重新获取的锁。
            if (holder && holder.pid !== process.pid) return;
            try {
              rmSync(lockPath, { force: true });
            } catch {
              // best-effort
            }
          },
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        return {
          ok: false,
          code: 'data_dir_lock_failed',
          message: `无法在数据目录上加锁，请确认数据目录可写后重试。原始错误：${(err as Error).message}`,
          holder: undefined,
        };
      }
    }

    const holder = readLock(lockPath);
    if (inheritedFromParent(holder)) {
      // 竞态：父进程刚好在这一瞬间拿到了锁。
      return {
        ok: true,
        lease: {
          jobId: holder?.jobId ?? jobId,
          lockPath,
          inherited: true,
          release: () => {},
        },
      };
    }
    if (!isStale(holder)) {
      return {
        ok: false,
        code: 'data_dir_locked_externally',
        message: busyMessage(holder),
        holder,
      };
    }
    // 陈旧锁回收：持有者已经消失或超时，删除后重试一次。
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // 下一轮 openSync 会再报错，由上面的分支给出提示。
    }
  }

  return {
    ok: false,
    code: 'data_dir_locked_externally',
    message: '数据目录正被另一个任务占用，请稍后重试。',
    holder: readLock(lockPath),
  };
}
