import { z } from "zod";

/**
 * Shape returned by `GET /api/v1/about`: the running fdrive version and the
 * SFTPGo attribution required by its AGPL-3.0 NOTICE terms.
 */
export const AboutResponse = z.object({
  version: z.string(),
  builtOn: z.object({
    name: z.literal("SFTPGo"),
    sourceUrl: z.url(),
  }),
});

export type AboutResponse = z.infer<typeof AboutResponse>;
