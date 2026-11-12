import {
  AdminUser,
  AdminUserCreateRequest,
  AdminUsersResponse,
  AdminUserUpdateRequest,
  ChangePasswordRequest,
  OkResponse,
  ROUTES,
} from "@fdrive/contracts";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { z } from "zod";
import type { AuthedHono } from "../app.js";
import { createRequireAdmin } from "../auth/principal.js";
import { withoutApiV1Prefix } from "../auth/routes.js";
import { COOKIE_NAME, hashSessionId } from "../auth/sessions.js";
import { ApiHttpError } from "../errors.js";
import type { LocalUserService, UserViewer } from "./service.js";

export interface RegisterLocalUserRoutesDeps {
  readonly service: LocalUserService;
}

async function parseBody<T>(schema: z.ZodType<T>, c: Context, what: string): Promise<T> {
  const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) {
    throw new ApiHttpError("bad_request", `invalid ${what}`, { issues: parsed.error.issues });
  }
  return parsed.data;
}

/** The browser session's hash; `undefined` for a request made with an API token. */
function sessionIdHash(c: Context): string | undefined {
  const raw = getCookie(c, COOKIE_NAME);
  return raw === undefined ? undefined : hashSessionId(raw);
}

/**
 * Registers `/admin/users` (administrators manage the local users) and
 * `POST /auth/password` (a local login changes its own password, from a
 * browser session only).
 */
export function registerLocalUserRoutes(
  groups: { authed: AuthedHono },
  deps: RegisterLocalUserRoutesDeps,
): void {
  const requireAdmin = createRequireAdmin();
  const viewer = (c: Context): UserViewer => {
    const hash = sessionIdHash(c);
    return {
      accountId: c.get("principal").accountId,
      ...(hash === undefined ? {} : { sessionIdHash: hash }),
    };
  };
  const usernameParam = (c: Context): string => {
    const username = c.req.param("username");
    if (username === undefined || username.length === 0 || username.length > 255) {
      throw new ApiHttpError("bad_request", "invalid username");
    }
    return username;
  };
  const userPath = `${withoutApiV1Prefix(ROUTES.admin.users)}/:username`;

  groups.authed.get(withoutApiV1Prefix(ROUTES.admin.users), requireAdmin, async (c) => {
    return c.json(AdminUsersResponse.parse(await deps.service.list(viewer(c))));
  });

  groups.authed.post(withoutApiV1Prefix(ROUTES.admin.users), requireAdmin, async (c) => {
    const body = await parseBody(AdminUserCreateRequest, c, "user");
    return c.json(AdminUser.parse(await deps.service.create(body, viewer(c))), 201);
  });

  groups.authed.patch(userPath, requireAdmin, async (c) => {
    const body = await parseBody(AdminUserUpdateRequest, c, "user update");
    return c.json(AdminUser.parse(await deps.service.update(usernameParam(c), body, viewer(c))));
  });

  groups.authed.delete(userPath, requireAdmin, async (c) => {
    await deps.service.remove(usernameParam(c), viewer(c));
    return c.json(OkResponse.parse({ ok: true }));
  });

  groups.authed.post(withoutApiV1Prefix(ROUTES.auth.password), async (c) => {
    const hash = sessionIdHash(c);
    if (hash === undefined) {
      throw new ApiHttpError("forbidden", "change your password from a signed-in browser");
    }
    const body = await parseBody(ChangePasswordRequest, c, "password change");
    await deps.service.changeOwnPassword({
      identityId: c.get("principal").identityId,
      sessionIdHash: hash,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
    });
    return c.json(OkResponse.parse({ ok: true }));
  });
}
