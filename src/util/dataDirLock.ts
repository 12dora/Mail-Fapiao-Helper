/**
 * 数据目录跨进程锁（APP-05）——**不依赖 Electron** 的共享实现。
 *
 * 协议（GUI 的 `src/electron/opCoordinator.ts` 必须与此完全一致，否则两侧会各锁各的）：
 * - 锁文件路径：`<dataDir>/.mfh-cache/mfh-data.lock`，内容是一行 JSON；
 * - 独占创建：先把完整内容写进唯一临时文件，再 `link()` 到锁路径（原子、且目标已存在
 *   时报 EEXIST）。**不能**用 `open(wx)` 之后再写内容：那会留下一个「文件已存在但还是
 *   空的」窗口，并发读者会把它当成损坏锁抢走，从而出现双持有者（已由并发压测复现）；
 *   不支持硬链接的文件系统退回 `wx`，由 `isStale()` 的宽限期兜底；
 * - payload 字段：`pid` / `host` / `kind` / `jobId` / `startedAt` / `token` /
 *   `heartbeatAt` / `processStartId`；
 * - `token` 是 16 字节随机 hex，是**唯一的所有权凭证**：释放、回收校验、子进程继承
 *   都只认 token，不认 pid；
 * - `processStartId` 是平台进程出生标识，用于区分「PID 仍存活」与「PID 被无关进程
 *   复用」；缺失时退回纯 PID 判定（旧锁兼容）；
 * - 继承租约会做 **handoff**：子进程把 payload 的 pid/processStartId 原子更新为自己，
 *   并接管 heartbeat/release，避免父进程崩溃后锁被误回收（OCR-02）；
 * - 持锁期间每 `HEARTBEAT_INTERVAL_MS` 用「临时文件 + rename」原子刷新 `heartbeatAt`，
 *   刷新前先读回磁盘并校验 token，保留 handoff 写入的字段；
 * - 陈旧判定**绝不使用墙钟超时**：只有「锁文件损坏/读不出」或「同主机且持有者进程
 *   确已死亡/PID 复用」才算陈旧。活着的持有者永远不会被抢锁；跨主机的锁无法证明死亡，
 *   一律视为有效；
 * - 所有 acquire / reclaim 都先持有独立 recovery mutex，消除「rename 搬走新锁」的
 *   空窗（OCR-04）；CAS 恢复失败时保留墓碑，不得静默丢掉别人的锁。
 */

export { acquireDataDirLock, leaseEnvForChild } from './dataDirLock/acquire.js';
export { isSameProcessAlive, readProcessStartId } from './dataDirLock/process.js';
export { readDataDirLock } from './dataDirLock/snapshot.js';
export {
  LOCK_JOB_ID_ENV,
  LOCK_TOKEN_ENV,
  dataDirLockPath,
  dataOpLabel,
  resolveDataDir,
  type AcquireDataDirLockResult,
  type DataDirHints,
  type DataDirLease,
  type DataDirLockPayload,
  type DataOpKind,
} from './dataDirLock/types.js';
