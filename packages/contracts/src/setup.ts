import { z } from "zod";
import { LocalPassword, LocalUsername } from "./users.ts";

/**
 * Shape returned by `GET /api/v1/setup/status`. `required` mirrors
 * `AboutResponse.setupRequired`. `storageConfigured` is false when the
 * deployment sets no files folder (`FDRIVE_STORAGE_ROOT`): setup cannot
 * finish until it does.
 */
export const SetupStatusResponse = z.object({
  required: z.boolean(),
  storageConfigured: z.boolean(),
});

export type SetupStatusResponse = z.infer<typeof SetupStatusResponse>;

/** Body for `POST /api/v1/setup/complete`: the owner's username and password. */
export const SetupCompleteRequest = z.strictObject({
  username: LocalUsername,
  password: LocalPassword,
});

export type SetupCompleteRequest = z.infer<typeof SetupCompleteRequest>;

/** Header carrying the one-time setup token on every `/api/v1/setup/*` request except `status`. */
export const SETUP_TOKEN_HEADER = "x-setup-token";
