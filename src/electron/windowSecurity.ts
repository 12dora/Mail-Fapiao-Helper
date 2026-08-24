import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as ElectronAPI from 'electron';
import type { RunningOp } from './opCoordinator.js';

export interface WindowSecurityDeps {
  BrowserWindow: typeof ElectronAPI.BrowserWindow;
  ipcMain: typeof ElectronAPI.ipcMain;
  rootDir: string;
  e2eNoGuiMode: () => boolean;
  uiPath: (...parts: string[]) => string;
  sendToRenderer: (channel: string, data: Record<string, unknown>) => void;
  coordinatorState: () => { running: RunningOp | null };
}

export const UNTRUSTED_SENDER = {
  ok: false as const,
  code: 'untrusted_sender',
  message: '无权执行此操作。',
  error: '无权执行此操作。',
};

/** op-state 只暴露运行态枚举，不把锁文件路径/token 泄漏给 renderer（ELEC-07）。 */
export function sanitizeOpState(state: { running: RunningOp | null }): { running: RunningOp | null } {
  if (!state.running) return { running: null };
  return {
    running: {
      kind: state.running.kind,
      jobId: state.running.jobId,
      startedAt: state.running.startedAt,
    },
  };
}

export function createWindowSecurity(deps: WindowSecurityDeps): {
  createWindow: () => void;
  getMainWindow: () => ElectronAPI.BrowserWindow | undefined;
  appPagesRoot: () => string;
  isCanonicalAppPageUrl: (url: string) => boolean;
  assertTrustedSender: (event: ElectronAPI.IpcMainInvokeEvent) => boolean;
  handleTrusted: (
    channel: string,
    handler: (event: ElectronAPI.IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>,
  ) => void;
} {
  let mainWindow: ElectronAPI.BrowserWindow | undefined;

  /** 应用内页面根目录（gui-design/pages）。 */
  function appPagesRoot(): string {
    return deps.uiPath('pages');
  }

  /**
   * 判定 URL 是否为本应用合法 GUI 页面（ELEC-01）。
   * 必须是 file: 且 realpath 落在 gui-design/pages 下的 .html。
   */
  function isCanonicalAppPageUrl(url: string): boolean {
    if (typeof url !== 'string' || !url.startsWith('file:')) return false;
    try {
      const filePath = fileURLToPath(url.split('?')[0]!.split('#')[0]!);
      let pagesRoot: string;
      try {
        pagesRoot = fs.realpathSync(appPagesRoot());
      } catch {
        pagesRoot = path.resolve(appPagesRoot());
      }
      let realFile: string;
      try {
        realFile = fs.realpathSync(filePath);
      } catch {
        // 页面文件必须真实存在；失败则拒绝。
        return false;
      }
      const rel = path.relative(pagesRoot, realFile);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
      return rel.toLowerCase().endsWith('.html') && !rel.includes('..');
    } catch {
      return false;
    }
  }

  function createWindow(): void {
    const noGui = deps.e2eNoGuiMode();
    mainWindow = new deps.BrowserWindow({
      width: 1180,
      height: 780,
      show: !noGui,
      minWidth: 900,
      minHeight: 640,
      title: '发票助手',
      backgroundColor: '#f6f7f9',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      webPreferences: {
        preload: path.join(deps.rootDir, 'electron', 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    // ELEC-01：只允许导航到本应用 gui-design/pages 下的 file: 页面，并禁止 window.open。
    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (!isCanonicalAppPageUrl(url)) event.preventDefault();
    });
    mainWindow.webContents.on('will-frame-navigate', (event) => {
      // 子 frame 一律拒绝导航到站外；主 frame 同样只允许应用页面。
      if (!isCanonicalAppPageUrl(event.url)) event.preventDefault();
    });
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // 新窗口（含 macOS 从 Dock 重开）需要立刻知道是否已有任务在跑。
    mainWindow.webContents.once('did-finish-load', () => {
      deps.sendToRenderer('op-state', sanitizeOpState(deps.coordinatorState()) as unknown as Record<string, unknown>);
    });
    void mainWindow.loadFile(deps.uiPath('pages', 'dashboard.html'));
  }

  function getMainWindow(): ElectronAPI.BrowserWindow | undefined {
    return mainWindow;
  }

  /**
   * 只接受主窗口 mainFrame 当前加载的应用页面作为 IPC 调用方（ELEC-01）。
   * - 要求 senderFrame === webContents.mainFrame（拒绝 iframe / 子 frame）
   * - URL 必须是 canonical app page
   * - 在任何 await dialog 之后必须重新调用本函数
   */
  function assertTrustedSender(event: ElectronAPI.IpcMainInvokeEvent): boolean {
    try {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return false;
      if (event.sender.isDestroyed()) return false;
      if (event.sender.id !== mainWindow.webContents.id) return false;
      const mainFrame = event.sender.mainFrame;
      if (!mainFrame || event.senderFrame == null || event.senderFrame !== mainFrame) return false;
      const url = event.senderFrame.url || event.sender.getURL();
      if (!isCanonicalAppPageUrl(url)) return false;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 中央 IPC 入口：每个 handler 在执行前强制 trusted-sender 校验（ELEC-01）。
   * 破坏性操作在 await dialog 之后还会再次调用 assertTrustedSender。
   */
  function handleTrusted(
    channel: string,
    handler: (event: ElectronAPI.IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>,
  ): void {
    deps.ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!assertTrustedSender(event)) return { ...UNTRUSTED_SENDER };
      return handler(event, ...args);
    });
  }

  return { createWindow, getMainWindow, appPagesRoot, isCanonicalAppPageUrl, assertTrustedSender, handleTrusted };
}
