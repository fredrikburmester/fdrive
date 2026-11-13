import {
  CreateGrantRequest,
  GrantPeopleResponse,
  GrantsResponse,
  OkResponse,
  OwnedGrant,
  ROUTES,
  UpdateGrantRequest,
} from "@fdrive/contracts";
import type { Context } from "hono";
import { z } from "zod";
import type { AuthedHono } from "../app.js";
import { withoutApiV1Prefix } from "../auth/routes.js";
import { ApiHttpError } from "../errors.js";
import type { LocalGrantService } from "./grants.js";

async function parseBody<T>(schema: z.ZodType<T>, c: Context, what: string): Promise<T> {
  const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) {
    throw new ApiHttpError("bad_request", `invalid ${what}`, { issues: parsed.error.issues });
  }
  return parsed.data;
}

function grantId(c: Context): string {
  const parsed = z.uuid().safeParse(c.req.param("id"));
  if (!parsed.success) throw new ApiHttpError("bad_request", "invalid share id");
  return parsed.data;
}

/**
 * Registers `/grants`: the active local login shares its folders with
 * other users, changes or ends those shares, and leaves folders shared
 * with it.
 */
export function registerGrantRoutes(
  groups: { authed: AuthedHono },
  deps: { readonly service: LocalGrantService },
): void {
  const one = `${withoutApiV1Prefix(ROUTES.grants.list)}/:id`;
  const identity = (c: Context) => c.get("principal").identityId;

  groups.authed.get(withoutApiV1Prefix(ROUTES.grants.list), async (c) =>
    c.json(GrantsResponse.parse(await deps.service.list(identity(c)))),
  );

  groups.authed.get(withoutApiV1Prefix(ROUTES.grants.people), async (c) =>
    c.json(GrantPeopleResponse.parse(await deps.service.people(identity(c)))),
  );

  groups.authed.post(withoutApiV1Prefix(ROUTES.grants.list), async (c) => {
    const body = await parseBody(CreateGrantRequest, c, "share");
    return c.json(OwnedGrant.parse(await deps.service.create(identity(c), body)), 201);
  });

  groups.authed.patch(one, async (c) => {
    const body = await parseBody(UpdateGrantRequest, c, "share update");
    return c.json(OwnedGrant.parse(await deps.service.update(identity(c), grantId(c), body)));
  });

  groups.authed.delete(one, async (c) => {
    await deps.service.remove(identity(c), grantId(c));
    return c.json(OkResponse.parse({ ok: true }));
  });
}
