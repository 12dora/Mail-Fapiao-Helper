import { lookup as dnsLookup } from 'node:dns/promises';
import { ipv4InPrefix, parseIpv4Uint } from './ipPolicy.js';

/**
 * Fake-IP 解析器画像（NET-01）。
 *
 * Clash / Surge / Quantumult X / sing-box 等本机代理默认开启 **fake-IP** 模式：
 * DNS 把*任意*公网域名映射到一段保留地址（默认 `198.18.0.0/15`，RFC 2544
 * benchmarking），真正的连接由 TUN / 代理按映射还原。在这种机器上
 * `resolvePublicUrl()` 的 default-deny 会把**每一个**发票直链都判成
 * `blocked_url:private_ip:host->198.18.x.x`，于是整个抓取队列退化成待确认——
 * 网络其实完全可用，只是 DNS 结果不再代表真实目的地。
 *
 * 这里**不放宽** IP 策略本身。做法是先*证明*解析器在做映射：拿几个必然是公网的
 * 域名去解析，只有当它们落进同一段「占位段」时，才把该段登记为解析器占位段。
 *
 * 仍然成立的边界（SSRF 主防线不变）：
 *   - 只对**域名解析结果**生效；URL 里写死的 IP 字面量一律照旧拒绝；
 *   - 只有下面这张白名单里的保留段有资格被登记，RFC1918 / loopback /
 *     link-local / CGNAT / 组播永远拒绝——SSRF 想打的正是那些段；
 *   - 探测失败（离线、DNS 不通）→ 不登记任何段，行为与今天完全一致。
 *
 * 关掉自动检测：设环境变量 `MFH_RESERVED_IP_POLICY=strict`。
 */

/** `[network, prefixLen]`，与 ipPolicy 内部表同构。 */
type Prefix = readonly [network: number, prefixLen: number];

/**
 * 有资格被登记为「解析器占位段」的保留前缀。
 * 只收本机上不会跑真实服务、且确实被 fake-IP 实现用过的段：
 *   198.18.0.0/15  RFC 2544 Benchmarking —— Clash / Surge / Quantumult X 默认
 *   240.0.0.0/4    Class E 保留 —— 部分 Clash.Meta / sing-box 配置
 *   192.0.2.0/24 · 198.51.100.0/24 · 203.0.113.0/24  TEST-NET-1/2/3
 *
 * 刻意**不收** `100.64.0.0/10`：那是真实的 CGNAT，且 Tailscale 的对端就住在
 * 里面，放开等于把内网主机暴露给邮件里的任意链接。
 */
const ELIGIBLE_PLACEHOLDER_PREFIXES: ReadonlyArray<Prefix> = [
  [0xc6120000, 15], // 198.18.0.0/15 Benchmarking
  [0xf0000000, 4],  // 240.0.0.0/4 Reserved (Class E)
  [0xc0000200, 24], // 192.0.2.0/24 TEST-NET-1
  [0xc6336400, 24], // 198.51.100.0/24 TEST-NET-2
  [0xcb007100, 24], // 203.0.113.0/24 TEST-NET-3
];

/**
 * 探针域名：必须是长期存在、且在正常解析器上一定返回公网地址的名字。
 * 用三个不同运营方的名字，避免单个域名被 DNS 劫持导致误判。
 */
const CANARY_HOSTS = ['example.com', 'www.iana.org', 'one.one.one.one'] as const;

/** 至少这么多个探针落进同一段，才认定解析器在做映射（防单点劫持误判）。 */
const MIN_CANARY_AGREEMENT = 2;

/** 探测超时：慢 DNS 不该把一次 run 拖住。 */
const CANARY_TIMEOUT_MS = 4_000;

/** 画像缓存有效期。CLI 每次 run 都是新进程，这里主要防长驻进程内的陈旧结果。 */
const PROFILE_TTL_MS = 10 * 60 * 1000;

export interface ResolverProfile {
  /** 已确认由解析器映射的占位前缀。空数组 = 未检测到 fake-IP。 */
  mapped: ReadonlyArray<Prefix>;
  /** 是否检测到 fake-IP 解析器。 */
  detected: boolean;
  /** 一行诊断说明，用于日志。 */
  detail: string;
}

