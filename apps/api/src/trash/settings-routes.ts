import { ROUTES, TrashSettings } from "@fdrive/contracts";
import type { AuthedHono } from "../app.js";
import { createRequireAdmin } from "../auth/principal.js";
import { withoutApiV1Prefix } from "../auth/routes.js";
import { ApiHttpError } from "../errors.js";
import type { TrashSettingsService } from "./settings.js";

/**
 * How long Trash keeps an item: anyone signed in reads it, since the Trash
 * page and the delete dialog say it; only an administrator changes it.
 */
export function registerTrashSettingsRoutes(
  groups: { authed: AuthedHono },
  deps: { service: TrashSettingsService },
): void {
  groups.authed.get(withoutApiV1Prefix(ROUTES.trash.settings), async (c) =>
    c.json(TrashSettings.parse(await deps.service.current())),
  );

  groups.authed.put(withoutApiV1Prefix(ROUTES.system.trash), createRequireAdmin(), async (c) => {
    const parsed = TrashSettings.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new ApiHttpError("bad_request", "Trash keeps items for 1 to 3650 days.", {
        issues: parsed.error.issues,
      });
    return c.json(TrashSettings.parse(await deps.service.update(parsed.data)));
  });
}
