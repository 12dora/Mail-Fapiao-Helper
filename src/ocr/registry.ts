import type { Config } from '../config.js';
import type { OcrProvider } from './types.js';
import { createEfapiaoProvider } from './efapiao.js';

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

export function getOcrProvider(cfg: Config): OcrProvider {
  if (cfg.ocr.provider === 'mock') {
    return {
      name: 'mock',
      async parse(_data, meta) {
        return mockResult(meta);
      },
      async parseBatch(items) {
        if (process.env.MFH_MOCK_OCR_FAIL_BATCH === '1') {
          throw new Error('mock batch parser should not be used');
        }
        return items.map((item) => mockResult(item.meta));
      },
    };
  }
  if (cfg.ocr.provider === 'efapiao') return createEfapiaoProvider(cfg);
  throw new Error(`unsupported OCR provider: ${cfg.ocr.provider}`);
}
