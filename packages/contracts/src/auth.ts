import { z } from "zod";

/**
 * Body for `POST /api/v1/auth/login`. `otp` is required only when SFTPGo
 * demands a TOTP code for the account.
 */
export const LoginRequest = z.object({
  username: z.string().min(1).max(255),
  password: z.string().min(1),
  otp: z.string().optional(),
});

export type LoginRequest = z.infer<typeof LoginRequest>;

/**
 * A single SFTPGo login linked to the signed-in account. v1 ships exactly
 * one provider type, `sftpgo`, but the shape leaves room for others.
 */
export const IdentitySummary = z.object({
  id: z.uuid(),
  username: z.string(),
  providerType: z.literal("sftpgo"),
  providerLabel: z.string(),
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
