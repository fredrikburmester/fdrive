import {
  AccountIdentityId,
  LinkIdentityRequest,
  ROUTES,
  SearchQuery,
  SwitchIdentityRequest,
} from "@fdrive/contracts";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { AppHono, AppVariables, AuthedHono } from "../app.js";
import type { PrincipalVariables } from "../auth/principal.js";
import { withoutApiV1Prefix } from "../auth/routes.js";
import { buildCookie, COOKIE_NAME, cookieSecureFor } from "../auth/sessions.js";
import type { AppConfig } from "../config.js";
import { ApiHttpError } from "../errors.js";
import { parseBody } from "../fs/routes.js";
import { extractClientIp } from "../net.js";
import { accountRepositoryCall } from "./errors.ts";
import type { AccountRotation, AccountsService } from "./service.ts";
import type { AccountRequestContext } from "./types.ts";
import type { AccountViews } from "./views.ts";

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
export function registerAccountsRoutes(
  groups: { public: AppHono; authed: AuthedHono },
  deps: { service: AccountsService; views: AccountViews; config: AppConfig; clock: () => Date },
): void {
  function rotationCookie(c: Context, result: AccountRotation) {
    c.header(
      "Set-Cookie",
      buildCookie({
        id: result.sessionId,
        secure: cookieSecureFor(deps.config, c),
        maxAgeSeconds: Math.max(
          0,
          Math.floor((result.expiresAt.getTime() - deps.clock().getTime()) / 1000),
        ),
      }),
    );
  }
  groups.authed.post(withoutApiV1Prefix(ROUTES.account.identities), async (c) => {
    const input = accountContext(c);
    const body = await parseBody(LinkIdentityRequest, c);
    const result = await accountRepositoryCall(() =>
      deps.service.link(input, { ...body, ip: extractClientIp(c) }),
    );
    rotationCookie(c, result);
    return c.json(result.me);
  });
  groups.authed.delete(`${withoutApiV1Prefix(ROUTES.account.identities)}/:id`, async (c) => {
    const input = accountContext(c);
    const id = AccountIdentityId.safeParse(c.req.param("id"));
    if (!id.success) throw new ApiHttpError("bad_request", "invalid identity ID");
    const result = await accountRepositoryCall(() => deps.service.unlink(input, id.data));
    rotationCookie(c, result);
    return c.json(result.me);
  });
  groups.authed.post(withoutApiV1Prefix(ROUTES.account.activeIdentity), async (c) => {
    const input = accountContext(c);
    const body = await parseBody(SwitchIdentityRequest, c);
    return c.json(await accountRepositoryCall(() => deps.service.switch(input, body.identityId)));
  });
  groups.authed.get(withoutApiV1Prefix(ROUTES.account.favorites), async (c) => {
    const input = accountContext(c);
    if (c.req.query("identity") !== undefined)
      throw new ApiHttpError("bad_request", "account views do not accept identity filters");
    return c.json(await accountRepositoryCall(() => deps.views.favorites(input)));
  });
  groups.authed.get(withoutApiV1Prefix(ROUTES.account.search), async (c) => {
    const input = accountContext(c);
    if (c.req.query("identity") !== undefined)
      throw new ApiHttpError("bad_request", "account views do not accept identity filters");
    const query = SearchQuery.safeParse(c.req.query());
    if (!query.success) throw new ApiHttpError("bad_request", "invalid query");
    return c.json(await accountRepositoryCall(() => deps.views.search(input, query.data)));
  });
}
