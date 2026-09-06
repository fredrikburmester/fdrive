import { z } from "zod";
import { HttpUrl } from "./http-url.ts";

/**
 * Shape returned by `GET /api/v1/setup/status`. `required` mirrors
 * `AboutResponse.setupRequired`; `hasEnvUrl` tells the setup page whether
 * `SFTPGO_URL` is already set by environment, in which case the setup flow
 * should skip asking for a base URL and jump straight to the home template
 * and admin account steps.
 */
export const SetupStatusResponse = z.object({
  required: z.boolean(),
  hasEnvUrl: z.boolean(),
});

export type SetupStatusResponse = z.infer<typeof SetupStatusResponse>;

/** Body for `POST /api/v1/setup/test`: the candidate SFTPGo base URL to probe. */
export const SetupTestRequest = z.object({
  baseUrl: HttpUrl,
});

export type SetupTestRequest = z.infer<typeof SetupTestRequest>;

/**
 * Result of probing a candidate SFTPGo base URL, shared by
 * `POST /api/v1/setup/test` and `POST /api/v1/admin/connection/test`.
 */
export const ConnectionTestResponse = z.object({
  ok: z.boolean(),
  detail: z.string(),
});

export type ConnectionTestResponse = z.infer<typeof ConnectionTestResponse>;

/**
 * Body for `POST /api/v1/setup/complete`: the connection to store plus the
 * SFTPGo credentials for the account that becomes the administrator.
 */
export const SetupCompleteRequest = z.object({
  baseUrl: HttpUrl,
  homeTemplate: z.string().min(1),
  username: z.string().min(1).max(255),
  password: z.string().min(1),
  otp: z.string().optional(),
});

export type SetupCompleteRequest = z.infer<typeof SetupCompleteRequest>;

/** Header carrying the one-time setup token on every `/api/v1/setup/*` request except `status`. */
export const SETUP_TOKEN_HEADER = "x-setup-token";
