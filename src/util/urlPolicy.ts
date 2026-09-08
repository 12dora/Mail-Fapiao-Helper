import net from 'node:net';
import { lookup as dnsLookup, resolve4 as dnsResolve4, resolve6 as dnsResolve6 } from 'node:dns/promises';
import { ipv6ToBytes, isBlockedIp, isLoopbackHost, isLoopbackIp } from './ipPolicy.js';
import { isResolverPlaceholder, loadResolverProfile } from './resolverProfile.js';
import { log } from '../log.js';

export { ipv6ToBytes };

let placeholderNoticeEmitted = false;

/**
 * 把一次 DNS 结果筛成「可以连的地址」，命中 default-deny 就抛 `blocked_url:private_ip`。
 *
 * 唯一的放宽口是 fake-IP 解析器（Clash / Surge 等把所有公网域名映射到
 * `198.18.0.0/15` 之类的占位段）：这种机器上 DNS 结果不再代表真实目的地，
 * 逐条按 IP 判定会把每一张发票直链都误判成内网。详见 `resolverProfile.ts`。
 * 该放宽**只对域名解析结果生效**——URL 里写死的 IP 字面量在调用方就已判掉，
 * 走不到这里。
 */
/** 解析结果的最小形状：与 `dns.lookup({ all: true })` 对齐。 */
export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface LookupDeps {
  lookup(host: string): Promise<ResolvedAddress[]>;
  resolveDirect(host: string): Promise<ResolvedAddress[]>;
  sleep(ms: number): Promise<void>;
  /** 给单次解析加上限；超时按失败处理。 */
  withDeadline<T>(promise: Promise<T>, ms: number): Promise<T>;
}

function raceDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`dns_timeout:${ms}`)), ms);
    timer.unref();
  });
  return Promise.race([promise, deadline]).finally(() => { if (timer) clearTimeout(timer); });
}

const defaultLookupDeps: LookupDeps = {
  lookup: (host) => dnsLookup(host, { all: true }),
  async resolveDirect(host) {
    // 先 A 记录再 AAAA：一个成功就够，不为卡住的 AAAA 查询白等。
    try {
      const v4 = await raceDeadline(dnsResolve4(host), DIRECT_RESOLVE_DEADLINE_MS);
      if (v4.length > 0) return v4.map((address) => ({ address, family: 4 }));
    } catch {
      // 继续试 AAAA
    }
    const v6 = await raceDeadline(dnsResolve6(host), DIRECT_RESOLVE_DEADLINE_MS);
    return v6.map((address) => ({ address, family: 6 }));
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  withDeadline: raceDeadline,
};

/** getaddrinfo 失败后的重试间隔；总计约 1.2 秒，不会把死域名拖成分钟级等待。 */
const LOOKUP_RETRY_DELAYS_MS = [400, 800];
/** 单次 getaddrinfo / 直连解析的上限：坏域名最坏约 3×3s + 1.2s + 2×2s，不会拖到分钟级。 */
const LOOKUP_ATTEMPT_DEADLINE_MS = 3000;
const DIRECT_RESOLVE_DEADLINE_MS = 2000;

/**
 * 解析主机名，失败时先重试、再直接问配置的 DNS 服务器，最后才报 `blocked_url:dns`。
 *
 * 本机跑 Surge / Clash 这类代理时，getaddrinfo 会对同一个域名时好时坏（几秒内一次
 * ENOTFOUND、下一次正常）。以前解析失败不在 network retry 之内，一次抽风就把整封
 * 邮件按 `blocked_url:dns` 压进待确认，用户手动打开却什么问题都没有。
 */
export async function lookupAddresses(host: string, deps: LookupDeps = defaultLookupDeps): Promise<ResolvedAddress[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      const addrs = await deps.withDeadline(deps.lookup(host), LOOKUP_ATTEMPT_DEADLINE_MS);
      if (addrs.length > 0) return addrs;
    } catch {
      // 继续重试 / 回退
    }
    const delay = LOOKUP_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) break;
    await deps.sleep(delay);
  }
  try {
    const direct = await deps.withDeadline(deps.resolveDirect(host), DIRECT_RESOLVE_DEADLINE_MS * 2 + 100);
    if (direct.length > 0) return direct;
  } catch {
    // 直接解析也失败：按 DNS 失败处理
  }
  throw new Error(`blocked_url:dns:${host}`);
}

async function screenResolvedAddresses(host: string, addresses: string[]): Promise<string[]> {
  const blocked = addresses.filter((address) => isBlockedIp(address));
  if (blocked.length === 0) return [...addresses];

  const profile = await loadResolverProfile();
  const stillBlocked = blocked.filter((address) => !isResolverPlaceholder(profile, address));
  if (stillBlocked.length > 0) {
    throw new Error(`blocked_url:private_ip:${host}->${stillBlocked[0]}`);
  }

  // 整批都是解析器占位地址：本机跑着 fake-IP 代理，真实目的地由 TUN/代理还原。
  if (!placeholderNoticeEmitted) {
    placeholderNoticeEmitted = true;
    log.info(
      `DNS placeholder mode detected (${profile.detail}); `
      + 'resolved addresses are proxy placeholders, not private hosts',
    );
  }
  return [...addresses];
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
  const addrs = await lookupAddresses(host);
  if (addrs.length === 0) throw new Error(`blocked_url:dns_empty:${host}`);
  return { url, addresses: await screenResolvedAddresses(host, addrs.map((a) => a.address)) };
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
  const addrs = await lookupAddresses(host);
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

  return { url, addresses: await screenResolvedAddresses(host, addrs.map((a) => a.address)) };
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
  const addrs = await lookupAddresses(host);
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
