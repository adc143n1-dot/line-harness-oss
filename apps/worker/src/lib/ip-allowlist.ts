/**
 * IP allowlist matching (IPv4 / IPv6, single address or CIDR range).
 *
 * Used to restrict access to the admin control plane (login + authenticated
 * admin API) to a configured set of source IPs — e.g. a company's fixed-IP
 * office/VPN egress. This is a control that protects THIS system's admin
 * surface; it does not touch any third-party service.
 *
 * `CF-Connecting-IP` (the real client IP as seen by Cloudflare) is the value
 * matched against the allowlist.
 */

type ParsedIp = { family: 4; value: number } | { family: 6; value: bigint };

function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (octet > 255) return null;
    n = n * 256 + octet;
  }
  return n >>> 0;
}

function ipv6ToBigInt(ip: string): bigint | null {
  let str = ip;
  const zone = str.indexOf('%'); // strip zone id (fe80::1%eth0)
  if (zone >= 0) str = str.slice(0, zone);

  // Expand an embedded IPv4 tail (::ffff:192.0.2.1) into two hextets.
  const lastColon = str.lastIndexOf(':');
  if (lastColon >= 0 && str.slice(lastColon + 1).includes('.')) {
    const v4 = ipv4ToInt(str.slice(lastColon + 1));
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    str = str.slice(0, lastColon + 1) + hi + ':' + lo;
  }

  const halves = str.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;

  let groups: string[];
  if (tail === null) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - (head.length + tail.length);
    if (missing < 0) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
    if (groups.length !== 8) return null;
  }

  let result = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    result = (result << 16n) | BigInt(parseInt(g, 16));
  }
  return result;
}

/** Parse an IP string. IPv4-mapped IPv6 (::ffff:a.b.c.d) is normalized to IPv4. */
export function parseIp(ip: string): ParsedIp | null {
  const trimmed = ip.trim();
  const v4 = ipv4ToInt(trimmed);
  if (v4 !== null) return { family: 4, value: v4 };

  const v6 = ipv6ToBigInt(trimmed);
  if (v6 !== null) {
    // ::ffff:0:0/96 — treat as the embedded IPv4 so a v4 allowlist entry matches
    // a v4-mapped client address.
    if (v6 >> 32n === 0xffffn) {
      return { family: 4, value: Number(v6 & 0xffffffffn) >>> 0 };
    }
    return { family: 6, value: v6 };
  }
  return null;
}

type ParsedEntry = { family: 4 | 6; value: number | bigint; prefix: number };

function parseEntry(entry: string): ParsedEntry | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;

  const slash = trimmed.indexOf('/');
  if (slash === -1) {
    const ip = parseIp(trimmed);
    if (!ip) return null;
    return { family: ip.family, value: ip.value, prefix: ip.family === 4 ? 32 : 128 };
  }

  const addr = trimmed.slice(0, slash);
  const prefixStr = trimmed.slice(slash + 1);
  if (!/^\d+$/.test(prefixStr)) return null;
  const prefix = Number(prefixStr);

  const ip = parseIp(addr);
  if (!ip) return null;
  const max = ip.family === 4 ? 32 : 128;
  if (prefix > max) return null;
  return { family: ip.family, value: ip.value, prefix };
}

/** True when `entry` is a syntactically valid IP address or CIDR range. */
export function isValidIpOrCidr(entry: string): boolean {
  return parseEntry(entry) !== null;
}

/** True when `ip` falls within the single address or CIDR range `entry`. */
export function ipMatches(ip: string, entry: string): boolean {
  const target = parseIp(ip);
  const e = parseEntry(entry);
  if (!target || !e) return false;
  if (target.family !== e.family) return false;

  if (target.family === 4 && e.family === 4) {
    const mask = e.prefix === 0 ? 0 : (0xffffffff << (32 - e.prefix)) >>> 0;
    return ((target.value as number) & mask) === ((e.value as number) & mask);
  }

  // IPv6
  const bits = 128n - BigInt(e.prefix);
  const mask = e.prefix === 0 ? 0n : (((1n << 128n) - 1n) >> bits) << bits;
  return ((target.value as bigint) & mask) === ((e.value as bigint) & mask);
}

/** True when `ip` matches any entry in the allowlist. */
export function ipMatchesAny(ip: string, entries: string[]): boolean {
  return entries.some((e) => ipMatches(ip, e));
}

/**
 * Normalize a raw list of user-entered entries: trim, drop blanks, dedupe.
 * Returns the cleaned entries plus any that failed validation so the caller
 * can reject the save with a precise message.
 */
export function normalizeEntries(raw: string[]): { entries: string[]; invalid: string[] } {
  const seen = new Set<string>();
  const entries: string[] = [];
  const invalid: string[] = [];
  for (const item of raw) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (!isValidIpOrCidr(trimmed)) {
      invalid.push(trimmed);
      continue;
    }
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    entries.push(trimmed);
  }
  return { entries, invalid };
}
