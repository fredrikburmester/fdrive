import { ROUTES, TrashSettings, TrashSettingsUpdateRequest } from "@fdrive/contracts";
import type { IdentityRepo } from "@fdrive/db";
import type { AuthedHono } from "../app.js";
import { createRequireAdmin } from "../auth/principal.js";
import { withoutApiV1Prefix } from "../auth/routes.js";
import { ApiHttpError } from "../errors.js";
import type { TrashSettingsService } from "./settings.js";

export function registerTrashSettingsRoutes(
  groups: { authed: AuthedHono },
  deps: { service: TrashSettingsService; identities: Pick<IdentityRepo, "get"> },
): void {
  const path = withoutApiV1Prefix(ROUTES.system.trash);
  const requireAdmin = createRequireAdmin();
  const activeProviderId = async (identityId: string): Promise<string> => {
    const identity = await deps.identities.get(identityId);
    if (identity === null) throw new ApiHttpError("unauthorized", "identity no longer exists");
    return identity.providerId;
  };

  groups.authed.get(path, requireAdmin, async (c) => {
    const providerId = await activeProviderId(c.get("principal").identityId);
    return c.json(TrashSettings.parse(await deps.service.configuration(providerId)));
  });

  groups.authed.put(path, requireAdmin, async (c) => {
    const parsed = TrashSettingsUpdateRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new ApiHttpError("bad_request", "Invalid Trash settings.", {
        issues: parsed.error.issues,
      });
    const providerId = await activeProviderId(c.get("principal").identityId);
    return c.json(TrashSettings.parse(await deps.service.update(providerId, parsed.data)));
  });
}
