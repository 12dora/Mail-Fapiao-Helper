import { spawnSync, type ChildProcess } from 'node:child_process';

/** CLI parse 的 stdout/stderr 有界 ring buffer 上限（OCR-12）。 */
export const CLI_OUTPUT_CAP_BYTES = 64 * 1024;
/** 超时后 SIGTERM → SIGKILL 的宽限。 */
const TERMINATE_GRACE_MS = 2_000;
/** 强杀后再等 close 的上限。 */
const TERMINATE_KILL_WAIT_MS = 1_000;

function childStillRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function sendSignal(child: ChildProcess, signal: NodeJS.Signals): boolean {
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

/**
 * Windows：taskkill /T 杀整棵进程树。
 * POSIX：对负 PGID 发信号（要求 spawn 时 `detached: true` 成为新组长）；
 * 失败再降级到直接子进程（OCR-12）。
 */
function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): boolean {
  const pid = child.pid;
  if (pid === undefined) return false;
  if (process.platform === 'win32') {
    try {
      const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 5000,
        stdio: 'ignore',
      });
      // 0 = 成功，128 = 进程已不存在。
      if (result.error) return sendSignal(child, 'SIGKILL');
      if (result.status === 0 || result.status === 128) return true;
      return sendSignal(child, 'SIGKILL');
    } catch {
      return sendSignal(child, 'SIGKILL');
    }
  }
  // POSIX 进程组信号：覆盖 efapiao 可能拉起的孙进程。
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return sendSignal(child, signal);
  }
}

/**
 * 仅在 `close` 上 resolve（stdio 全部释放）；超时返回 false，不把 exit 当完成（OCR-12）。
 * 子孙进程仍持有管道时 exit 可能先于 close，此时不得让 OCR promise 提前 settle。
 */
function waitForClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!childStillRunning(child) && child.exitCode !== null) {
    // 已完全结束：exitCode 有值且 stdio 通常已 close；仍等一个 tick 上的 close 若未触发则视为完成。
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      child.once('close', () => done(true));
      const timer = setTimeout(() => done(true), 0);
    });
  }
  if (!childStillRunning(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    child.once('close', () => done(true));
    const timer = setTimeout(() => done(false), timeoutMs);
  });
}

export class ChildTerminateError extends Error {
  readonly code = 'efapiao_child_terminate_failed';

  constructor(message: string) {
    super(message);
    this.name = 'ChildTerminateError';
  }
}

/**
 * 统一子进程终止：关 stdin → 进程组 SIGTERM → 等 close → 进程组 SIGKILL → 再等 close（OCR-12）。
 * 最终仍未 close 时抛出，调用方不得把解析结果当成成功。
 */
export async function terminateChildTree(child: ChildProcess, graceMs = TERMINATE_GRACE_MS): Promise<void> {
  if (!childStillRunning(child)) {
    // 确保 close 已经发生（或立即判定完成）。
    await waitForClose(child, 0);
    return;
  }
  try {
    child.stdin?.end();
  } catch {
    // ignore
  }
  try {
    child.stdin?.destroy();
  } catch {
    // ignore
  }
  killProcessTree(child, 'SIGTERM');
  if (await waitForClose(child, graceMs)) return;
  killProcessTree(child, 'SIGKILL');
  sendSignal(child, 'SIGKILL');
  if (await waitForClose(child, TERMINATE_KILL_WAIT_MS)) return;
  throw new ChildTerminateError(
    `efapiao_child_terminate_failed:pid=${child.pid ?? 'unknown'}:close_timeout`,
  );
}

/**
 * 有界输出缓冲（OCR-12）：超过上限后停止累积并标记 overflow。
 * **不得**丢弃头部后把截断尾部交给 JSON.parse——那会静默解析残缺 JSON。
 * overflow 时 toString 仍返回已缓冲前缀，供错误消息；调用方必须先检查 overflow。
 */
export class BoundedOutput {
  private readonly chunks: Buffer[] = [];
  private total = 0;
  /** 一旦为 true，后续 chunk 丢弃且不得再解析为结构化结果。 */
  overflow = false;

  constructor(private readonly capBytes: number) {}

  push(chunk: Buffer): void {
    if (this.overflow) return;
    if (this.total + chunk.length > this.capBytes) {
      // 尽量保留 cap 内前缀，便于错误诊断；标记 overflow。
      const room = this.capBytes - this.total;
      if (room > 0) {
        this.chunks.push(chunk.subarray(0, room));
        this.total += room;
      }
      this.overflow = true;
      return;
    }
    this.chunks.push(chunk);
    this.total += chunk.length;
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}
