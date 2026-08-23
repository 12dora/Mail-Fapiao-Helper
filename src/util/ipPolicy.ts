import net from 'node:net';

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
export function ipv6ToBytes(ip: string): number[] | null {
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
