import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.js';
import type { DocumentFormat, DocumentType } from '../extract/types.js';
import type { InvoiceFields, OcrProvider, OcrResult } from './types.js';

interface EfapiaoPayload {
  index?: number;
  filename?: string;
  status?: string;
  code?: string;
  message?: string;
  data?: Record<string, unknown>;
  engine?: Record<string, unknown>;
  document_type?: string | null;
  invoice_type?: string | null;
  format?: string | null;
}

interface EfapiaoBatchPayload {
  status?: string;
  total?: number;
  succeeded?: number;
  failed?: number;
  items?: EfapiaoPayload[];
  detail?: unknown;
}

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

const EFAPIAO_VERSION = '0.1.3';
const serviceStates = new Map<string, ServiceState>();

function platformArch(): string {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'darwin-x86_64';
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x86_64';
  if (process.platform === 'linux' && process.arch === 'arm64') return 'linux-arm64';
  if (process.platform === 'win32' && process.arch === 'x64') return 'windows-x86_64';
  return `${process.platform}-${process.arch}`;
}

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..');
}

function resourceRoots(): string[] {
  return [
    process.env.MFH_RESOURCE_ROOT,
    process.env.MFH_APP_ROOT,
    repoRoot(),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function findBinaryInDir(dir: string, exe: string): string | undefined {
  const candidate = path.join(dir, exe);
  if (fs.existsSync(candidate)) return candidate;
  if (!fs.existsSync(dir)) return undefined;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = path.join(dir, entry.name, exe);
    if (fs.existsSync(nested)) return nested;
  }
  return undefined;
}

function bundledBinaryPath(): string | undefined {
  const exe = process.platform === 'win32' ? 'efapiao.exe' : 'efapiao';
  for (const root of resourceRoots()) {
    const found = findBinaryInDir(path.join(root, 'vendor', 'efapiao', EFAPIAO_VERSION, platformArch()), exe);
    if (found) return found;
  }
  return undefined;
}

function binaryPath(cfg: Config): string {
  if (cfg.ocr.binaryPath !== 'auto') return cfg.ocr.binaryPath;
  return bundledBinaryPath() ?? 'efapiao';
}

function binaryDir(cfg: Config): string | undefined {
  const bin = binaryPath(cfg);
  if (bin === 'efapiao') return undefined;
  return path.dirname(bin);
}

function hasBundledModels(cfg: Config): boolean {
  const dir = binaryDir(cfg);
  return dir ? fs.existsSync(path.join(dir, 'models')) : false;
}

function efapiaoEnv(cfg: Config): NodeJS.ProcessEnv {
  const credentials = cfg.ocr.credentials ?? {};
  const configuredVendor = process.env.EFAPIAO_OCR_VENDOR || credentials.ocrVendor;
  const ocrVendor = configuredVendor
    || (credentials.tencentSecretId || credentials.tencentSecretKey ? 'tencent' : '')
    || (hasBundledModels(cfg) ? 'cnocr' : 'none');
  return {
    ...process.env,
    EFAPIAO_OCR_VENDOR: ocrVendor,
    EFAPIAO_API_KEY: credentials.apiKey || process.env.EFAPIAO_API_KEY,
    EFAPIAO_CNOCR_MODEL_PROFILE: credentials.cnocrModelProfile || process.env.EFAPIAO_CNOCR_MODEL_PROFILE,
    EFAPIAO_CNOCR_DET_MODEL: credentials.cnocrDetModel || process.env.EFAPIAO_CNOCR_DET_MODEL,
    EFAPIAO_CNOCR_REC_MODEL: credentials.cnocrRecModel || process.env.EFAPIAO_CNOCR_REC_MODEL,
    TENCENTCLOUD_SECRET_ID: credentials.tencentSecretId || credentials.secretId || process.env.TENCENTCLOUD_SECRET_ID,
    TENCENTCLOUD_SECRET_KEY: credentials.tencentSecretKey || credentials.secretKey || process.env.TENCENTCLOUD_SECRET_KEY,
    TENCENTCLOUD_REGION: credentials.tencentRegion || credentials.region || process.env.TENCENTCLOUD_REGION,
    TENCENT_SECRET_ID: credentials.tencentSecretId || credentials.secretId || process.env.TENCENT_SECRET_ID,
    TENCENT_SECRET_KEY: credentials.tencentSecretKey || credentials.secretKey || process.env.TENCENT_SECRET_KEY,
    TENCENT_REGION: credentials.tencentRegion || credentials.region || process.env.TENCENT_REGION,
  };
}

function stringValue(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function nestedName(v: unknown): string {
  if (v && typeof v === 'object' && 'name' in v) {
    return stringValue((v as { name?: unknown }).name);
  }
  return '';
}

function nestedRecord(v: unknown, key: string): Record<string, unknown> {
  if (v && typeof v === 'object' && key in v) {
    const child = (v as Record<string, unknown>)[key];
    if (child && typeof child === 'object') return child as Record<string, unknown>;
  }
  return {};
}

function hintFor(format: DocumentFormat): string {
  if (format === 'image') return 'image';
  return format === 'ofd' ? 'ofd' : 'pdf';
}

function ocrModeFor(cfg: Config): string {
  return cfg.ocr.ocrMode ?? 'auto';
}

function documentTypeFromEfapiao(value: string, fallback: DocumentType): DocumentType {
  if (value.includes('itinerary') || value.includes('rail')) return 'itinerary';
  if (value.includes('fapiao')) return 'invoice';
  return fallback;
}

function parseEfapiaoJson(text: string): EfapiaoPayload {
  const trimmed = text.trim();
  if (!trimmed) return {};
  return JSON.parse(trimmed) as EfapiaoPayload;
}

function compactError(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 500);
}

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

function toEfapiaoPayload(value: unknown): EfapiaoPayload {
  if (value && typeof value === 'object') return value as EfapiaoPayload;
  return {};
}

async function healthOk(cfg: Config): Promise<boolean> {
  try {
    const res = await fetch(`${serviceBaseUrl(cfg)}/v1/health`, {
      method: 'GET',
      signal: timeoutSignal(1000),
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
 */
export function stopEfapiaoServices(): void {
  for (const state of serviceStates.values()) {
    const child = state.child;
    if (child && !child.killed) {
      try {
        child.kill('SIGTERM');
      } catch {
        // best-effort
      }
    }
  }
  serviceStates.clear();
}

async function runService(
  cfg: Config,
  data: Buffer,
  meta: { format: DocumentFormat; filename: string },
): Promise<EfapiaoPayload> {
  await ensureService(cfg);
  const form = new FormData();
  form.set('file', new Blob([data]), meta.filename);
  form.set('hint_type', hintFor(meta.format));
  form.set('ocr_mode', ocrModeFor(cfg));

  const res = await fetch(`${serviceBaseUrl(cfg)}/v1/invoices/parse`, {
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

async function runServiceBatch(
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

  const res = await fetch(`${serviceBaseUrl(cfg)}/v1/invoices/parse-batch`, {
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

function runBinary(
  cfg: Config,
  data: Buffer,
  meta: { format: DocumentFormat; documentType: DocumentType; filename: string },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
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
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`efapiao timeout after ${cfg.ocr.timeoutMs}ms`));
    }, cfg.ocr.timeoutMs);

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });

    // Swallow EPIPE/ECONNRESET on stdin (e.g. the child exits or is killed on
    // timeout before consuming input); the failure is reported via 'error'/'close'.
    child.stdin.on('error', () => { /* ignore broken-pipe on stdin */ });
    child.stdin.end(data);
  });
}

function filled(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 按 document type 定义最小有效字段集（APP-14B）。
 * 顶层 `status:"ok"` 但结构为空/关键字段缺失时不能算识别成功，否则这份文档会从
 * 待处理和失败工作量里同时消失，重跑还会被当作已完成而跳过。
 * 返回空字符串表示通过，否则返回可读的缺失说明。
 */
function missingCoreFields(documentType: DocumentType, fields: Partial<InvoiceFields>): string {
  const present = [
    filled(fields.invoiceNo) ? 'invoiceNo' : '',
    filled(fields.seller) ? 'seller' : '',
    filled(fields.amount) ? 'amount' : '',
    filled(fields.date) ? 'date' : '',
  ].filter(Boolean);
  if (present.length === 0) return 'no_fields';
  if (documentType === 'invoice') {
    // 发票至少要有票号，或者「销售方 + 金额」这一组可对账的字段。
    if (filled(fields.invoiceNo)) return '';
    if (filled(fields.seller) && filled(fields.amount)) return '';
    return 'need_invoiceNo_or_seller_and_amount';
  }
  if (documentType === 'itinerary') {
    // 行程单不一定有票号，但至少要有两项可用字段才有归档价值。
    return present.length >= 2 ? '' : 'need_two_of_invoiceNo_seller_amount_date';
  }
  return '';
}

function okResult(payload: EfapiaoPayload, fallbackDocumentType: DocumentType, transport: 'cli' | 'http'): OcrResult {
  const data = payload.data ?? {};
  const source = nestedRecord(data, 'source');
  const documentTypeRaw = stringValue(data.document_type) || stringValue(payload.document_type);
  const invoiceType = stringValue(data.invoice_type) || stringValue(payload.invoice_type);
  const sourceFormat = stringValue(source.format) || stringValue(payload.format);
  const fields: Partial<InvoiceFields> = {
    seller: nestedName(data.seller),
    amount: stringValue(data.amount_with_tax) || stringValue(data.amount_without_tax),
    date: stringValue(data.issue_date),
    invoiceNo: stringValue(data.invoice_number) || stringValue(data.invoice_code),
    documentType: documentTypeFromEfapiao(documentTypeRaw, fallbackDocumentType),
    invoiceType,
  };
  const missing = missingCoreFields(fields.documentType ?? fallbackDocumentType, fields);
  return {
    // 字段不完整时给出明确的 partial 状态，保留已解析字段供人工复核。
    status: missing ? 'partial' : 'success',
    fields,
    error: missing ? `efapiao_incomplete_result:${missing}` : '',
    source: {
      format: sourceFormat === 'ofd' || sourceFormat === 'image' ? sourceFormat : 'pdf',
      parserVersion: stringValue(source.parser_version),
      extractedBy: stringValue(source.extracted_by),
      ocrVendor: stringValue(source.ocr_vendor) || null,
    },
    transport,
    raw: payload,
  };
}

function errorResult(payload: EfapiaoPayload, fallbackError: string, transport: 'cli' | 'http', fallbackDocumentType: DocumentType): OcrResult {
  const code = stringValue(payload.code);
  const message = stringValue(payload.message);
  const error = [code, message].filter(Boolean).join(':') || fallbackError;
  return {
    status: 'error',
    fields: {
      invoiceType: stringValue(payload.invoice_type),
      documentType: documentTypeFromEfapiao(stringValue(payload.document_type), fallbackDocumentType),
    },
    error,
    transport,
    raw: payload,
  };
}

async function parseViaCli(cfg: Config, data: Buffer, meta: { format: DocumentFormat; documentType: DocumentType; filename: string }): Promise<OcrResult> {
  let result: { code: number | null; stdout: string; stderr: string };
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
