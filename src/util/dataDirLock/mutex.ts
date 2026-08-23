import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

import { readProcessStartId, isSameProcessAlive } from './process.js';
import {
  lockFileAgeMs,
  readLockSnapshot,
  sameObservedLock,
  type LockSnapshot,
} from './snapshot.js';
import { CORRUPT_LOCK_GRACE_MS, type DataDirLockPayload } from './types.js';

/**
 * 独占地把**完整内容**放到锁路径上。
 *
 * 不能直接 `openSync(lockPath,'wx')` 然后再写：那样在 open 与 write 之间锁文件是
 * **空文件**，并发读者会把它解析失败当成「损坏 ⇒ 陈旧」并抢锁，于是出现双持有者
 * （已由并发压测复现）。这里先把内容写进唯一临时文件，再用 `link()` 把它挂到锁路径：
 * `link` 既是原子的，也在目标已存在时报 EEXIST，因此读者只可能看到完整内容。
 * 某些文件系统不支持硬链接，此时退回 `wx` 路径，并由 `isStale()` 的宽限期兜底。
 */
function createLockExclusive(lockPath: string, text: string, token: string): 'ok' | 'exists' | 'error' {
  const staging = `${lockPath}.new-${token}`;
  try {
    writeFileSync(staging, text, { encoding: 'utf8', mode: 0o600 });
  } catch {
    return 'error';
  }
  try {
    linkSync(staging, lockPath);
    return 'ok';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return 'exists';
    // 文件系统不支持 link（EPERM/ENOSYS/EXDEV/EOPNOTSUPP…）：退回 wx。
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try {
        writeFileSync(fd, text);
      } finally {
        closeSync(fd);
      }
      return 'ok';
    } catch (fallbackErr) {
      return (fallbackErr as NodeJS.ErrnoException).code === 'EEXIST' ? 'exists' : 'error';
    }
  } finally {
    try {
      rmSync(staging, { force: true });
    } catch {
      // best-effort
    }
  }
}

export function writeLockExclusive(lockPath: string, payload: DataDirLockPayload): 'ok' | 'exists' | 'error' {
  return createLockExclusive(lockPath, `${JSON.stringify(payload)}\n`, payload.token);
}

/**
 * recovery mutex payload：持有者进程身份 + token，崩溃后可按 PID/startId 回收（OCR-04）。
 * 若 mutex 只有 token/时间戳、没有进程身份，崩溃会永久卡死数据目录——比原 bug 更糟。
 */
interface RecoveryMutexPayload {
  token: string;
  pid: number;
  processStartId: string;
  startedAt: number;
}

function recoveryMutexPath(lockPath: string): string {
  return `${lockPath}.recovery`;
}

function parseRecoveryMutex(text: string): RecoveryMutexPayload | undefined {
  try {
    const raw = JSON.parse(text.trim()) as Partial<RecoveryMutexPayload>;
    if (typeof raw.token !== 'string' || raw.token.length === 0) return undefined;
    if (typeof raw.pid !== 'number' || !Number.isInteger(raw.pid)) return undefined;
    return {
      token: raw.token,
      pid: raw.pid,
      processStartId: typeof raw.processStartId === 'string' ? raw.processStartId : '',
      startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0,
    };
  } catch {
    // 兼容旧格式 `token\ntimestamp\n`：无进程身份，视为陈旧可回收，避免永久死锁。
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines[0] && lines[0].length > 0) {
      return {
        token: lines[0],
        pid: -1,
        processStartId: '',
        startedAt: Number(lines[1]) || 0,
      };
    }
    return undefined;
  }
}

function readRecoveryMutex(lockPath: string): RecoveryMutexPayload | undefined {
  try {
    return parseRecoveryMutex(readFileSync(recoveryMutexPath(lockPath), 'utf8'));
  } catch {
    return undefined;
  }
}

function isRecoveryMutexStale(holder: RecoveryMutexPayload): boolean {
  // 旧格式 / 无效 pid：一律可回收（崩溃遗留的无身份 mutex 不得永久阻塞）。
  if (holder.pid <= 0) return true;
  return !isSameProcessAlive(holder.pid, holder.processStartId);
}

/**
 * 独立 recovery mutex：所有 acquire / reclaim / payload 改写必须先持有它。
 * - 消除「A rename 走 B 的新锁…」双持有者窗口（OCR-04）
 * - 持有者崩溃后按 pid+processStartId 回收，禁止永久死锁（OCR-04 rework）
 * - handoff 与 heartbeat 共享同一临界区，避免父心跳覆盖子 handoff（OCR-02）
 */
