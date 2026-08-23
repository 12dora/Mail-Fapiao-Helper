import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import type { RequestOptions as HttpsRequestOptions } from 'node:https';
import {
  isRedirectStatus,
  ipv6ToBytes,
  resolvePublicUrl,
  resolveRedirectUrl,
  resolveServiceUrl,
  resolveUrlForPinnedPolicy,
  serviceHopPolicyOf,
} from './urlPolicy.js';
import type { PublicUrlResolution, ServiceHopPolicy } from './urlPolicy.js';

/** Per-document / per-response memory cap. Mirrors the 50MB invariant in ARCHITECTURE.md (R4). */
export const MAX_DOC_BYTES = 50 * 1024 * 1024;

/** `network.timeoutMs` 缺失或非法时的兜底 per-attempt deadline。 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** 受控 HTTP transport 允许的最大 redirect 跳数。 */
export const MAX_REDIRECTS = 5;

/**
 * 为单次 HTTP 尝试构造 deadline signal（APP-13）。
 *
 * 该 signal 会同时挂在 request 与 `Response.body` 上，所以 header 阶段“接受连接
 * 但不发完响应头”和 body 阶段“持续滴流”都会在 `timeoutMs` 后被中止并释放 socket；
 * 调用方自带的 signal（若有）会与 deadline 合并。
 */
export function attemptDeadlineSignal(
  existing: AbortSignal | null | undefined,
  timeoutMs: number,
): AbortSignal | undefined {
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const deadline = AbortSignal.timeout(ms);
  if (!existing) return deadline;
  return AbortSignal.any([existing, deadline]);
}

/** body 读取阶段命中 per-attempt deadline 时的错误前缀。 */
export const RESPONSE_TIMEOUT_PREFIX = 'response_timeout:';

/** 判断一个错误是否来自 per-attempt deadline / abort，用于决定是否重试。 */
export function isTimeoutError(err: unknown): boolean {
  if (!err) return false;
  const name = (err as { name?: string }).name;
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  const cause = (err as { cause?: unknown }).cause;
  const causeName = cause ? (cause as { name?: string }).name : undefined;
  if (causeName === 'TimeoutError' || causeName === 'AbortError') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /timed out|timeout|operation was aborted|the operation was aborted/i.test(msg);
}

/**
 * 用一份已读完的字节重建 Response，供“把 body 消费放进同一个 attempt”的重试器
 * 返回给调用方（APP-13）。`url` 是 Response 原型上的只读 getter，这里用同名自有
 * 属性遮蔽它，使 `response.url`（短链解析、SSRF 复核都依赖）保持原值。
 */
export function bufferedResponse(original: Response, data: Buffer): Response {
  const headers = new Headers(original.headers);
  // body 已被解码并物化：把长度对齐到真实字节数，并去掉会误导二次读取的编码头。
  headers.delete('content-encoding');
  headers.set('content-length', String(data.length));
  // 204/205/304 在 Response 构造器里必须是 null body。
  const nullBody = data.length === 0 || original.status === 204 || original.status === 205 || original.status === 304;
  const rebuilt = new Response(nullBody ? null : new Uint8Array(data), {
    status: original.status,
    statusText: original.statusText,
    headers,
  });
  Object.defineProperty(rebuilt, 'url', { value: original.url, enumerable: true, configurable: true });
  return rebuilt;
}

function stampResponseUrl(response: Response, url: string): Response {
  try {
    Object.defineProperty(response, 'url', { value: url, enumerable: true, configurable: true });
  } catch {
    // 某些 runtime 上 Response.url 不可配置；调用方仍可用返回值旁路。
  }
  return response;
}

/** 把 IPv6 压缩/映射形式归一成可比较的小写字面量。 */
function normalizeIpLiteral(ip: string): string {
  let s = ip.toLowerCase();
  if (s.startsWith('::ffff:') && net.isIPv4(s.slice(7))) return s.slice(7);
  const bytes = ipv6ToBytes(s);
  if (bytes) {
    // 展开为固定 8 组，便于与 pin 列表比对。
    const words: string[] = [];
    for (let i = 0; i < 16; i += 2) {
      words.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16));
    }
    return words.join(':');
  }
  return s;
}