const STRICT_PROFILE: ResolverProfile = { mapped: [], detected: false, detail: 'strict' };

function prefixLabel([network, prefixLen]: Prefix): string {
  const a = (network >>> 24) & 0xff;
  const b = (network >>> 16) & 0xff;
  const c = (network >>> 8) & 0xff;
  const d = network & 0xff;
  return `${a}.${b}.${c}.${d}/${prefixLen}`;
}

function placeholderPrefixFor(ip: string): Prefix | undefined {
  const n = parseIpv4Uint(ip);
  if (n === null) return undefined;
  return ELIGIBLE_PLACEHOLDER_PREFIXES.find(([network, len]) => ipv4InPrefix(n, network, len));
}

/**
 * 这个地址所在的段**有没有资格**被登记为占位段？（登记还需要探针实证。）
 * 回归测试用它钉住白名单边界：RFC1918 / loopback / link-local / CGNAT / 组播
 * 一旦变成 eligible，SSRF 防线就被拆开了。
 */
export function eligiblePlaceholderPrefixFor(ip: string): string | undefined {
  const prefix = placeholderPrefixFor(ip);
  return prefix ? prefixLabel(prefix) : undefined;
}

/** 自动检测是否被显式关闭。 */
function strictModeRequested(): boolean {
  return (process.env.MFH_RESERVED_IP_POLICY ?? '').trim().toLowerCase() === 'strict';
}

async function lookupCanary(host: string): Promise<string[]> {
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error('canary_timeout')), CANARY_TIMEOUT_MS);
    timer.unref?.();
  });
  const addrs = await Promise.race([dnsLookup(host, { all: true }), timeout]);
  return addrs.map((a) => a.address);
}

async function detectResolverProfile(): Promise<ResolverProfile> {
  if (strictModeRequested()) return STRICT_PROFILE;

  const results = await Promise.all(CANARY_HOSTS.map(async (host) => {
    try {
      return await lookupCanary(host);
    } catch {
      return [] as string[];
    }
  }));

  // 每个探针只投一票：一个探针返回多条同段地址不能把票数灌满。
  const votes = new Map<string, { prefix: Prefix; count: number }>();
  for (const addresses of results) {
    const seen = new Set<string>();
    for (const address of addresses) {
      const prefix = placeholderPrefixFor(address);
      if (!prefix) continue;
      const key = prefixLabel(prefix);
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = votes.get(key);
      if (entry) entry.count++;
      else votes.set(key, { prefix, count: 1 });
    }
  }

  const mapped = [...votes.values()]
    .filter((entry) => entry.count >= MIN_CANARY_AGREEMENT)
    .map((entry) => entry.prefix);

  if (mapped.length === 0) {
    const reachable = results.some((addresses) => addresses.length > 0);
    return {
      mapped: [],
      detected: false,
      detail: reachable ? 'resolver returns public addresses' : 'canary lookups failed',
    };
  }

  return {
    mapped,
    detected: true,
    detail: `resolver maps public hostnames into ${mapped.map(prefixLabel).join(', ')}`,
  };
}

let cached: { at: number; profile: Promise<ResolverProfile> } | undefined;

/**
 * 取解析器画像（进程内带 TTL 缓存）。
 * 探测本身不会抛错：任何失败都退化成 strict（等于当前行为）。
 */
export function loadResolverProfile(): Promise<ResolverProfile> {
  const now = Date.now();
  if (cached && now - cached.at < PROFILE_TTL_MS) return cached.profile;
  const profile = detectResolverProfile().catch(() => STRICT_PROFILE);
  cached = { at: now, profile };
  return profile;
}

/**
 * 这个地址是否是解析器给出的占位地址？
 * 只应在 `isBlockedIp()` 已经拒绝、且该地址来自**域名解析**时调用。
 */
export function isResolverPlaceholder(profile: ResolverProfile, ip: string): boolean {
  if (!profile.detected) return false;
  const n = parseIpv4Uint(ip);
  if (n === null) return false;
  return profile.mapped.some(([network, len]) => ipv4InPrefix(n, network, len));
}
