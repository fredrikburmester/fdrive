import {
  AdminProvider,
  AdminProvidersResponse,
  AdminProviderUpdateRequest,
  ProvidersResponse,
  ROUTES,
} from "@fdrive/contracts";
import { z } from "zod";
import type { AppHono, AuthedHono } from "../app.js";
import { createRequireAdmin } from "../auth/principal.js";
import { withoutApiV1Prefix } from "../auth/routes.js";
import { ApiHttpError } from "../errors.js";
import type { ProviderService } from "./service.js";

export interface RegisterProviderRoutesDeps {
  readonly service: ProviderService;
}

/**
 * Registers the public `GET /providers` (what the login page renders) and
 * the admin `/admin/providers` routes: list the storage with a fresh
 * reachability probe, and rename it. The storage itself comes from the
 * deployment (`FDRIVE_STORAGE_ROOT`), so there is nothing to add or remove.
 */
export function registerProviderRoutes(
  groups: { public: AppHono; authed: AuthedHono },
  deps: RegisterProviderRoutesDeps,
): void {
  const requireAdmin = createRequireAdmin();
  const providerId = (raw: string): string => {
    const parsed = z.uuid().safeParse(raw);
    if (!parsed.success) {
      throw new ApiHttpError("bad_request", "invalid provider id");
    }
    return parsed.data;
  };

  groups.public.get(withoutApiV1Prefix(ROUTES.providers), async (c) => {
    const providers = (await deps.service.enabled())
      .map((provider) => deps.service.publicView(provider))
      .filter((view) => view !== null);
    return c.json(ProvidersResponse.parse({ providers }));
  });

  groups.authed.get(withoutApiV1Prefix(ROUTES.admin.providers), requireAdmin, async (c) => {
    const views = await Promise.all(
      (await deps.service.list()).map((provider) => deps.service.adminView(provider)),
    );
    return c.json(
      AdminProvidersResponse.parse({ providers: views.filter((view) => view !== null) }),
    );
  });

  groups.authed.patch(
    `${withoutApiV1Prefix(ROUTES.admin.providers)}/:id`,
    requireAdmin,
    async (c) => {
      const id = providerId(c.req.param("id"));
      const parsed = AdminProviderUpdateRequest.safeParse(
        await c.req.json().catch(() => undefined),
      );
      if (!parsed.success) {
        throw new ApiHttpError("bad_request", "invalid provider update", {
          issues: parsed.error.issues,
        });
      }
      // A row whose module this deployment no longer has is not storage.
      if ((await deps.service.get(id)) === null) {
        throw new ApiHttpError("not_found", "storage provider not found");
      }
      const updated = await deps.service.update(id, parsed.data);
      return c.json(AdminProvider.parse(await deps.service.adminView(updated)));
    },
  );
}
