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

/**
 * SSRF IP classification — genuine DEFAULT-DENY.
 *
 * An address is blocked unless it is **provably global unicast**:
 *   1. must parse as a strict IPv4 / IPv6 literal (else BLOCK);
 *   2. IPv4-mapped / IPv4-compatible IPv6 → classify the embedded IPv4;
 *   3. IPv6 must sit in 2000::/3 (global unicast container);
 *   4. subtract the full IANA Special-Purpose Address Registries
 *      (any match → BLOCK; unclassifiable → BLOCK).
 *
 * Ordinary public destinations (e.g. CDN invoice hosts) remain allowed.
 *
 * Audit sources (do not treat this as an ad-hoc deny-list to grow piecemeal):
 *   - https://www.iana.org/assignments/iana-ipv4-special-registry/
 *   - https://www.iana.org/assignments/iana-ipv6-special-registry/
 *   - Multicast / reserved are non-unicast and therefore never global.
 *
 * Compact IPv4 special-purpose table (registry name → prefix):
 *   This network              0.0.0.0/8
 *   Private-Use               10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
 *   Shared Address Space      100.64.0.0/10
 *   Loopback                  127.0.0.0/8
 *   Link Local                169.254.0.0/16
 *   IETF Protocol Assignments 192.0.0.0/24  (covers /29 continuity, dummy, PCP, TURN, NAT64)
 *   TEST-NET-1                192.0.2.0/24
 *   AS112-v4                  192.31.196.0/24
 *   AMT                       192.52.193.0/24
 *   6to4 Relay Anycast (dep.) 192.88.99.0/24
 *   Direct Delegation AS112   192.175.48.0/24
 *   Benchmarking              198.18.0.0/15
 *   TEST-NET-2                198.51.100.0/24
 *   TEST-NET-3                203.0.113.0/24
 *   Multicast (non-unicast)   224.0.0.0/4
 *   Reserved / Limited Bcast  240.0.0.0/4  (includes 255.255.255.255/32)
 *
 * Compact IPv6 special-purpose table (registry name → prefix):
 *   Unspecified               ::/128
 *   Loopback                  ::1/128
 *   IPv4-mapped / compatible  ::ffff:0:0/96, ::/96  (→ embedded IPv4 rules)
 *   Well-known NAT64          64:ff9b::/96
 *   Local-Use IPv4/IPv6 XLAT  64:ff9b:1::/48
 *   Discard-Only              100::/64
 *   IETF Protocol Assignments 2001::/23  (TEREDO, benchmarking, AMT, AS112-v6, ORCHID*, …)
 *   Documentation             2001:db8::/32, 3fff::/20
 *   6to4                      2002::/16
 *   Direct Delegation AS112   2620:4f:8000::/48
 *   Segment Routing (SIDs)    5f00::/16
 *   Unique-Local              fc00::/7
 *   Link-Local Unicast        fe80::/10
 *   Multicast                 ff00::/8
 */

/** IANA IPv4 Special-Purpose (+ non-unicast) prefixes — subtracted after parse. */
const IPV4_SPECIAL_PURPOSE: ReadonlyArray<readonly [network: number, prefixLen: number]> = [
  [0x00000000, 8],  // 0.0.0.0/8 This network
  [0x0a000000, 8],  // 10.0.0.0/8 Private-Use
  [0x64400000, 10], // 100.64.0.0/10 Shared Address Space (CGNAT)
  [0x7f000000, 8],  // 127.0.0.0/8 Loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 Link Local
  [0xac100000, 12], // 172.16.0.0/12 Private-Use
  [0xc0000000, 24], // 192.0.0.0/24 IETF Protocol Assignments
  [0xc0000200, 24], // 192.0.2.0/24 TEST-NET-1
  [0xc01fc400, 24], // 192.31.196.0/24 AS112-v4
  [0xc034c100, 24], // 192.52.193.0/24 AMT
  [0xc0586300, 24], // 192.88.99.0/24 6to4 Relay Anycast (deprecated)
  [0xc0a80000, 16], // 192.168.0.0/16 Private-Use
  [0xc0af3000, 24], // 192.175.48.0/24 Direct Delegation AS112 Service
  [0xc6120000, 15], // 198.18.0.0/15 Benchmarking
  [0xc6336400, 24], // 198.51.100.0/24 TEST-NET-2
  [0xcb007100, 24], // 203.0.113.0/24 TEST-NET-3
  [0xe0000000, 4],  // 224.0.0.0/4 Multicast (non-unicast)
  [0xf0000000, 4],  // 240.0.0.0/4 Reserved (incl. 255.255.255.255/32)
];

