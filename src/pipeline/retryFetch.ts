import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import {
  attemptDeadlineSignal,
  bufferedResponse,
  isTimeoutError,
  readCappedBuffer,
  safeFetch,
} from '../util/net.js';

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function requestUrl(input: FetchInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestMethod(init: FetchInit): string {
  return (init?.method ?? 'GET').toUpperCase();
}

/**
 * CORE-08：日志与 pending reason 只保留 protocol + host + 截断 pathname，
 * 删除 query / fragment / userinfo，避免签名 URL 落盘泄露。
 */
export function redactUrlForLog(url: string): string {
  try {
    const u = new URL(url);
    const pathPart = u.pathname.length > 96 ? `${u.pathname.slice(0, 96)}…` : u.pathname;
    return `${u.protocol}//${u.host}${pathPart}`;
  } catch {
    return '[invalid-url]';
  }
}

/** 错误串里若夹带 URL，同样脱敏后再写入日志 / pending。 */
export function redactErrorDetail(detail: string): string {
  return detail.replace(/https?:\/\/[^\s"'<>\\]+/gi, (m) => redactUrlForLog(m));
}

/**
 * CORE-08：pending / 日志只保留稳定枚举与脱敏片段，不落签名 URL。
 */
export function sanitizePendingReason(reason: string): string {
  const redacted = redactErrorDetail(reason);
  // 压缩过长诊断，避免台账膨胀；保留类型前缀。
  return redacted.length > 400 ? `${redacted.slice(0, 400)}…` : redacted;
}

/**
 * 这些失败与网络抖动无关，重试只会放大伤害/浪费时间，必须原样上抛：
 * - `blocked_url:` SSRF 判定（调用方按前缀区分并降级）
 * - `response_too_large:` 超出 50MB 硬上限
 *
 * CORE-08：上抛前仍须脱敏——signed URL 可能出现在 redirect / invalid 细节里。
 */
function isNonRetryableFetchError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.startsWith('blocked_url:') || msg.startsWith('response_too_large:');
}

/** 把非重试传输错误收成带类型码、已脱敏的 Error。 */
function typedNonRetryableError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.startsWith('blocked_url:')) {
    // 保留 blocked_url:<kind> 前缀；其余 URL/细节脱敏。
    const rest = msg.slice('blocked_url:'.length);
    const kind = rest.split(':')[0] ?? 'unknown';
    const detail = rest.includes(':') ? rest.slice(kind.length + 1) : '';
    const safeDetail = detail ? redactErrorDetail(detail) : '';
    return new Error(safeDetail ? `blocked_url:${kind}:${safeDetail}` : `blocked_url:${kind}`);
  }
  if (msg.startsWith('response_too_large:')) {
    // 仅尺寸信息，无直接保留。
    return new Error(msg);
  }
  return new Error(redactErrorDetail(msg));
}

/** 导出仅用于测试：构造带 per-attempt deadline 与重试的 fetch。 */
export function makeRetryingFetch(cfg: Config, log: Logger): typeof fetch {
  return (async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const attempts = cfg.network.retries + 1;
    const url = requestUrl(input);
    const safeUrl = redactUrlForLog(url);
    const method = requestMethod(init);
    const timeoutMs = cfg.network.timeoutMs;
    let lastError = '';

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        // per-attempt deadline：signal 同时约束 header 与 body，接受连接后不发完
        // 响应头、或持续滴流的服务器不会再永久占住一个 worker（APP-13）。
        const attemptInit = {
          ...(init ?? {}),
          signal: attemptDeadlineSignal(init?.signal, timeoutMs),
        } as FetchInit;
        // WIRE-01 / OCR-01：用 safeFetch 替代裸 fetch——逐跳校验 redirect 并 pin DNS。
        const response = await safeFetch(input as string | URL | Request, attemptInit);
        if (isRetryableStatus(response.status)) {
          lastError = `http_${response.status}`;
          // Drain the discarded error body so undici can release the socket back to
          // the pool instead of leaking a connection on every retry.
          await response.body?.cancel().catch(() => {});
          if (attempt === attempts) {
            throw new Error(`network_retry_failed:${method}:${safeUrl}:${lastError}`);
          }
          log.warn(`network retry ${attempt}/${cfg.network.retries} ${method} ${safeUrl}: ${lastError}`);
        } else {
          // safeFetch 已在每跳发出前校验；body 仍须在同一 attempt 内读完（APP-13）。
          const data = await readCappedBuffer(response);
          return bufferedResponse(response, data);
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('network_retry_failed:')) {
          throw err;
        }
        if (isNonRetryableFetchError(err)) {
          // CORE-08：非重试错误也不得携带签名 URL。
          throw typedNonRetryableError(err);
        }
        // 超时属于可重试失败：header 阶段由 fetch 抛出，body 阶段由
        // readCappedBuffer 转成 `response_timeout:*`，两者现在走同一条重试路径。
        lastError = isTimeoutError(err)
          ? `timeout_${timeoutMs}ms`
          : redactErrorDetail(err instanceof Error ? err.message : String(err));
        if (attempt === attempts) {
          throw new Error(`network_retry_failed:${method}:${safeUrl}:${lastError}`);
        }
        log.warn(`network retry ${attempt}/${cfg.network.retries} ${method} ${safeUrl}: ${lastError}`);
      }

      if (cfg.network.retryDelayMs > 0) {
        await sleep(cfg.network.retryDelayMs * attempt);
      }
    }

    throw new Error(`network_retry_failed:${method}:${safeUrl}:${lastError || 'unknown'}`);
  }) as typeof fetch;
}
