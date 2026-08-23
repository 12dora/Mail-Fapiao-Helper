import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import type { Config } from '../config.js';
import { log } from '../log.js';
import {
  acquireDataDirLock, resolveDataDir,
  type DataDirHints, type DataDirLease, type DataOpKind,
} from '../util/dataDirLock.js';

// ---------------------------------------------------------------------------
// 数据目录跨进程锁（APP-05）
// ---------------------------------------------------------------------------

/**
 * 本进程持有的数据目录租约。GUI 侧由 `OperationCoordinator` 持有同一把锁，
 * 两侧共用 `src/util/dataDirLock.ts` 描述的同一套锁文件协议，因此
 * 「GUI 挡住 CLI」「CLI 挡住 GUI」「两个 CLI 实例互斥」三条都成立。
 *
 * CORE-01：可能持有多把按路径排序的 per-target 锁（交集写目标仍互斥）。
 */
let activeDataDirLeases: DataDirLease[] = [];

/**
 * 规范化写目标路径：realpath 消除符号链接/大小写别名；路径尚不存在时
 * 回溯已存在祖先再拼回剩余段，保证同一物理目标得到同一字符串。
 */
export function canonicalizePath(p: string): string {
  const abs = resolve(p);
  try { return realpathSync(abs); } catch {
    // 目标尚不存在：规范化已存在的最长祖先。
    let current = abs;
    const missing: string[] = [];
    for (;;) {
      try {
        const real = realpathSync(current);
        return missing.length === 0 ? real : join(real, ...missing.reverse());
      } catch {
        const parent = dirname(current);
        if (parent === current) return abs;
        missing.push(basename(current));
        current = parent;
      }
    }
  }
}

export interface LockTargetOverrides {
  /** fetch --out 覆盖 samples 写目标。 */
  samplesDir?: string;
  /** 显式 state 路径（写入 state.json）。 */
  statePath?: string;
}

/**
 * CORE-01：收集本次命令的全部实际写目标（含 overrides），逐个 canonicalize。
 * 返回按字典序排序的去重列表，供 per-target 加锁或稳定 hash。
 */
export function collectWriteTargets(cfg: Config, overrides: LockTargetOverrides = {}): string[] {
  const samples = overrides.samplesDir ?? cfg.paths.samples;
  const statePath = overrides.statePath;
  const targets = [samples, cfg.paths.invoices, cfg.paths.pending, dirname(resolve(cfg.output.csv)), join(cfg.paths.invoices, 'ocr')];
  if (statePath && statePath.length > 0) targets.push(dirname(resolve(statePath)));
  const canon = targets.map((t) => canonicalizePath(t));
  return [...new Set(canon)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 从完整规范写目标集合推导稳定锁根：
 * - `MFH_DATA_DIR` 优先（与 GUI 对齐）
 * - 否则对排序后的目标集做 sha256，在「字典序最小目标」下挂 `.mfh-cache/scope-<hash12>`
 *   作为唯一锁目录——同一目标集永远同一把锁；目标集相交但不全等时，
 *   仍通过下方 per-target 锁覆盖交集。
 */
export function scopeLockDir(targets: string[]): string {
  const fromEnv = process.env.MFH_DATA_DIR;
  if (fromEnv && fromEnv.length > 0) return canonicalizePath(fromEnv);
  if (targets.length === 0) return process.cwd();
  const digest = createHash('sha256').update(targets.join('\0')).digest('hex').slice(0, 12);
  // 锁落在字典序最小目标旁，避免依赖公共祖先（公共祖先会随「其它」路径漂移）。
  const anchor = targets[0]!;
  return join(anchor, '.mfh-cache', `scope-${digest}`);
}

/**
 * 会写数据目录的命令入口统一走这里。拿不到锁时只打印中文提示，由调用方返回
 * 退出码 2，不抛栈。只读命令与 `--dry-run` 不需要调用本函数。
 *
 * 已加载 config 时必须传入 `cfg`，以便 CORE-01 按写目标持锁。
 */
export function acquireCommandLock(kind: DataOpKind, hints: DataDirHints, cfg?: Config, overrides: LockTargetOverrides = {}): boolean {
  if (!cfg) {
    const dataDir = resolveDataDir(hints);
    const result = acquireDataDirLock(dataDir, kind);
    if (!result.ok) { log.error(result.message); return false; }
    activeDataDirLeases = [result.lease];
    if (result.lease.inherited) log.debug(`data dir lock inherited from parent process (${result.lease.lockPath})`);
    return true;
  }
  const statePath = overrides.statePath ?? hints.statePath;
  const targets = collectWriteTargets(cfg, { samplesDir: overrides.samplesDir, statePath });
  // 稳定 scope 锁 + 每个写目标各一把，均按路径排序获取，避免死锁。
  // scope 保证「相同完整目标集」互斥；per-target 保证「交集写路径」互斥。
  const lockDirs = [...new Set([scopeLockDir(targets), ...targets])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const acquired: DataDirLease[] = [];
  for (const dir of lockDirs) {
    const result = acquireDataDirLock(dir, kind);
    if (!result.ok) {
      for (const lease of acquired) { try { lease.release(); } catch { /* best-effort */ } }
      log.error(result.message); return false;
    }
    acquired.push(result.lease);
    if (result.lease.inherited) log.debug(`data dir lock inherited from parent process (${result.lease.lockPath})`);
  }
  activeDataDirLeases = acquired;
  return true;
}

/** 幂等释放；正常结束、异常与信号退出三条路径都会走到。 */
export function releaseDataDirLock(): void {
  const leases = activeDataDirLeases;
  activeDataDirLeases = [];
  // 逆序释放。
  for (let i = leases.length - 1; i >= 0; i--) {
    try { leases[i]!.release(); } catch {
      // best-effort：释放失败会留下一把锁，下次由陈旧回收清理。
    }
  }
}
