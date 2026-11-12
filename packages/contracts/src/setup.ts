import { z } from "zod";
import { HttpUrl } from "./http-url.ts";
import { AdminProviderType, ProviderFieldValues, ProviderName, ProviderType } from "./providers.ts";
import { LocalPassword, LocalUsername } from "./users.ts";

/**
 * How setup creates the first account. `local`: the deployment serves a
 * folder (`FDRIVE_STORAGE_ROOT`), so the owner picks a username and
 * password for it. `provider`: there is no local folder, so the owner
 * connects one of `types` and signs in to it.
 */
export const SetupMode = z.enum(["local", "provider"]);
export type SetupMode = z.infer<typeof SetupMode>;

/**
 * Shape returned by `GET /api/v1/setup/status`. `required` mirrors
 * `AboutResponse.setupRequired`. `types` lists what `provider` setup can
 * connect, with the form each needs; it is empty in `local` mode.
 */
export const SetupStatusResponse = z.object({
  required: z.boolean(),
  mode: SetupMode,
  types: z.array(AdminProviderType),
});

export type SetupStatusResponse = z.infer<typeof SetupStatusResponse>;

/** Body for `POST /api/v1/setup/test`: a candidate storage to probe in `provider` setup. */
export const SetupTestRequest = z.strictObject({
  type: ProviderType,
  baseUrl: HttpUrl,
  config: ProviderFieldValues.optional(),
});

export type SetupTestRequest = z.infer<typeof SetupTestRequest>;

/**
 * Result of probing a candidate storage, shared by
 * `POST /api/v1/setup/test` and the admin provider probe routes.
 */
export const ConnectionTestResponse = z.object({
  ok: z.boolean(),
  detail: z.string(),
});

export type ConnectionTestResponse = z.infer<typeof ConnectionTestResponse>;

/** `local` setup: the owner's username and password for the deployment's folder. */
export const SetupCompleteLocalRequest = z.strictObject({
  kind: z.literal("local"),
  username: LocalUsername,
  password: LocalPassword,
});

/** `provider` setup: the storage to add and the owner's sign-in to it. */
export const SetupCompleteProviderRequest = z.strictObject({
  kind: z.literal("provider"),
  type: ProviderType,
  baseUrl: HttpUrl,
  label: ProviderName.optional(),
  config: ProviderFieldValues.optional(),
  credential: ProviderFieldValues,
});

/** Body for `POST /api/v1/setup/complete`: the account that becomes the administrator. */
export const SetupCompleteRequest = z.discriminatedUnion("kind", [
  SetupCompleteLocalRequest,
  SetupCompleteProviderRequest,
]);

export type SetupCompleteRequest = z.infer<typeof SetupCompleteRequest>;

/** Header carrying the one-time setup token on every `/api/v1/setup/*` request except `status`. */
export const SETUP_TOKEN_HEADER = "x-setup-token";
