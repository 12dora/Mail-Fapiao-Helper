import { spawnSync, type ChildProcess } from 'node:child_process';

/**
 * 子进程树终止工具（APP-16 / ELEC-04）。
 *
 * Windows 上 `ChildProcess.kill('SIGTERM')` 不保证目标进程能执行 JS 清理逻辑，
 * CLI 里那个被 `unref()` 的 `efapiao serve` 孙进程会因此变成孤儿，继续占用端口
 * 并携带旧配置。所以 Windows 必须按 PID 精确终止整棵进程树（taskkill /T）。
 *
 * POSIX 上 CLI 以独立进程组启动（`detached: true`），这里对负 PGID 发信号，
 * 才能连同 `efapiao serve` 孙进程一起终止。
 *
 * 重要：发出信号 ≠ 进程已退出。`treeSignalled` 只表示「已对整棵树发出终止信号」；
 * 真正是否还活着必须由 `terminateChildren` 等待并验证后决定（ELEC-04 rework）。
 */

export interface KillOutcome {
  /**
   * 已向整棵进程树发出终止信号（Windows taskkill /T 成功，或 POSIX 进程组信号成功）。
   * 这不表示子进程已经退出。
   */
  treeSignalled: boolean;
  /** 已向直接子进程发过信号（taskkill / 进程组失败后的降级路径）。 */
  signalled: boolean;
  /** 失败原因，仅用于主进程日志/诊断，不直接进 UI。 */
  detail?: string;
}

/**
 * `spawnSync` 不会因为「命令不存在 / 超时 / 退出码非零」而抛异常，这些情况分别
 * 体现在 `error`、`signal` 和 `status` 上。只看 try/catch 会把失败当成功，从而
 * 跳过降级路径——这正是复核指出的问题。
 */
function runTaskkill(pid: number): { ok: boolean; detail?: string } {
  const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    timeout: 5000,
    stdio: 'ignore',
  });
  if (result.error) return { ok: false, detail: `taskkill 启动失败：${result.error.message}` };
  if (result.signal) return { ok: false, detail: `taskkill 被信号 ${result.signal} 终止（可能超时）` };
  if (result.status === null) return { ok: false, detail: 'taskkill 没有返回退出码' };
  // 128 = 进程已经不存在，对我们而言与成功等价。
  if (result.status === 0 || result.status === 128) return { ok: true };
  return { ok: false, detail: `taskkill 退出码 ${result.status}` };
}

function isAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function sendSignal(child: ChildProcess, signal: NodeJS.Signals): boolean {
  try {
    return child.kill(signal);
  } catch {
    // 进程可能已经退出。
    return false;
  }
}

/** POSIX：向进程组发信号（要求 spawn 时 detached 以成为新组长）。 */
function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * 向进程树发出终止信号。不把「信号已发出」当作「已终止」——调用方必须等待并验证。
 */
export function killProcessTree(child: ChildProcess): KillOutcome {
  const pid = child.pid;
  if (pid === undefined) return { treeSignalled: false, signalled: false, detail: '子进程没有 PID' };
  if (!isAlive(child)) return { treeSignalled: true, signalled: false };

  if (process.platform === 'win32') {
    const killed = runTaskkill(pid);
    if (killed.ok) return { treeSignalled: true, signalled: false };
    // 降级：taskkill 不可用/失败时至少终止直接子进程。注意这**不能**替代 /T 的
    // 树终止，孙进程可能仍然存活，所以 treeSignalled 保持 false。
    const signalled = sendSignal(child, 'SIGKILL');
    return { treeSignalled: false, signalled, ...(killed.detail ? { detail: killed.detail } : {}) };
  }

  // POSIX：先对进程组发 SIGTERM（覆盖 CLI 与 unref 的 efapiao serve）。
  // 信号发出成功 ≠ 已终止；调用方必须 wait + 验证。
  if (signalProcessGroup(pid, 'SIGTERM')) {
    return { treeSignalled: true, signalled: true };
  }
  // 进程组信号失败（例如未以 detached 启动）：降级到直接子进程。
  const signalled = sendSignal(child, 'SIGTERM');
  return {
    treeSignalled: false,
    signalled,
    detail: signalled ? '进程组信号失败，已降级为仅终止直接子进程' : '无法向子进程发送 SIGTERM',
  };
}

export interface TerminateSummary {
  /** 仍然存活的直接子进程数量（0 表示全部已退出）。 */
  remaining: number;
  /**
   * 终止不完整：树级信号失败、或仍有存活子进程、或无法证明整棵树已清。
   * 只要为 true，调用方就必须保留数据目录锁（ELEC-04 / NEW-DEFECT 4）。
   */
  treeIncomplete: boolean;
  details: string[];
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (!isAlive(child)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const done = (): void => {
      if (timer) clearTimeout(timer);
      resolve();
    };
    child.once('close', done);
    child.once('exit', done);
    timer = setTimeout(resolve, timeoutMs);
  });
}

/**
 * 终止全部 tracked 子进程并等待它们真正退出（app quit 路径使用）。
 * 超时后重试一次树终止再强制 kill，最后**验证**直接子进程是否确实退出。
 *
 * 注意：Node 只能可靠观察我们 spawn 的直接子进程。Windows 用 taskkill /T 杀整棵树；
 * POSIX 依赖进程组。若树级信号失败，即使直接子进程已退出，也标记 treeIncomplete，
 * 因为孙进程（如 efapiao serve）可能仍存活。
 */
export async function terminateChildren(
  children: Iterable<ChildProcess>,
  timeoutMs = 4000,
): Promise<TerminateSummary> {
  const pending = Array.from(children).filter(isAlive);
  const details: string[] = [];
  let treeIncomplete = false;
  if (pending.length === 0) return { remaining: 0, treeIncomplete: false, details };

  for (const child of pending) {
    const outcome = killProcessTree(child);
    // 未能对整棵树发信号 → 终止不完整（即使后续直接子进程退出）。
    if (!outcome.treeSignalled) treeIncomplete = true;
    if (outcome.detail) details.push(outcome.detail);
  }

  await Promise.all(pending.map((child) => waitForExit(child, timeoutMs)));

  // 第二轮：仍然存活的再试一次树终止，然后强制 kill 并验证。
  const stillAlive = pending.filter(isAlive);
  for (const child of stillAlive) {
    const pid = child.pid;
    if (process.platform === 'win32' && pid !== undefined) {
      const retry = runTaskkill(pid);
      if (!retry.ok) {
        if (retry.detail) details.push(retry.detail);
        // NEW-DEFECT 4：第二次 taskkill 失败时恢复直接子进程 SIGKILL 降级。
        sendSignal(child, 'SIGKILL');
        treeIncomplete = true;
      }
    } else if (pid !== undefined) {
      if (!signalProcessGroup(pid, 'SIGKILL')) {
        sendSignal(child, 'SIGKILL');
        treeIncomplete = true;
      }
    } else {
      sendSignal(child, 'SIGKILL');
      treeIncomplete = true;
    }
  }
  await Promise.all(stillAlive.map((child) => waitForExit(child, 1000)));

  const remaining = pending.filter(isAlive).length;
  if (remaining > 0) {
    treeIncomplete = true;
    details.push(`仍有 ${remaining} 个后台进程没有在超时内退出`);
  }
  return { remaining, treeIncomplete, details };
}
