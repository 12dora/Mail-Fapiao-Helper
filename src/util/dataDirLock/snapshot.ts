import { readFileSync, statSync } from 'node:fs';
import { hostname } from 'node:os';

import { isSameProcessAlive } from './process.js';
import {
  CORRUPT_LOCK_GRACE_MS,
  HEARTBEAT_STALE_MS,
  LOCK_TOKEN_ENV,
  dataOpLabel,
  type DataDirLockPayload,
  type DataOpKind,
} from './types.js';

export interface LockSnapshot {
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

export function readLockSnapshot(lockPath: string): LockSnapshot {
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

export function lockFileAgeMs(lockPath: string): number | undefined {
  try {
    return Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * 陈旧判定。**不使用墙钟超时**：长时间运行的合法任务永远不会被抢锁。
 */
export function isStale(lockPath: string, snapshot: LockSnapshot): boolean {
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

export function sameObservedLock(a: LockSnapshot, b: LockSnapshot): boolean {
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
export function inheritedFromParent(holder: DataDirLockPayload | undefined): boolean {
  if (!holder) return false;
  if (holder.host && holder.host !== hostname()) return false;
  if (holder.token.length === 0) return false;
  const envToken = process.env[LOCK_TOKEN_ENV];
  return typeof envToken === 'string' && envToken.length > 0 && envToken === holder.token;
}

export function busyMessage(holder: DataDirLockPayload | undefined): string {
  if (!holder) return '数据目录正被另一个任务占用，请稍后重试。';
  const label = dataOpLabel(holder.kind);
  return `数据目录正被另一个发票助手实例或命令行任务占用（正在${label}，进程 ${holder.pid}），`
    + '请等待它结束后再试。';
}
