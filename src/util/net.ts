import net from 'node:net';
import { lookup } from 'node:dns/promises';

/** Per-document / per-response memory cap. Mirrors the 50MB invariant in ARCHITECTURE.md (R4). */
export const MAX_DOC_BYTES = 50 * 1024 * 1024;

/** `network.timeoutMs` 缺失或非法时的兜底 per-attempt deadline。 */
export const DEFAULT_TIMEOUT_MS = 30_000;

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
  if (a === 192 && b === 168) return true;      // 192.168/16 private
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
    if ((bytes[0]! & 0xfe) === 0xfc) return true;                                      // fc00::/7 unique-local
    if (bytes[0] === 0xff) return true;                                                // ff00::/8 multicast
    return false;
  }
  return true; // not a recognizable IP -> treat as blocked
}

/**
 * SSRF guard: validate that a URL is a public http(s) endpoint before fetching
 * it. Rejects non-http schemes and any host that resolves to a private /
 * loopback / link-local address. Throws an ordinary Error (prefix
 * `blocked_url:`) so the caller's per-email try/catch degrades to manual.
 */
export async function assertPublicUrl(urlStr: string): Promise<URL> {
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
    return url;
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error(`blocked_url:dns:${host}`);
  }
  if (addrs.length === 0) throw new Error(`blocked_url:dns_empty:${host}`);
  for (const a of addrs) {
    if (isBlockedIp(a.address)) throw new Error(`blocked_url:private_ip:${host}->${a.address}`);
  }
  return url;
}

/**
 * Defense-in-depth against redirect-based SSRF: after a redirect-following fetch,
 * reject when the FINAL resolved URL (`response.url`) landed on a private /
 * loopback / link-local host that `assertPublicUrl` would have blocked up front.
 * undici's `redirect:'manual'` yields an opaque, unreadable response, so per-hop
 * validation isn't possible with global fetch; this at least guarantees the body
 * is never consumed from an internal host reached via a public URL's redirect.
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
