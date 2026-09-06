import { type ApiError, HealthResponse, statusForKind } from "@fdrive/contracts";
import { Hono } from "hono";
import { requestId as requestIdMiddleware } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Logger } from "pino";
import type { AppConfig } from "./config.js";
import { ApiHttpError, toApiError } from "./errors.js";

export type AppVariables = {
  requestId: string;
};

export type AppHono = Hono<{ Variables: AppVariables }>;

export interface AppDeps {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly version: string;
  readonly startedAt: Date;
  /**
   * Test-only hook: lets tests mount extra routes on the `/api/v1` sub-app
   * (for example, a route that throws) without adding test-only routes to
   * production code.
   */
  readonly extraRoutes?: (v1: AppHono) => void;
}

const REQUEST_ID_HEADER = "X-Request-Id";

/**
 * Builds the fdrive API Hono application: request id handling, structured
 * request logging, security headers, the `/api/v1` route group, and the
 * error/not-found handlers that translate into the `ApiError` contract
 * shape.
 */
export function createApp(deps: AppDeps): AppHono {
  const clock = deps.clock ?? (() => new Date());
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

  deps.extraRoutes?.(v1);

  app.route("/api/v1", v1);

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
