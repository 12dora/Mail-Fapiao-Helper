import { randomBytes } from 'node:crypto';
import {
  acquireDataDirLock,
  dataOpLabel,
  leaseEnvForChild,
  type DataDirLease,
  type DataOpKind,
} from '../util/dataDirLock.js';

/**
 * 全局操作协调器（APP-05）。
 *
 * 之前 fetch / normal-force pipeline / OCR / organize 可以互相独立启动，多个写入者
 * 会覆盖 state、擦掉新加入的 OCR 队列行并产生重复文件。这里维护：
 *   1. 进程内带 jobId 的操作注册表 + 兼容矩阵（当前全部互斥）；
 *   2. 数据目录上的跨进程文件锁，把 CLI、第二个应用实例一起挡在门外；
 *   3. 状态变化时向所有窗口广播 `op-state`。
 *
 * 锁本身复用 `src/util/dataDirLock.ts`（不依赖 Electron 的共享实现），GUI 与 CLI
 * 必须是同一份协议实现，否则两侧会各锁各的。
 *
 * 租约继承**只认 token**：`begin()` 拿到锁后，`leaseEnv()` 会把锁 payload 里的随机
 * token 通过 `MFH_LOCK_TOKEN`（连同 `MFH_LOCK_JOB_ID`）下发给 spawn 出来的 CLI 子
 * 进程；子进程用环境变量里的 token 与磁盘锁文件里的 token 比对，一致才判定为在父
 * 进程的租约内运行，因此不会被 GUI 自己启动的任务挡住。判据里**没有** `process.ppid`：
 * 按父子关系推断会让「GUI 异常退出后仍在工作的子进程」脱离锁 ownership，新实例回收
 * 这把锁后就会与旧子进程并发写同一个数据目录。
 */

export type OpKind = DataOpKind;

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

export function opLabel(kind: OpKind): string {
  return dataOpLabel(kind);
}

export class OperationCoordinator {
  private running: RunningOp | null = null;
  private lease: DataDirLease | undefined;
  private broadcast: (payload: { running: RunningOp | null }) => void = () => {};

  constructor(private readonly dataDir: string) {}

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

  /**
   * 下发给 CLI 子进程的租约凭证（APP-05）。
   *
   * 子进程不能再凭「锁持有者 pid == 自己的 ppid」就认定继承租约：GUI 异常退出后
   * 仍在工作的子进程不再体现在锁 ownership 里，新实例会回收这把锁并与旧子进程并发。
   * 改成由父进程显式下发 token，子进程只有在 token 与磁盘锁文件里的 token 一致时
   * 才判定为继承。变量名与取值都交给共享锁模块的 `leaseEnvForChild()`，避免两侧
   * 各写一份字符串。
   */
  leaseEnv(): Record<string, string> {
    const lease = this.lease;
    if (!lease) return {};
    return leaseEnvForChild(lease);
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
    const acquired = acquireDataDirLock(this.dataDir, kind, jobId);
    if (!acquired.ok) {
      return {
        ok: false,
        code: acquired.code === 'data_dir_lock_failed' ? 'operation_lock_failed' : 'operation_locked_externally',
        message: acquired.message,
        running: this.running,
      };
    }

    this.lease = acquired.lease;
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

  private releaseLock(): void {
    const lease = this.lease;
    this.lease = undefined;
    if (!lease) return;
    try {
      lease.release();
    } catch {
      // best-effort：释放失败会留下一把锁，下次由陈旧回收清理。
    }
  }
}
