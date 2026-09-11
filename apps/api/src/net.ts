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
 * Splits a comma-separated forwarding header (`x-forwarded-for`,
 * `x-forwarded-proto`) into trimmed, non-empty entries, left to right in the
 * order the header lists them (a proxy that appends writes to the right of
 * what it received). Returns an empty array for an absent, empty, or
 * whitespace-only header. Which entry is the trusted one depends on how the
 * chain grows, which is why the two selectors below differ:
 * `trustedForwardedEntry` for headers every proxy appends to, and
 * `trustedForwardedProtoEntry` for headers proxies replace.
 */
export function parseForwardedEntries(header: string | undefined): string[] {
  if (header === undefined) {
    return [];
  }
  return header
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Picks the entry the outermost trusted proxy wrote out of a parsed
 * forwarding header that every proxy *appends* to, i.e. `x-forwarded-for`,
 * given how many hops of the proxy chain are trusted. Each trusted proxy
 * appends the peer address it saw, so that entry is `hops` from the right
 * and anything further left came from the client. Returns `undefined` when
 * `hops` is `0` (the header is not trusted at all) or when there are fewer
 * entries than `hops` (an appended chain shorter than the trusted chain
 * means the header cannot be attributed to a trusted proxy at all: a forged
 * leading entry could otherwise be read as the trusted one), leaving the
 * caller to fall back to something it observed itself.
 *
 * Headers proxies replace instead of append need the different short-chain
 * rule in `trustedForwardedProtoEntry`; keep the two apart.
 */
export function trustedForwardedEntry(
  entries: readonly string[],
  hops: number,
): string | undefined {
  if (hops <= 0 || entries.length < hops) {
    return undefined;
  }
  return entries[entries.length - hops];
}

/**
 * Picks the trusted entry out of a parsed `x-forwarded-proto`, which needs a
 * different short-chain rule than `x-forwarded-for`: proxies conventionally
 * *replace* this header rather than append to it (nginx's `proxy_set_header
 * X-Forwarded-Proto $scheme`, and the other edges in `deploy/REFERENCE.md`),
 * so it carries a single entry however many hops are configured. Failing
 * closed on `entries.length < hops` the way `trustedForwardedEntry` does
 * would ignore a perfectly good `https` behind TLS and drop the session
 * cookie's `Secure` attribute on every deployment with
 * `FDRIVE_TRUSTED_PROXY_HOPS >= 2`.
 *
 * Clamping to the outermost entry present is safe against the forgery this
 * trust discipline exists to stop, because a client can only *add* entries
 * to the header, never remove them: `entries.length < hops` is therefore
 * never attacker-induced, only a hop count configured longer than the chain
 * that actually reaches fdrive. Reading `entries[max(0, length - hops)]`
 * still skips everything a client could have prepended whenever the chain is
 * as long as configured or longer, and degrades to the leftmost entry
 * otherwise.
 *
 * `hops` of `0` still returns `undefined`: no trusted proxy means the header
 * is not trusted at all, which is not the same as a short chain.
 */
export function trustedForwardedProtoEntry(
  entries: readonly string[],
  hops: number,
): string | undefined {
  if (hops <= 0 || entries.length === 0) {
    return undefined;
  }
  return entries[Math.max(0, entries.length - hops)];
}

/**
 * Extracts the caller's IP for rate limiting and audit logging.
 *
 * Trusts `x-forwarded-for` only up to `hops` proxy hops (see
 * `trustedForwardedEntry`); `hops` should equal the number of reverse
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
  const forwarded = trustedForwardedEntry(
    parseForwardedEntries(c.req.header("x-forwarded-for")),
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
