import { LoginRequest, ROUTES } from "@fdrive/contracts";
import { getCookie } from "hono/cookie";
import type { AppHono, AuthedHono } from "../app.js";
import type { AppConfig } from "../config.js";
import { ApiHttpError } from "../errors.js";
import { extractClientIp } from "../net.js";
import type { AuthService } from "./service.js";
import { buildCookie, COOKIE_NAME, clearCookie, cookieSecureFor } from "./sessions.js";

const API_V1_PREFIX = "/api/v1";

/** Strips the shared `/api/v1` prefix so a `ROUTES` path fits under a group already mounted there. */
export function withoutApiV1Prefix(path: string): string {
  return path.startsWith(API_V1_PREFIX) ? path.slice(API_V1_PREFIX.length) : path;
}

export interface RegisterAuthRoutesDeps {
  readonly service: AuthService;
  readonly config: AppConfig;
}

/**
 * Registers `/auth/login` (public), `/auth/logout`, and `/auth/me`
 * (authed) on the given route groups.
 */
export function registerAuthRoutes(
  groups: { public: AppHono; authed: AuthedHono },
  deps: RegisterAuthRoutesDeps,
): void {
  groups.public.post(withoutApiV1Prefix(ROUTES.auth.login), async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined);
    const parsed = LoginRequest.safeParse(body);
    if (!parsed.success) {
      throw new ApiHttpError("bad_request", "invalid login request", {
        issues: parsed.error.issues,
      });
    }

    const ip = extractClientIp(c);
    const userAgent = c.req.header("user-agent") ?? null;

    const result = await deps.service.login({
      username: parsed.data.username,
      password: parsed.data.password,
      ...(parsed.data.otp !== undefined ? { otp: parsed.data.otp } : {}),
      userAgent,
      ip,
    });

    c.header(
      "Set-Cookie",
      buildCookie({
        id: result.sessionId,
        maxAgeSeconds: deps.config.fdriveSessionTtlDays * 24 * 60 * 60,
        secure: cookieSecureFor(deps.config, c),
      }),
    );
    return c.json(result.me);
  });

  groups.authed.post(withoutApiV1Prefix(ROUTES.auth.logout), async (c) => {
    const rawSessionId = getCookie(c, COOKIE_NAME);
    if (rawSessionId !== undefined) {
      await deps.service.logout(rawSessionId);
    }
    c.header("Set-Cookie", clearCookie({ secure: cookieSecureFor(deps.config, c) }));
    return c.json({ ok: true });
  });

  groups.authed.get(withoutApiV1Prefix(ROUTES.auth.me), async (c) => {
    const principal = c.get("principal");
    const response = await deps.service.me(principal.accountId, principal.identityId);
    return c.json(response);
  });
}
