import { z } from "zod";
import { HttpUrl } from "./http-url.ts";

/**
 * Where the active SFTPGo connection came from: the `SFTPGO_URL`
 * environment variable (locked, cannot be changed from the admin UI) or the
 * `settings` table (editable).
 */
export const ConnectionSource = z.enum(["env", "settings"]);

export type ConnectionSource = z.infer<typeof ConnectionSource>;

/** Shape returned by `GET /api/v1/admin/connection`. */
export const AdminConnectionResponse = z.object({
  baseUrl: HttpUrl,
  host: z.string(),
  homeTemplate: z.string(),
  source: ConnectionSource,
  reachable: z.boolean(),
  checkedAt: z.iso.datetime(),
});

export type AdminConnectionResponse = z.infer<typeof AdminConnectionResponse>;

/**
 * Body for `PUT /api/v1/admin/connection`. `baseUrl` is refused with
 * `forbidden` when the active connection's source is `env`. Both fields
 * are optional so a caller can update just the home template.
 */
export const AdminConnectionUpdateRequest = z.object({
  baseUrl: HttpUrl.optional(),
  homeTemplate: z.string().min(1).optional(),
});

export type AdminConnectionUpdateRequest = z.infer<typeof AdminConnectionUpdateRequest>;

/**
 * Body for `POST /api/v1/admin/connection/test`. When `baseUrl` is
 * omitted, the currently configured connection is probed instead of a
 * candidate one.
 */
export const AdminConnectionTestRequest = z.object({
  baseUrl: HttpUrl.optional(),
});

export type AdminConnectionTestRequest = z.infer<typeof AdminConnectionTestRequest>;
