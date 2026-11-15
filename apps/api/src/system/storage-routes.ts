import { ROUTES, SystemStorage, SystemStorageUpdateRequest } from "@fdrive/contracts";
import type { AuthedHono } from "../app.js";
import { createRequireAdmin } from "../auth/principal.js";
import { withoutApiV1Prefix } from "../auth/routes.js";
import { ApiHttpError } from "../errors.js";
import type { StorageService } from "./storage.js";

/** System > General's storage card: the files folder's name and health, and a rename. */
export function registerStorageRoutes(
  groups: { authed: AuthedHono },
  deps: { service: StorageService },
): void {
  const path = withoutApiV1Prefix(ROUTES.system.storage);
  const requireAdmin = createRequireAdmin();

  groups.authed.get(path, requireAdmin, async (c) =>
    c.json(SystemStorage.parse(await deps.service.view())),
  );

  groups.authed.patch(path, requireAdmin, async (c) => {
    const parsed = SystemStorageUpdateRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new ApiHttpError("bad_request", "Invalid storage name.", {
        issues: parsed.error.issues,
      });
    return c.json(SystemStorage.parse(await deps.service.rename(parsed.data.name)));
  });
}
