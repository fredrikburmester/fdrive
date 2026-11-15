import { z } from "zod";
import { ProviderType } from "./providers.ts";

/**
 * Body for `POST /api/v1/auth/login`: a local user's name, in any case, and
 * password. A name no user can have is refused like a wrong password.
 */
export const LoginRequest = z.strictObject({
  username: z.string().min(1).max(255),
  password: z.string().min(1).max(1024),
});

export type LoginRequest = z.infer<typeof LoginRequest>;

/** The signed-in account's login. */
export const IdentitySummary = z.object({
  id: z.uuid(),
  username: z.string(),
  providerId: z.uuid(),
  providerType: ProviderType,
  providerLabel: z.string(),
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
  /** Trash is on for the installation: deletes move to the Trash folder. */
  trash: z.boolean(),
  /** The files folder is indexed: search, thumbnails and folder sizes apply. */
  index: z.boolean(),
});

export type MeResponse = z.infer<typeof MeResponse>;

export const LoginResponse = MeResponse;

export type LoginResponse = z.infer<typeof LoginResponse>;
