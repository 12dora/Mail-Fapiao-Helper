import fs from 'node:fs';
import path from 'node:path';
import {
  ArchiveRecoveryError,
  assertArchiveTransactionsRecovered,
  isJournalShapeFailureReason,
  journalRecordInvalidReason,
} from '../download/archiveJournal.js';
import { isSameProcessAlive } from '../util/dataDirLock.js';
import { redactPath, sanitizeText, type UiError } from './sanitize.js';

/** journal 目录检查结果：缺席 / 有残留 / 无法判定（读错误）。 */
export type JournalPresence =
  | { kind: 'absent' }
  | { kind: 'residual'; names: string[] }
  | { kind: 'unreadable'; detail: string };

export interface ArchiveRecoveryDialog {
  showMessageBoxSync(options: {
    type: 'warning';
    buttons: string[];
    defaultId: number;
    cancelId: number;
    title: string;
    message: string;
    detail: string;
  }): number;
}

export interface ArchiveRecoveryDeps {
  invoicesDirPath: () => string;
  e2eNoGuiMode: () => boolean;
  dialog: ArchiveRecoveryDialog;
}

const archiveRecoveryFailures = new Map<string, UiError>();

export function createArchiveRecovery(deps: ArchiveRecoveryDeps) {
  function archiveRecoveryBlockedError(extra?: string): UiError {
    return {
      code: 'archive_recovery_blocked',
      // COPY-10：可执行动作；优先应用内隔离，而非让非技术用户改隐藏目录。
      message: '上次保存发票时中断，当前无法继续修改。请先关闭可能占用发票清单的表格程序，然后重试。若仍无法继续，可在「设置」中查看归档恢复状态并确认隔离未解决的恢复记录（隔离前请勿删除文件）。',
      detail: extra
        ? sanitizeText(extra, { maxLength: 300 })
        : '归档事务恢复未完成或仍有未解决的 journal，写入已停止。',
    };
  }

  /**
   * OCR-05 rework：journal 目录读错误 ≠ 无残留（fail closed）。
   * 只有确认目录不存在（ENOENT）才算 absent。
   */
  function inspectArchiveJournals(invoicesDir: string): JournalPresence {
    const dir = path.join(invoicesDir, '.journal');
    try {
      const names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
      return names.length === 0 ? { kind: 'absent' } : { kind: 'residual', names };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { kind: 'absent' };
      return {
        kind: 'unreadable',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * 判断单条 journal 是否仍由「存活进程」持有（含 startId，避免 PID 复用）。
   * 存活则不得隔离：进程崩溃前重写 journal 的证据不可丢。
   * 解析/形态失败视为非存活持有，可走确认隔离。
   */
  function archiveJournalHeldByLiveProcess(journalFilePath: string): boolean {
    try {
      const raw = JSON.parse(fs.readFileSync(journalFilePath, 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
      const rec = raw as Record<string, unknown>;
      const pid = typeof rec.pid === 'number' && Number.isInteger(rec.pid) ? rec.pid : NaN;
      if (!Number.isInteger(pid) || pid <= 0) return false;
      const processStartId = typeof rec.processStartId === 'string' ? rec.processStartId : undefined;
      return isSameProcessAlive(pid, processStartId);
    } catch {
      return false;
    }
  }

  /** 从 ArchiveRecoveryError / 嵌套 cause 提取机器可读 reason。 */
  function archiveRecoveryFailureReason(err: unknown): string {
    if (err instanceof ArchiveRecoveryError) return err.reason;
    if (err instanceof Error) {
      const withCause = err as Error & { cause?: unknown; reason?: unknown };
      if (typeof withCause.reason === 'string' && withCause.reason) return withCause.reason;
      if (withCause.cause !== undefined) {
        const nested = archiveRecoveryFailureReason(withCause.cause);
        if (nested && nested !== String(withCause.cause)) return nested;
      }
      return err.message;
    }
    return String(err);
  }

  /**
   * 主进程原生确认隔离（S7）。
   * 形态/解析失败与「可解析但无法自动清理」共用此入口，保证有可达恢复路径。
   * e2e 无 GUI 不弹窗，返回 false，保持 archive_recovery_blocked 契约。
   */
  function offerArchiveJournalQuarantineDialog(opts: {
    title: string;
    message: string;
    detail: string;
  }): boolean {
    if (deps.e2eNoGuiMode()) return false;
    try {
      const choice = deps.dialog.showMessageBoxSync({
        type: 'warning',
        buttons: ['隔离并继续', '取消'],
        defaultId: 1,
        cancelId: 1,
        title: opts.title,
        message: opts.message,
        detail: opts.detail,
      });
      if (choice === 0) {
        const quarantined = quarantineArchiveJournalsWithConfirm(true);
        return quarantined.ok === true;
      }
    } catch {
      // 对话框失败时视为未确认
    }
    return false;
  }

  function recoveryErrorForPresence(
    key: string,
    presence: JournalPresence,
    shapeFailureOnEntry: boolean,
  ): UiError | undefined {
    if (presence.kind === 'unreadable') {
      // fail closed：读错误 ≠ 无残留
      const error = archiveRecoveryBlockedError(`无法读取归档恢复记录：${presence.detail}`);
      archiveRecoveryFailures.set(key, error);
      return error;
    }

    // 形态失败却已无 journal：理论上不应出现；仍 fail closed 并提示设置页隔离入口。
    if (shapeFailureOnEntry && presence.kind === 'absent') {
      const error = archiveRecoveryBlockedError(
        '归档恢复记录形态异常，但未找到残留文件。请在「设置」中查看归档恢复状态后重试。',
      );
      archiveRecoveryFailures.set(key, error);
      return error;
    }
    return undefined;
  }

  function settleConfirmedQuarantine(key: string): UiError | undefined {
    // 确认隔离成功后再次检查：若仍有存活进程 journal 被跳过，不得放行。
    const after = inspectArchiveJournals(key);
    if (after.kind === 'absent') {
      archiveRecoveryFailures.delete(key);
      return undefined;
    }
    if (after.kind === 'unreadable') {
      const error = archiveRecoveryBlockedError(`无法读取归档恢复记录：${after.detail}`);
      archiveRecoveryFailures.set(key, error);
      return error;
    }
    const error = archiveRecoveryBlockedError(
      `仍有 ${after.names.length} 条未解决的归档恢复记录（可能属于正在运行的进程，已拒绝隔离）。`,
    );
    archiveRecoveryFailures.set(key, error);
    return error;
  }

  function handleResidualJournals(
    key: string,
    presence: JournalPresence,
    shapeFailureOnEntry: boolean,
  ): UiError | undefined {
    // B6a：绝不在未经用户确认时搬迁 journal。
    // 形态失败 / 残留均只导向确认 affordance（原生对话框或设置页），保持 fail-closed。
    const residual = presence.kind === 'residual'
      ? presence
      : inspectArchiveJournals(key);
    if (residual.kind === 'unreadable') {
      const error = archiveRecoveryBlockedError(`无法读取归档恢复记录：${residual.detail}`);
      archiveRecoveryFailures.set(key, error);
      return error;
    }
    if (residual.kind === 'absent') {
      // 形态失败标记但目录已空：仍 fail closed（见上方 shapeFailureOnEntry && absent）。
      if (shapeFailureOnEntry) {
        const error = archiveRecoveryBlockedError(
          '归档恢复记录形态异常，但未找到残留文件。请在「设置」中查看归档恢复状态后重试。',
        );
        archiveRecoveryFailures.set(key, error);
        return error;
      }
      archiveRecoveryFailures.delete(key);
      return undefined;
    }
    // residual.kind === 'residual'
    // S7：主进程原生确认隔离。形态失败与「可解析未清理」都走这里。
    // e2e 无 GUI 模式不弹窗，保持 archive_recovery_blocked 契约供测试断言。
    const dialogTitle = shapeFailureOnEntry ? '归档恢复记录无效' : '归档恢复未完成';
    const dialogMessage = shapeFailureOnEntry
      ? `发现 ${residual.names.length} 条无法自动处理的归档恢复记录`
      : `发现 ${residual.names.length} 条未解决的归档恢复记录`;
    const dialogDetail = shapeFailureOnEntry
      ? '恢复记录格式不正确或已损坏，无法自动回滚。隔离后可继续写入；证据会保留在数据目录的隔离副本中，请勿删除直至确认发票清单无误。也可稍后在「设置」中查看状态并确认隔离。'
      : '自动恢复无法清理这些记录。隔离后可继续写入；证据会保留在数据目录的隔离副本中，请勿删除直至确认发票清单无误。也可在「设置」中查看归档恢复状态并确认隔离。';
    if (offerArchiveJournalQuarantineDialog({
      title: dialogTitle,
      message: dialogMessage,
      detail: dialogDetail,
    })) {
      return settleConfirmedQuarantine(key);
    }
    // 用户未确认：阻断写入，指引人工隔离（绝不自动搬迁证据）。
    const error = archiveRecoveryBlockedError(
      `仍有 ${residual.names.length} 条未解决的归档恢复记录`,
    );
    archiveRecoveryFailures.set(key, error);
    return error;
  }

  function ensureArchiveRecoveryReady(): UiError | undefined {
    const key = path.resolve(deps.invoicesDirPath());
    let shapeFailureOnEntry = false;
    try {
      assertArchiveTransactionsRecovered(key);
    } catch (err) {
      const reason = archiveRecoveryFailureReason(err);
      // B6：形态/解析失败不得在此死锁——进入与 residual 相同的*确认*隔离恢复路径。
      // 禁止静默搬迁 journal；未确认前保持 fail-closed。
      if (isJournalShapeFailureReason(reason)) {
        shapeFailureOnEntry = true;
      } else {
        const error = archiveRecoveryBlockedError(
          err instanceof Error ? err.message : String(err),
        );
        archiveRecoveryFailures.set(key, error);
        return error;
      }
    }

    const presence = inspectArchiveJournals(key);
    const presenceError = recoveryErrorForPresence(key, presence, shapeFailureOnEntry);
    if (presenceError) return presenceError;

    if (presence.kind === 'residual' || shapeFailureOnEntry) {
      return handleResidualJournals(key, presence, shapeFailureOnEntry);
    }
    archiveRecoveryFailures.delete(key);
    return undefined;
  }

  /**
   * 应用内归档 journal 状态（NON-BLOCKING 3）：供设置页展示，不泄漏绝对路径。
   */
  function archiveJournalStatus(): Record<string, unknown> {
    const key = path.resolve(deps.invoicesDirPath());
    const presence = inspectArchiveJournals(key);
    const blocked = archiveRecoveryFailures.get(key);
    if (presence.kind === 'unreadable') {
      return {
        ok: false,
        code: 'archive_journal_unreadable',
        status: 'unreadable',
        message: '无法读取归档恢复记录（权限或 I/O 错误）。请检查磁盘权限后重试，勿当作「无残留」。',
        detail: sanitizeText(presence.detail, { maxLength: 200 }),
        residualCount: -1,
        blocked: true,
      };
    }
    if (presence.kind === 'absent') {
      return {
        ok: true,
        code: 'archive_journal_clear',
        status: 'clear',
        message: blocked
          ? '未发现残留恢复记录，但写入门禁仍可能因其他原因阻断。请重试操作。'
          : '没有未解决的归档恢复记录。',
        residualCount: 0,
        blocked: Boolean(blocked),
      };
    }
    // residual：区分「形态合法可解析」与「损坏/形态非法（可安全隔离）」
    const corrupt: string[] = [];
    const parseable: string[] = [];
    const dir = path.join(key, '.journal');
    for (const name of presence.names) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as unknown;
        const shapeReason = journalRecordInvalidReason(raw);
        if (shapeReason && isJournalShapeFailureReason(shapeReason)) {
          corrupt.push(name);
        } else {
          parseable.push(name);
        }
      } catch {
        corrupt.push(name);
      }
    }
    return {
      ok: false,
      code: 'archive_journal_residual',
      status: 'residual',
      message: `发现 ${presence.names.length} 条未解决的归档恢复记录（可解析 ${parseable.length}，损坏或格式无效 ${corrupt.length}）。可重试自动恢复，或在确认后隔离这些记录以解除写入阻断。`,
      residualCount: presence.names.length,
      parseableCount: parseable.length,
      corruptCount: corrupt.length,
      blocked: true,
      canQuarantine: true,
      ...(blocked?.detail ? { detail: blocked.detail } : {}),
    };
  }

  function moveQuarantineJournals(
    key: string,
    dir: string,
    movable: string[],
    skippedLive: string[],
  ): Record<string, unknown> {
    const dest = path.join(key, `.journal-quarantine-${Date.now()}`);
    try {
      fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
      let moved = 0;
      for (const name of movable) {
        fs.renameSync(path.join(dir, name), path.join(dest, name));
        moved++;
      }
      if (skippedLive.length === 0) {
        archiveRecoveryFailures.delete(key);
        return {
          ok: true,
          code: 'archive_journal_quarantined',
          message: `已隔离 ${moved} 条归档恢复记录。写入门禁已解除；隔离副本仍保留在数据目录中，请勿删除直至确认发票清单无误。`,
          quarantined: moved,
          dest: redactPath(dest),
        };
      }
      // 部分隔离：活进程条目仍在，不得解除门禁。
      const error = archiveRecoveryBlockedError(
        `已隔离 ${moved} 条记录，但仍有 ${skippedLive.length} 条属于正在运行的进程，写入仍阻断。`,
      );
      archiveRecoveryFailures.set(key, error);
      return {
        ok: false,
        code: 'archive_journal_partial_live_process',
        message: `已隔离 ${moved} 条归档恢复记录，但有 ${skippedLive.length} 条仍属于正在运行的进程，已跳过且写入门禁未解除。请等待当前任务结束后再试。`,
        quarantined: moved,
        skippedLive: skippedLive.length,
        dest: redactPath(dest),
        blocked: true,
      };
    } catch (err) {
      return {
        ok: false,
        code: 'archive_journal_quarantine_failed',
        message: '隔离归档恢复记录失败，请确认磁盘可写后重试。',
        detail: sanitizeText(err instanceof Error ? err.message : String(err), { maxLength: 200 }),
      };
    }
  }

  /**
   * 用户确认后隔离残留 journal（损坏 + 可解析但无法自动清理的条目）。
   * confirm 必须为 true；隔离到 `.journal-quarantine-<ts>`，**移动**不删除证据。
   * B6b：逐条检查存活进程；仍被活进程持有的 journal 绝不搬迁，并如实回报。
   * 调用方（IPC）须已持有操作租约；对话框路径在父操作租约内调用。
   */
  function quarantineArchiveJournalsWithConfirm(confirm: boolean): Record<string, unknown> {
    if (confirm !== true) {
      return {
        ok: false,
        code: 'archive_journal_confirm_required',
        message: '隔离归档恢复记录需要明确确认。请先查看状态后再确认操作。',
      };
    }
    const key = path.resolve(deps.invoicesDirPath());
    const presence = inspectArchiveJournals(key);
    if (presence.kind === 'unreadable') {
      return {
        ok: false,
        code: 'archive_journal_unreadable',
        message: '无法读取归档恢复记录，已拒绝隔离（权限错误不能当作无残留）。',
        detail: sanitizeText(presence.detail, { maxLength: 200 }),
      };
    }
    if (presence.kind === 'absent' || presence.names.length === 0) {
      archiveRecoveryFailures.delete(key);
      return {
        ok: true,
        code: 'archive_journal_clear',
        message: '没有需要隔离的归档恢复记录。',
        quarantined: 0,
      };
    }
    // 先尝试自动恢复，再隔离仍残留的条目（不得因 live_pid 抛错后无差别搬迁全部）。
    try {
      assertArchiveTransactionsRecovered(key);
    } catch {
      // 继续隔离路径；下方按条检查存活
    }
    const again = inspectArchiveJournals(key);
    if (again.kind === 'unreadable') {
      return {
        ok: false,
        code: 'archive_journal_unreadable',
        message: '恢复后仍无法读取归档记录，已拒绝隔离。',
        detail: sanitizeText(again.detail, { maxLength: 200 }),
      };
    }
    if (again.kind === 'absent' || again.names.length === 0) {
      archiveRecoveryFailures.delete(key);
      return {
        ok: true,
        code: 'archive_journal_recovered',
        message: '自动恢复已清除残留记录，无需隔离。',
        quarantined: 0,
      };
    }
    const dir = path.join(key, '.journal');
    const movable: string[] = [];
    const skippedLive: string[] = [];
    for (const name of again.names) {
      const journalPath = path.join(dir, name);
      if (archiveJournalHeldByLiveProcess(journalPath)) {
        skippedLive.push(name);
      } else {
        movable.push(name);
      }
    }
    if (movable.length === 0) {
      // 全部仍被活进程持有：拒绝搬迁，门禁保持阻断。
      return {
        ok: false,
        code: 'archive_journal_live_process',
        message: `有 ${skippedLive.length} 条归档恢复记录仍属于正在运行的进程，已拒绝隔离。请等待当前归档/处理任务结束后再试。`,
        quarantined: 0,
        skippedLive: skippedLive.length,
      };
    }
    return moveQuarantineJournals(key, dir, movable, skippedLive);
  }

  function recordArchiveRecoveryFailure(invoicesDir: string, error: UiError): void {
    archiveRecoveryFailures.set(path.resolve(invoicesDir), error);
  }

  return {
    archiveRecoveryBlockedError,
    inspectArchiveJournals,
    archiveJournalHeldByLiveProcess,
    archiveRecoveryFailureReason,
    offerArchiveJournalQuarantineDialog,
    ensureArchiveRecoveryReady,
    archiveJournalStatus,
    quarantineArchiveJournalsWithConfirm,
    recordArchiveRecoveryFailure,
  };
}

export type ArchiveRecovery = ReturnType<typeof createArchiveRecovery>;
