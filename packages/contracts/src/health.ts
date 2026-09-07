import { z } from "zod";

/**
 * The functional areas fdrive can be configured for, mirrored from the
 * API's `apps/api/src/config-keys.ts`. Kept as a plain string here (not a
 * `z.enum`) so this contracts package never needs to import from `apps/api`;
 * an API-side test keeps the two lists in sync.
 */
export const HealthSubsystemName = z.enum([
  "core",
  "index",
  "search",
  "ocr",
  "thumbnails",
  "office",
  "trash",
  "shares",
  "network",
]);

export type HealthSubsystemName = z.infer<typeof HealthSubsystemName>;

/**
 * One subsystem's configuration and reachability state, part of `GET
 * /api/v1/health`'s public `subsystems` field. `not_configured` means the
 * variables in `missing` (by name) must be set to enable it; `unreachable`
 * means it is configured but the API could not reach it just now;
 * `configured` means it is set up and, where a liveness probe exists,
 * reachable.
 */
export const HealthSubsystemStatus = z.object({
  status: z.enum(["configured", "not_configured", "unreachable"]),
  missing: z.array(z.string()),
});

export type HealthSubsystemStatus = z.infer<typeof HealthSubsystemStatus>;

/**
 * Shape returned by the API's health endpoint. `version` is the running
 * package version and `uptimeSeconds` is the number of seconds since the
 * process started. `subsystems` reports every configurable subsystem's
 * state by name, so a misconfigured or unreachable sidecar is visible from
 * this public, unauthenticated endpoint without leaking any secret value:
 * only variable names appear, never their values.
 */
export const HealthResponse = z.object({
  status: z.literal("ok"),
  service: z.literal("fdrive-api"),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  subsystems: z.record(HealthSubsystemName, HealthSubsystemStatus),
});

export type HealthResponse = z.infer<typeof HealthResponse>;
