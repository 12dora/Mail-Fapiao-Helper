import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { IncomingMessage, RequestOptions } from 'node:http';
import type { RequestOptions as HttpsRequestOptions } from 'node:https';

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

function ipv4Blocked(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true;                     // 0.0.0.0/8 "this host"
  if (a === 10) return true;                    // 10/8 private
  if (a === 127) return true;                   // loopback
  if (a === 169 && b === 254) return true;      // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 0) return true;        // 192.0.0.0/24 IETF Protocol Assignments
  if (a === 192 && b === 168) return true;      // 192.168/16 private
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a >= 224) return true;                     // multicast + reserved
  return false;
}

/** Expand any valid IPv6 literal (including `::` compression and an embedded
 *  IPv4 tail) to its 16 raw bytes, or null if it cannot be parsed. */
function ipv6ToBytes(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone); // drop scope id (fe80::1%eth0)
  // Convert a trailing dotted-quad (::ffff:127.0.0.1, ::127.0.0.1) to two hex words.
  const v4 = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4 && v4[1]) {
    const octs = v4[1].split('.').map(Number);
    if (octs.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hex = `${((octs[0]! << 8) | octs[1]!).toString(16)}:${((octs[2]! << 8) | octs[3]!).toString(16)}`;
    s = s.slice(0, s.length - v4[1].length) + hex;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  let words: string[];
  if (halves.length === 2) {
    const missing = 8 - (head.length + tail.length);
    if (missing < 0) return null;
    words = [...head, ...Array<string>(missing).fill('0'), ...tail];
  } else {
    words = head;
  }
  if (words.length !== 8) return null;
  const bytes: number[] = [];
  for (const w of words) {
    if (!/^[0-9a-f]{1,4}$/.test(w)) return null;
    const n = parseInt(w, 16);
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  return bytes;
}

/** True if an IP literal falls in a loopback / private / link-local / reserved range. */
export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return ipv4Blocked(ip);
  if (net.isIPv6(ip)) {
    const bytes = ipv6ToBytes(ip);
    if (!bytes) return true; // unparseable but net.isIPv6 accepted it -> block defensively
    if (bytes.every((b) => b === 0)) return true;                                    // :: unspecified
    if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true;     // ::1 loopback (any form)
    const first10Zero = bytes.slice(0, 10).every((b) => b === 0);
    if (first10Zero && bytes[10] === 0xff && bytes[11] === 0xff) {
      return ipv4Blocked(bytes.slice(12).join('.'));                                  // ::ffff:a.b.c.d (mapped, incl. hex form)
    }
    if (bytes.slice(0, 12).every((b) => b === 0)) {
      return ipv4Blocked(bytes.slice(12).join('.'));                                  // ::a.b.c.d (IPv4-compatible)
    }
    if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true;                 // fe80::/10 link-local
    if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0xc0) return true;                 // fec0::/10 site-local (deprecated)
    if ((bytes[0]! & 0xfe) === 0xfc) return true;                                      // fc00::/7 unique-local
    if (bytes[0] === 0xff) return true;                                                // ff00::/8 multicast
    return false;
  }
  return true; // not a recognizable IP -> treat as blocked
}

/** True if an IP is IPv4 127/8 or IPv6 ::1 (incl. v4-mapped/compat loopback). */
export function isLoopbackIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    return parts.length === 4 && parts[0] === 127;
  }
  if (net.isIPv6(ip)) {
    const bytes = ipv6ToBytes(ip);
    if (!bytes) return false;
    if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true; // ::1
    const first10Zero = bytes.slice(0, 10).every((b) => b === 0);
    if (first10Zero && bytes[10] === 0xff && bytes[11] === 0xff) {
      return bytes[12] === 127; // ::ffff:127.x.x.x
    }
    if (bytes.slice(0, 12).every((b) => b === 0)) {
      return bytes[12] === 127; // ::127.x.x.x
    }
  }
  return false;
}

/** Hostname is localhost or a loopback IP literal. */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (h === 'localhost') return true;
  if (net.isIP(h)) return isLoopbackIp(h);
  return false;
}

