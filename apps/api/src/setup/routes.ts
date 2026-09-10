import {
  ConnectionTestResponse,
  ROUTES,
  SETUP_TOKEN_HEADER,
  SetupCompleteRequest,
  SetupStatusResponse,
  SetupTestRequest,
} from "@fdrive/contracts";
import type { Context } from "hono";
import type { AppHono, AuthedHono } from "../app.js";
import type { LoginLimiter } from "../auth/login-limiter.js";
import { withoutApiV1Prefix } from "../auth/routes.js";
import { buildCookie, cookieSecureFor } from "../auth/sessions.js";
import type { AppConfig } from "../config.js";
import { ApiHttpError } from "../errors.js";
import { extractClientIp } from "../net.js";
import type { SetupService } from "./service.js";
import type { SetupTokenGuard } from "./token.js";

export interface RegisterSetupRoutesDeps {
  readonly service: SetupService;
  readonly tokenGuard: SetupTokenGuard;
  readonly limiter: LoginLimiter;
  readonly config: AppConfig;
}

/** The limiter key setup endpoints share, distinct from login's own `ip|username` keys. */
function limiterKeyFor(ip: string): string {
  return `setup|${ip}`;
}

async function assertSetupAllowed(c: Context, deps: RegisterSetupRoutesDeps): Promise<string> {
  const status = await deps.service.status();
  if (!status.required) {
    throw new ApiHttpError("not_found", "setup has already been completed");
  }
  const ip = extractClientIp(c, deps.config.fdriveTrustedProxyHops);
  const limiterStatus = deps.limiter.check(limiterKeyFor(ip));
  if (!limiterStatus.allowed) {
    throw new ApiHttpError("rate_limited", "too many setup attempts", {
      retryAfterMs: limiterStatus.retryAfterMs ?? 0,
    });
  }
  if (!deps.tokenGuard.verify(c.req.header(SETUP_TOKEN_HEADER))) {
    deps.limiter.recordFailure(limiterKeyFor(ip));
    throw new ApiHttpError("unauthorized", "invalid or missing setup token");
  }
  return ip;
}

/**
 * Registers the public `/setup/status`, `/setup/test`, and `/setup/complete`
 * routes. `test` and `complete` require the `x-setup-token` header to match
 * the active `SetupTokenGuard`, are rate limited by ip, and 404 once setup
 * is no longer required.
 */
export function registerSetupRoutes(
  groups: { public: AppHono; authed: AuthedHono },
  deps: RegisterSetupRoutesDeps,
): void {
  groups.public.get(withoutApiV1Prefix(ROUTES.setup.status), async (c) => {
    const status = await deps.service.status();
    return c.json(SetupStatusResponse.parse(status));
  });

  groups.public.post(withoutApiV1Prefix(ROUTES.setup.test), async (c) => {
    const ip = await assertSetupAllowed(c, deps);
    const parsed = SetupTestRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      throw new ApiHttpError("bad_request", "invalid setup test request", {
        issues: parsed.error.issues,
      });
    }

    const result = await deps.service.test(parsed.data.baseUrl);
    deps.limiter.recordSuccess(limiterKeyFor(ip));
    return c.json(ConnectionTestResponse.parse(result));
  });

  groups.public.post(withoutApiV1Prefix(ROUTES.setup.complete), async (c) => {
    const ip = await assertSetupAllowed(c, deps);
    const parsed = SetupCompleteRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      throw new ApiHttpError("bad_request", "invalid setup complete request", {
        issues: parsed.error.issues,
      });
    }

    const userAgent = c.req.header("user-agent") ?? null;

    let result: Awaited<ReturnType<SetupService["complete"]>>;
    try {
      result = await deps.service.complete({
        baseUrl: parsed.data.baseUrl,
        homeTemplate: parsed.data.homeTemplate,
        username: parsed.data.username,
        password: parsed.data.password,
        ...(parsed.data.otp !== undefined ? { otp: parsed.data.otp } : {}),
        userAgent,
        ip,
      });
    } catch (err) {
      deps.limiter.recordFailure(limiterKeyFor(ip));
      throw err;
    }

    deps.tokenGuard.invalidate();
    deps.limiter.recordSuccess(limiterKeyFor(ip));

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
}
