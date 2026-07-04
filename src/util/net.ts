import net from 'node:net';
import { lookup } from 'node:dns/promises';

/** Per-document / per-response memory cap. Mirrors the 50MB invariant in ARCHITECTURE.md (R4). */
export const MAX_DOC_BYTES = 50 * 1024 * 1024;

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

/** True if an IP literal falls in a loopback / private / link-local / reserved range. */
export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return ipv4Blocked(ip);
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;
    const mapped = low.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped && mapped[1]) return ipv4Blocked(mapped[1]);
    if (low.startsWith('fe8') || low.startsWith('fe9') || low.startsWith('fea') || low.startsWith('feb')) return true; // fe80::/10 link-local
    if (low.startsWith('fc') || low.startsWith('fd')) return true; // fc00::/7 unique-local
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
 * Read a fetch Response body into a Buffer while enforcing a hard byte cap.
 * Short-circuits on an oversized Content-Length, then streams the body and
 * aborts once the running total exceeds the cap. Throws `response_too_large:*`.
 */
export async function readCappedBuffer(response: Response, cap = MAX_DOC_BYTES): Promise<Buffer> {
  const lenHeader = response.headers.get('content-length');
  if (lenHeader) {
    const len = Number(lenHeader);
    if (Number.isFinite(len) && len > cap) {
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
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => {});
        throw new Error(`response_too_large:${total}`);
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks);
}
