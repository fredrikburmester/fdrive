import { z } from "zod";
import { ProviderType } from "./providers.ts";

/**
 * Shape returned by `GET /api/v1/about`: the running fdrive version, the
 * attribution each configured provider's licence asks for (SFTPGo's
 * AGPL-3.0 NOTICE terms), and the providers users authenticate against.
 * This endpoint is public, so `providers[].label` is the host of the
 * provider's endpoint and is only revealed to an authenticated caller: an
 * anonymous request gets `label: null` for every provider, so a visitor
 * cannot use this endpoint to learn which internal or third-party servers
 * fdrive is configured against. `providers` is empty and `setupRequired`
 * is true while no provider is configured yet; the web app redirects to
 * `/setup` in that case.
 */
export const AboutResponse = z.object({
  version: z.string(),
  /** API process uptime, sampled on request. Optional for older servers. */
  uptimeSeconds: z.number().nonnegative().optional(),
  builtOn: z.array(
    z.object({
      name: z.string(),
      sourceUrl: z.url(),
    }),
  ),
  providers: z.array(
    z.object({
      type: ProviderType,
      label: z.string().nullable(),
    }),
  ),
  setupRequired: z.boolean(),
});

export type AboutResponse = z.infer<typeof AboutResponse>;