function addressAllowed(remote: string | undefined, allowed: string[]): boolean {
  if (!remote) return false;
  const remoteNorm = normalizeIpLiteral(remote);
  for (const a of allowed) {
    if (normalizeIpLiteral(a) === remoteNorm) return true;
    // 直接字符串相等（含 IPv4）
    if (a === remote || a.toLowerCase() === remote.toLowerCase()) return true;
  }
  return false;
}

/** 需要在跨源 / 降级 redirect 时剥离的敏感请求头。 */
const SENSITIVE_REQUEST_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'cookie2',
  // OCR / 站点 API Key；跨源不得带到 redirect 目标。
  'x-api-key',
  // 部分站点 handler 把签名发票 URL 放进 Referer，跨源会泄露。
  'referer',
]);

/** 方法改写为 GET 后必须丢弃的实体头。 */
const ENTITY_REQUEST_HEADERS = new Set([
  'content-length',
  'content-type',
  'content-encoding',
  'content-language',
  'content-location',
  'content-md5',
  'content-range',
  'transfer-encoding',
  'trailer',
]);

function headerKeyLower(key: string): string {
  return key.toLowerCase();
}

/** 把 RequestInit.headers 摊成普通对象，并强制 Host 为原始 hostname（配合 IP pin）。 */
function headersToRecord(headers: RequestInit['headers'] | undefined, hostHeader: string): Record<string, string> {
  const out: Record<string, string> = { host: hostHeader };
  if (!headers) return out;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key] = value;
    });
  } else if (Array.isArray(headers)) {
    for (const pair of headers) {
      const key = pair[0];
      const value = pair[1];
      if (key !== undefined && value !== undefined) out[String(key)] = String(value);
    }
  } else {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (value !== undefined && value !== null) out[key] = String(value);
    }
  }
  // Host 必须以校验过的 URL host 为准，防止调用方覆盖。
  out.host = hostHeader;
  return out;
}

/**
 * 跨源或 HTTPS→HTTP 降级时剥离 Authorization/Cookie 等敏感头。
 * 方法变为 GET/HEAD 时去掉实体头，避免把 POST 的 Content-Type/Length 带到 GET。
 */
function sanitizeRedirectHeaders(
  headers: Record<string, string>,
  fromUrl: URL,
  toUrl: URL,
  method: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = value;
  }

  const sameOrigin =
    fromUrl.protocol === toUrl.protocol
    && fromUrl.hostname.toLowerCase() === toUrl.hostname.toLowerCase()
    && (fromUrl.port || defaultPort(fromUrl.protocol)) === (toUrl.port || defaultPort(toUrl.protocol));
  const downgrade = fromUrl.protocol === 'https:' && toUrl.protocol === 'http:';

  if (!sameOrigin || downgrade) {
    for (const key of Object.keys(out)) {
      if (SENSITIVE_REQUEST_HEADERS.has(headerKeyLower(key))) {
        delete out[key];
      }
    }
  }

  if (method === 'GET' || method === 'HEAD') {
    for (const key of Object.keys(out)) {
      if (ENTITY_REQUEST_HEADERS.has(headerKeyLower(key))) {
        delete out[key];
      }
    }
  }

  // Host 在每跳 headersToRecord / 此处统一设为当前目标。
  out.host = toUrl.host;
  return out;
}

function defaultPort(protocol: string): string {
  return protocol === 'https:' ? '443' : '80';
}

