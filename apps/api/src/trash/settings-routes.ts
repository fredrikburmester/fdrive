import {
  ROUTES,
  SystemTrashQuery,
  TrashSettings,
  TrashSettingsUpdateRequest,
} from "@fdrive/contracts";
import type { ProviderRepo } from "@fdrive/db";
import type { AuthedHono } from "../app.js";
import { createRequireAdmin } from "../auth/principal.js";
import { withoutApiV1Prefix } from "../auth/routes.js";
import { ApiHttpError } from "../errors.js";
import type { TrashSettingsService } from "./settings.js";

/**
 * Trash is configured per storage server, so both routes name the provider
 * explicitly (`?providerId=` on GET, `providerId` in the PUT body) instead
 * of reading it off the caller's active login: an administrator edits any
 * server's Trash from System > Storage, whichever login the tab browses as.
 */
export function registerTrashSettingsRoutes(
  groups: { authed: AuthedHono },
  deps: { service: TrashSettingsService; providers: Pick<ProviderRepo, "get"> },
): void {
  const path = withoutApiV1Prefix(ROUTES.system.trash);
  const requireAdmin = createRequireAdmin();
  const knownProviderId = async (providerId: string): Promise<string> => {
    if ((await deps.providers.get(providerId)) === null)
      throw new ApiHttpError("not_found", "storage provider not found");
    return providerId;
  };

  groups.authed.get(path, requireAdmin, async (c) => {
    const query = SystemTrashQuery.safeParse(c.req.query());
    if (!query.success)
      throw new ApiHttpError("bad_request", "Trash settings need a providerId.", {
        issues: query.error.issues,
      });
    const providerId = await knownProviderId(query.data.providerId);
    return c.json(TrashSettings.parse(await deps.service.configuration(providerId)));
  });

  groups.authed.put(path, requireAdmin, async (c) => {
    const parsed = TrashSettingsUpdateRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new ApiHttpError("bad_request", "Invalid Trash settings.", {
        issues: parsed.error.issues,
      });
    const providerId = await knownProviderId(parsed.data.providerId);
    return c.json(TrashSettings.parse(await deps.service.update(providerId, parsed.data)));
  });
}
