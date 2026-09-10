import { z } from "zod";
import { ProviderCapabilities, ProviderFieldValues, ProviderType } from "./providers.ts";

/**
 * Body for `POST /api/v1/auth/login`. `credential` holds the values of the
 * provider's `credentialFields` (for SFTPGo: `username`, `password` and an
 * optional `otp`), validated by the provider module on the server.
 * `providerId` may be omitted when exactly one provider is enabled.
 */
export const LoginRequest = z.strictObject({
  providerId: z.uuid().optional(),
  credential: ProviderFieldValues,
});

export type LoginRequest = z.infer<typeof LoginRequest>;

/** A single login linked to the signed-in account, with what its storage can do. */
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
 * The signed-in account, every identity linked to it, and which identity is
 * currently active for the session. Returned by both login and `/auth/me`.
 */
export const MeResponse = z.object({
  account: z.object({
    id: z.uuid(),
    displayName: z.string().nullable(),
  }),
  identities: z.array(IdentitySummary),
  activeIdentityId: z.uuid(),
  /** True when the signed-in account can reach the System admin pages. */
  isAdmin: z.boolean(),
});

export type MeResponse = z.infer<typeof MeResponse>;

export const LoginResponse = MeResponse;

export type LoginResponse = z.infer<typeof LoginResponse>;
