import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { ipv6ToBytes, isBlockedIp, isLoopbackHost, isLoopbackIp } from './ipPolicy.js';

export { ipv6ToBytes };

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
export function resolveUrlForPinnedPolicy(
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

export function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export function resolveRedirectUrl(current: URL, location: string): string {
  try {
    return new URL(location, current).href;
  } catch {
    throw new Error(`blocked_url:invalid_redirect:${location}`);
  }
}
