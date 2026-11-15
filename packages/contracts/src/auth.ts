import { z } from "zod";
import { CanonicalUuid } from "./canonical-uuid.ts";
import { ProviderCapabilities, ProviderFieldValues, ProviderType } from "./providers.ts";

/**
 * Body for `POST /api/v1/auth/login`. `credential` holds the values of the
 * provider's `credentialFields` (for the files folder: `username` and
 * `password`), validated by the provider module on the server.
 * `providerId` may be omitted when exactly one provider is enabled.
 */
export const LoginRequest = z.strictObject({
  providerId: CanonicalUuid.optional(),
  credential: ProviderFieldValues,
});

export type LoginRequest = z.infer<typeof LoginRequest>;

/** The signed-in account's login, with what its storage can do. */
export const IdentitySummary = z.object({
  id: z.uuid(),
  username: z.string(),
  providerId: z.uuid(),
  providerType: ProviderType,
  providerLabel: z.string(),
  capabilities: ProviderCapabilities,
});

export type IdentitySummary = z.infer<typeof IdentitySummary>;

/**
 * The signed-in account and its one login. Returned by both login and
 * `/auth/me`.
 */
export const MeResponse = z.object({
  account: z.object({
    id: z.uuid(),
    displayName: z.string().nullable(),
  }),
  identity: IdentitySummary,
  /** True when the signed-in account can reach the System admin pages. */
  isAdmin: z.boolean(),
});

export type MeResponse = z.infer<typeof MeResponse>;

export const LoginResponse = MeResponse;

export type LoginResponse = z.infer<typeof LoginResponse>;
