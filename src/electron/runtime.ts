import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfigPath } from './summary.js';
import { OperationCoordinator } from './opCoordinator.js';
import { electron } from './electronApi.js';

const { app } = electron;

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const dataDir = process.env.MFH_DATA_DIR
  ? path.resolve(process.env.MFH_DATA_DIR)
  : app.getPath('userData');
export const bundledConfigPath = path.join(rootDir, 'config.example.json');
export const configPath = process.env.MFH_CONFIG_PATH
  ? path.resolve(process.env.MFH_CONFIG_PATH)
  : defaultConfigPath(dataDir);
export const statePath = process.env.MFH_STATE_PATH
  ? path.resolve(process.env.MFH_STATE_PATH)
  : path.join(dataDir, 'state.json');

export const coordinator = new OperationCoordinator(dataDir);

// Every CLI subprocess we spawn, so they can be terminated on app quit instead
// of being orphaned (they can in turn hold an efapiao serve child / a port).
const activeChildren = new Set<ChildProcess>();
// OCR 子进程按 jobId 追踪：第二次 OCR 不会覆盖第一次的句柄，「停止」也不会漏掉
// 任何一个进程（APP-05）。
const ocrProcesses = new Map<string, ChildProcess>();
const ocrStopRequested = new Set<string>();

export interface ProcessRegistries {
  activeChildren: Set<ChildProcess>;
  ocrProcesses: Map<string, ChildProcess>;
  ocrStopRequested: Set<string>;
}

export const processRegistries: ProcessRegistries = {
  activeChildren,
  ocrProcesses,
  ocrStopRequested,
};

/**
 * 仅在「未打包 + 显式开启」时加载的开发用假后端（CODE-04）。打包后 app.isPackaged
 * 为 true，无论环境变量如何都必须走真实 CLI。
 */
type DevFakeBackend = typeof import('./devFakeBackend.js');
let devBackend: DevFakeBackend | undefined;

export function devFakeBackendEnabled(): boolean {
  return !app.isPackaged && process.env.MFH_E2E_FAKE_CLI === '1';
}

export function e2eNoGuiMode(): boolean {
  return !app.isPackaged && process.env.MFH_E2E_NO_GUI === '1';
}

export async function loadDevFakeBackend(): Promise<void> {
  if (!devFakeBackendEnabled()) return;
  try {
    devBackend = await import('./devFakeBackend.js');
  } catch {
    devBackend = undefined;
  }
}

export function getDevBackend(): DevFakeBackend | undefined {
  return devBackend;
}

export function uiPath(...parts: string[]): string {
  return path.join(rootDir, 'gui-design', ...parts);
}

export function ensureUserDataConfig(): void {
  fs.mkdirSync(dataDir, { recursive: true });
  if (fs.existsSync(configPath)) return;
  fs.copyFileSync(bundledConfigPath, configPath);
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    // Best-effort on platforms that do not preserve POSIX file modes.
  }
}
