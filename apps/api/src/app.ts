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
import { applyReachability, type Subsystem, subsystemsStatus } from "./config-keys.js";
import { ApiHttpError, toApiError } from "./errors.js";

export type AppVariables = {
  requestId: string;
};

export type AppHono = Hono<{ Variables: AppVariables }>;

/** The `/api/v1` sub-app mounted behind `createRequireAuth`. */
export type AuthedHono = Hono<{ Variables: AppVariables & PrincipalVariables }>;

/**
 * Whether fdrive setup is still required, and the SFTPGo host to show on
 * the public `/about` route when it is not. `host` is null exactly when
 * `required` is true.
 */
export interface ConnectionStatus {
  readonly required: boolean;
  readonly host: string | null;
}

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
   * Reports whether fdrive setup is required and the SFTPGo host to show on
   * `/about`. Defaults to deriving this from `config.sftpgoUrl` alone
   * (required when unset), which is enough for tests that do not exercise
   * the `settings`-backed connection; `composeApp` wires the real
   * `ConnectionStore`-backed version.
   */
  readonly connectionStatus?: () => Promise<ConnectionStatus>;
  /**
   * Lets route-chunks (and tests) add routes to the public or authed
   * `/api/v1` sub-apps without `createApp` knowing about every feature.
   * `public` has no auth requirement; `authed` runs `createRequireAuth`
   * first.
   */
  readonly registerRoutes?: (groups: { public: AppHono; authed: AuthedHono }) => void;
  /**
   * Probes reachability for whichever subsystems have a liveness check
   * (indexer, embed/search, OCR, office), called on every `GET
   * /api/v1/health` request. Returns `true`/`false` per subsystem it
   * probed; a subsystem it omits keeps its config-only status. Defaults to
   * probing nothing (every configured subsystem reports "configured" with
   * no liveness check), which is enough for tests that do not exercise
   * reachability; `composeApp` wires the real sidecar-backed version.
   */
  readonly subsystemReachability?: (
    config: AppConfig,
  ) => Promise<Partial<Record<Subsystem, boolean>>>;
}

const REQUEST_ID_HEADER = "X-Request-Id";
const SFTPGO_SOURCE_URL = "https://github.com/drakkan/sftpgo";

/** Path prefixes reachable even while `ConnectionStatus.required` is true. */
const SETUP_EXEMPT_PREFIXES = [
  "/api/v1/health",
  "/api/v1/about",
  "/api/v1/setup/",
  "/api/v1/internal/features",
  "/api/v1/internal/office",
];

/** True when `path` is one of the routes that must work while setup is required. */
export function isSetupExempt(path: string): boolean {
  return SETUP_EXEMPT_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix));
}

/** Prefix of the claude.ai-style MCP connector URL: itself a bearer secret, see `mcp/routes.ts`. */
const MCP_TOKEN_PATH_PREFIX = "/mcp/t/";

/**
 * Replaces the token segment of an `/mcp/t/:token` path with `[redacted]`
 * for logging, leaving every other path unchanged. `/mcp/t/:token` is a
 * bearer secret in URL form: logging it verbatim would leak the credential
 * into log storage.
 */
export function redactMcpTokenPath(path: string): string {
  return path.startsWith(MCP_TOKEN_PATH_PREFIX) ? `${MCP_TOKEN_PATH_PREFIX}[redacted]` : path;
}

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
  const connectionStatus: () => Promise<ConnectionStatus> =
    deps.connectionStatus ??
    (async () =>
      deps.config.sftpgoUrl === undefined
        ? { required: true, host: null }
        : { required: false, host: sftpgoHostLabel(deps.config.sftpgoUrl) });
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
        path: redactMcpTokenPath(c.req.path),
        status: c.res.status,
        ms,
        requestId: c.get("requestId"),
      },
      "request completed",
    );
  });

  app.use("/api/v1/*", createCsrfGuard());

  app.use("/api/v1/*", async (c, next) => {
    if (!isSetupExempt(c.req.path)) {
      const status = await connectionStatus();
      if (status.required) {
        throw new ApiHttpError("setup_required", "fdrive setup has not been completed yet");
      }
    }
    await next();
  });

  const v1: AppHono = new Hono();

  const subsystemReachability = deps.subsystemReachability ?? (async () => ({}));

  v1.get("/health", async (c) => {
    const uptimeSeconds = (clock().getTime() - deps.startedAt.getTime()) / 1000;
    const reachable = await subsystemReachability(deps.config);
    const subsystems = applyReachability(subsystemsStatus(deps.config), reachable);
    const body: HealthResponse = HealthResponse.parse({
      status: "ok",
      service: "fdrive-api",
      version: deps.version,
      uptimeSeconds,
      subsystems,
    });
    return c.json(body);
  });

  v1.get("/about", async (c) => {
    const status = await connectionStatus();
    // `/about` is reachable without a session (see SETUP_EXEMPT_PREFIXES),
    // so an anonymous caller must not learn the configured SFTPGo host: only
    // reveal `provider.label` once `principalResolver` confirms a valid
    // session. `provider.type` still tells an anonymous caller setup is
    // complete, which the login page needs to decide whether to redirect to
    // `/setup`.
    const principal = status.host === null ? null : await principalResolver(c);
    const body: AboutResponse = AboutResponse.parse({
      version: deps.version,
      builtOn: { name: "SFTPGo", sourceUrl: SFTPGO_SOURCE_URL },
      provider:
        status.host === null
          ? null
          : { type: "sftpgo", label: principal === null ? null : status.host },
      setupRequired: status.required,
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