async function bodyToBuffer(body: RequestInit['body'] | undefined): Promise<Buffer | undefined> {
  if (body == null) return undefined;
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (typeof body === 'string') return Buffer.from(body);
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return Buffer.from(body.toString());
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return Buffer.from(await body.arrayBuffer());
  }
  // ReadableStream / FormData 等：退回 Response 物化。
  if (typeof body === 'object' && body !== null && 'getReader' in (body as object)) {
    const res = new Response(body as never);
    return Buffer.from(await res.arrayBuffer());
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const res = new Response(body as never);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error('safe_fetch_unsupported_body');
}

function incomingToHeaders(incoming: IncomingMessage): Headers {
  const responseHeaders = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) responseHeaders.append(key, v);
    } else {
      responseHeaders.set(key, value);
    }
  }
  return responseHeaders;
}

type Settle = (fn: () => void) => void;

function pinnedRequestOptions(
  url: URL,
  addresses: string[],
  method: string,
  headers: Record<string, string>,
): RequestOptions & HttpsRequestOptions {
  const pinned = addresses.map((address) => ({
    address,
    family: (net.isIPv6(address) ? 6 : 4) as 4 | 6,
  }));
  const isHttps = url.protocol === 'https:';
  const port = url.port ? Number(url.port) : (isHttps ? 443 : 80);
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port,
    path: `${url.pathname}${url.search}`,
    method,
    headers,
    // 禁止全局 Agent 连接池：池按 hostname 键控，会复用未走 pin lookup 的 socket（OCR-01）。
    agent: false,
    // 连接：lookup 固定到校验过的 IP，SNI 仍用 hostname（https 默认）。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    lookup: ((
      _hostname: string,
      lookupOptions: unknown,
      callback: (
        err: NodeJS.ErrnoException | null,
        address: string | Array<{ address: string; family: number }>,
        family?: number,
      ) => void,
    ): void => {
      const opts = typeof lookupOptions === 'object' && lookupOptions !== null
        ? lookupOptions as { all?: boolean }
        : {};
      if (opts.all) {
        callback(null, pinned);
        return;
      }
      callback(null, pinned[0]!.address, pinned[0]!.family);
    }) as any,
    servername: isHttps ? url.hostname.replace(/^\[/, '').replace(/\]$/, '') : undefined,
  };
}

function responseFromIncoming(
  incoming: IncomingMessage,
  status: number,
  responseHeaders: Headers,
  data: Uint8Array,
  nullBody: boolean,
  url: URL,
): Response {
  const response = new Response(nullBody ? null : new Uint8Array(data), {
    status,
    statusText: incoming.statusMessage ?? '',
    headers: responseHeaders,
  });
  stampResponseUrl(response, url.href);
  return response;
}

function settleRedirectResponse(
  incoming: IncomingMessage,
  status: number,
  responseHeaders: Headers,
  url: URL,
  settle: Settle,
  resolve: (response: Response | PromiseLike<Response>) => void,
): boolean {
  if (!isRedirectStatus(status)) return false;
  // Redirect：header 阶段即返回并**销毁** socket，禁止 resume 排空——恶意
  // Location 后仍可无限推 body，resume 会在下一跳进行时占满带宽/事件循环。
  incoming.destroy();
  const nullBody = status === 204 || status === 205 || status === 304;
  const response = responseFromIncoming(incoming, status, responseHeaders, new Uint8Array(0), nullBody, url);
  settle(() => resolve(response));
  return true;
}

function attachPinnedSocketVerification(
  req: ClientRequest,
  url: URL,
  addresses: string[],
): void {
  // 连接建立后校验远端地址必须属于 pin 集合，堵住池复用/错误路由（OCR-01）。
  req.on('socket', (socket) => {
    const verify = (): void => {
      const remote = socket.remoteAddress;
      if (!addressAllowed(remote, addresses)) {
        req.destroy(new Error(
          `blocked_url:remote_mismatch:${url.hostname}->${remote ?? 'unknown'}`,
        ));
      }
    };
    if (socket.connecting) {
      socket.once('connect', verify);
    } else {
      verify();
    }
  });
}

