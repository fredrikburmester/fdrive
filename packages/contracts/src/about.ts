import { z } from "zod";

/**
 * Shape returned by the public `GET /api/v1/about`: the running fdrive
 * build, and whether setup is still required, in which case the web app
 * redirects to `/setup`.
 */
export const AboutResponse = z.object({
  /** The build as one value: the full Git revision, else the release, else `development`. */
  version: z.string(),
  /**
   * Release the API image was built as: `X.Y.Z` from a `vX.Y.Z` tag, or `main`
   * for the main branch. Absent for any other build.
   */
  release: z.string().optional(),
  /** Full Git commit the API was built from. Absent when unknown. */
  revision: z.string().optional(),
  /** API process uptime, sampled on request. */
  uptimeSeconds: z.number().nonnegative(),
  setupRequired: z.boolean(),
});

export type AboutResponse = z.infer<typeof AboutResponse>;
