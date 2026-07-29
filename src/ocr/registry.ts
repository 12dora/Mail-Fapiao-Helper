import { createRequire } from 'node:module';
import type { Config } from '../config.js';
import { isDevelopmentRuntime } from '../util/testFaults.js';
import type { OcrProvider } from './types.js';
import { createEfapiaoProvider } from './efapiao.js';

const require = createRequire(import.meta.url);

/**
 * mock OCR 仅供本地开发/回归测试。生产配置即使写 `"provider":"mock"` 也不可达（OCR-11）。
 *
 * 放行条件（全部满足）：
 * 1. `isDevelopmentRuntime()`——能证明是源码检出开发树，且无 `dist/buildInfo.js`
 *    `production: true` 标记（fail closed；不依赖 asar 路径）；
 * 2. 显式 `MFH_ALLOW_MOCK_OCR=1`；
 * 3. 测试专用模块 `mockProvider.js` 存在（打包时由 build.files 排除，import 失败）。
 *
 * 不得用「工作目录下是否存在 gui-design/tests」这类用户可伪造的目录存在性门禁；
 * 也不得依赖从未在仓库中设置的 `MFH_APP_IS_PACKAGED`。
 */
function mockOcrAllowed(): boolean {
  if (!isDevelopmentRuntime()) return false;
  return process.env.MFH_ALLOW_MOCK_OCR === '1';
}

/**
 * 测试专用入口：从**被打包排除**的模块构造 mock provider。
 * 生产代码路径不得在未设置 `MFH_ALLOW_MOCK_OCR=1` 时调用。
 */
export function createMockOcrProvider(): OcrProvider {
  if (!mockOcrAllowed()) {
    throw new Error('mock OCR provider is test-only and is not available in this environment');
  }
  try {
    // 同步加载：保持 getOcrProvider 同步 API。模块在 packaged build 中不存在。
    const mod = require('./mockProvider.js') as { createMockOcrProvider: () => OcrProvider };
    return mod.createMockOcrProvider();
  } catch {
    throw new Error('mock OCR provider is test-only and is not available in this build');
  }
}

export function getOcrProvider(cfg: Config): OcrProvider {
  if (cfg.ocr.provider === 'mock') {
    if (!mockOcrAllowed()) {
      throw new Error(
        'OCR provider "mock" is test-only and cannot be enabled from a production config. '
        + 'Use "efapiao", or set MFH_ALLOW_MOCK_OCR=1 only in local test environments.',
      );
    }
    return createMockOcrProvider();
  }
  if (cfg.ocr.provider === 'efapiao') return createEfapiaoProvider(cfg);
  throw new Error(`unsupported OCR provider: ${cfg.ocr.provider}`);
}
