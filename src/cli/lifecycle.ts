import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Config } from '../config.js';
import { log } from '../log.js';
import { stopEfapiaoServices } from '../ocr/efapiao.js';
import { ensureSecureDir, flushActiveStates, secureFileMode } from '../state.js';
import { releaseDataDirLock } from './lock.js';

/**
 * OCR 运行期 PID 记录（APP-16）。
 *
 * Windows 上父进程用 `SIGTERM` 终止本 CLI 时不会执行任何 JS 清理
 * （等价于 TerminateProcess），而托管的 `efapiao serve` 是 unref 的子进程，
 * 因此本进程无法保证自己停掉它。这里把 PID 写入文件并打印一行稳定标记，
 * 让父进程（GUI）可以按 PID 终止整棵进程树。
 */
let activeOcrPidFile: string | undefined;

export function writeOcrRuntimePid(cfg: Config): void {
  try {
    const pidPath = join(resolve(cfg.paths.invoices), 'ocr', '.mfh-ocr-cli.pid');
    ensureSecureDir(dirname(pidPath));
    const payload = { pid: process.pid, startedAt: new Date().toISOString(), serviceHost: cfg.ocr.serviceHost, servicePort: cfg.ocr.servicePort };
    writeFileSync(pidPath, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 });
    secureFileMode(pidPath);
    activeOcrPidFile = pidPath;
    // 稳定前缀，供父进程解析后做进程树终止（Windows 需要 taskkill /T）。
    process.stdout.write(`mfh:ocr-cli-pid ${process.pid}\n`);
  } catch {
    // PID 记录只是辅助手段，失败不应阻断 OCR。
  }
}

export function clearOcrRuntimePid(): void {
  const pidPath = activeOcrPidFile;
  activeOcrPidFile = undefined;
  if (!pidPath) return;
  try {
    rmSync(pidPath, { force: true });
  } catch {
    // best-effort
  }
}

// The GUI kills this CLI with SIGTERM (and users press Ctrl-C = SIGINT). A signal
// terminates the process without running cmdOcr's `finally`, so an unref'd
// `efapiao serve` child would be orphaned holding its port. Stop it explicitly.
//
// APP-16：Windows 上 `ChildProcess.kill('SIGTERM')` 等价于 TerminateProcess，
// 不会执行下面任何 JS，所以除了信号处理还必须有 `process.on('exit')` 兜底
// （覆盖正常结束与未捕获异常两条路径），并由 writeOcrRuntimePid() 记录 PID，
// 让父进程可以按 PID 终止整棵进程树。
let shuttingDown = false;

export function shutdownManagedServices(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  // CODE-07：先把未达 checkpoint 阈值的状态增量同步刷盘，再放锁、再退出。
  // 顺序很重要——刷盘必须发生在仍然持有数据目录锁的时候。
  for (const err of flushActiveStates()) log.error(`state flush failed during shutdown: ${err.message}`);
  stopEfapiaoServices();
  clearOcrRuntimePid();
  // 数据目录锁必须在信号退出路径上也释放，否则会留下一把要等陈旧回收的锁。
  releaseDataDirLock();
}

const SIGNAL_EXIT_CODES: Record<string, number> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143, SIGBREAK: 149 };

export function installSignalHandlers(): void {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGBREAK'] as const) {
    process.on(signal, () => {
      shutdownManagedServices();
      process.exit(SIGNAL_EXIT_CODES[signal] ?? 143);
    });
  }
  process.on('exit', () => { shutdownManagedServices(); });
}
