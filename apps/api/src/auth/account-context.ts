import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { AppVariables } from "../app.js";
import { ApiHttpError } from "../errors.js";
import type { Principal, PrincipalVariables } from "./principal.js";
import { COOKIE_NAME } from "./sessions.js";

/** A request a person makes in the browser: their session, never an API token. */
export interface AccountRequestContext {
  readonly principal: Principal;
  readonly sessionId: string;
}

/**
 * Admits only the browser session, for routes an API token must never reach
 * (history, shares, Mac pairing approval), and marks the response uncacheable.
 */
export function accountContext(
  c: Context<{ Variables: PrincipalVariables & AppVariables }>,
): AccountRequestContext {
  if (c.req.header("authorization") !== undefined)
    throw new ApiHttpError("forbidden", "account session required");
  const sessionId = getCookie(c, COOKIE_NAME);
  if (sessionId === undefined) throw new ApiHttpError("unauthorized", "account session required");
  c.header("Cache-Control", "no-store");
  return { sessionId, principal: c.get("principal") };
}
