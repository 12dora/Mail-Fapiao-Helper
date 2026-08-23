import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Config } from '../../config.js';
import type { DocumentFormat } from '../../extract/types.js';
import { safeServiceFetch } from '../../util/net.js';
import { binaryPath, efapiaoEnv, hintFor, ocrModeFor } from './binary.js';
import { ChildTerminateError, terminateChildTree } from './process.js';
import {
  compactError,
  nestedRecord,
  parseEfapiaoJson,
  toEfapiaoPayload,
  type EfapiaoBatchPayload,
  type EfapiaoPayload,
} from './result.js';

interface ServiceState {
  ready: boolean;
  failed: boolean;
  child?: ChildProcess;
  failureReason?: string;
  startup?: Promise<void>;
  /** 子进程是否已经退出（持久 exit/close listener 置位）。 */
  exited?: boolean;
  /** 是否曾经健康过；只有崩溃（而非启动失败）才允许下次请求重启。 */
  everReady?: boolean;
  /** 最近一段 stderr，用于组装退出原因。 */
  stderrTail?: () => string;
}

/** 保留的 stderr 尾部字节数，避免长时间运行的服务把日志堆在内存里。 */
const STDERR_TAIL_BYTES = 8192;
const serviceStates = new Map<string, ServiceState>();

function serviceBaseUrl(cfg: Config): string {
  if (cfg.ocr.serviceUrl) return cfg.ocr.serviceUrl.replace(/\/+$/, '');
  return `http://${cfg.ocr.serviceHost}:${cfg.ocr.servicePort}`;
}

