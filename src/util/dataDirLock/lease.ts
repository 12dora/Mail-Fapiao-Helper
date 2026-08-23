import { rmSync } from 'node:fs';
import { hostname } from 'node:os';

import { ownsLock, rewriteLockPayload, rewriteLockPayloadUnlocked } from './mutex.js';
import { readProcessStartId } from './process.js';
import { HEARTBEAT_INTERVAL_MS, type DataDirLease, type DataDirLockPayload } from './types.js';

/**
 * 继承 handoff：必须在已持有 recovery mutex 时调用（acquire 临界区）。
 * 把锁 payload 的 pid/processStartId 更新为当前进程，token 不变。
 */
export function handoffOwnership(lockPath: string, holder: DataDirLockPayload): DataDirLockPayload | undefined {
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

export function makeOwnedLease(lockPath: string, payload: DataDirLockPayload, inherited: boolean): DataDirLease {
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
