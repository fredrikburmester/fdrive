import { createHash, randomBytes } from "node:crypto";
import type { AppConfig, CookieSecureMode } from "../config.js";

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
 *   from `x-forwarded-proto` (set by a reverse proxy) or from the request
 *   URL's own protocol.
 */
export function cookieSecureFor(
  config: Pick<AppConfig, "fdriveCookieSecure">,
  c: CookieSecureRequest,
): boolean {
  return cookieSecureForMode(config.fdriveCookieSecure, {
    forwardedProto: c.req.header("x-forwarded-proto"),
    url: c.req.url,
  });
}

/**
 * Pure decision function behind `cookieSecureFor`, taking the already-read
 * request signals so it is trivially testable without a Hono context.
 */
export function cookieSecureForMode(
  mode: CookieSecureMode,
  signals: { forwardedProto: string | undefined; url: string },
): boolean {
  if (mode === "true") {
    return true;
  }
  if (mode === "false") {
    return false;
  }
  if (signals.forwardedProto !== undefined) {
    return signals.forwardedProto.split(",")[0]?.trim() === "https";
  }
  try {
    return new URL(signals.url).protocol === "https:";
  } catch {
    return false;
  }
}
