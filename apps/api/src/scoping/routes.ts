import {
  AccountIdentityId,
  IdentityScopeResponse,
  ROUTES,
  SetIdentityScopeRequest,
} from "@fdrive/contracts";
import type { IdentityRepo } from "@fdrive/db";
import { accountContext } from "../accounts/routes.js";
import type { AppHono, AuthedHono } from "../app.js";
import { withoutApiV1Prefix } from "../auth/routes.js";
import { ApiHttpError } from "../errors.js";
import type { ScopeResolver } from "./resolver.ts";
import { ScopeOverrideValidationError } from "./validate-overrides.ts";

export interface ScopeRoutesDeps {
  readonly resolver: Pick<ScopeResolver, "status" | "setOverrides">;
  readonly identities: Pick<IdentityRepo, "get">;
}

/** `${ROUTES.account.identities}/:id/scope`, with the shared `/api/v1` prefix already stripped. */
function scopeRoutePath(): string {
  return `${withoutApiV1Prefix(ROUTES.account.identities)}/:id/scope`;
}

/**
 * Resolves the identity named by the `:id` route param, requiring it to
 * belong to the calling account. 404 (never a more specific status, so an
 * unknown id and one owned by another account are indistinguishable) when
 * it does not exist or is not owned; 400 only for an id that is not even a
 * well-formed identity id (never reaches the database).
 */
async function ownedIdentity(deps: ScopeRoutesDeps, accountId: string, rawId: string | undefined) {
  const parsedId = AccountIdentityId.safeParse(rawId);
  if (!parsedId.success) {
    throw new ApiHttpError("bad_request", "invalid identity id");
  }
  const identity = await deps.identities.get(parsedId.data);
  if (identity === null || identity.accountId !== accountId) {
    throw new ApiHttpError("not_found", "identity not found");
  }
  return identity;
}

/**
 * Registers `GET`/`PUT /api/v1/account/identities/:id/scope`. Both require
 * a cookie session that owns `:id`; a bearer/API-token principal is
 * rejected on both, since a token carries no session (`accountContext`
 * throws when an `authorization` header is present). `PUT` additionally
 * requires the caller to be an fdrive administrator; the app-wide CSRF
 * guard already covers the state-changing method. `GET` returns
 * `resolver.status`, redacted for a non-administrator; `PUT` validates the
 * body against `SetIdentityScopeRequest`, replaces the override through
 * `resolver.setOverrides` (which invalidates the resolver's verification
 * cache immediately), and returns the resulting status so the caller never
 * has to issue a follow-up `GET` to see its own change take effect.
 */
export function registerScopeRoutes(
  groups: { public: AppHono; authed: AuthedHono },
  deps: ScopeRoutesDeps,
): void {
  const { authed } = groups;
  const path = scopeRoutePath();

  authed.get(path, async (c) => {
    const input = accountContext(c);
    const id = c.req.param("id");
    const identity = await ownedIdentity(deps, input.principal.accountId, id);
    const status = await deps.resolver.status(identity, input.principal.isAdmin);
    return c.json(IdentityScopeResponse.parse(status));
  });

  authed.put(path, async (c) => {
    const input = accountContext(c);
    if (!input.principal.isAdmin) {
      throw new ApiHttpError("forbidden", "admin access required");
    }
    const id = c.req.param("id");
    const identity = await ownedIdentity(deps, input.principal.accountId, id);

    const json: unknown = await c.req.json().catch(() => undefined);
    const parsed = SetIdentityScopeRequest.safeParse(json);
    if (!parsed.success) {
      throw new ApiHttpError("bad_request", "invalid scope request", {
        issues: parsed.error.issues,
      });
    }

    try {
      await deps.resolver.setOverrides(identity, parsed.data.scopes);
    } catch (error) {
      if (error instanceof ScopeOverrideValidationError) {
        throw new ApiHttpError("bad_request", error.message);
      }
      throw error;
    }

    const status = await deps.resolver.status(identity, input.principal.isAdmin);
    return c.json(IdentityScopeResponse.parse(status));
  });
}
