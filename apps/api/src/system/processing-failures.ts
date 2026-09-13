import {
  ProcessingFailuresQuery,
  ProcessingFailuresResponse,
  ProcessingFeature,
  RetryProcessingFailuresRequest,
  RetryProcessingFailuresResponse,
} from "@fdrive/contracts";
import type { ProcessingFailureReader } from "@fdrive/db";
import type { AuthedHono } from "../app.js";
import { createRequireAdmin } from "../auth/principal.js";
import { ApiHttpError } from "../errors.js";
import { callSidecar } from "./sidecar-client.js";

export function registerProcessingFailureRoutes(
  groups: { authed: AuthedHono },
  deps: {
    read: ProcessingFailureReader;
    indexerUrl: string | undefined;
    fetch: typeof globalThis.fetch;
  },
) {
  const admin = createRequireAdmin();
  groups.authed.get("/system/processing-failures/:feature", admin, async (c) => {
    const feature = ProcessingFeature.safeParse(c.req.param("feature"));
    const query = ProcessingFailuresQuery.safeParse(c.req.query());
    if (!feature.success || !query.success)
      throw new ApiHttpError("bad_request", "invalid failure query");
    c.header("Cache-Control", "no-store");
    return c.json(ProcessingFailuresResponse.parse(await deps.read(feature.data, query.data)));
  });
  groups.authed.post("/system/processing-failures/:feature/retry", admin, async (c) => {
    const feature = ProcessingFeature.safeParse(c.req.param("feature"));
    const payload = RetryProcessingFailuresRequest.safeParse(await c.req.json().catch(() => null));
    if (!feature.success || !payload.success)
      throw new ApiHttpError("bad_request", "invalid retry request");
    if (!deps.indexerUrl)
      throw new ApiHttpError("upstream_unavailable", "indexer is not configured");
    const result = await callSidecar(
      deps.indexerUrl,
      "/failures/retry",
      RetryProcessingFailuresResponse,
      { method: "POST", jsonBody: { feature: feature.data, ...payload.data } },
      deps,
    );
    if (!result.ok) {
      if (result.status === 409)
        throw new ApiHttpError("conflict", "Processing is busy or this feature is disabled.");
      if (result.status === 404)
        throw new ApiHttpError("not_found", "No unresolved failure found.");
      throw new ApiHttpError(
        "upstream_unavailable",
        "Could not start retry. Check the indexer status.",
      );
    }
    return c.json(result.data, 202);
  });
}
