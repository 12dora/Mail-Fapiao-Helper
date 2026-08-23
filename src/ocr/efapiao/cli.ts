import { spawn } from 'node:child_process';
import type { Config } from '../../config.js';
import type { DocumentFormat, DocumentType } from '../../extract/types.js';
import type { OcrResult } from '../types.js';
import { binaryPath, efapiaoEnv, hintFor, ocrModeFor } from './binary.js';
import {
  BoundedOutput,
  CLI_OUTPUT_CAP_BYTES,
  terminateChildTree,
} from './process.js';
import {
  compactError,
  errorResult,
  okResult,
  parseEfapiaoJson,
  type EfapiaoPayload,
} from './result.js';

function runBinary(
  cfg: Config,
  data: Buffer,
  meta: { format: DocumentFormat; documentType: DocumentType; filename: string },
): Promise<{ code: number | null; stdout: string; stderr: string; stdoutOverflow: boolean; stderrOverflow: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath(cfg), [
      'parse',
      '-',
      '--hint',
      hintFor(meta.format),
      '--ocr-mode',
      ocrModeFor(cfg),
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: efapiaoEnv(cfg),
      // POSIX：新进程组，便于 kill(-pid) 覆盖孙进程（OCR-12）。
      detached: process.platform !== 'win32',
    });

    const stdoutBuf = new BoundedOutput(CLI_OUTPUT_CAP_BYTES);
    const stderrBuf = new BoundedOutput(CLI_OUTPUT_CAP_BYTES);
    let settled = false;
    let timedOut = false;
    let terminateFailed = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      // 超时：terminate 完整进程组并**必须**等 close，再 reject（OCR-12）。
      void terminateChildTree(child)
        .catch(() => {
          terminateFailed = true;
        })
        .finally(() => {
          settle(() => {
            if (terminateFailed) {
              reject(new Error(
                `efapiao timeout after ${cfg.ocr.timeoutMs}ms; child process group did not close`,
              ));
              return;
            }
            reject(new Error(`efapiao timeout after ${cfg.ocr.timeoutMs}ms`));
          });
        });
    }, cfg.ocr.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => stdoutBuf.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrBuf.push(chunk));
    child.on('error', (err) => {
      // spawn 失败：仍尝试清理，再 settle。
      void terminateChildTree(child).catch(() => {}).finally(() => {
        settle(() => reject(err));
      });
    });
    // 只在 close 上 settle 成功路径：保证 stdio 释放后再解析（OCR-12）。
    child.on('close', (code) => {
      if (timedOut) {
        // 超时路径由 terminate 的 finally settle；这里只保证不会 resolve 成功。
        return;
      }
      settle(() => {
        resolve({
          code,
          stdout: stdoutBuf.toString(),
          stderr: stderrBuf.toString(),
          stdoutOverflow: stdoutBuf.overflow,
          stderrOverflow: stderrBuf.overflow,
        });
      });
    });

    // Swallow EPIPE/ECONNRESET on stdin (e.g. the child exits or is killed on
    // timeout before consuming input); the failure is reported via 'error'/'close'.
    child.stdin?.on('error', () => { /* ignore broken-pipe on stdin */ });
    child.stdin?.end(data);
  });
}

export async function parseViaCli(cfg: Config, data: Buffer, meta: { format: DocumentFormat; documentType: DocumentType; filename: string }): Promise<OcrResult> {
  let result: {
    code: number | null;
    stdout: string;
    stderr: string;
    stdoutOverflow: boolean;
    stderrOverflow: boolean;
  };
  try {
    result = await runBinary(cfg, data, meta);
  } catch (err) {
    // A spawn error or per-item timeout must degrade to a single failed result,
    // not reject — otherwise Promise.all in the batch/concurrent paths discards
    // every sibling document that parsed fine alongside it.
    return {
      status: 'error',
      fields: {},
      error: err instanceof Error ? err.message : String(err),
      transport: 'cli',
      raw: null,
    };
  }

  // stdout 超限：明确的有界输出失败，绝不 JSON.parse 截断字节（OCR-12）。
  if (result.stdoutOverflow) {
    return {
      status: 'error',
      fields: {},
      error: `efapiao_stdout_overflow:cap_${CLI_OUTPUT_CAP_BYTES}:exit_${result.code}`,
      transport: 'cli',
      raw: null,
    };
  }
  // 失败路径若只有 stderr 且 stderr 溢出：同样不得当 JSON 解析。
  if (result.code !== 0 && result.stderrOverflow && !result.stdout.trim()) {
    return {
      status: 'error',
      fields: {},
      error: `efapiao_stderr_overflow:cap_${CLI_OUTPUT_CAP_BYTES}:exit_${result.code}`,
      transport: 'cli',
      raw: null,
    };
  }

  const rawJson = result.code === 0 ? result.stdout : result.stderr || result.stdout;
  let payload: EfapiaoPayload;
  try {
    payload = parseEfapiaoJson(rawJson);
  } catch {
    return {
      status: 'error',
      fields: {},
      error: `efapiao_invalid_json:exit_${result.code}:${compactError(rawJson)}`,
      transport: 'cli',
      raw: rawJson,
    };
  }

  if (result.code === 0 && payload.status === 'ok') {
    return okResult(payload, meta.documentType, 'cli');
  }
  return errorResult(payload, `efapiao_exit_${result.code}`, 'cli', meta.documentType);
}
