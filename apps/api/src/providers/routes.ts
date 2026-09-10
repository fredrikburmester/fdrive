import {
  AdminProvider,
  AdminProviderCreateRequest,
  AdminProvidersResponse,
  AdminProviderTestRequest,
  AdminProviderUpdateRequest,
  ConnectionTestResponse,
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

async function parseBody<T>(schema: z.ZodType<T>, raw: unknown, what: string): Promise<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiHttpError("bad_request", `invalid ${what}`, { issues: parsed.error.issues });
  }
  return parsed.data;
}

/**
 * Registers the public `GET /providers` (what the login page renders) and
 * the admin `/admin/providers` routes: list, create, update, delete and
 * probe. Creating or re-addressing a provider probes it first and refuses
 * an unreachable endpoint.
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
      AdminProvidersResponse.parse({
        providers: views.filter((view) => view !== null),
        types: deps.service.types(),
      }),
    );
  });

  groups.authed.post(withoutApiV1Prefix(ROUTES.admin.providers), requireAdmin, async (c) => {
    const body = await parseBody(
      AdminProviderCreateRequest,
      await c.req.json().catch(() => undefined),
      "provider",
    );
    const probe = await deps.service.probe({
      type: body.type,
      baseUrl: body.baseUrl,
      ...(body.config === undefined ? {} : { config: body.config }),
    });
    if (!probe.ok) {
      throw new ApiHttpError("bad_request", `provider is not reachable: ${probe.detail}`);
    }
    const created = await deps.service.create(body);
    return c.json(AdminProvider.parse(await deps.service.adminView(created, probe)));
  });

  groups.authed.post(withoutApiV1Prefix(ROUTES.admin.providersTest), requireAdmin, async (c) => {
    const body = await parseBody(
      AdminProviderTestRequest,
      await c.req.json().catch(() => undefined),
      "provider test request",
    );
    return c.json(ConnectionTestResponse.parse(await deps.service.probe(body)));
  });

  groups.authed.post(
    `${withoutApiV1Prefix(ROUTES.admin.providers)}/:id/test`,
    requireAdmin,
    async (c) => {
      const result = await deps.service.probe(providerId(c.req.param("id")));
      return c.json(ConnectionTestResponse.parse(result));
    },
  );

  groups.authed.patch(
    `${withoutApiV1Prefix(ROUTES.admin.providers)}/:id`,
    requireAdmin,
    async (c) => {
      const id = providerId(c.req.param("id"));
      const body = await parseBody(
        AdminProviderUpdateRequest,
        await c.req.json().catch(() => undefined),
        "provider update",
      );
      const current = await deps.service.get(id);
      if (current === null) {
        throw new ApiHttpError("not_found", "storage provider not found");
      }
      let probe: ConnectionTestResponse | undefined;
      if (body.baseUrl !== undefined && body.baseUrl !== current.provider.baseUrl) {
        probe = await deps.service.probe({
          type: current.module.type as AdminProviderTestRequest["type"],
          baseUrl: body.baseUrl,
        });
        if (!probe.ok) {
          throw new ApiHttpError("bad_request", `provider is not reachable: ${probe.detail}`);
        }
      }
      const updated = await deps.service.update(id, body);
      return c.json(AdminProvider.parse(await deps.service.adminView(updated, probe)));
    },
  );

  groups.authed.delete(
    `${withoutApiV1Prefix(ROUTES.admin.providers)}/:id`,
    requireAdmin,
    async (c) => {
      await deps.service.remove(providerId(c.req.param("id")));
      return c.json({ ok: true });
    },
  );
}
