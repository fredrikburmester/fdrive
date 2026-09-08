import { ROUTES } from "@fdrive/contracts";
import type { AuthedHono } from "../app.js";
import { withoutApiV1Prefix } from "../auth/routes.js";
import { ApiHttpError } from "../errors.js";
import type { FeatureService } from "./service.js";

/** Reject work immediately after saving a disable, before a worker's next settings poll. */
export function registerFeatureAdmission(authed: AuthedHono, service: FeatureService): void {
  authed.use("/system/*", async (c, next) => {
    if (c.req.method !== "POST") return next();
    const path = c.req.path;
    const values = (await service.configuration()).values;
    const requirements = [
      [ROUTES.system.ocrRun, values.pdfOcr],
      [ROUTES.system.searchReembed, values.semanticSearch],
      [ROUTES.system.imageSearchRebuild, values.imageSearch],
      [ROUTES.system.thumbnailsRebuild, values.thumbnails || values.imageSearch],
      [ROUTES.system.indexerThumbnailsRebuild, values.thumbnails || values.imageSearch],
      [ROUTES.system.indexerReindex, values.textSearch || values.thumbnails || values.imageSearch],
    ] as const;
    if (
      requirements.some(
        ([route, enabled]) => !enabled && (path === route || path === withoutApiV1Prefix(route)),
      )
    ) {
      throw new ApiHttpError(
        "conflict",
        "Enable this feature in System > Features before starting work.",
      );
    }
    return next();
  });
}
