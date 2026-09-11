import { createHash, randomBytes } from "node:crypto";
import type { AppConfig, CookieSecureMode } from "../config.js";
import { parseForwardedEntries, trustedForwardedProtoEntry } from "../net.js";

/** The cookie name the browser carries the raw (unhashed) session id in. */
export const COOKIE_NAME = "fdrive_session";

/** Generates a fresh session id: 32 random bytes, base64url-encoded. */
export function generateSessionId(): string {
  return randomBytes(32).toString("base64url");
}

/** Hashes a session id to the form stored in the database (sha256 hex). */
export function hashSessionId(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

/**
 * Builds the `Set-Cookie` header value for a fresh session: HttpOnly,
 * SameSite=Lax, Path=/, and `Secure` only when `secure` is true.
 */
export function buildCookie(input: { id: string; maxAgeSeconds: number; secure: boolean }): string {
  const parts = [
    `${COOKIE_NAME}=${input.id}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${input.maxAgeSeconds}`,
  ];
  if (input.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

/**
 * Builds the `Set-Cookie` header value that deletes the session cookie
 * (empty value, immediately expired).
 */
export function clearCookie(input: { secure: boolean }): string {
  const parts = [`${COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (input.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

/** The minimal request shape `cookieSecureFor` needs, satisfied by a Hono `Context`. */
export interface CookieSecureRequest {
  readonly req: {
    header(name: string): string | undefined;
    readonly url: string;
  };
}

/**
 * Decides whether the session cookie should carry the `Secure` attribute
 * for a given request, per `config.fdriveCookieSecure`:
 *
 * - `"true"` always secure.
 * - `"false"` never secure.
 * - `"auto"` secure when the request arrived over https, judged either
 *   from `x-forwarded-proto` (only the entry a trusted proxy wrote, see
 *   `cookieSecureForMode`) or from the request URL's own protocol.
 */
export function cookieSecureFor(
  config: Pick<AppConfig, "fdriveCookieSecure" | "fdriveTrustedProxyHops">,
  c: CookieSecureRequest,
): boolean {
  return cookieSecureForMode(config.fdriveCookieSecure, {
    forwardedProto: c.req.header("x-forwarded-proto"),
    trustedProxyHops: config.fdriveTrustedProxyHops,
    url: c.req.url,
  });
}

/**
 * Pure decision function behind `cookieSecureFor`, taking the already-read
 * request signals so it is trivially testable without a Hono context.
 *
 * In `"auto"` mode `x-forwarded-proto` gets the same trust discipline as
 * `x-forwarded-for` in `extractClientIp`: only the entry the outermost
 * trusted proxy wrote counts (`trustedProxyHops` from the right), so a
 * client that prepends `http` to the chain cannot talk an https deployment
 * out of `Secure`. A chain shorter than the trusted hop count is not
 * suspicious here, though — proxies replace this header instead of
 * appending to it — so the selection clamps to the outermost entry present
 * rather than failing closed; see `trustedForwardedProtoEntry`. Only with
 * no trusted hops at all, or no entries, is the header ignored entirely and
 * the request URL's own scheme decides, exactly as when it is absent.
 */
export function cookieSecureForMode(
  mode: CookieSecureMode,
  signals: { forwardedProto: string | undefined; trustedProxyHops: number; url: string },
): boolean {
  if (mode === "true") {
    return true;
  }
  if (mode === "false") {
    return false;
  }
  const forwardedProto = trustedForwardedProtoEntry(
    parseForwardedEntries(signals.forwardedProto),
    signals.trustedProxyHops,
  );
  if (forwardedProto !== undefined) {
    return forwardedProto === "https";
  }
  try {
    return new URL(signals.url).protocol === "https:";
  } catch {
    return false;
  }
}
