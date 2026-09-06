import { AboutResponse, type ApiError, HealthResponse, statusForKind } from "@fdrive/contracts";
import { Hono } from "hono";
import { requestId as requestIdMiddleware } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Logger } from "pino";
import {
  createCsrfGuard,
  createRequireAuth,
  type PrincipalResolver,
  type PrincipalVariables,
} from "./auth/principal.js";
import type { AppConfig } from "./config.js";
import { ApiHttpError, toApiError } from "./errors.js";

export type AppVariables = {
  requestId: string;
};

export type AppHono = Hono<{ Variables: AppVariables }>;

/** The `/api/v1` sub-app mounted behind `createRequireAuth`. */
export type AuthedHono = Hono<{ Variables: AppVariables & PrincipalVariables }>;

export interface AppDeps {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly version: string;
  readonly startedAt: Date;
  /**
   * Resolves the authenticated caller for routes mounted on the `authed`
   * group. Defaults to a resolver that always returns `null` (nothing is
   * authenticated) until a later chunk wires up real sessions.
   */
  readonly principalResolver?: PrincipalResolver;
  /**
   * Lets route-chunks (and tests) add routes to the public or authed
   * `/api/v1` sub-apps without `createApp` knowing about every feature.
   * `public` has no auth requirement; `authed` runs `createRequireAuth`
   * first.
   */
  readonly registerRoutes?: (groups: { public: AppHono; authed: AuthedHono }) => void;
}

const REQUEST_ID_HEADER = "X-Request-Id";
const SFTPGO_SOURCE_URL = "https://github.com/drakkan/sftpgo";

/**
 * Extracts the host (hostname and, when non-default for the scheme, port)
 * from a configured SFTPGo URL, for display on the public `/about` route.
 * Never returns anything beyond the host: no scheme, no path, no
 * credentials, even if `sftpgoUrl` contains them.
 */
export function sftpgoHostLabel(sftpgoUrl: string): string {
  return new URL(sftpgoUrl).host;
}

/**
 * Builds the fdrive API Hono application: request id handling, structured
 * request logging, security headers, a CSRF guard over every `/api/v1`
 * route, the public and authed `/api/v1` route groups, and the
 * error/not-found handlers that translate into the `ApiError` contract
 * shape.
 */
export function createApp(deps: AppDeps): AppHono {
  const clock = deps.clock ?? (() => new Date());
  const principalResolver: PrincipalResolver = deps.principalResolver ?? (async () => null);
  const app: AppHono = new Hono();

  app.use("*", requestIdMiddleware({ headerName: REQUEST_ID_HEADER }));
  app.use("*", secureHeaders());

  app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    deps.logger.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms,
        requestId: c.get("requestId"),
      },
      "request completed",
    );
  });

  app.use("/api/v1/*", createCsrfGuard());

  const v1: AppHono = new Hono();

  v1.get("/health", (c) => {
    const uptimeSeconds = (clock().getTime() - deps.startedAt.getTime()) / 1000;
    const body: HealthResponse = HealthResponse.parse({
      status: "ok",
      service: "fdrive-api",
      version: deps.version,
      uptimeSeconds,
    });
    return c.json(body);
  });

  v1.get("/about", (c) => {
    const body: AboutResponse = AboutResponse.parse({
      version: deps.version,
      builtOn: { name: "SFTPGo", sourceUrl: SFTPGO_SOURCE_URL },
      provider: { type: "sftpgo", label: sftpgoHostLabel(deps.config.sftpgoUrl) },
    });
    return c.json(body);
  });

  const authed: AuthedHono = new Hono();
  authed.use("*", createRequireAuth(principalResolver));

  deps.registerRoutes?.({ public: v1, authed });

  app.route("/api/v1", v1);
  app.route("/api/v1", authed);

  app.notFound((c) => {
    const body: ApiError = toApiError(
      "not_found",
      `not found: ${c.req.method} ${c.req.path}`,
      c.get("requestId"),
    );
    return c.json(body, statusForKind("not_found") as ContentfulStatusCode);
  });

  app.onError((err, c) => {
    const requestId = c.get("requestId");

    if (err instanceof ApiHttpError) {
      const body = toApiError(err.kind, err.message, requestId, err.details);
      return c.json(body, statusForKind(err.kind) as ContentfulStatusCode);
    }

    deps.logger.error({ err, requestId }, "unhandled error");
    const body = toApiError("internal", "internal server error", requestId);
    return c.json(body, statusForKind("internal") as ContentfulStatusCode);
  });

  return app;
}
