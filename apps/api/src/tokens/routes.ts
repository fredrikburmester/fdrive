import { CreateApiTokenRequest, ROUTES } from "@fdrive/contracts";
import type { AuthedHono } from "../app.js";
import { withoutApiV1Prefix } from "../auth/routes.js";
import { ApiHttpError } from "../errors.js";
import type { TokenService } from "./service.js";

export interface RegisterTokenRoutesDeps {
  readonly service: TokenService;
}

/**
 * Registers the account-page API token routes on the authed group: `GET`
 * and `POST /account/tokens`, `DELETE /account/tokens/:id`. These are only
 * ever reachable with a session cookie (the authed group's principal
 * resolver never resolves a bearer token), matching PLAN.md's "session
 * only, never token-authenticated" for token management itself.
 */
export function registerTokenRoutes(
  groups: { authed: AuthedHono },
  deps: RegisterTokenRoutesDeps,
): void {
  const { authed } = groups;

  authed.get(withoutApiV1Prefix(ROUTES.account.tokens), async (c) => {
    const principal = c.get("principal");
    const items = await deps.service.list(principal.accountId);
    return c.json({ items });
  });

  authed.post(withoutApiV1Prefix(ROUTES.account.tokens), async (c) => {
    const principal = c.get("principal");
    const rawBody: unknown = await c.req.json().catch(() => undefined);
    const parsed = CreateApiTokenRequest.safeParse(rawBody);
    if (!parsed.success) {
      throw new ApiHttpError("bad_request", "invalid create token request", {
        issues: parsed.error.issues,
      });
    }

    const result = await deps.service.create(principal.accountId, parsed.data);
    return c.json(result, 201);
  });

  authed.delete(`${withoutApiV1Prefix(ROUTES.account.tokens)}/:id`, async (c) => {
    const principal = c.get("principal");
    const id = c.req.param("id");
    await deps.service.revoke(id, principal.accountId);
    return c.json({ ok: true });
  });
}
