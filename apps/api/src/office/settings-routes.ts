import { timingSafeEqual } from "node:crypto";
import {
  OfficeRuntimeConfiguration,
  OfficeSettingsUpdateRequest,
  ROUTES,
  SystemOfficeResponse,
  WORKER_TOKEN_HEADER,
} from "@fdrive/contracts";
import type { AppHono, AuthedHono } from "../app.js";
import { createRequireAdmin } from "../auth/principal.js";
import { withoutApiV1Prefix } from "../auth/routes.js";
import { ApiHttpError } from "../errors.js";
import type { OfficeProviderRef, OfficeSettingsService } from "./settings.js";

function requireWorkerToken(expectedToken: string | undefined, suppliedToken: string | undefined) {
  const expected = Buffer.from(expectedToken ?? "");
  const supplied = Buffer.from(suppliedToken ?? "");
  if (
    expected.length === 0 ||
    supplied.length !== expected.length ||
    !timingSafeEqual(expected, supplied)
  )
    throw new ApiHttpError("unauthorized", "Invalid worker credential.");
}

export function registerOfficeSettingsRoutes(
  groups: { public: AppHono; authed: AuthedHono },
  deps: {
    service: OfficeSettingsService;
    workerToken: string | undefined;
    activeProvider: () => Promise<OfficeProviderRef | null>;
  },
): void {
  const path = withoutApiV1Prefix(ROUTES.system.office);
  const requireAdmin = createRequireAdmin();

  groups.authed.get(path, requireAdmin, async (c) =>
    c.json(SystemOfficeResponse.parse(await deps.service.status(await deps.activeProvider()))),
  );
  groups.authed.put(path, requireAdmin, async (c) => {
    const parsed = OfficeSettingsUpdateRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new ApiHttpError("bad_request", "Invalid Office settings.", {
        issues: parsed.error.issues,
      });
    const provider = await deps.activeProvider();
    await deps.service.update(provider?.id ?? null, parsed.data);
    return c.json(SystemOfficeResponse.parse(await deps.service.status(provider)));
  });

  groups.public.get("/internal/office", async (c) => {
    requireWorkerToken(deps.workerToken, c.req.header(WORKER_TOKEN_HEADER));
    c.header("Cache-Control", "no-store");
    return c.json(OfficeRuntimeConfiguration.parse(await deps.service.runtimeConfiguration()));
  });
}
