import {
  AiConnectionTestResponse,
  AiSettingsUpdateRequest,
  AiStatusResponse,
  OrganizeRequest,
  OrganizeRun,
  ROUTES,
  SystemAiResponse,
} from "@fdrive/contracts";
import type { AppHono, AuthedHono } from "../app.js";
import { createRequireAdmin } from "../auth/principal.js";
import { withoutApiV1Prefix } from "../auth/routes.js";
import { parseBody } from "../fs/routes.js";
import type { AiModel } from "./model.ts";
import type { OrganizeService } from "./organize/service.ts";
import type { AiSettingsService, ResolvedAiConfig } from "./settings.ts";

export interface AiRoutesDeps {
  readonly settings: AiSettingsService;
  readonly organize: OrganizeService;
  readonly modelFor: (config: ResolvedAiConfig) => AiModel;
  /** How long the connection check may take. Default 15 seconds. */
  readonly testTimeoutMs?: number;
}

/**
 * `/ai/*` for every signed-in person (status and organize runs) and
 * `/system/ai` for administrators (provider settings and a connection check).
 */
export function registerAiRoutes(
  groups: { public: AppHono; authed: AuthedHono },
  deps: AiRoutesDeps,
) {
  const { authed } = groups;
  const requireAdmin = createRequireAdmin();
  const organizePath = withoutApiV1Prefix(ROUTES.ai.organize);

  authed.get(withoutApiV1Prefix(ROUTES.ai.status), async (c) =>
    c.json(AiStatusResponse.parse(await deps.organize.status())),
  );

  authed.post(organizePath, async (c) => {
    const request = await parseBody(OrganizeRequest, c);
    const run = await deps.organize.start(c.get("principal"), request);
    return c.json(OrganizeRun.parse(run), 202);
  });

  authed.get(`${organizePath}/:id`, (c) =>
    c.json(OrganizeRun.parse(deps.organize.get(c.get("principal"), c.req.param("id")))),
  );

  authed.post(`${organizePath}/:id/cancel`, (c) =>
    c.json(OrganizeRun.parse(deps.organize.cancel(c.get("principal"), c.req.param("id")))),
  );

  const systemPath = withoutApiV1Prefix(ROUTES.system.ai);

  authed.get(systemPath, requireAdmin, async (c) =>
    c.json(SystemAiResponse.parse({ configuration: await deps.settings.configuration() })),
  );

  authed.put(systemPath, requireAdmin, async (c) => {
    const input = await parseBody(AiSettingsUpdateRequest, c);
    return c.json(SystemAiResponse.parse({ configuration: await deps.settings.update(input) }));
  });

  authed.post(withoutApiV1Prefix(ROUTES.system.aiTest), requireAdmin, async (c) => {
    const config = await deps.settings.saved();
    if (config === null)
      return c.json(
        AiConnectionTestResponse.parse({
          ok: false,
          message: "Save a provider, model and key first.",
        }),
      );
    const result = await deps
      .modelFor(config)
      .ping(AbortSignal.timeout(deps.testTimeoutMs ?? 15_000))
      .catch(() => ({ ok: false, message: "The connection check did not finish in time." }));
    return c.json(AiConnectionTestResponse.parse(result));
  });
}
