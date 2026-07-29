/**
 * 测试专用 mock OCR provider。
 *
 * 本模块**不得**打进打包产物（见 package.json `build.files` 排除项）。
 * `registry.ts` 仅在 `isDevelopmentRuntime()`（源码检出 + 非 production buildInfo）
 * 且 `MFH_ALLOW_MOCK_OCR=1` 时加载；asar / release CLI / 纯 dist 出货树均 fail closed。
 * 合法消费者只有 `gui-design/tests/*.mjs`。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { OcrProvider } from './types.js';

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

/**
 * Peak path is confined under the process temp dir or cwd's own `mfh-test-` prefix
 * so a mis-set env cannot truncate arbitrary user files even in unpackaged test runs.
 */
function isUnderAllowedRoot(resolved: string): boolean {
  const roots = [
    path.resolve(os.tmpdir()),
    path.resolve(process.env.TMPDIR || process.env.TEMP || os.tmpdir()),
    path.resolve(process.cwd()),
  ];
  for (const root of roots) {
    if (resolved === root || resolved.startsWith(root + path.sep)) return true;
  }
  return false;
}

function safeMockPeakPath(): string | undefined {
  const peakPath = process.env.MFH_MOCK_OCR_PEAK_PATH;
  if (!peakPath || peakPath.length === 0) return undefined;
  const resolved = path.resolve(peakPath);
  return isUnderAllowedRoot(resolved) ? resolved : undefined;
}

function safeMockBarrierDir(): string | undefined {
  const barrierDir = process.env.MFH_MOCK_OCR_BARRIER_DIR;
  if (!barrierDir || barrierDir.length === 0) return undefined;
  const resolved = path.resolve(barrierDir);
  return isUnderAllowedRoot(resolved) ? resolved : undefined;
}

function writePeak(): void {
  const peakPath = safeMockPeakPath();
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
 * - `MFH_MOCK_OCR_PEAK_PATH`: peak concurrent parse count (path must be under tmp or cwd).
 * - `MFH_MOCK_OCR_BARRIER_DIR`: wait until `<dir>/go` exists (path must be under tmp or cwd).
 * - `MFH_MOCK_OCR_DELAY_MS`: artificial delay when no barrier is configured.
 */
async function withMockConcurrencyGate<T>(body: () => Promise<T>): Promise<T> {
  mockActive += 1;
  mockPeak = Math.max(mockPeak, mockActive);
  writePeak();

  const barrierDir = safeMockBarrierDir();
  try {
    if (barrierDir) {
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

export function createMockOcrProvider(): OcrProvider {
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
