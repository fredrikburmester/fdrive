import type { Context } from "hono";
import type { Principal } from "../auth/principal.js";

const BEARER_PATTERN = /^Bearer\s+(.+)$/i;

/** Extracts the raw token from an `Authorization: Bearer <token>` header value, `null` when absent or malformed. */
export function parseBearerHeader(headerValue: string | undefined): string | null {
  if (headerValue === undefined) {
    return null;
  }
  const match = BEARER_PATTERN.exec(headerValue.trim());
  return match?.[1]?.trim() ?? null;
}

export interface McpAuthDeps {
  /** Maps a bearer token to a `Principal`, `null` for an invalid or unrecognized one. */
  readonly resolveToken: (token: string) => Promise<Principal | null>;
}

/**
 * Resolves the caller of an `/mcp` or `/mcp/t/:token` request: the path
 * segment token takes priority (for clients that cannot set headers, such
 * as claude.ai connectors), falling back to the `Authorization: Bearer`
 * header. `null` when neither is present or the token does not resolve.
 */
export async function resolveMcpPrincipal(
  c: Context,
  deps: McpAuthDeps,
): Promise<Principal | null> {
  const pathToken = c.req.param("token");
  if (pathToken !== undefined) {
    return deps.resolveToken(pathToken);
  }

  const token = parseBearerHeader(c.req.header("authorization"));
  if (token === null) {
    return null;
  }
  return deps.resolveToken(token);
}
