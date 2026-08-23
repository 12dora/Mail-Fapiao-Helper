import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname } from 'node:path';

import { handoffOwnership, makeOwnedLease } from './lease.js';
import {
  ownsLock,
  reclaimStaleLock,
  releaseRecoveryMutex,
  sleepSync,
  tryAcquireRecoveryMutex,
  writeLockExclusive,
} from './mutex.js';
import { readProcessStartId } from './process.js';
import { busyMessage, inheritedFromParent, isStale, readLockSnapshot } from './snapshot.js';
import {
  LOCK_JOB_ID_ENV,
  LOCK_TOKEN_ENV,
  MAX_ACQUIRE_ATTEMPTS,
  RECOVERY_MUTEX_BACKOFF_MS,
  dataDirLockPath,
  type AcquireDataDirLockResult,
  type DataDirLease,
  type DataDirLockPayload,
  type DataOpKind,
} from './types.js';

/**
 * 获取数据目录锁。返回的 lease 必须在命令结束、异常与信号退出路径上释放。
 */
export function acquireDataDirLock(
  dataDir: string,
  kind: DataOpKind,
  jobId: string = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
): AcquireDataDirLockResult {
  const lockPath = dataDirLockPath(dataDir);

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
    token: randomBytes(16).toString('hex'),
    heartbeatAt: Date.now(),
    processStartId: readProcessStartId(process.pid),
  };

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    // 整个观察/回收/创建临界区必须持有 recovery mutex（OCR-04）。
    if (!tryAcquireRecoveryMutex(lockPath, payload.token)) {
      sleepSync(RECOVERY_MUTEX_BACKOFF_MS);
      continue;
    }
    try {
      const snapshot = readLockSnapshot(lockPath);

      if (snapshot.payload && inheritedFromParent(snapshot.payload)) {
        // 显式 handoff：子进程接管 ownership，父崩溃后锁仍显示子 PID 存活（OCR-02）。
        const handed = handoffOwnership(lockPath, snapshot.payload);
        if (handed) {
          // jobId 优先用环境变量里父进程下发的值。
          const envJob = process.env[LOCK_JOB_ID_ENV];
          if (envJob && envJob.length > 0) handed.jobId = envJob;
          return { ok: true, lease: makeOwnedLease(lockPath, handed, true) };
        }
        // handoff 失败：token 仍匹配时不能抢锁，报占用。
        return {
          ok: false,
          code: 'data_dir_locked_externally',
          message: busyMessage(snapshot.payload),
          holder: snapshot.payload,
        };
      }

      if (!snapshot.present) {
        const created = writeLockExclusive(lockPath, payload);
        if (created === 'error') {
          return {
            ok: false,
            code: 'data_dir_lock_failed',
            message: '无法在数据目录上写入锁文件，请确认数据目录可写后重试。',
            holder: undefined,
          };
        }
        if (created === 'exists') continue; // 被抢先，重新观察
        // CAS 读回校验：确认磁盘上的确实是自己的 token。
        if (ownsLock(lockPath, payload.token)) {
          return { ok: true, lease: makeOwnedLease(lockPath, payload, false) };
        }
        continue;
      }

      if (!isStale(lockPath, snapshot)) {
        return {
          ok: false,
          code: 'data_dir_locked_externally',
          message: busyMessage(snapshot.payload),
          holder: snapshot.payload,
        };
      }

      // 陈旧锁：在 mutex 内 CAS 回收后，同轮继续创建。
      if (!reclaimStaleLock(lockPath, snapshot, payload.token)) {
        continue;
      }
      const created = writeLockExclusive(lockPath, payload);
      if (created === 'ok' && ownsLock(lockPath, payload.token)) {
        return { ok: true, lease: makeOwnedLease(lockPath, payload, false) };
      }
    } finally {
      releaseRecoveryMutex(lockPath, payload.token);
    }
  }

  const finalSnapshot = readLockSnapshot(lockPath);
  return {
    ok: false,
    code: 'data_dir_locked_externally',
    message: busyMessage(finalSnapshot.payload),
    holder: finalSnapshot.payload,
  };
}

/**
 * 父进程给子进程下发租约时应该注入的环境变量。Electron 侧 spawn CLI 时用它，
 * 子进程就能凭 token 判定继承，而不再依赖 `process.ppid`。
 */
export function leaseEnvForChild(lease: Pick<DataDirLease, 'token' | 'jobId'>): Record<string, string> {
  return {
    [LOCK_TOKEN_ENV]: lease.token,
    [LOCK_JOB_ID_ENV]: lease.jobId,
  };
}
