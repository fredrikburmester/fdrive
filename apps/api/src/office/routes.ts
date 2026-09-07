import { OfficeCreateDocumentRequest, OfficeOpenRequest, ROUTES } from "@fdrive/contracts";
import { getCookie } from "hono/cookie";
import type { AppHono, AuthedHono } from "../app.js";
import { COOKIE_NAME } from "../auth/sessions.js";
import { ApiHttpError } from "../errors.js";
import { parseBody } from "../fs/routes.js";
import { officeErrorResponse, WopiError } from "./errors.ts";
import type { OfficeService } from "./service.ts";

function apiFailure(error: unknown): never {
  const response = officeErrorResponse(error);
  const kind =
    response.status === 401
      ? "unauthorized"
      : response.status === 403
        ? "forbidden"
        : response.status === 404
          ? "not_found"
          : response.status === 409
            ? "conflict"
            : response.status === 413
              ? "payload_too_large"
              : response.status === 400
                ? "bad_request"
                : "upstream_unavailable";
  throw new ApiHttpError(kind, "Office operation could not be completed");
}
export function registerOfficeRoutes(
  groups: { authed: AuthedHono },
  deps: { service: OfficeService },
): void {
  groups.authed.get(ROUTES.office.status.slice(7), async (c) =>
    c.json(await deps.service.status()),
  );
  groups.authed.post(ROUTES.office.open.slice(7), async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    const request = await parseBody(OfficeOpenRequest, c);
    try {
      const sessionId = getCookie(c, COOKIE_NAME);
      if (!sessionId) throw new WopiError(401);
      return c.json(await deps.service.open({ principal: c.get("principal"), sessionId }, request));
    } catch (error) {
      return apiFailure(error);
    }
  });
  groups.authed.post(ROUTES.office.documents.slice(7), async (c) => {
    const request = await parseBody(OfficeCreateDocumentRequest, c);
    try {
      const sessionId = getCookie(c, COOKIE_NAME);
      if (!sessionId) throw new WopiError(401);
      return c.json(
        await deps.service.create({ principal: c.get("principal"), sessionId }, request),
        201,
      );
    } catch (error) {
      return apiFailure(error);
    }
  });
}
export function registerWopiRoutes(app: AppHono, deps: { service: OfficeService }): void {
  app.all("/wopi/files/:id", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    return deps.service.callback(c.req.raw, c.req.param("id"), false);
  });
  app.all("/wopi/files/:id/contents", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    return deps.service.callback(c.req.raw, c.req.param("id"), true);
  });
}
