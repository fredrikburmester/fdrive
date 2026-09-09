import { PublicUrlSettings, PublicUrlUpdateRequest, ROUTES } from "@fdrive/contracts";
import type { AuthedHono } from "../app.js";
import { createRequireAdmin } from "../auth/principal.js";
import { withoutApiV1Prefix } from "../auth/routes.js";
import { ApiHttpError } from "../errors.js";
import type { PublicUrlService } from "./public-url.js";

export function registerPublicUrlRoutes(
  groups: { authed: AuthedHono },
  deps: { service: PublicUrlService },
): void {
  const path = withoutApiV1Prefix(ROUTES.system.publicUrl);
  const requireAdmin = createRequireAdmin();

  groups.authed.get(path, requireAdmin, async (c) =>
    c.json(PublicUrlSettings.parse(await deps.service.configuration())),
  );

  groups.authed.put(path, requireAdmin, async (c) => {
    const parsed = PublicUrlUpdateRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new ApiHttpError("bad_request", "Invalid server address.", {
        issues: parsed.error.issues,
      });
    return c.json(PublicUrlSettings.parse(await deps.service.update(parsed.data)));
  });
}
