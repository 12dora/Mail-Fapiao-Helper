import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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

/**
 * 读取平台进程出生标识，用于把「PID 存活」与「PID 被无关进程复用」区分开（OCR-06）。
 * 取不到时返回空串，调用方退回纯 PID 判定。
 */
export function readProcessStartId(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) return '';
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // comm 可能含空格/括号：以最后一个 ')' 为界，其后字段从 state 起算。
      const close = stat.lastIndexOf(')');
      if (close < 0) return '';
      const rest = stat.slice(close + 2).split(' ');
      // /proc/pid/stat 字段 22 = starttime → 在 rest 中下标 19。
      const starttime = rest[19];
      return typeof starttime === 'string' && starttime.length > 0 ? starttime : '';
    }
    if (process.platform === 'darwin') {
      const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return out;
    }
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
        ],
        {
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      ).trim();
      return out;
    }
  } catch {
    return '';
  }
  return '';
}

/**
 * 判断记录中的 pid + processStartId 是否仍指向同一进程。
 * - PID 已死 → false
 * - 有 startId 且与当前不符 → PID 复用 → false
 * - 取不到当前 startId 时保守认为仍存活（避免误抢活锁）
 */
export function isSameProcessAlive(pid: number, processStartId: string | undefined): boolean {
  if (!isProcessAlive(pid)) return false;
  if (!processStartId || processStartId.length === 0) return true;
  const current = readProcessStartId(pid);
  // 取不到当前标识时保守：按存活处理，宁可阻塞也不双持有。
  if (!current) return true;
  return current === processStartId;
}
