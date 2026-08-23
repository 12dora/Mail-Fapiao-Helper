import type { Config } from '../../config.js';
import type { DocumentFormat, DocumentType } from '../../extract/types.js';
import type { OcrProvider, OcrResult } from '../types.js';
import { parseViaCli } from './cli.js';
import { runService, runServiceBatch } from './service.js';
import { errorResult, okResult } from './result.js';

async function parseViaService(cfg: Config, data: Buffer, meta: { format: DocumentFormat; documentType: DocumentType; filename: string }): Promise<OcrResult> {
  const payload = await runService(cfg, data, meta);
  if (payload.status === 'ok') {
    return okResult(payload, meta.documentType, 'http');
  }
  return errorResult(payload, 'efapiao_http_error', 'http', meta.documentType);
}

async function parseBatchViaService(
  cfg: Config,
  items: Array<{ data: Buffer; meta: { format: DocumentFormat; documentType: DocumentType; filename: string } }>,
): Promise<OcrResult[]> {
  const payloads = await runServiceBatch(cfg, items);
  return payloads.map((payload, index) => {
    const meta = items[index]?.meta;
    if (payload.status === 'ok') {
      return okResult(payload, meta?.documentType ?? 'invoice', 'http');
    }
    return errorResult(payload, 'efapiao_http_error', 'http', meta?.documentType ?? 'invoice');
  });
}

export function createEfapiaoProvider(cfg: Config): OcrProvider {
  return {
    name: 'efapiao',

    async parse(data, meta): Promise<OcrResult> {
      if (cfg.ocr.executionMode === 'cli') {
        return parseViaCli(cfg, data, meta);
      }

      try {
        return await parseViaService(cfg, data, meta);
      } catch (err) {
        if (cfg.ocr.executionMode === 'serve') throw err;
        const reason = err instanceof Error ? err.message : String(err);
        const cliResult = await parseViaCli(cfg, data, meta);
        if (!cliResult.error) return cliResult;
        cliResult.error = `serve_fallback:${reason};${cliResult.error}`;
        return cliResult;
      }
    },

    async parseBatch(items): Promise<OcrResult[]> {
      if (cfg.ocr.executionMode === 'cli') {
        const results: OcrResult[] = [];
        for (const item of items) {
          results.push(await parseViaCli(cfg, item.data, item.meta));
        }
        return results;
      }

      try {
        return await parseBatchViaService(cfg, items);
      } catch (err) {
        if (cfg.ocr.executionMode === 'serve') throw err;
        const reason = err instanceof Error ? err.message : String(err);
        const results: OcrResult[] = [];
        for (const item of items) {
          const cliResult = await parseViaCli(cfg, item.data, item.meta);
          if (cliResult.error) cliResult.error = `serve_fallback:${reason};${cliResult.error}`;
          results.push(cliResult);
        }
        return results;
      }
    },
  };
}
