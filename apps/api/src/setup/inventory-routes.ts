import { ROUTES, SetupUserInventoryRequest, SetupUserInventoryResponse } from "@fdrive/contracts";
import type { AuthedHono } from "../app.js";
import type { LoginLimiter } from "../auth/login-limiter.js";
import { createRequireAdmin } from "../auth/principal.js";
import { withoutApiV1Prefix } from "../auth/routes.js";
import type { AppConfig } from "../config.js";
import type { ConnectionStore } from "../connection/store.js";
import { ApiHttpError } from "../errors.js";
import { extractClientIp } from "../net.js";
import { discoverSftpgoUsers } from "./discovery.js";

export const SETUP_INVENTORY_PATH = ROUTES.admin.inventory;

export interface RegisterSetupInventoryRoutesDeps {
  readonly connectionStore: ConnectionStore;
  readonly fetch: typeof globalThis.fetch;
  readonly limiter: LoginLimiter;
  readonly config: AppConfig;
}

function limiterKey(accountId: string, ip: string): string {
  return `setup-inventory|${accountId}|${ip}`;
}

/**
 * Adds the post-claim inventory endpoint. It is session-authenticated and
 * administrator-only; caller-supplied SFTPGo admin credentials are used for
 * one read-only request sequence and discarded immediately.
 */
export function registerSetupInventoryRoutes(
  groups: { authed: AuthedHono },
  deps: RegisterSetupInventoryRoutesDeps,
): void {
  groups.authed.post(withoutApiV1Prefix(SETUP_INVENTORY_PATH), createRequireAdmin(), async (c) => {
    const principal = c.get("principal");
    const key = limiterKey(
      principal.accountId,
      extractClientIp(c, deps.config.fdriveTrustedProxyHops),
    );
    const limit = deps.limiter.check(key);
    if (!limit.allowed) {
      throw new ApiHttpError("rate_limited", "too many SFTPGo inventory attempts", {
        retryAfterMs: limit.retryAfterMs ?? 0,
      });
    }
    const body: unknown = await c.req.json().catch(() => undefined);
    const parsed = SetupUserInventoryRequest.safeParse(body);
    if (!parsed.success) {
      throw new ApiHttpError("bad_request", "invalid SFTPGo inventory request", {
        issues: parsed.error.issues,
      });
    }
    const connection = await deps.connectionStore.current();
    if (connection === null) {
      throw new ApiHttpError("setup_required", "no SFTPGo connection is configured yet");
    }
    const result = await discoverSftpgoUsers(
      {
        baseUrl: connection.baseUrl,
        username: parsed.data.username,
        password: parsed.data.password,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
        ...(parsed.data.otp === undefined ? {} : { otp: parsed.data.otp }),
      },
      { fetch: deps.fetch },
    );
    if (result.ok) deps.limiter.recordSuccess(key);
    else deps.limiter.recordFailure(key);
    return c.json(SetupUserInventoryResponse.parse(result));
  });
}
