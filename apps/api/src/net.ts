import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

/**
 * The subset of `@hono/node-server`'s `ConnInfo` this module actually reads,
 * so `extractClientIp` can accept a fake in tests without importing the
 * whole Node-server-specific type.
 */
export interface ConnInfoLike {
  readonly remote: { readonly address?: string };
}

/**
 * Splits an `x-forwarded-for` header value into trimmed, non-empty entries,
 * left to right in the order the header lists them (each proxy appends its
 * own hop to the right of what it received). Returns an empty array for an
 * absent, empty, or whitespace-only header.
 */
export function parseForwardedForEntries(header: string | undefined): string[] {
  if (header === undefined) {
    return [];
  }
  return header
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Picks the client's IP out of parsed `x-forwarded-for` entries, given how
 * many hops of the proxy chain are trusted. Each trusted proxy appends the
 * peer address it saw, so the real client is `hops` entries from the right.
 * Returns `undefined` when `hops` is `0` (the header is not trusted at all)
 * or when there are fewer entries than `hops` (the header cannot be
 * trusted: a forged leading entry could otherwise be read as the client).
 */
export function clientIpFromForwardedFor(
  entries: readonly string[],
  hops: number,
): string | undefined {
  if (hops <= 0 || entries.length < hops) {
    return undefined;
  }
  return entries[entries.length - hops];
}

/**
 * Extracts the caller's IP for rate limiting and audit logging.
 *
 * Trusts `x-forwarded-for` only up to `hops` proxy hops (see
 * `clientIpFromForwardedFor`); `hops` should equal the number of reverse
 * proxies fdrive sits behind (`config.fdriveTrustedProxyHops`, normally `1`
 * for a single Caddy in front). `x-real-ip` is never trusted: with `hops =
 * 0` and no proxy in front, it would be attacker-settable like any other
 * header. Falls back to the actual socket peer address from `connInfo`
 * (defaulting to `@hono/node-server`'s `getConnInfo`, which throws outside a
 * real Node socket, e.g. in unit tests), and finally to the literal string
 * `"unknown"`.
 */
export function extractClientIp(
  c: Context,
  hops: number,
  connInfo: (c: Context) => ConnInfoLike = getConnInfo,
): string {
  const forwarded = clientIpFromForwardedFor(
    parseForwardedForEntries(c.req.header("x-forwarded-for")),
    hops,
  );
  if (forwarded !== undefined) {
    return forwarded;
  }

  try {
    const address = connInfo(c).remote.address;
    if (address !== undefined && address.length > 0) {
      return address;
    }
  } catch {
    // No usable connection info, e.g. a test harness with no real socket.
  }

  return "unknown";
}
