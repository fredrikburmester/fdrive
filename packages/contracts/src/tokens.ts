import { z } from "zod";
import { CanonicalUuid } from "./canonical-uuid.ts";

/**
 * The expiry choices offered on the account page's "create token" dialog:
 * 30 days, 90 days, 365 days, or omitted entirely for a token that never
 * expires.
 */
export const ApiTokenExpiresInDays = z.union([z.literal(30), z.literal(90), z.literal(365)]);

export type ApiTokenExpiresInDays = z.infer<typeof ApiTokenExpiresInDays>;

/**
 * One API token as listed on the account page. Never carries the secret
 * itself, only `POST /api/v1/account/tokens` does that, and only once.
 */
export const ApiTokenSummary = z.object({
  id: z.uuid(),
  name: z.string(),
  /** The identity the token is scoped to. `null` if that identity was since unlinked; the token can no longer authenticate. */
  identityId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
});

export type ApiTokenSummary = z.infer<typeof ApiTokenSummary>;

/** Response for `GET /api/v1/account/tokens`. */
export const ApiTokensResponse = z.object({
  items: z.array(ApiTokenSummary),
});

export type ApiTokensResponse = z.infer<typeof ApiTokensResponse>;

/**
 * Body for `POST /api/v1/account/tokens`. `identityId` defaults to the
 * account's first linked identity when omitted; `expiresInDays` omitted
 * means the token never expires.
 */
export const CreateApiTokenRequest = z.object({
  name: z.string().min(1).max(200),
  identityId: CanonicalUuid.optional(),
  expiresInDays: ApiTokenExpiresInDays.optional(),
});

export type CreateApiTokenRequest = z.infer<typeof CreateApiTokenRequest>;

/**
 * Response for `POST /api/v1/account/tokens`: the raw secret, shown to the
 * caller exactly once, plus the same summary `GET` would later return for
 * it.
 */
export const CreateApiTokenResponse = z.object({
  token: z.string(),
  item: ApiTokenSummary,
});

export type CreateApiTokenResponse = z.infer<typeof CreateApiTokenResponse>;
