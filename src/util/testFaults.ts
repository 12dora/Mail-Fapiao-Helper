import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_FAULT_TOKEN = 'mail-fapiao-helper-test-faults';

/**
 * 是否运行在 electron-builder 打包后的运行时（含 asar 内的 CLI 子进程）。
 *
 * 不依赖从未设置的 `MFH_APP_IS_PACKAGED`。Electron 主进程用 `app.isPackaged`；
 * 打包后主进程与 `ELECTRON_RUN_AS_NODE` 子进程的模块路径都落在 `app.asar` 内，
 * CLI 无 `app` 对象时同样可靠。开发态 `electron .` / `node dist/index.js` 路径不含 asar。
 */
export function isPackagedRuntime(): boolean {
  try {
    const modulePath = fileURLToPath(import.meta.url);
    // app.asar / app.asar.unpacked 均视为已打包。
    if (modulePath.includes(`${path.sep}app.asar${path.sep}`)
      || modulePath.includes(`${path.sep}app.asar.unpacked${path.sep}`)
      || modulePath.includes('/app.asar/')
      || modulePath.includes('/app.asar.unpacked/')) {
      return true;
    }
    // Windows asar 路径有时是 app.asar\...
    if (/\.asar([\\/]|$)/i.test(modulePath) && /app\.asar/i.test(modulePath)) {
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

/**
 * Sentinel 锚定在**本包安装根**（dist/util → ../..），绝不使用 process.cwd()。
 * Electron 把 CLI 的 cwd 设为 dataDir，用户可在 dataDir 下伪造
 * `gui-design/tests/.fault-injection-enabled`；打包产物又排除了 `gui-design/tests/**`，
 * 因此在 asar 内该路径不可能被用户写入。
 */
function faultSentinelPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'gui-design', 'tests', '.fault-injection-enabled');
}

/**
 * 测试故障注入总闸。打包运行时恒为 false（模块仍保留薄桩，因 pipeline/archive
 * 等生产路径会静态 import；真正的故障逻辑在打包后不可达）。
 */
export function testFaultEnabled(name: string): boolean {
  if (isPackagedRuntime()) return false;
  if (process.env.MFH_TEST_FAULT_TOKEN !== TEST_FAULT_TOKEN) return false;
  if (process.env[name] !== '1') return false;
  try {
    return fs.existsSync(faultSentinelPath());
  } catch {
    return false;
  }
}