/** Parse dotted-quad to uint32; null if not a strict IPv4 literal. */
function parseIpv4Uint(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const o = Number(part);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    n = ((n << 8) | o) >>> 0;
  }
  return n >>> 0;
}

function ipv4InPrefix(ip: number, network: number, prefixLen: number): boolean {
  if (prefixLen <= 0) return true;
  if (prefixLen >= 32) return ip === (network >>> 0);
  const mask = (0xffffffff << (32 - prefixLen)) >>> 0;
  return ((ip & mask) >>> 0) === ((network & mask) >>> 0);
}

/**
 * True only if IPv4 is provably globally routable unicast.
 * DEFAULT-DENY: unparseable or any IANA special-purpose / non-unicast → false.
 */
function isGlobalIpv4(ip: string): boolean {
  const n = parseIpv4Uint(ip);
  if (n === null) return false; // unparseable → blocked
  for (const [network, prefixLen] of IPV4_SPECIAL_PURPOSE) {
    if (ipv4InPrefix(n, network, prefixLen)) return false;
  }
  // Survived full special-purpose subtraction → global unicast.
  return true;
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

function ipv6MatchesPrefix(bytes: number[], prefix: number[], prefixBits: number): boolean {
  const fullBytes = Math.floor(prefixBits / 8);
  const remBits = prefixBits % 8;
  for (let i = 0; i < fullBytes; i++) {
    if ((bytes[i] ?? 0) !== (prefix[i] ?? 0)) return false;
  }
  if (remBits > 0) {
    const mask = (0xff << (8 - remBits)) & 0xff;
    if (((bytes[fullBytes] ?? 0) & mask) !== ((prefix[fullBytes] ?? 0) & mask)) return false;
  }
  return true;
}

/** Pad a short prefix array to 16 bytes for matching helpers. */
function v6Prefix(hexGroups: string, prefixBits: number): { bytes: number[]; bits: number } {
  // hexGroups like "2001:db8" — expand via ipv6ToBytes by padding with ::
  const literal = hexGroups.includes('::') ? hexGroups : `${hexGroups}::`;
  const bytes = ipv6ToBytes(literal);
  if (!bytes) throw new Error(`internal: bad v6 prefix ${hexGroups}`);
  return { bytes, bits: prefixBits };
}

/**
 * IANA IPv6 Special-Purpose prefixes subtracted from 2000::/3 (and other non-global).
 * IPv4-mapped / IPv4-compatible are classified via the embedded IPv4 path first.
 */
const IPV6_SPECIAL_PURPOSE: ReadonlyArray<{ bytes: number[]; bits: number }> = [
  v6Prefix('::', 128),              // ::/128 Unspecified
  v6Prefix('::1', 128),             // ::1/128 Loopback
  v6Prefix('64:ff9b', 96),          // 64:ff9b::/96 Well-Known NAT64 Prefix
  v6Prefix('64:ff9b:1', 48),        // 64:ff9b:1::/48 Local-Use IPv4/IPv6 Translation
  v6Prefix('100', 64),              // 100::/64 Discard-Only Address Block
  v6Prefix('2001', 23),             // 2001::/23 IETF Protocol Assignments
  v6Prefix('2001:db8', 32),         // 2001:db8::/32 Documentation
  v6Prefix('2002', 16),             // 2002::/16 6to4
  v6Prefix('3fff', 20),             // 3fff::/20 Documentation (RFC 9637)
  v6Prefix('5f00', 16),             // 5f00::/16 Segment Routing (IPv6 SIDs)
  v6Prefix('2620:4f:8000', 48),     // 2620:4f:8000::/48 Direct Delegation AS112 Service
  v6Prefix('fc00', 7),              // fc00::/7 Unique-Local
  v6Prefix('fe80', 10),             // fe80::/10 Link-Local Unicast
  v6Prefix('ff00', 8),              // ff00::/8 Multicast
];

/** Only addresses inside 2000::/3 can be global unicast (IPv6). */
const IPV6_GLOBAL_UNICAST_CONTAINER = v6Prefix('2000', 3);

function embeddedIpv4FromBytes(bytes: number[], offset: number): string {
  return `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;
}

/**
 * True only if an IPv6 literal is provably globally routable unicast.
 * DEFAULT-DENY: unparseable → false; outside 2000::/3 → false; special-purpose → false.
 * IPv4-mapped (`::ffff:x.x.x.x`) and IPv4-compatible (`::x.x.x.x`) use IPv4 global rules.
 */
function isGlobalIpv6(ip: string): boolean {
  const bytes = ipv6ToBytes(ip);
  if (!bytes) return false; // unparseable → blocked

  // ::ffff:0:0/96 IPv4-mapped → embedded IPv4 classification (default-deny inherits).
  const first10Zero = bytes.slice(0, 10).every((b) => b === 0);
  if (first10Zero && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isGlobalIpv4(embeddedIpv4FromBytes(bytes, 12));
  }
  // ::/96 IPv4-compatible (deprecated) → embedded IPv4.
  if (bytes.slice(0, 12).every((b) => b === 0)) {
    return isGlobalIpv4(embeddedIpv4FromBytes(bytes, 12));
  }

  // Positive membership in global-unicast container first (default-deny outside).
  if (!ipv6MatchesPrefix(bytes, IPV6_GLOBAL_UNICAST_CONTAINER.bytes, IPV6_GLOBAL_UNICAST_CONTAINER.bits)) {
    return false;
  }

  // Subtract full IANA IPv6 special-purpose registry.
  for (const { bytes: prefix, bits } of IPV6_SPECIAL_PURPOSE) {
    if (ipv6MatchesPrefix(bytes, prefix, bits)) return false;
  }

  return true;
}

/**
 * True if an IP literal is **not** a provably global unicast destination.
 * DEFAULT-DENY: only positively classified global unicast is allowed; unparseable → blocked.
 */
export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return !isGlobalIpv4(ip);
  if (net.isIPv6(ip)) return !isGlobalIpv6(ip);
  return true; // not a recognizable IP → blocked
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
 *
 * 注意：`safeServiceFetch` 在**首跳**用本函数，随后将 redirect 链锁定到首跳策略
 * （公网链不得进 loopback，loopback 链不得出站）。
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

/** Redirect / service hop policy locked from the first authorized hop. */
export type ServiceHopPolicy = 'public' | 'loopback';

/**
 * Classify a resolved service URL: all-loopback addresses → loopback, else public.
 * Used to pin redirect chains so a public OCR host cannot 307 into 127.0.0.1.
 */
export function serviceHopPolicyOf(resolved: PublicUrlResolution): ServiceHopPolicy {
  if (resolved.addresses.length > 0 && resolved.addresses.every((a) => isLoopbackIp(a))) {
    return 'loopback';
  }
  const host = resolved.url.hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (isLoopbackHost(host)) return 'loopback';
  return 'public';
}

/**
 * Loopback-only URL resolver（redirect 链锁定为 loopback 时使用）。
 * 拒绝任何非回环主机，防止本机 efapiao 被指到站外。
 */
export async function resolveLoopbackServiceUrl(urlStr: string): Promise<PublicUrlResolution> {
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
    if (!isLoopbackIp(host)) {
      throw new Error(`blocked_url:redirect_policy:loopback_only:${host}`);
    }
    return { url, addresses: [host] };
  }
  if (!isLoopbackHost(host)) {
    throw new Error(`blocked_url:redirect_policy:loopback_only:${host}`);
  }
  let addrs: { address: string; family: number }[];
  try {
    addrs = await dnsLookup(host, { all: true });
  } catch {
    throw new Error(`blocked_url:dns:${host}`);
  }
  if (addrs.length === 0) throw new Error(`blocked_url:dns_empty:${host}`);
  const loopbackAddrs: string[] = [];
  for (const a of addrs) {
    if (!isLoopbackIp(a.address)) {
      throw new Error(`blocked_url:localhost_non_loopback:${host}->${a.address}`);
    }
    loopbackAddrs.push(a.address);
  }
  return { url, addresses: loopbackAddrs };
}

/**
 * Resolver for subsequent hops under a pinned first-hop policy.
 * Public-first chains use the global-only public resolver (never loopback/private).
 */
function resolveUrlForPinnedPolicy(
  policy: ServiceHopPolicy,
): (urlStr: string) => Promise<PublicUrlResolution> {
  return policy === 'loopback' ? resolveLoopbackServiceUrl : resolvePublicUrl;
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

interface ControlledFetchOptions {
  /**
   * 首跳成功后把 redirect 策略锁到首跳类别（public 或 loopback）。
   * OCR `safeServiceFetch` 必须开启：公网 OCR 不得 307 把发票 body 打到 127.0.0.1。
   */
  pinRedirectPolicy?: boolean;
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
