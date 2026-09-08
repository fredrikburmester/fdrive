import { timingSafeEqual } from "node:crypto";
import {
  FeaturesUpdateRequest,
  ROUTES,
  SystemFeaturesResponse,
  WORKER_TOKEN_HEADER,
} from "@fdrive/contracts";
import type { AppHono, AuthedHono } from "../app.js";
import { createRequireAdmin } from "../auth/principal.js";
import { withoutApiV1Prefix } from "../auth/routes.js";
import { ApiHttpError } from "../errors.js";
import type { FeatureService } from "./service.js";

export function registerFeatureRoutes(
  groups: { public: AppHono; authed: AuthedHono },
  deps: {
    service: FeatureService;
    workerToken: string | undefined;
  },
): void {
  const path = withoutApiV1Prefix(ROUTES.system.features);
  groups.authed.get(path, createRequireAdmin(), async (c) =>
    c.json(SystemFeaturesResponse.parse(await deps.service.status())),
  );
  groups.authed.put(path, createRequireAdmin(), async (c) => {
    const input = FeaturesUpdateRequest.safeParse(await c.req.json().catch(() => null));
    if (!input.success)
      throw new ApiHttpError("bad_request", "Invalid feature settings or missing dependencies.");
    await deps.service.update(input.data);
    return c.json(SystemFeaturesResponse.parse(await deps.service.status()));
  });
  groups.public.get("/internal/features", async (c) => {
    const expected = Buffer.from(deps.workerToken ?? "");
    const supplied = Buffer.from(c.req.header(WORKER_TOKEN_HEADER) ?? "");
    if (
      expected.length === 0 ||
      supplied.length !== expected.length ||
      !timingSafeEqual(expected, supplied)
    ) {
      throw new ApiHttpError("unauthorized", "Invalid worker credential.");
    }
    c.header("Cache-Control", "no-store");
    return c.json(await deps.service.configuration());
  });
}