/** 一次 SSRF 校验得到的 URL + 已验证的公网 IP 列表（用于 DNS pin）。 */
export interface PublicUrlResolution {
  url: URL;
  /** 已确认公网的 IP 字面量；IP 字面量 host 时就是它自己。 */
  addresses: string[];
}

/**
 * SSRF guard: validate that a URL is a public http(s) endpoint before fetching
 * it. Rejects non-http schemes and any host that resolves to a private /
 * loopback / link-local address. Throws an ordinary Error (prefix
 * `blocked_url:`) so the caller's per-email try/catch degrades to manual.
 *
 * 返回已验证的地址列表，供 `safeFetch` 在连接时 pin 到同一批 IP，避免
 * 校验 lookup 与实际 connect lookup 之间的 DNS rebinding。
 */
export async function resolvePublicUrl(urlStr: string): Promise<PublicUrlResolution> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new Error(`blocked_url:invalid:${urlStr}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`blocked_url:scheme:${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error(`blocked_url:private_ip:${host}`);
    return { url, addresses: [host] };
  }
  let addrs: { address: string; family: number }[];
  try {
    addrs = await dnsLookup(host, { all: true });
  } catch {
    throw new Error(`blocked_url:dns:${host}`);
  }
  if (addrs.length === 0) throw new Error(`blocked_url:dns_empty:${host}`);
  const publicAddrs: string[] = [];
  for (const a of addrs) {
    if (isBlockedIp(a.address)) throw new Error(`blocked_url:private_ip:${host}->${a.address}`);
    publicAddrs.push(a.address);
  }
  return { url, addresses: publicAddrs };
}

/**
 * SSRF guard（兼容入口）：只校验 URL，不返回 pin 地址。
 * 新代码应优先用 `resolvePublicUrl` + `safeFetch`。
 */
export async function assertPublicUrl(urlStr: string): Promise<URL> {
  const resolved = await resolvePublicUrl(urlStr);
  return resolved.url;
}

/**
 * OCR / 本机服务 URL 校验：允许回环（bundled efapiao）或公网，拒绝其它内网/保留段。
 * - `localhost` / `127.0.0.1` / `::1`：DNS 结果必须全部是 loopback
 * - 其它 hostname：与 `resolvePublicUrl` 相同（全部公网）
 * - 其它私网 IP 字面量：拒绝（防把发票字节与 API Key 打到链路本地/CGNAT 等）
 */
