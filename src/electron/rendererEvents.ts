import { terminalGuard, type ProgressSink } from './cliProtocol.js';
import { electron } from './electronApi.js';

const { BrowserWindow } = electron;

// ---------------------------------------------------------------------------
// 事件广播（COPY-01：统一脱敏后再进 IPC）
// ---------------------------------------------------------------------------

export function sendToRenderer(channel: string, data: Record<string, unknown>): void {
  // A CLI subprocess keeps streaming progress after the user closes the window
  // (on macOS the app stays alive). Sending to a destroyed webContents throws
  // "Object has been destroyed" from inside a stream 'data' listener and would
  // crash the main process, so guard every send.
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    win.webContents.send(channel, data);
  }
}

export const sendProgress: ProgressSink = (data) => sendToRenderer('mfh:fetch-progress', data);
export const sendOperationProgress: ProgressSink = (data) => sendToRenderer('mfh:operation-progress', data);
export const sendFileProgress: ProgressSink = (data) => sendToRenderer('mfh:file-progress', data);

export { terminalGuard };
export type { ProgressSink };
