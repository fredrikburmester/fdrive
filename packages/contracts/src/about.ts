import { z } from "zod";
import { ProviderType } from "./providers.ts";

/**
 * Shape returned by `GET /api/v1/about`: the running fdrive build and the
 * providers users authenticate against. This endpoint is public, so
 * `providers[].label` is the host of the provider's endpoint and is only
 * revealed to an authenticated caller: an
 * anonymous request gets `label: null` for every provider, so a visitor
 * cannot use this endpoint to learn which internal or third-party servers
 * fdrive is configured against. `providers` is empty and `setupRequired`
 * is true while no provider is configured yet; the web app redirects to
 * `/setup` in that case.
 */
export const AboutResponse = z.object({
  /**
   * The build as one value, which is all older servers send: the full Git
   * revision, else the release, else `development` (`0.0.0` from the oldest).
   */
  version: z.string(),
  /**
   * Release the API image was built as: `X.Y.Z` from a `vX.Y.Z` tag, or `main`
   * for the main branch. Absent for any other build and from older servers.
   */
  release: z.string().optional(),
  /** Full Git commit the API was built from. Absent when unknown and from older servers. */
  revision: z.string().optional(),
  /** API process uptime, sampled on request. Optional for older servers. */
  uptimeSeconds: z.number().nonnegative().optional(),
  providers: z.array(
    z.object({
      type: ProviderType,
      label: z.string().nullable(),
    }),
  ),
  setupRequired: z.boolean(),
});

export type AboutResponse = z.infer<typeof AboutResponse>;
