import { z } from "zod";

/**
 * Shape returned by `GET /api/v1/about`: the running fdrive version, the
 * SFTPGo attribution required by its AGPL-3.0 NOTICE terms, and the
 * identity provider users authenticate against. This endpoint is public, so
 * `provider.label` must only ever be the SFTPGo host (host and port, no
 * scheme, no path) and must never leak credentials or internal paths.
 */
export const AboutResponse = z.object({
  version: z.string(),
  builtOn: z.object({
    name: z.literal("SFTPGo"),
    sourceUrl: z.url(),
  }),
  provider: z.object({
    type: z.literal("sftpgo"),
    label: z.string(),
  }),
});

export type AboutResponse = z.infer<typeof AboutResponse>;