export function tryAcquireRecoveryMutex(lockPath: string, token: string): boolean {
  const mutexPath = recoveryMutexPath(lockPath);
  const payload: RecoveryMutexPayload = {
    token,
    pid: process.pid,
    processStartId: readProcessStartId(process.pid),
    startedAt: Date.now(),
  };
  const text = `${JSON.stringify(payload)}\n`;
  const created = createLockExclusive(mutexPath, text, token);
  if (created === 'ok') return true;
  if (created !== 'exists') return false;

  // 目标已存在：仅当持有者确已死亡时 CAS 回收。
  let existingText: string;
  try {
    existingText = readFileSync(mutexPath, 'utf8');
  } catch {
    return false;
  }
  const existing = parseRecoveryMutex(existingText);
  // 损坏/无身份：超过宽限期才抢；刚创建的空窗交给下次重试。
  if (!existing) {
    const age = lockFileAgeMs(mutexPath);
    if (age === undefined || age <= CORRUPT_LOCK_GRACE_MS) return false;
  } else if (!isRecoveryMutexStale(existing)) {
    return false;
  }

  const graveyard = `${mutexPath}.stale-${token}`;
  try {
    renameSync(mutexPath, graveyard);
  } catch {
    return false;
  }
  // 确认搬走的仍是我们判定为陈旧的那一份。
  let movedText: string | undefined;
  try {
    movedText = readFileSync(graveyard, 'utf8');
  } catch {
    movedText = undefined;
  }
  const moved = movedText !== undefined ? parseRecoveryMutex(movedText) : undefined;
  const same =
    existing && moved
      ? existing.token === moved.token && existing.pid === moved.pid && existing.startedAt === moved.startedAt
      : existingText === movedText;
  if (!same) {
    // 不是预期的陈旧 mutex：尽力放回，失败则保留墓碑。
    if (movedText !== undefined) {
      const put = createLockExclusive(mutexPath, movedText, `restore-mtx-${token}`);
      if (put === 'ok') {
        try { rmSync(graveyard, { force: true }); } catch { /* best-effort */ }
      }
    } else {
      try { renameSync(graveyard, mutexPath); } catch { /* keep graveyard */ }
    }
    return false;
  }
  try { rmSync(graveyard, { force: true }); } catch { /* best-effort */ }

  const recreated = createLockExclusive(mutexPath, text, token);
  return recreated === 'ok';
}

/** 仅当磁盘 mutex 仍是本 token 时删除；防止误删别人刚拿到的 mutex。 */
export function releaseRecoveryMutex(lockPath: string, token: string): void {
  const mutexPath = recoveryMutexPath(lockPath);
  try {
    const holder = readRecoveryMutex(lockPath);
    if (holder && holder.token.length > 0 && holder.token !== token) return;
    rmSync(mutexPath, { force: true });
  } catch {
    // best-effort
  }
}

export function sleepSync(ms: number): void {
  // 获取锁路径上允许极短同步退避；避免空转烧 CPU。
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // spin
    }
  }
}

/**
 * CAS 方式回收陈旧锁。**必须在持有 recovery mutex 时调用**。
 * `rename` 是原子的；若搬走的不是观察到的那把，必须尝试原样放回，且恢复失败时
 * **保留墓碑**供诊断，绝不能静默删除导致别人的 token 消失（OCR-04）。
 */
export function reclaimStaleLock(lockPath: string, observed: LockSnapshot, token: string): boolean {
  const graveyard = `${lockPath}.stale-${token}`;
  try {
    renameSync(lockPath, graveyard);
  } catch {
    // 别人已经先一步回收，或持有者正好释放了：重新读一次即可。
    return false;
  }

  const moved = readLockSnapshot(graveyard);
  if (!sameObservedLock(observed, moved)) {
    // 搬走的不是我们判定为陈旧的那一把（中途换了持有者）：原样放回去。
    let restored = false;
    if (moved.raw !== undefined) {
      const put = createLockExclusive(lockPath, moved.raw, `restore-${token}`);
      restored = put === 'ok';
      if (!restored && put === 'exists') {
        // 锁路径上已有别人的新锁：绝不能覆盖。保留墓碑以便人工/下次诊断。
        restored = false;
      }
    } else {
      try {
        renameSync(graveyard, lockPath);
        restored = true;
      } catch {
        restored = false;
      }
    }
    if (restored) {
      try {
        rmSync(graveyard, { force: true });
      } catch {
        // best-effort
      }
    }
    // 恢复失败：保留墓碑，返回 false 让调用方整体获取失败，不得假装成功。
    return false;
  }

  try {
    rmSync(graveyard, { force: true });
  } catch {
    // 墓碑文件残留不影响正确性，下次回收会覆盖同名文件。
  }
  return true;
}

export function ownsLock(lockPath: string, token: string): boolean {
  const holder = readLockSnapshot(lockPath).payload;
  return holder !== undefined && holder.token.length > 0 && holder.token === token;
}

/**
 * 假定调用方已持有 recovery mutex：原子改写锁 payload。
 * handoff（在 acquire 临界区内）与 heartbeat（自行取 mutex）共用，
 * 避免「父心跳读旧 payload → 子 handoff → 父 rename 覆盖」竞态（OCR-02）。
 */
export function rewriteLockPayloadUnlocked(
  lockPath: string,
  token: string,
  mutate: (current: DataDirLockPayload) => DataDirLockPayload | null,
): DataDirLockPayload | undefined {
  if (!token) return undefined;
  const tmp = `${lockPath}.rw-${token}.tmp`;
  try {
    const current = readLockSnapshot(lockPath).payload;
    if (!current || current.token.length === 0 || current.token !== token) return undefined;
    const next = mutate(current);
    if (!next) return undefined;
    // 所有权凭证不可被 mutate 篡改。
    next.token = token;
    writeFileSync(tmp, `${JSON.stringify(next)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, lockPath);
    // 读回校验：token 仍属于我们，且关键身份与写入一致。
    const verified = readLockSnapshot(lockPath).payload;
    if (!verified || verified.token !== token) return undefined;
    if (verified.pid !== next.pid || verified.processStartId !== next.processStartId) return undefined;
    return verified;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort
    }
    return undefined;
  }
}

/**
 * 自行获取 recovery mutex 后改写 payload（心跳路径）。
 * mutex token 使用锁 token，与 handoff/acquire 串行化。
 */
export function rewriteLockPayload(
  lockPath: string,
  token: string,
  mutate: (current: DataDirLockPayload) => DataDirLockPayload | null,
): DataDirLockPayload | undefined {
  if (!token) return undefined;
  if (!tryAcquireRecoveryMutex(lockPath, token)) return undefined;
  try {
    return rewriteLockPayloadUnlocked(lockPath, token, mutate);
  } finally {
    releaseRecoveryMutex(lockPath, token);
  }
}
