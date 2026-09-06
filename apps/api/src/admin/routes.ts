import {
  AdminConnectionResponse,
  AdminConnectionTestRequest,
  AdminConnectionUpdateRequest,
  ConnectionTestResponse,
  ROUTES,
} from "@fdrive/contracts";
import { CoreError, parseHomeTemplate } from "@fdrive/core";
import type { AuthedHono } from "../app.js";
import { createRequireAdmin } from "../auth/principal.js";
import { withoutApiV1Prefix } from "../auth/routes.js";
import { probeConnection } from "../connection/probe.js";
import type { ConnectionStore } from "../connection/store.js";
import { ApiHttpError } from "../errors.js";

export interface RegisterAdminRoutesDeps {
  readonly connectionStore: ConnectionStore;
  readonly fetch: typeof globalThis.fetch;
  readonly clock: () => Date;
}

/** Turns a `CoreError` from `parseHomeTemplate` into `ApiHttpError("bad_request", ...)`. */
function assertValidHomeTemplate(homeTemplate: string): void {
  try {
    parseHomeTemplate(homeTemplate);
  } catch (err) {
    if (err instanceof CoreError) {
      throw new ApiHttpError("bad_request", err.message, err.details);
    }
    throw err;
  }
}

/** Builds the `GET /admin/connection` response shape from `connection` and a fresh probe. */
async function describeConnection(
  connectionStore: ConnectionStore,
  fetchImpl: typeof globalThis.fetch,
  clock: () => Date,
) {
  const connection = await connectionStore.current();
  if (connection === null) {
    throw new ApiHttpError("setup_required", "no SFTPGo connection is configured yet");
  }
  const probe = await probeConnection(connection.baseUrl, { fetch: fetchImpl });
  return AdminConnectionResponse.parse({
    baseUrl: connection.baseUrl,
    host: new URL(connection.baseUrl).host,
    homeTemplate: connection.homeTemplate,
    source: connection.source,
    reachable: probe.ok,
    checkedAt: clock().toISOString(),
  });
}

/**
 * Registers the admin-only `/admin/connection` routes (GET, PUT) and
 * `/admin/connection/test` (POST), all behind `createRequireAdmin()`.
 */
export function registerAdminRoutes(
  groups: { authed: AuthedHono },
  deps: RegisterAdminRoutesDeps,
): void {
  const admin: AuthedHono = groups.authed;
  const requireAdmin = createRequireAdmin();

  admin.get(withoutApiV1Prefix(ROUTES.admin.connection), requireAdmin, async (c) => {
    const body = await describeConnection(deps.connectionStore, deps.fetch, deps.clock);
    return c.json(body);
  });

  admin.put(withoutApiV1Prefix(ROUTES.admin.connectionUpdate), requireAdmin, async (c) => {
    const rawBody: unknown = await c.req.json().catch(() => undefined);
    const parsed = AdminConnectionUpdateRequest.safeParse(rawBody);
    if (!parsed.success) {
      throw new ApiHttpError("bad_request", "invalid connection update request", {
        issues: parsed.error.issues,
      });
    }

    if (parsed.data.homeTemplate !== undefined) {
      assertValidHomeTemplate(parsed.data.homeTemplate);
    }
    if (parsed.data.baseUrl !== undefined) {
      const probe = await probeConnection(parsed.data.baseUrl, { fetch: deps.fetch });
      if (!probe.ok) {
        throw new ApiHttpError("bad_request", `SFTPGo is not reachable: ${probe.detail}`);
      }
    }

    await deps.connectionStore.update({
      ...(parsed.data.baseUrl !== undefined ? { baseUrl: parsed.data.baseUrl } : {}),
      ...(parsed.data.homeTemplate !== undefined ? { homeTemplate: parsed.data.homeTemplate } : {}),
    });
    const body = await describeConnection(deps.connectionStore, deps.fetch, deps.clock);
    return c.json(body);
  });

  admin.post(withoutApiV1Prefix(ROUTES.admin.connectionTest), requireAdmin, async (c) => {
    const rawBody: unknown = await c.req.json().catch(() => ({}));
    const parsed = AdminConnectionTestRequest.safeParse(rawBody);
    if (!parsed.success) {
      throw new ApiHttpError("bad_request", "invalid connection test request", {
        issues: parsed.error.issues,
      });
    }

    let baseUrl = parsed.data.baseUrl;
    if (baseUrl === undefined) {
      const connection = await deps.connectionStore.current();
      if (connection === null) {
        throw new ApiHttpError("setup_required", "no SFTPGo connection is configured yet");
      }
      baseUrl = connection.baseUrl;
    }

    const result = await probeConnection(baseUrl, { fetch: deps.fetch });
    return c.json(ConnectionTestResponse.parse(result));
  });
}