export async function resolveServiceUrl(urlStr: string): Promise<PublicUrlResolution> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new Error(`blocked_url:invalid:${urlStr}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`blocked_url:scheme:${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (net.isIP(host)) {
    if (isLoopbackIp(host)) return { url, addresses: [host] };
    if (isBlockedIp(host)) throw new Error(`blocked_url:private_ip:${host}`);
    return { url, addresses: [host] };
  }
  let addrs: { address: string; family: number }[];
  try {
    addrs = await dnsLookup(host, { all: true });
  } catch {
    throw new Error(`blocked_url:dns:${host}`);
  }
  if (addrs.length === 0) throw new Error(`blocked_url:dns_empty:${host}`);

  if (isLoopbackHost(host)) {
    const loopbackAddrs: string[] = [];
    for (const a of addrs) {
      if (!isLoopbackIp(a.address)) {
        throw new Error(`blocked_url:localhost_non_loopback:${host}->${a.address}`);
      }
      loopbackAddrs.push(a.address);
    }
    return { url, addresses: loopbackAddrs };
  }

  const publicAddrs: string[] = [];
  for (const a of addrs) {
    if (isBlockedIp(a.address)) throw new Error(`blocked_url:private_ip:${host}->${a.address}`);
    publicAddrs.push(a.address);
  }
  return { url, addresses: publicAddrs };
}

/**
 * 事后防线：在 body 消费前再校验 `response.url`。
 * **不能**作为 SSRF 主防线——`redirect:'follow'` 已经对内网发出请求之后才走到这里。
 * 主防线是 `safeFetch`（逐跳校验 + DNS pin）。
 */
export async function assertPublicResponse(response: Response): Promise<Response> {
  const finalUrl = response.url;
  if (finalUrl) {
    try {
      await assertPublicUrl(finalUrl);
    } catch (err) {
      await response.body?.cancel().catch(() => {});
      throw err;
    }
  }
  return response;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function resolveRedirectUrl(current: URL, location: string): string {
  try {
    return new URL(location, current).href;
  } catch {
    throw new Error(`blocked_url:invalid_redirect:${location}`);
  }
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
    const pinned = addresses.map((address) => ({
      address,
      family: (net.isIPv6(address) ? 6 : 4) as 4 | 6,
    }));
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const port = url.port ? Number(url.port) : (isHttps ? 443 : 80);
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      fn();
    };

    const options: RequestOptions & HttpsRequestOptions = {
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

    const req = lib.request(options, (incoming: IncomingMessage) => {
      const status = incoming.statusCode ?? 0;
      const responseHeaders = incomingToHeaders(incoming);

      // Redirect：header 阶段即返回并**销毁** socket，禁止 resume 排空——恶意
      // Location 后仍可无限推 body，resume 会在下一跳进行时占满带宽/事件循环。
      if (isRedirectStatus(status)) {
        incoming.destroy();
        const nullBody = status === 204 || status === 205 || status === 304;
        const response = new Response(nullBody ? null : new Uint8Array(0), {
          status,
          statusText: incoming.statusMessage ?? '',
          headers: responseHeaders,
        });
        stampResponseUrl(response, url.href);
        settle(() => resolve(response));
        return;
      }

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
        const response = new Response(nullBody ? null : new Uint8Array(data), {
          status,
          statusText: incoming.statusMessage ?? '',
          headers: responseHeaders,
        });
        stampResponseUrl(response, url.href);
        settle(() => resolve(response));
      });
    });

    const onAbort = (): void => {
      req.destroy(new Error('The operation was aborted'));
    };

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

/**
 * 受控 HTTP transport 内核：逐跳校验 + DNS pin + body 上限。
 * `resolveUrl` 决定公网-only（safeFetch）还是服务端点（safeServiceFetch）。
 */
async function controlledFetch(
  input: string | URL | Request,
  init: SafeFetchInit | undefined,
  resolveUrl: ResolveUrlFn,
): Promise<Response> {
  const maxRedirects = init?.maxRedirects ?? MAX_REDIRECTS;
  const bodyCapBytes = typeof init?.maxBodyBytes === 'number' && init.maxBodyBytes > 0
    ? init.maxBodyBytes
    : MAX_DOC_BYTES;
  let urlStr: string;
  if (typeof input === 'string') {
    urlStr = input;
  } else if (input instanceof URL) {
    urlStr = input.href;
  } else {
    urlStr = input.url;
  }

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

  while (true) {
    if (signal?.aborted) {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    }
    if (hop > maxRedirects) {
      throw new Error(`blocked_url:too_many_redirects:${maxRedirects}:${currentUrl}`);
    }
    const resolved = await resolveUrl(currentUrl);
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
    if (!location) {
      throw new Error(`blocked_url:redirect_without_location:${response.status}:${resolved.url.href}`);
    }
    const nextUrl = resolveRedirectUrl(resolved.url, location);
    if (!/^https?:\/\//i.test(nextUrl)) {
      throw new Error(`blocked_url:scheme_redirect:${nextUrl}`);
    }
    const nextParsed = new URL(nextUrl);
    // 301/302/303：非 GET/HEAD 改为 GET 且丢掉 body（浏览器语义）；307/308 保留。
    let nextMethod = method;
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== 'GET' && method !== 'HEAD')) {
      nextMethod = 'GET';
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
 */
export async function safeServiceFetch(input: string | URL | Request, init?: SafeFetchInit): Promise<Response> {
  return controlledFetch(input, init, resolveServiceUrl);
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