/**
 * 单跳 HTTP(S) 请求：connect lookup 固定到已验证公网 IP，TLS servername/Host 保留原 hostname。
 * - `agent: false`：禁止 keep-alive 池复用未 pin 的 socket（OCR-01）
 * - connect 后校验 `socket.remoteAddress` 必须落在 pin 集合内
 * - 非 redirect 响应在接收阶段强制 MAX_DOC_BYTES 上限（NEW-DEFECT 1）
 * - redirect 在 header 阶段判定，销毁 body 流，不整包缓冲
 */
function pinnedRequest(
  url: URL,
  addresses: string[],
  method: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
  signal: AbortSignal | null | undefined,
  bodyCapBytes: number = MAX_DOC_BYTES,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (addresses.length === 0) {
      reject(new Error(`blocked_url:dns_empty:${url.hostname}`));
      return;
    }
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      fn();
    };

    const options = pinnedRequestOptions(url, addresses, method, headers);

    const req = lib.request(options, (incoming: IncomingMessage) => {
      const status = incoming.statusCode ?? 0;
      const responseHeaders = incomingToHeaders(incoming);

      if (settleRedirectResponse(incoming, status, responseHeaders, url, settle, resolve)) return;

      // Content-Length 预检：过大则立刻断开，不读 body。
      const lenHeader = incoming.headers['content-length'];
      if (typeof lenHeader === 'string') {
        const len = Number(lenHeader);
        if (Number.isFinite(len) && len > bodyCapBytes) {
          incoming.destroy();
          settle(() => reject(new Error(`response_too_large:content_length:${len}`)));
          return;
        }
      }

      const chunks: Buffer[] = [];
      let total = 0;
      incoming.on('data', (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > bodyCapBytes) {
          incoming.destroy();
          settle(() => reject(new Error(`response_too_large:${total}`)));
          return;
        }
        chunks.push(buf);
      });
      incoming.on('error', (err) => {
        settle(() => reject(err));
      });
      incoming.on('end', () => {
        if (settled) return;
        const data = Buffer.concat(chunks);
        const nullBody = data.length === 0 || status === 204 || status === 205 || status === 304;
        const response = responseFromIncoming(incoming, status, responseHeaders, data, nullBody, url);
        settle(() => resolve(response));
      });
    });

    const onAbort = (): void => {
      req.destroy(new Error('The operation was aborted'));
    };

    attachPinnedSocketVerification(req, url, addresses);

    if (signal) {
      if (signal.aborted) {
        onAbort();
        settle(() => {
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        });
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    req.on('error', (err) => {
      settle(() => reject(err));
    });
    if (body && method !== 'GET' && method !== 'HEAD') {
      req.end(body);
    } else {
      req.end();
    }
  });
}

export interface SafeFetchInit extends RequestInit {
  /** 覆盖默认最大跳数（含起始请求共 N+1 次连接）。 */
  maxRedirects?: number;
  /**
   * 响应 body 接收上限（字节）。在 pinned 接收阶段强制，避免
   * `makeRetryingFetch` 先按 MAX_DOC_BYTES 整包缓冲后再由调用方限流。
   */
  maxBodyBytes?: number;
}

type ResolveUrlFn = (urlStr: string) => Promise<PublicUrlResolution>;

interface ControlledFetchOptions {
  /**
   * 首跳成功后把 redirect 策略锁到首跳类别（public 或 loopback）。
   * OCR `safeServiceFetch` 必须开启：公网 OCR 不得 307 把发票 body 打到 127.0.0.1。
   */
  pinRedirectPolicy?: boolean;
}

function controlledFetchUrl(input: string | URL | Request): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

interface RedirectTransition {
  nextUrl: string;
  nextParsed: URL;
  nextMethod: string;
  discardBody: boolean;
}

