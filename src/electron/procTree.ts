import { spawnSync, type ChildProcess } from 'node:child_process';

/**
 * 子进程树终止工具（APP-16）。
 *
 * Windows 上 `ChildProcess.kill('SIGTERM')` 不保证目标进程能执行 JS 清理逻辑，
 * CLI 里那个被 `unref()` 的 `efapiao serve` 孙进程会因此变成孤儿，继续占用端口
 * 并携带旧配置。所以 Windows 必须按 PID 精确终止整棵进程树。
 */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      // /T 连同子孙进程，/F 强制终止；taskkill 自身很快返回，同步调用可接受。
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 5000,
        stdio: 'ignore',
      });
      return;
    } catch {
      // taskkill 不可用时退回普通 kill。
    }
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // 进程可能已经退出。
  }
}

/**
 * 终止全部 tracked 子进程并等待它们真正退出（app quit 路径使用）。
 * 超时后再做一次强制 kill，然后放行退出，避免应用永远无法关闭。
 */
export async function terminateChildren(
  children: Iterable<ChildProcess>,
  timeoutMs = 4000,
): Promise<void> {
  const pending = Array.from(children).filter((child) => child.exitCode === null && child.signalCode === null);
  if (pending.length === 0) return;

  const waits = pending.map((child) => new Promise<void>((resolve) => {
    child.once('close', () => resolve());
    child.once('exit', () => resolve());
  }));

  for (const child of pending) killProcessTree(child);

  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all(waits),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
  ]);
  if (timer) clearTimeout(timer);

  for (const child of pending) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      child.kill('SIGKILL');
    } catch {
      // best-effort
    }
  }
}
