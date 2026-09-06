import type { Context } from "hono";

/**
 * Extracts the caller's IP for rate limiting: the first hop of
 * `x-forwarded-for` when present and non-empty, else `x-real-ip`, else the
 * literal string `"unknown"` (still a valid, if coarse, rate-limit key).
 */
export function extractClientIp(c: Context): string {
  const forwardedFor = c.req.header("x-forwarded-for");
  const firstForwardedIp = forwardedFor?.split(",")[0]?.trim();
  if (firstForwardedIp !== undefined && firstForwardedIp.length > 0) {
    return firstForwardedIp;
  }
  return c.req.header("x-real-ip") ?? "unknown";
}
