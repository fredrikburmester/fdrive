import type { Context } from "hono";
import type { LoginLimiter } from "../auth/login-limiter.js";
import type { Principal } from "../auth/principal.js";
import { looksLikeApiToken } from "../tokens/token-format.js";

const BEARER_PATTERN = /^Bearer\s+(.+)$/i;

/** Extracts the raw token from an `Authorization: Bearer <token>` header value, `null` when absent or malformed. */
export function parseBearerHeader(headerValue: string | undefined): string | null {
  if (headerValue === undefined) {
    return null;
  }
  const match = BEARER_PATTERN.exec(headerValue.trim());
  return match?.[1]?.trim() ?? null;
}

/**
 * The limiter key MCP authentication shares, distinct from login's
 * `ip|username` keys and setup's `setup|ip`. The client address is the only
 * axis: the presented token is attacker-chosen and would let a single caller
 * mint an unbounded number of keys.
 */
function limiterKeyFor(ip: string): string {
  return `mcp|${ip}`;
}

export interface McpAuthDeps {
  /** Maps a bearer token to a `Principal`, `null` for an invalid or unrecognized one. */
  readonly resolveToken: (token: string) => Promise<Principal | null>;
  /**
   * Throttles failed authentication by client address. Only an attempt that
   * cost a token lookup is recorded, and a successful one clears the
   * address, so a client holding a live token is never throttled.
   */
  readonly limiter: LoginLimiter;
  /** The caller's address, normally `extractClientIp(c, config.fdriveTrustedProxyHops)`. */
  readonly clientIp: (c: Context) => string;
}

/** The outcome of authenticating an MCP request: a principal, a plain rejection, or a throttled rejection. */
export type McpAuthResult =
  | { readonly kind: "ok"; readonly principal: Principal }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "rate_limited"; readonly retryAfterMs: number };

const UNAUTHORIZED = { kind: "unauthorized" } as const;

/**
 * The credential an `/mcp` request presents: the `/mcp/t/:token` path
 * segment when there is one (for clients that cannot set headers, such as
 * claude.ai connectors), otherwise the `Authorization: Bearer` header. A
 * path token is never supplemented by the header.
 */
function presentedToken(c: Context): string | null {
  const pathToken = c.req.param("token");
  if (pathToken !== undefined) {
    return pathToken;
  }
  return parseBearerHeader(c.req.header("authorization"));
}

/**
 * Authenticates the caller of an `/mcp` or `/mcp/t/:token` request.
 *
 * Both routes are reachable without a session, so an anonymous caller must
 * not be able to spend fdrive's database connections at will. The presented
 * value is first checked against the exact minted token shape
 * (`looksLikeApiToken`), which costs nothing and never touches storage; only
 * a value that could actually be a token is looked up. Lookups that fail are
 * then counted per client address, so a caller guessing well-formed tokens
 * is blocked after a handful of attempts. Neither step affects a request
 * that carries a live token: it is resolved as before, and resolving it
 * clears the address's failure history.
 */
export async function authenticateMcpRequest(
  c: Context,
  deps: McpAuthDeps,
): Promise<McpAuthResult> {
  const presented = presentedToken(c);
  if (presented === null || !looksLikeApiToken(presented)) {
    return UNAUTHORIZED;
  }

  const key = limiterKeyFor(deps.clientIp(c));
  const status = deps.limiter.check(key);
  if (!status.allowed) {
    return { kind: "rate_limited", retryAfterMs: status.retryAfterMs ?? 0 };
  }

  const principal = await deps.resolveToken(presented);
  if (principal === null) {
    deps.limiter.recordFailure(key);
    return UNAUTHORIZED;
  }

  deps.limiter.recordSuccess(key);
  return { kind: "ok", principal };
}
