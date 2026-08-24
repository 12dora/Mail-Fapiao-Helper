import type * as ElectronAPI from 'electron';
import type { TerminateSummary } from './procTree.js';
import { redactPath, sanitizeText } from './sanitize.js';

// ---------------------------------------------------------------------------
// 应用生命周期
// ---------------------------------------------------------------------------

export interface LifecycleProcessRegistry {
  size: () => number;
  clear: () => void;
  terminate: () => Promise<TerminateSummary>;
}

export interface LifecycleDeps {
  app: typeof ElectronAPI.app;
  BrowserWindow: typeof ElectronAPI.BrowserWindow;
  dialog: Pick<typeof ElectronAPI.dialog, 'showErrorBox'>;
  hasSingleInstanceLock: boolean;
  dataDir: string;
  e2eNoGuiMode: () => boolean;
  ensureUserDataConfig: () => void;
  cleanupStaleTempDirs: () => void;
  cleanupAllTempDirs: () => void;
  invoicesDirPath: () => string;
  recoverArchiveTransactions: (invoicesDir: string) => unknown;
  recoverOcrRerunJournals: () => unknown;
  loadDevFakeBackend: () => Promise<void>;
  createWindow: () => void;
  coordinatorDispose: () => void;
  activeChildren: LifecycleProcessRegistry;
}

export interface InstalledLifecycle {
  recoverPendingArchives: () => void;
  fatalStartupError: (err: unknown) => void;
  bootstrapApp: () => Promise<void>;
}

export function installLifecycle(deps: LifecycleDeps): InstalledLifecycle {
  /**
   * 回滚上次崩溃/强退留下的半成品归档事务（APP-04）。自动归档与手工归档共用同一份
   * journal，所以这里一次调用就能把两边的残留一起清掉。
   */
  function recoverPendingArchives(): void {
    try {
      deps.recoverArchiveTransactions(deps.invoicesDirPath());
    } catch {
      // 启动恢复只做 best-effort；真正写入前会走 strict gate 并返回可见错误。
    }
    try {
      deps.recoverOcrRerunJournals();
    } catch {
      // OCR 重跑 journal 恢复失败时保留现场，写入前 ensure 会再处理。
    }
  }

  /** ELEC-14：启动失败时给用户可操作的中文说明，而不是无窗口挂起。 */
  function fatalStartupError(err: unknown): void {
    const detail = sanitizeText(err instanceof Error ? err.message : String(err), { maxLength: 300 });
    const body = [
      '应用无法完成启动初始化。',
      '',
      `数据位置：${redactPath(deps.dataDir)}`,
      detail ? `原因：${detail}` : '',
      '',
      '请确认磁盘空间充足、数据目录可写后重新打开应用。',
    ].filter(Boolean).join('\n');
    try {
      if (!deps.e2eNoGuiMode()) {
        deps.dialog.showErrorBox('发票助手无法启动', body);
      }
    } catch {
      // ignore
    }
    try {
      deps.cleanupAllTempDirs();
      deps.coordinatorDispose();
    } catch {
      // ignore
    }
    deps.app.exit(1);
  }

  async function bootstrapApp(): Promise<void> {
    if (!deps.hasSingleInstanceLock) return;
    deps.ensureUserDataConfig();
    deps.cleanupStaleTempDirs();
    recoverPendingArchives();
    await deps.loadDevFakeBackend();
    deps.createWindow();
  }

  deps.app.whenReady().then(() => {
    void bootstrapApp().catch(fatalStartupError);
  });

  let quitCleanupStarted = false;
  /** ELEC-04：终止失败时保留锁，exit 钩子也不得 dispose。 */
  let preserveDataDirLockOnExit = false;
  deps.app.on('before-quit', (event) => {
    deps.cleanupAllTempDirs();
    if (quitCleanupStarted || deps.activeChildren.size() === 0) {
      if (!preserveDataDirLockOnExit) deps.coordinatorDispose();
      return;
    }
    // 等待 tracked children（及其 efapiao serve 孙进程）真正退出后再放行退出。
    quitCleanupStarted = true;
    event.preventDefault();
    void deps.activeChildren.terminate().then((summary) => {
      deps.activeChildren.clear();
      // ELEC-04 / NEW-DEFECT 4：remaining>0 **或** treeIncomplete 都必须保留锁。
      // 树级信号失败时孙进程（efapiao serve）可能仍存活，即使直接子进程已退出。
      if (summary.remaining > 0 || summary.treeIncomplete) {
        preserveDataDirLockOnExit = true;
        try {
          if (!deps.e2eNoGuiMode()) {
            const detail = summary.remaining > 0
              ? `仍有 ${summary.remaining} 个后台进程未退出。`
              : '后台进程树可能未完全终止。';
            deps.dialog.showErrorBox(
              '无法完全停止后台任务',
              `${detail}为保护数据，本次不会释放数据目录锁。请稍后重新打开应用。`,
            );
          }
        } catch {
          // ignore
        }
        deps.cleanupAllTempDirs();
        // 不调用 coordinator.dispose()，避免新实例在旧写者仍存活时立刻抢锁。
        deps.app.exit(1);
        return;
      }
      deps.coordinatorDispose();
      deps.cleanupAllTempDirs();
      deps.app.quit();
    });
  });

  process.on('exit', () => {
    deps.cleanupAllTempDirs();
    if (!preserveDataDirLockOnExit) {
      try {
        deps.coordinatorDispose();
      } catch {
        // ignore
      }
    }
  });

  deps.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') deps.app.quit();
  });

  deps.app.on('activate', () => {
    if (deps.e2eNoGuiMode()) return;
    if (deps.BrowserWindow.getAllWindows().length === 0) deps.createWindow();
  });

  return { recoverPendingArchives, fatalStartupError, bootstrapApp };
}