function redirectTransition(
  response: Response,
  currentUrl: URL,
  method: string,
  location: string | null,
): RedirectTransition {
  if (!location) {
    throw new Error(`blocked_url:redirect_without_location:${response.status}:${currentUrl.href}`);
  }
  const nextUrl = resolveRedirectUrl(currentUrl, location);
  if (!/^https?:\/\//i.test(nextUrl)) {
    throw new Error(`blocked_url:scheme_redirect:${nextUrl}`);
  }
  const nextParsed = new URL(nextUrl);
  // 301/302/303：非 GET/HEAD 改为 GET 且丢掉 body（浏览器语义）；307/308 保留。
  let nextMethod = method;
  let discardBody = false;
  if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== 'GET' && method !== 'HEAD')) {
    nextMethod = 'GET';
    discardBody = true;
  }
  return { nextUrl, nextParsed, nextMethod, discardBody };
}

/**
 * 受控 HTTP transport 内核：逐跳校验 + DNS pin + body 上限。
 * `resolveUrl` 决定公网-only（safeFetch）还是服务端点（safeServiceFetch）。
 */
async function controlledFetch(
  input: string | URL | Request,
  init: SafeFetchInit | undefined,
  resolveUrl: ResolveUrlFn,
  options?: ControlledFetchOptions,
): Promise<Response> {
  const maxRedirects = init?.maxRedirects ?? MAX_REDIRECTS;
  const bodyCapBytes = typeof init?.maxBodyBytes === 'number' && init.maxBodyBytes > 0
    ? init.maxBodyBytes
    : MAX_DOC_BYTES;
  const urlStr = controlledFetchUrl(input);

  // 从 init 去掉我们接管的字段，避免调用方 `redirect:'follow'` 绕过。
  const {
    maxRedirects: _ignoredMax,
    maxBodyBytes: _ignoredCap,
    redirect: _ignoredRedirect,
    ...restInit
  } = init ?? {};

  let currentUrl = urlStr;
  let hop = 0;
  // 303 以及部分 302 习惯上把方法改成 GET；307/308 保留原方法。
  let method = (restInit.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  let body: RequestInit['body'] | undefined = restInit.body;
  // 可变请求头：跨跳时可能剥离敏感字段 / 实体字段。
  let headerRecord: Record<string, string> | undefined;
  // 整链共用同一 abort signal，deadline 覆盖全部 redirect hop。
  const signal = restInit.signal;
  // 首跳策略锁定：后续跳不再使用「公网或 loopback 均可」的宽解析器。
  let resolveHop: ResolveUrlFn = resolveUrl;
  let pinnedPolicy: ServiceHopPolicy | null = null;

  while (true) {
    if (signal?.aborted) {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    }
    if (hop > maxRedirects) {
      throw new Error(`blocked_url:too_many_redirects:${maxRedirects}:${currentUrl}`);
    }
    const resolved = await resolveHop(currentUrl);
    if (options?.pinRedirectPolicy && pinnedPolicy === null) {
      pinnedPolicy = serviceHopPolicyOf(resolved);
      // 从第二跳起强制同一策略；跨策略 Location 在解析阶段即拒绝（含 307/308 保 body）。
      resolveHop = resolveUrlForPinnedPolicy(pinnedPolicy);
    }
    const hostHeader = resolved.url.host; // 含非默认端口
    if (!headerRecord) {
      headerRecord = headersToRecord(restInit.headers, hostHeader);
    } else {
      headerRecord = { ...headerRecord, host: hostHeader };
    }
    const bodyBuf = method === 'GET' || method === 'HEAD' ? undefined : await bodyToBuffer(body);
    if (bodyBuf && !headerRecord['content-length'] && !headerRecord['Content-Length']) {
      headerRecord['content-length'] = String(bodyBuf.length);
    }

    const response = await pinnedRequest(
      resolved.url,
      resolved.addresses,
      method,
      headerRecord,
      bodyBuf,
      signal,
      bodyCapBytes,
    );

    if (!isRedirectStatus(response.status)) {
      return response;
    }

    const location = response.headers.get('location');
    // redirect body 已在 pinnedRequest 中 destroy，这里仍做 cancel 兼容。
    await response.body?.cancel().catch(() => {});
    const { nextUrl, nextParsed, nextMethod, discardBody } = redirectTransition(
      response,
      resolved.url,
      method,
      location,
    );
    if (discardBody) {
      body = undefined;
    }
    // 跨源 / HTTPS→HTTP / 方法改写：剥离敏感头与陈旧实体头（NEW-DEFECT 2）。
    headerRecord = sanitizeRedirectHeaders(headerRecord, resolved.url, nextParsed, nextMethod);
    method = nextMethod;
    currentUrl = nextUrl;
    hop++;
  }
}

/**
 * 受控 HTTP transport（OCR-01 / SSRF 主防线）：
 * 1. 关闭自动 redirect，逐跳解析 Location；
 * 2. 每一跳在**发出请求前**做 scheme/host/IP 校验（仅公网）；
 * 3. 连接时把已验证 IP pin 到 `http(s).request` 的 lookup，并用 `agent:false`
 *    禁止 keep-alive 池绕过 pin；connect 后复核 remoteAddress；
 * 4. TLS SNI 与 Host 仍使用原始 hostname；
 * 5. 跨源/降级 redirect 剥离敏感头；方法改写后丢弃实体头；
 * 6. 最终（及非 redirect）body 在接收阶段强制字节上限。
 *
 * 调用方应优先用本函数替代裸 `fetch` + `assertPublicResponse`。
 * 兼容 `fetch` 签名，便于接到现有 retrying wrapper。
 */
export async function safeFetch(input: string | URL | Request, init?: SafeFetchInit): Promise<Response> {
  return controlledFetch(input, init, resolvePublicUrl);
}

/**
 * OCR 服务专用 transport：在 `safeFetch` 同等防护上，额外允许**显式回环**地址
 *（bundled efapiao 的 `http://127.0.0.1:port`），并拒绝其它私网/链路本地目标。
 * 跨源 redirect 会丢掉 `X-API-Key` / `Authorization` / `Referer` 等敏感头。
 *
 * Redirect 策略与首跳绑定（S4）：
 * - 首跳公网 → 后续仅公网（`resolvePublicUrl`），不得 307/308 进 loopback；
 * - 首跳 loopback → 后续仅 loopback，不得出站。
 * 发票字节在 body-preserving redirect 下也不会被带到另一策略空间。
 */
export async function safeServiceFetch(input: string | URL | Request, init?: SafeFetchInit): Promise<Response> {
  return controlledFetch(input, init, resolveServiceUrl, { pinRedirectPolicy: true });
}

/**
 * Read a fetch Response body into a Buffer while enforcing a hard byte cap.
 * Short-circuits on an oversized Content-Length, then streams the body and
 * aborts once the running total exceeds the cap. Throws `response_too_large:*`.
 */
export async function readCappedBuffer(response: Response, cap = MAX_DOC_BYTES): Promise<Buffer> {
  const lenHeader = response.headers.get('content-length');
  if (lenHeader) {
    const len = Number(lenHeader);
    if (Number.isFinite(len) && len > cap) {
      // Release the socket instead of leaking the unread oversized body.
      await response.body?.cancel().catch(() => {});
      throw new Error(`response_too_large:content_length:${len}`);
    }
  }
  const body = response.body;
  if (!body) {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > cap) throw new Error(`response_too_large:${buf.length}`);
    return buf;
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > cap) {
          throw new Error(`response_too_large:${total}`);
        }
        chunks.push(Buffer.from(value));
      }
    }
  } catch (err) {
    // per-attempt deadline 到期会在 body 读取中途 abort：主动取消 reader 释放
    // socket，并转成明确的超时错误，便于上层形成可读的 pending reason（APP-13）。
    await reader.cancel().catch(() => {});
    if (isTimeoutError(err)) throw new Error(`${RESPONSE_TIMEOUT_PREFIX}${total}`);
    throw err;
  }
  return Buffer.concat(chunks);
}
