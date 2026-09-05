import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type * as ElectronAPI from 'electron';
import { electron } from '../electronApi.js';
import { asObject } from '../payload.js';
import { redactPath, sanitizeText } from '../sanitize.js';

type TrustedHandler = (
  event: ElectronAPI.IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown | Promise<unknown>;

export interface ShellHandlerDeps {
  handleTrusted(channel: string, handler: TrustedHandler): void;
  getMainWindow(): ElectronAPI.BrowserWindow | undefined;
  /** ELEC-01：await 对话框之后必须重新确认发起方。 */
  assertTrustedSender(event: ElectronAPI.IpcMainInvokeEvent): boolean;
  /** 默认取 Electron 自带的实现；单元测试注入桩，不必起一个真窗口。 */
  dialog?: Pick<ElectronAPI.Dialog, 'showOpenDialog' | 'showSaveDialog'>;
  shell?: Pick<ElectronAPI.Shell, 'openExternal'>;
}

/**
 * 允许用默认浏览器打开的外部地址，逐条写死。
 * 「关于」页只有项目地址和反馈入口两个按钮，没有第三个来源，也不接受渲染层拼串。
 */
const EXTERNAL_ALLOWLIST = new Set([
  'https://github.com/12dora/Mail-Fapiao-Helper',
  'https://github.com/12dora/Mail-Fapiao-Helper/issues',
]);

/** 导出的 CSV 全在内存里拼好再交过来，超过这个大小说明调用方出了问题。 */
const CSV_LIMIT_BYTES = 20 * 1024 * 1024;

function normalizeExternal(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const value = raw.trim();
  // 末尾斜杠等同于原地址，其余一律按不在名单里处理。
  const canonical = value.endsWith('/') ? value.slice(0, -1) : value;
  return EXTERNAL_ALLOWLIST.has(canonical) ? canonical : '';
}

/** 对话框里预填的文件名：只取基名，去掉分隔符与控制字符，保证以 .csv 结尾。 */
const UNSAFE_FILENAME = new RegExp('[\\u0000-\\u001f<>:"/\\\\|?*]', 'g');

function safeFilename(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  const base = path.basename(value).replace(UNSAFE_FILENAME, '').trim();
  if (!base || base === '.' || base === '..') return '导出.csv';
  return base.toLowerCase().endsWith('.csv') ? base : `${base}.csv`;
}

/** 与 configService / pendingStore 相同的写法：同目录临时文件 + fsync + rename。 */
function writeCsvAtomic(target: string, text: string): void {
  const temp = `${target}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 });
    const fd = fs.openSync(temp, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export function registerShellHandlers(deps: ShellHandlerDeps): void {
  const { handleTrusted, getMainWindow, assertTrustedSender } = deps;
  const dialog = deps.dialog ?? electron.dialog;
  const shell = deps.shell ?? electron.shell;

  /** 用系统浏览器打开项目地址或反馈入口；名单外的地址一律拒绝。 */
  handleTrusted('mfh:open-external', async (_event, payload: unknown) => {
    const url = normalizeExternal(asObject(payload).url);
    if (!url) return { ok: false, code: 'external_url_not_allowed', message: '这个地址不能从应用内打开。' };
    try {
      await shell.openExternal(url);
      return { ok: true, code: 'external_opened', message: '已在浏览器中打开。' };
    } catch (err) {
      return {
        ok: false,
        code: 'external_open_failed',
        message: '没能打开浏览器。',
        detail: sanitizeText(err instanceof Error ? err.message : err),
      };
    }
  });

  /**
   * 选择一个目录，原样返回绝对路径。
   * 脱敏只作用于 get-config 回给渲染层的展示串；这里的路径会被原样送回 saveConfig，
   * 换成展示串就写不进配置文件了。
   */
  handleTrusted('mfh:pick-directory', async (event, payload: unknown) => {
    const raw = asObject(payload);
    const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : '选择目录';
    const defaultPath = typeof raw.defaultPath === 'string' && raw.defaultPath.trim()
      ? raw.defaultPath.trim()
      : undefined;
    const options = {
      title,
      ...(defaultPath ? { defaultPath } : {}),
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
    };
    const mainWindow = getMainWindow();
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (!assertTrustedSender(event)) return { ok: false, code: 'untrusted_sender', message: '无权选择目录。' };
    const picked = result.filePaths[0];
    if (result.canceled || !picked) return { ok: false, canceled: true, code: 'pick_canceled', message: '已取消。' };
    return { ok: true, path: picked };
  });

  /** 把渲染层拼好的 CSV 存到用户选的位置。 */
  handleTrusted('mfh:export-csv', async (event, payload: unknown) => {
    const raw = asObject(payload);
    const csv = typeof raw.csv === 'string' ? raw.csv : '';
    if (!csv) return { ok: false, canceled: false, code: 'export_empty', message: '没有可导出的内容。' };
    if (Buffer.byteLength(csv, 'utf8') > CSV_LIMIT_BYTES) {
      return { ok: false, canceled: false, code: 'export_too_large', message: '内容太大，先缩小筛选范围再导出。' };
    }

    const mainWindow = getMainWindow();
    const options = { title: '导出 CSV', defaultPath: safeFilename(raw.filename), filters: [{ name: 'CSV', extensions: ['csv'] }] };
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options);
    if (!assertTrustedSender(event)) {
      return { ok: false, canceled: false, code: 'untrusted_sender', message: '无权导出文件。' };
    }
    if (result.canceled || !result.filePath) {
      return { ok: false, canceled: true, code: 'export_canceled', message: '已取消导出。' };
    }

    try {
      writeCsvAtomic(result.filePath, csv);
      return { ok: true, canceled: false, path: redactPath(result.filePath), code: 'export_saved', message: '已导出。' };
    } catch (err) {
      return {
        ok: false,
        canceled: false,
        code: 'export_write_failed',
        message: '文件没有写成功。',
        detail: sanitizeText(err instanceof Error ? err.message : err),
      };
    }
  });
}
