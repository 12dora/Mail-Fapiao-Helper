import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * 全局操作协调器（APP-05）。
 *
 * 之前 fetch / normal-force pipeline / OCR / organize 可以互相独立启动，多个写入者
 * 会覆盖 state、擦掉新加入的 OCR 队列行并产生重复文件。这里维护：
 *   1. 进程内带 jobId 的操作注册表 + 兼容矩阵（当前全部互斥）；
 *   2. 数据目录上的跨进程文件锁（lockfile + PID + 陈旧锁回收），把 CLI、第二个
 *      应用实例一起挡在门外；
 *   3. 状态变化时向所有窗口广播 `op-state`。
 */

export type OpKind = 'fetch' | 'pipeline' | 'ocr' | 'organize';

export interface RunningOp {
  kind: OpKind;
  jobId: string;
  startedAt: number;
}

export interface OpLease {
  jobId: string;
  release(): void;
}

export type BeginResult =
  | { ok: true; lease: OpLease }
  | { ok: false; code: string; message: string; detail?: string; running: RunningOp | null };

/**
 * 兼容矩阵：值是「允许与之并行的操作」。当前四个操作都会写同一份 state / CSV /
 * 队列，因此全部互斥；将来某个组合被证明安全时只需要在这里放开。
 */
const COMPATIBLE_WITH: Record<OpKind, OpKind[]> = {
  fetch: [],
  pipeline: [],
  ocr: [],
  organize: [],
};

const OP_LABEL: Record<OpKind, string> = {
  fetch: '获取邮件',
  pipeline: '处理缓存邮件',
  ocr: '识别文件',
  organize: '整理输出文件',
};

export function opLabel(kind: OpKind): string {
  return OP_LABEL[kind];
}

interface LockPayload {
  pid: number;
  host: string;
  kind: OpKind;
  jobId: string;
  startedAt: number;
}

/** 超过这个时长且持有者仍在的锁也视为陈旧（进程卡死时不至于永远锁死）。 */
const STALE_LOCK_MS = 6 * 60 * 60 * 1000;

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

function readLock(lockPath: string): LockPayload | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<LockPayload>;
    if (typeof raw.pid !== 'number' || typeof raw.jobId !== 'string') return undefined;
    return {
      pid: raw.pid,
      host: typeof raw.host === 'string' ? raw.host : '',
      kind: (raw.kind ?? 'fetch') as OpKind,
      jobId: raw.jobId,
      startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0,
    };
  } catch {
    return undefined;
  }
}

export class OperationCoordinator {
  private running: RunningOp | null = null;
  private readonly lockPath: string;
  private lockOwned = false;
  private broadcast: (payload: { running: RunningOp | null }) => void = () => {};

  constructor(private readonly dataDir: string) {
    this.lockPath = path.join(dataDir, '.mfh-cache', 'mfh-data.lock');
  }

  setBroadcast(fn: (payload: { running: RunningOp | null }) => void): void {
    this.broadcast = fn;
  }

  current(): RunningOp | null {
    return this.running;
  }

  /** 供窗口创建时补发一次当前状态。 */
  state(): { running: RunningOp | null } {
    return { running: this.running };
  }

  begin(kind: OpKind): BeginResult {
    const running = this.running;
    if (running && !COMPATIBLE_WITH[kind].includes(running.kind)) {
      return {
        ok: false,
        code: 'operation_busy',
        message: `当前正在${opLabel(running.kind)}，请等待完成后再开始${opLabel(kind)}。`,
        running,
      };
    }

    const jobId = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
    const lock = this.acquireLock(kind, jobId);
    if (!lock.ok) return lock;

    this.running = { kind, jobId, startedAt: Date.now() };
    this.emit();

    let released = false;
    return {
      ok: true,
      lease: {
        jobId,
        release: () => {
          if (released) return;
          released = true;
          if (this.running?.jobId === jobId) this.running = null;
          this.releaseLock();
          this.emit();
        },
      },
    };
  }

  /** 应用退出时兜底释放，避免留下需要下一次陈旧回收的锁文件。 */
  dispose(): void {
    this.running = null;
    this.releaseLock();
  }

  private emit(): void {
    try {
      this.broadcast({ running: this.running });
    } catch {
      // 广播失败不应影响操作本身。
    }
  }

  private acquireLock(kind: OpKind, jobId: string): { ok: true } | Extract<BeginResult, { ok: false }> {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
    const payload: LockPayload = {
      pid: process.pid,
      host: os.hostname(),
      kind,
      jobId,
      startedAt: Date.now(),
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx', 0o600);
        try {
          fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`);
        } finally {
          fs.closeSync(fd);
        }
        this.lockOwned = true;
        return { ok: true };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          return {
            ok: false,
            code: 'operation_lock_failed',
            message: '无法在数据目录上加锁，请确认数据目录可写后重试。',
            running: this.running,
          };
        }
      }

      const holder = readLock(this.lockPath);
      const sameHost = !holder?.host || holder.host === os.hostname();
      const stale = !holder
        || (sameHost && !isProcessAlive(holder.pid))
        || (holder.startedAt > 0 && Date.now() - holder.startedAt > STALE_LOCK_MS);
      if (!stale) {
        return {
          ok: false,
          code: 'operation_locked_externally',
          message: '数据目录正被另一个发票助手实例或命令行任务占用，请等待它结束后再试。',
          running: this.running,
        };
      }
      // 陈旧锁回收：持有者已经消失或超时，删除后重试一次。
      try {
        fs.rmSync(this.lockPath, { force: true });
      } catch {
        // 下一轮 openSync 会再报错，由上面的分支给出提示。
      }
    }

    return {
      ok: false,
      code: 'operation_locked_externally',
      message: '数据目录正被另一个任务占用，请稍后重试。',
      running: this.running,
    };
  }

  private releaseLock(): void {
    if (!this.lockOwned) return;
    this.lockOwned = false;
    const holder = readLock(this.lockPath);
    // 只删自己写的锁，避免误删陈旧回收后别人重新获取的锁。
    if (holder && holder.pid !== process.pid) return;
    try {
      fs.rmSync(this.lockPath, { force: true });
    } catch {
      // best-effort
    }
  }
}
