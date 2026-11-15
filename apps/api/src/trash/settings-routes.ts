import {
  ROUTES,
  SystemTrashQuery,
  TrashSettings,
  TrashSettingsUpdateRequest,
} from "@fdrive/contracts";
import type { AuthedHono } from "../app.js";
import { createRequireAdmin } from "../auth/principal.js";
import { withoutApiV1Prefix } from "../auth/routes.js";
import { ApiHttpError } from "../errors.js";
import type { TrashSettingsService } from "./settings.js";

/**
 * Trash is configured for the files folder's provider row, which both
 * routes name (`?providerId=` on GET, `providerId` in the PUT body); any
 * other id is not found.
 */
export function registerTrashSettingsRoutes(
  groups: { authed: AuthedHono },
  deps: { service: TrashSettingsService; storageId: string },
): void {
  const path = withoutApiV1Prefix(ROUTES.system.trash);
  const requireAdmin = createRequireAdmin();
  const knownProviderId = (providerId: string): string => {
    if (providerId !== deps.storageId) throw new ApiHttpError("not_found", "storage not found");
    return providerId;
  };

  groups.authed.get(path, requireAdmin, async (c) => {
    const query = SystemTrashQuery.safeParse(c.req.query());
    if (!query.success)
      throw new ApiHttpError("bad_request", "Trash settings need a providerId.", {
        issues: query.error.issues,
      });
    const providerId = knownProviderId(query.data.providerId);
    return c.json(TrashSettings.parse(await deps.service.configuration(providerId)));
  });

  groups.authed.put(path, requireAdmin, async (c) => {
    const parsed = TrashSettingsUpdateRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new ApiHttpError("bad_request", "Invalid Trash settings.", {
        issues: parsed.error.issues,
      });
    const providerId = knownProviderId(parsed.data.providerId);
    return c.json(TrashSettings.parse(await deps.service.update(providerId, parsed.data)));
  });
}
