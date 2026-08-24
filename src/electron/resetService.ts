import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type * as ElectronAPI from 'electron';
import { historyPath } from './summary.js';
import { dataDirLockPath } from '../util/dataDirLock.js';
import type { OpLease, RunningOp } from './opCoordinator.js';
import { redactPath, sanitizeText, type UiError } from './sanitize.js';

export interface ResetDeletionPlan {
  items: { label: string; target: string; relative: string }[];
  skippedExternal: string[];
  dataDirReal: string;
  configPathReal: string | undefined;
}

export interface ResetServiceDeps {
  app: Pick<typeof ElectronAPI.app, 'isPackaged'>;
  dialog: Pick<typeof ElectronAPI.dialog, 'showMessageBox'>;
  dataDir: string;
  configPath: string;
  statePath: string;
  realDataDir: () => string | undefined;
  resolveCanonicalPath: (target: string) => string | undefined;
  isCanonicallyInside: (target: string, root: string) => boolean;
  assertSafeToDeleteInsideDataDir: (target: string) => string | undefined;
  readConfigForPaths: () => Record<string, unknown>;
  asObject: (value: unknown) => Record<string, unknown>;
  e2eNoGuiMode: () => boolean;
  assertTrustedSender: (event: ElectronAPI.IpcMainInvokeEvent) => boolean;
  getMainWindow: () => ElectronAPI.BrowserWindow | undefined;
  currentOperation: () => RunningOp | null;
  acquireOperation: (kind: 'pipeline') =>
    | { ok: true; lease: OpLease }
    | { ok: false; response: Record<string, unknown> };
  ensureBaseDirectories: () => void;
  appSummary: () => unknown;
}

