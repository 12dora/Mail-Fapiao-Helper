import type { Config } from '../config.js';
import type { OcrProvider } from './types.js';
import { createEfapiaoProvider } from './efapiao.js';

export function getOcrProvider(cfg: Config): OcrProvider {
  if (cfg.ocr.provider === 'efapiao') return createEfapiaoProvider(cfg);
  throw new Error(`unsupported OCR provider: ${cfg.ocr.provider}`);
}