function serviceKey(cfg: Config): string {
  // Fold a fingerprint of the effective vendor/credentials into the key so that
  // a credential or vendor change forces a fresh service rather than silently
  // reusing one started with different secrets.
  const env = efapiaoEnv(cfg);
  const fp = createHash('sha1').update([
    env.EFAPIAO_OCR_VENDOR ?? '',
    env.EFAPIAO_API_KEY ?? '',
    env.TENCENTCLOUD_SECRET_ID ?? '',
    env.TENCENTCLOUD_SECRET_KEY ?? '',
    env.TENCENTCLOUD_REGION ?? '',
    env.EFAPIAO_CNOCR_MODEL_PROFILE ?? '',
    env.EFAPIAO_CNOCR_DET_MODEL ?? '',
    env.EFAPIAO_CNOCR_REC_MODEL ?? '',
  ].join('\0')).digest('hex').slice(0, 12);
  return `${binaryPath(cfg)}\0${cfg.ocr.serviceHost}\0${cfg.ocr.servicePort}\0${cfg.ocr.serviceWorkers}\0${fp}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref();
  return controller.signal;
}

async function healthOk(cfg: Config): Promise<boolean> {
  try {
    // 经 safeServiceFetch：允许本机回环，拒绝其它私网；禁止裸 fetch 被指到攻击者主机。
    const res = await safeServiceFetch(`${serviceBaseUrl(cfg)}/v1/health`, {
      method: 'GET',
      signal: timeoutSignal(1000),
      maxBodyBytes: 64 * 1024,
    });
    return res.ok;
  } catch {
    return false;
  }
}

function serviceHeaders(cfg: Config): Record<string, string> | undefined {
  const apiKey = cfg.ocr.credentials?.apiKey || process.env.EFAPIAO_API_KEY;
  return apiKey ? { 'X-API-Key': apiKey } : undefined;
}

function unrefStream(stream: unknown): void {
  (stream as { unref?: () => void } | null | undefined)?.unref?.();
}

/**
 * 挂上**持久**的 exit/close listener 并持续 drain stdout/stderr（APP-14A）。
 * - 持续 drain：不读就会把 OS 管道写满，子进程阻塞在 write 上，服务再也不会健康。
 * - 退出时原子地把 state 标为 not-ready；如果它曾经健康过（属于崩溃/被杀），
 *   还要把它移出 registry，下一次请求就会同步重启，而不是继续连一个死进程。
 */
function attachServiceChild(key: string, child: ChildProcess, state: ServiceState): void {
  const tail: Buffer[] = [];
  let tailBytes = 0;
  const keepTail = (chunk: Buffer): void => {
    tail.push(chunk);
    tailBytes += chunk.length;
    while (tailBytes > STDERR_TAIL_BYTES && tail.length > 1) {
      tailBytes -= tail.shift()?.length ?? 0;
    }
  };
  state.stderrTail = () => Buffer.concat(tail).toString('utf8');

  child.stdout?.on('data', () => { /* drain */ });
  child.stderr?.on('data', keepTail);
  child.stdout?.on('error', () => { /* 管道随子进程一起消失，忽略 */ });
  child.stderr?.on('error', () => { /* 同上 */ });
  // 只 drain 不持有事件循环：CLI 退出时不应被这两个管道拖住。
  unrefStream(child.stdout);
  unrefStream(child.stderr);

  const onGone = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (state.exited) return;
    state.exited = true;
    const wasReady = state.everReady === true;
    state.ready = false;
    state.failed = true;
    state.failureReason = state.failureReason
      || `efapiao_serve_exit_${code ?? signal ?? 'unknown'}:${compactError(state.stderrTail?.() ?? '')}`;
    // 曾经就绪过的服务崩溃后必须让位给一次重启；从未就绪的启动失败保留在
    // registry 里快速失败，避免每份文档都去重复一次注定失败的启动。
    if (wasReady && serviceStates.get(key) === state) serviceStates.delete(key);
  };
  child.on('exit', onGone);
  child.on('close', onGone);
  child.on('error', (err) => {
    state.failureReason = state.failureReason || `efapiao_serve_spawn_error:${compactError(err.message)}`;
    onGone(null, null);
  });
}

async function waitForHealth(cfg: Config, child: ChildProcess, state: ServiceState): Promise<void> {
  const deadline = Date.now() + cfg.ocr.serviceStartupMs;

  while (Date.now() < deadline) {
    if (await healthOk(cfg)) {
      // 子进程已经退出时不能标 ready：健康的可能是别的服务或端口残留。
      if (state.exited) break;
      // 不再摘掉 exit listener、也不 destroy 管道：服务就绪之后依然要持续
      // 监听退出并 drain 输出（APP-14A）。
      state.ready = true;
      state.everReady = true;
      return;
    }
    if (state.failed || state.exited) break;
    await sleep(300);
  }

  child.kill('SIGTERM');
  const reason = state.failureReason || `efapiao_serve_unhealthy:${serviceBaseUrl(cfg)}/v1/health`;
  state.failed = true;
  state.failureReason = reason;
  throw new Error(reason);
}

async function ensureService(cfg: Config): Promise<void> {
  const key = serviceKey(cfg);
  const existing = serviceStates.get(key);
  if (existing) {
    if (existing.exited && existing.everReady) {
      // 曾经健康的服务崩溃或被杀：移出 registry，下面同步重启（APP-14A）。
      serviceStates.delete(key);
    } else {
      // ready 之外还要确认子进程没退出：退出后 state 已被置为 not-ready。
      if (existing.ready && !existing.exited) return;
      if (existing.failed || existing.exited) {
        throw new Error(existing.failureReason || 'efapiao_serve_failed');
      }
      // A startup is already in flight for this key; await the SAME promise so we
      // never spawn a second `efapiao serve` under concurrency.
      if (existing.startup) return existing.startup;
    }
  }

  const state: ServiceState = { ready: false, failed: false };
  // Register synchronously (no await before this) so concurrent callers observe
  // the in-flight startup and join it instead of racing another spawn.
  serviceStates.set(key, state);
  state.startup = (async () => {
    if (await healthOk(cfg)) {
      // 外部（非本进程托管）已经在跑的服务：没有子进程可监听，只能按需健康检查。
      state.ready = true;
      state.everReady = true;
      return;
    }
    const child = spawn(binaryPath(cfg), [
      'serve',
      '--host',
      cfg.ocr.serviceHost,
      '--port',
      String(cfg.ocr.servicePort),
      '--workers',
      String(cfg.ocr.serviceWorkers),
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: efapiaoEnv(cfg),
      // POSIX：独立进程组，stop 时 kill(-pid) 可清孙进程（OCR-12）。
      detached: process.platform !== 'win32',
    });
    state.child = child;
    child.unref();
    attachServiceChild(key, child, state);
    await waitForHealth(cfg, child, state);
  })();
  return state.startup;
}

/**
 * Terminate any `efapiao serve` children this process started. Serve children
 * are unref()'d so they would otherwise outlive the CLI as orphans holding the
 * port; callers must invoke this before the process exits.
 *
 * 异步版本会等 close；同步 `stopEfapiaoServices` 发信号后清空 registry，
 * 并 kick 一轮 terminate（fire-and-forget 带 grace）。
 */
export async function stopEfapiaoServicesAsync(): Promise<void> {
  const children: ChildProcess[] = [];
  for (const state of serviceStates.values()) {
    if (state.child) children.push(state.child);
  }
  serviceStates.clear();
  const results = await Promise.allSettled(children.map((child) => terminateChildTree(child)));
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length > 0) {
    const first = failed[0] as PromiseRejectedResult;
    const msg = first.reason instanceof Error ? first.reason.message : String(first.reason);
    throw new ChildTerminateError(`efapiao_stop_incomplete:${failed.length}:${msg}`);
  }
}

export function stopEfapiaoServices(): void {
  const children: ChildProcess[] = [];
  for (const state of serviceStates.values()) {
    if (state.child) children.push(state.child);
  }
  serviceStates.clear();
  for (const child of children) {
    // 同步路径：立即 SIGTERM，并调度异步升级到 SIGKILL（失败仅记入 unhandled rejection 路径外：吞掉）。
    void terminateChildTree(child).catch(() => { /* best-effort on sync exit path */ });
  }
}

export async function runService(
  cfg: Config,
  data: Buffer,
  meta: { format: DocumentFormat; filename: string },
): Promise<EfapiaoPayload> {
  await ensureService(cfg);
  const form = new FormData();
  form.set('file', new Blob([data]), meta.filename);
  form.set('hint_type', hintFor(meta.format));
  form.set('ocr_mode', ocrModeFor(cfg));

  const res = await safeServiceFetch(`${serviceBaseUrl(cfg)}/v1/invoices/parse`, {
    method: 'POST',
    headers: serviceHeaders(cfg),
    body: form,
    signal: timeoutSignal(cfg.ocr.timeoutMs),
  });
  const text = await res.text();
  let payload: EfapiaoPayload;
  try {
    payload = parseEfapiaoJson(text);
  } catch {
    throw new Error(`efapiao_http_invalid_json:http_${res.status}:${compactError(text)}`);
  }
  if (res.ok) return payload;
  // A non-2xx response is always an error. Keep status:'error' last so an error
  // body that happens to carry status:'ok' cannot be misread as success.
  return {
    ...(payload as Record<string, unknown>),
    ...nestedRecord(payload, 'detail'),
    status: 'error',
  };
}

export async function runServiceBatch(
  cfg: Config,
  items: Array<{ data: Buffer; meta: { filename: string } }>,
): Promise<EfapiaoPayload[]> {
  await ensureService(cfg);
  const form = new FormData();
  for (const item of items) {
    form.append('files', new Blob([item.data]), item.meta.filename);
  }
  form.set('hint_type', 'auto');
  form.set('ocr_mode', ocrModeFor(cfg));

  const res = await safeServiceFetch(`${serviceBaseUrl(cfg)}/v1/invoices/parse-batch`, {
    method: 'POST',
    headers: serviceHeaders(cfg),
    body: form,
    signal: timeoutSignal(cfg.ocr.timeoutMs),
  });
  const text = await res.text();
  let payload: EfapiaoBatchPayload;
  try {
    payload = parseEfapiaoJson(text) as EfapiaoBatchPayload;
  } catch {
    throw new Error(`efapiao_http_invalid_json:http_${res.status}:${compactError(text)}`);
  }

  if (!res.ok) {
    const detail = toEfapiaoPayload(payload.detail);
    throw new Error(`efapiao_http_batch_error:http_${res.status}:${compactError(detail.message || text)}`);
  }
  if (!Array.isArray(payload.items)) {
    throw new Error(`efapiao_http_batch_invalid_response:${compactError(text)}`);
  }

  const byIndex = new Map<number, EfapiaoPayload>();
  for (const item of payload.items) {
    if (typeof item.index === 'number') byIndex.set(item.index, item);
  }
  return items.map((_, index) => byIndex.get(index) ?? {
    status: 'error',
    code: 'missing_batch_item',
    message: `efapiao batch response missing item index ${index}`,
  });
}
