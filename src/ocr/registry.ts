import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import type { OcrProvider } from './types.js';
import { createEfapiaoProvider } from './efapiao.js';

/**
 * mock OCR 仅供本地开发/回归测试。生产配置即使写 `"provider":"mock"` 也不可达（OCR-11）。
 *
 * 唯一放行条件：显式环境变量 `MFH_ALLOW_MOCK_OCR=1`（测试套件注入）。
 * 不得用「工作目录下是否存在 gui-design/tests」这类用户可伪造的目录存在性门禁；
 * 也不得依赖从未在仓库中设置的 `MFH_APP_IS_PACKAGED`。
 */
function mockOcrAllowed(): boolean {
  return process.env.MFH_ALLOW_MOCK_OCR === '1';
}

function mockResult(meta: Parameters<OcrProvider['parse']>[1]) {
  return {
    status: 'success' as const,
    fields: {
      seller: meta.documentType === 'itinerary' ? '差旅平台' : '国家电网有限公司',
      amount: meta.documentType === 'itinerary' ? '88.00' : '318.42',
      date: '2026-05-21',
      invoiceNo: meta.documentType === 'itinerary' ? 'TRIP-20260521' : '1234567890',
      documentType: meta.documentType,
      invoiceType: meta.documentType === 'itinerary' ? '行程单' : '电子发票',
    },
    error: '',
    source: {
      format: meta.format,
      parserVersion: 'mock',
      extractedBy: 'text_layer',
      ocrVendor: null,
    },
    transport: 'http' as const,
    raw: { status: 'ok', mock: true, filename: meta.filename },
  };
}

/** In-process concurrency counters for TEST-04 barrier assertions. */
let mockActive = 0;
let mockPeak = 0;

function writePeak(): void {
  const peakPath = process.env.MFH_MOCK_OCR_PEAK_PATH;
  if (!peakPath) return;
  try {
    fs.writeFileSync(peakPath, `${mockPeak}\n`, 'utf8');
  } catch {
    // best-effort for the test harness
  }
}

/**
 * TEST-04: optional barrier + peak counter.
 *
 * - `MFH_MOCK_OCR_PEAK_PATH`: continuously rewritten with the peak concurrent
 *   `parse()` count observed in this process.
 * - `MFH_MOCK_OCR_BARRIER_DIR`: each concurrent parse creates an entry file and
 *   waits until `<dir>/go` exists, so the parent test can observe overlap
 *   without wall-clock budgets.
 * - `MFH_MOCK_OCR_DELAY_MS`: artificial delay when no barrier is configured.
 */
async function withMockConcurrencyGate<T>(body: () => Promise<T>): Promise<T> {
  mockActive += 1;
  mockPeak = Math.max(mockPeak, mockActive);
  writePeak();

  const barrierDir = process.env.MFH_MOCK_OCR_BARRIER_DIR;
  try {
    if (barrierDir && barrierDir.length > 0) {
      try {
        fs.mkdirSync(barrierDir, { recursive: true });
        const stamp = `${process.pid}-${mockActive}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        fs.writeFileSync(path.join(barrierDir, `entered-${stamp}`), `${mockActive}\n`);
      } catch {
        // still honour the go-file wait even if entry bookkeeping fails
      }
      const goPath = path.join(barrierDir, 'go');
      const deadline = Date.now() + 60_000;
      while (!fs.existsSync(goPath)) {
        if (Date.now() > deadline) {
          throw new Error('mock OCR barrier wait timed out waiting for go file');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } else {
      const ms = Number(process.env.MFH_MOCK_OCR_DELAY_MS || 0);
      if (Number.isFinite(ms) && ms > 0) {
        await new Promise((resolve) => setTimeout(resolve, ms));
      }
    }
    return await body();
  } finally {
    mockActive = Math.max(0, mockActive - 1);
    writePeak();
  }
}

/**
 * 测试专用入口：显式构造 mock provider（依赖注入）。
 * 生产代码路径不得在未设置 `MFH_ALLOW_MOCK_OCR=1` 时调用。
 */
export function createMockOcrProvider(): OcrProvider {
  if (!mockOcrAllowed()) {
    throw new Error('mock OCR provider is test-only and is not available in this environment');
  }
  // Reset peak for each provider instance so serial/parallel measurements in one
  // suite process do not bleed into each other when tests spawn separate CLIs
  // (each CLI is its own process — module state is already isolated).
  mockActive = 0;
  mockPeak = 0;
  writePeak();
  return {
    name: 'mock',
    async parse(_data, meta) {
      return withMockConcurrencyGate(async () => mockResult(meta));
    },
    async parseBatch(items) {
      if (process.env.MFH_MOCK_OCR_FAIL_BATCH === '1') {
        throw new Error('mock batch parser should not be used');
      }
      return withMockConcurrencyGate(async () => items.map((item) => mockResult(item.meta)));
    },
  };
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