export function createResetService(deps: ResetServiceDeps): {
  isDisposableTestStorage: () => boolean;
  clearMfhCachePreservingLocks: () => { removed: boolean; detail?: string };
  freezeResetDeletionPlan: () => ResetDeletionPlan | { error: UiError };
  confirmReset: (
    event: ElectronAPI.IpcMainInvokeEvent,
  ) => Promise<Record<string, unknown> | undefined>;
  revalidatePlan: (
    snapshot: string,
  ) => { ok: true; plan: ResetDeletionPlan } | { ok: false; response: Record<string, unknown> };
  deleteResetItems: (plan: ResetDeletionPlan) => { removed: string[]; skippedExternal: string[] };
  finishReset: (result: { removed: string[]; skippedExternal: string[] }) => Record<string, unknown>;
  performDeveloperReset: (event: ElectronAPI.IpcMainInvokeEvent) => Promise<Record<string, unknown>>;
} {
  /**
   * 数据目录是否可证明为可丢弃的测试存储（E2E）。
   * 仅当未打包且数据目录位于系统临时目录下时，才允许跳过确认对话框。
   */
  function isDisposableTestStorage(): boolean {
    if (deps.app.isPackaged) return false;
    if (process.env.MFH_E2E_ALLOW_DESTRUCTIVE === '1' && process.env.MFH_DATA_DIR) {
      const base = deps.realDataDir();
      if (!base) return false;
      try {
        const tmp = fs.realpathSync(os.tmpdir());
        return deps.isCanonicallyInside(base, tmp);
      } catch {
        return false;
      }
    }
    if (!deps.e2eNoGuiMode() || !process.env.MFH_DATA_DIR) return false;
    const base = deps.realDataDir();
    if (!base) return false;
    try {
      const tmp = fs.realpathSync(os.tmpdir());
      return deps.isCanonicallyInside(base, tmp);
    } catch {
      return false;
    }
  }

  /**
   * 清空 `.mfh-cache` 的内容，但**保留**当前持有的数据目录锁与 recovery 相关文件
   * （NEW-DEFECT 1 / ELEC-02），避免 reset 过程中其它实例抢锁并发写。
   */
  function clearMfhCachePreservingLocks(): { removed: boolean; detail?: string } {
    const cacheDir = path.join(deps.dataDir, '.mfh-cache');
    const lockPath = dataDirLockPath(deps.dataDir);
    const preserveNames = new Set<string>();
    try {
      const lockReal = deps.resolveCanonicalPath(lockPath);
      if (lockReal) preserveNames.add(path.basename(lockReal));
    } catch {
      preserveNames.add(path.basename(lockPath));
    }
    // recovery mutex、墓碑、心跳临时文件都带锁文件名前缀。
    const lockBase = path.basename(lockPath);
    try {
      if (!fs.existsSync(cacheDir)) return { removed: false };
      for (const entry of fs.readdirSync(cacheDir, { withFileTypes: true })) {
        const name = entry.name;
        if (
          name === lockBase
          || name.startsWith(`${lockBase}.`)
          || name === `${lockBase}.recovery`
          || name.startsWith(`${lockBase}.stale-`)
          || name.startsWith(`${lockBase}.new-`)
          || name.startsWith(`${lockBase}.rw-`)
        ) {
          continue;
        }
        const full = path.join(cacheDir, name);
        const safe = deps.assertSafeToDeleteInsideDataDir(full);
        if (!safe) continue;
        try {
          fs.rmSync(safe, { recursive: true, force: true });
        } catch {
          // best-effort per entry
        }
      }
      return { removed: true };
    } catch (err) {
      return {
        removed: false,
        detail: sanitizeText(err instanceof Error ? err.message : String(err), { maxLength: 200 }),
      };
    }
  }

  /**
   * 在持锁后冻结不可变的规范删除计划（ELEC-01 rework 2）。
   * 路径全部 canonical；不在真实 dataDir 内的跳过。
   */
  function freezeResetDeletionPlan(): ResetDeletionPlan | { error: UiError } {
    const dataDirReal = deps.realDataDir();
    if (!dataDirReal) {
      return {
        error: {
          code: 'reset_data_dir_unresolvable',
          message: '无法确认数据目录的真实位置，已取消重置以保护文件。',
        },
      };
    }
    const configPathReal = deps.resolveCanonicalPath(deps.configPath);
    const cfg = deps.readConfigForPaths();
    const paths = deps.asObject(cfg.paths);
    const output = deps.asObject(cfg.output);
    const ocr = deps.asObject(cfg.ocr);
    const rename = deps.asObject(cfg.rename);
    const candidates: { label: string; value: unknown; special?: 'mfh-cache' }[] = [
      { label: '邮件缓存', value: paths.samples },
      { label: '归档发票', value: paths.invoices },
      { label: '待确认队列', value: paths.pending },
      { label: '归档台账', value: output.csv },
      { label: '识别结果', value: ocr.resultsCsv },
      { label: '整理输出目录', value: rename.organizedDir },
      { label: '运行状态', value: deps.statePath },
      { label: '运行记录', value: historyPath(deps.dataDir) },
      { label: '应用缓存', value: '.mfh-cache', special: 'mfh-cache' },
    ];
    const items: ResetDeletionPlan['items'] = [];
    const skippedExternal: string[] = [];
    for (const candidate of candidates) {
      const value = candidate.value;
      if (typeof value !== 'string' || value.length === 0) continue;
      const target = path.resolve(deps.dataDir, value);
      const canon = deps.resolveCanonicalPath(target);
      if (!canon) {
        skippedExternal.push(`${candidate.label}：无法确认路径，已跳过`);
        continue;
      }
      if (canon === dataDirReal) continue;
      if (configPathReal && canon === configPathReal) continue;
      if (!deps.isCanonicallyInside(canon, dataDirReal)) {
        if (fs.existsSync(canon)) skippedExternal.push(`${candidate.label}：${redactPath(canon)}`);
        continue;
      }
      // mfh-cache 特殊处理：删除时保留锁文件，用 relative 标记。
      items.push({
        label: candidate.label,
        target: candidate.special === 'mfh-cache' ? '__mfh_cache_preserve_lock__' : canon,
        relative: path.relative(dataDirReal, canon) || candidate.label,
      });
    }
    return { items, skippedExternal, dataDirReal, configPathReal };
  }

  async function confirmReset(event: ElectronAPI.IpcMainInvokeEvent): Promise<Record<string, unknown> | undefined> {
    const skipConfirm = isDisposableTestStorage();
    if (!skipConfirm) {
      if (deps.e2eNoGuiMode()) {
        return {
          ok: false,
          code: 'reset_confirmation_required',
          message: '无界面模式下拒绝清空数据：当前数据目录不是可证明的临时测试目录。',
          removed: [],
          skippedExternal: [],
        };
      }
      const first = await deps.dialog.showMessageBox(deps.getMainWindow()!, {
        type: 'warning',
        buttons: ['取消', '继续删除'],
        defaultId: 0,
        cancelId: 0,
        title: '清空应用管理的数据',
        message: '清空应用管理的数据（保留邮箱与保存设置）',
        detail: [
          '会永久删除应用内部保存的邮件、发票和行程单、待确认记录、识别结果及处理记录。',
          '邮箱与保存设置不会删除；你另选文件夹中的文件也不会删除。',
          '',
          '此操作不能撤销。',
        ].join('\n'),
      });
      // 对话框后重新校验 sender（ELEC-01）。
      if (!deps.assertTrustedSender(event)) {
        return { ok: false, code: 'untrusted_sender', message: '无权执行重置。', removed: [], skippedExternal: [] };
      }
      if (first.response !== 1) {
        return { ok: false, code: 'reset_cancelled', message: '已取消重置。', removed: [], skippedExternal: [] };
      }
      const second = await deps.dialog.showMessageBox(deps.getMainWindow()!, {
        type: 'warning',
        buttons: ['取消', '确定删除'],
        defaultId: 0,
        cancelId: 0,
        title: '再次确认',
        message: '再次确认：已归档的发票原件会被删除。',
        detail: '请先自行备份需要保留的文件。确定要删除吗？',
      });
      if (!deps.assertTrustedSender(event)) {
        return { ok: false, code: 'untrusted_sender', message: '无权执行重置。', removed: [], skippedExternal: [] };
      }
      if (second.response !== 1) {
        return { ok: false, code: 'reset_cancelled', message: '已取消重置。', removed: [], skippedExternal: [] };
      }
    }
    return undefined;
  }

  function revalidatePlan(
    planSnapshot: string,
  ): { ok: true; plan: ResetDeletionPlan } | { ok: false; response: Record<string, unknown> } {
    // 对话框期间 config 可能被改：重新冻结并与快照比对。
    const revalidated = freezeResetDeletionPlan();
    if ('error' in revalidated) {
      return { ok: false, response: { ok: false, ...revalidated.error, removed: [], skippedExternal: [] } };
    }
    const planNow = JSON.stringify(revalidated.items.map((i) => i.target).sort());
    if (planNow !== planSnapshot) {
      return {
        ok: false,
        response: {
          ok: false,
          code: 'reset_plan_changed',
          message: '等待确认期间保存位置发生了变化，已取消重置以保护文件。请重新操作。',
          removed: [],
          skippedExternal: [],
        },
      };
    }
    return { ok: true, plan: revalidated };
  }

  function deleteResetItems(plan: ResetDeletionPlan): { removed: string[]; skippedExternal: string[] } {
    const removed: string[] = [];
    const skippedExternal = [...plan.skippedExternal];
    for (const item of plan.items) {
      if (item.target === '__mfh_cache_preserve_lock__') {
        const cleared = clearMfhCachePreservingLocks();
        if (cleared.removed) removed.push(item.relative);
        else if (cleared.detail) skippedExternal.push(`${item.label}：清理失败`);
        continue;
      }
      const safe = deps.assertSafeToDeleteInsideDataDir(item.target);
      if (!safe) {
        skippedExternal.push(`${item.label}：路径校验失败，已跳过`);
        continue;
      }
      // 再次确认仍在冻结的 dataDir 内。
      if (!deps.isCanonicallyInside(safe, plan.dataDirReal)) {
        skippedExternal.push(`${item.label}：${redactPath(safe)}`);
        continue;
      }
      try {
        fs.rmSync(safe, { recursive: true, force: true });
        removed.push(item.relative);
      } catch {
        skippedExternal.push(`${item.label}：删除失败，请手动清理`);
      }
    }
    return { removed, skippedExternal };
  }

  function finishReset(result: { removed: string[]; skippedExternal: string[] }): Record<string, unknown> {
    deps.ensureBaseDirectories();
    return {
      ok: true,
      removed: Array.from(new Set(result.removed)),
      skippedExternal: Array.from(new Set(result.skippedExternal)),
      message: result.skippedExternal.length > 0
        ? '已重置应用管理的数据；配置指向应用目录之外的位置未被清理。'
        : '已重置应用管理的数据。',
      summary: deps.appSummary(),
    };
  }

  /**
   * ELEC-01：破坏性 reset 的授权在**主进程**用原生对话框完成。
   * - 先占锁并冻结删除计划，再弹确认（防止对话框期间 config IPC 改路径）
   * - 确认后重新校验 sender 与计划
   * - 删除使用 realpath containment
   * - no-GUI 仅在可丢弃测试存储上跳过确认
   */
  async function performDeveloperReset(event: ElectronAPI.IpcMainInvokeEvent): Promise<Record<string, unknown>> {
    if (!deps.assertTrustedSender(event)) {
      return { ok: false, code: 'untrusted_sender', message: '无权执行重置。', removed: [], skippedExternal: [] };
    }

    if (deps.currentOperation()) {
      const running = deps.currentOperation();
      return {
        ok: false,
        code: 'operation_busy',
        message: running
          ? `当前正在${running.kind === 'fetch' ? '获取邮件' : running.kind === 'pipeline' ? '处理邮件' : running.kind === 'ocr' ? '识别文件' : '整理文件'}，请等待完成后再重置。`
          : '当前有任务正在运行，请等待完成后再重置。',
        running: running ? { kind: running.kind, jobId: running.jobId, startedAt: running.startedAt } : null,
        removed: [],
        skippedExternal: [],
        summary: deps.appSummary(),
      };
    }

    // MUST-REWORK 2：先占锁并冻结计划，再弹确认。
    const gate = deps.acquireOperation('pipeline');
    if (!gate.ok) {
      return { ...gate.response, removed: [], skippedExternal: [] };
    }

    try {
      const frozen = freezeResetDeletionPlan();
      if ('error' in frozen) {
        return { ok: false, ...frozen.error, removed: [], skippedExternal: [] };
      }
      const planSnapshot = JSON.stringify(frozen.items.map((i) => i.target).sort());

      const confirmation = await confirmReset(event);
      if (confirmation) return confirmation;

      const revalidated = revalidatePlan(planSnapshot);
      if (!revalidated.ok) return revalidated.response;
      return finishReset(deleteResetItems(revalidated.plan));
    } finally {
      gate.lease.release();
    }
  }

  return {
    isDisposableTestStorage,
    clearMfhCachePreservingLocks,
    freezeResetDeletionPlan,
    confirmReset,
    revalidatePlan,
    deleteResetItems,
    finishReset,
    performDeveloperReset,
  };
}
