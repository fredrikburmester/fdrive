import { isIPv4, isIPv6 } from "node:net";

/**
 * Splits the colon-separated half of an IPv6 literal into 16-bit groups.
 * A trailing dotted quad (`::ffff:203.0.113.9`) contributes two groups.
 */
function groupsOf(half: string): number[] {
  if (half === "") {
    return [];
  }
  return half.split(":").flatMap((piece) => {
    if (!piece.includes(".")) {
      return [Number.parseInt(piece, 16)];
    }
    const [a = 0, b = 0, c = 0, d = 0] = piece
      .split(".")
      .map((octet) => Number.parseInt(octet, 10));
    return [(a << 8) | b, (c << 8) | d];
  });
}

/** The eight 16-bit groups of an IPv6 literal, or `null` when `ip` is not one. */
function hextets(ip: string): number[] | null {
  if (!isIPv6(ip)) {
    return null;
  }
  const halves = ip.split("::");
  const head = groupsOf(halves[0] ?? "");
  if (halves.length === 1) {
    return head;
  }
  const tail = groupsOf(halves[1] ?? "");
  const elided = Math.max(8 - head.length - tail.length, 0);
  return [...head, ...new Array<number>(elided).fill(0), ...tail];
}

/** The embedded address of an IPv4-mapped IPv6 group vector (`::ffff:a.b.c.d`), else `null`. */
function mappedIpv4(groups: readonly number[]): string | null {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, marker = 0, high = 0, low = 0] = groups;
  if (a !== 0 || b !== 0 || c !== 0 || d !== 0 || e !== 0 || marker !== 0xffff) {
    return null;
  }
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/** Strips the brackets and zone id an address may arrive wrapped in (`[fe80::1%eth0]:443`). */
function bare(ip: string): string {
  const trimmed = ip.trim();
  const closing = trimmed.startsWith("[") ? trimmed.indexOf("]") : -1;
  const unwrapped = closing === -1 ? trimmed : trimmed.slice(1, closing);
  const zone = unwrapped.indexOf("%");
  return zone === -1 ? unwrapped : unwrapped.slice(0, zone);
}

/**
 * Reduces a client address to the unit rate limiting counts as one caller.
 *
 * IPv4 addresses are that unit already, but a single IPv6 host is routinely
 * handed a whole /64 to source from, so keying per address would give one
 * machine an unlimited supply of fresh rate-limit keys: it would get a new
 * allowance for every attempt and could fill the limiter's capacity on its
 * own. Folding an IPv6 address into its /64 makes it as bounded as an IPv4
 * address behind NAT, at the cost of pooling the (single subscriber line or
 * LAN) hosts inside that prefix. IPv4-mapped forms collapse to the IPv4
 * address they carry; anything unparseable (a hostname, or the literal
 * `"unknown"` `extractClientIp` falls back to) is returned untouched.
 */
export function addressBlock(ip: string): string {
  const address = bare(ip);
  if (isIPv4(address)) {
    return address;
  }
  const groups = hextets(address);
  if (groups === null) {
    return ip;
  }
  const mapped = mappedIpv4(groups);
  if (mapped !== null) {
    return mapped;
  }
  const prefix = groups.slice(0, 4);
  while (prefix.length > 0 && prefix[prefix.length - 1] === 0) {
    prefix.pop();
  }
  return `${prefix.map((group) => group.toString(16)).join(":")}::/64`;
}
