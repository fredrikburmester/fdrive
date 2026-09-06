import { z } from "zod";

/**
 * Shape returned by the API's health endpoint. `version` is the running
 * package version and `uptimeSeconds` is the number of seconds since the
 * process started.
 */
export const HealthResponse = z.object({
  status: z.literal("ok"),
  service: z.literal("fdrive-api"),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
});

export type HealthResponse = z.infer<typeof HealthResponse>;
