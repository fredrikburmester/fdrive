import { z } from "zod";
import { FsEntry } from "./fs.ts";
import { FavoriteItem } from "./metadata.ts";
import { ProviderFieldValues } from "./providers.ts";
import { SearchHit } from "./search.ts";

export const AccountIdentityId = z.uuid().regex(/^[0-9a-f-]+$/);
/**
 * Body for `POST /api/v1/account/identities`. `credential` holds the new
 * login's values for its provider's `credentialFields`; `currentCredential`
 * re-proves the signed-in login (its password and one-time code when its
 * provider demands one, never its username) because linking plants a
 * durable login path on the account.
 */
export const LinkIdentityRequest = z.strictObject({
  providerId: z.uuid().optional(),
  credential: ProviderFieldValues,
  currentCredential: ProviderFieldValues,
});
export type LinkIdentityRequest = z.infer<typeof LinkIdentityRequest>;
/** Unlinking also re-authenticates the signed-in login; sent as the DELETE body. */
export const UnlinkIdentityRequest = LinkIdentityRequest.pick({
  currentCredential: true,
});
export type UnlinkIdentityRequest = z.infer<typeof UnlinkIdentityRequest>;
export const SwitchIdentityRequest = z.strictObject({ identityId: AccountIdentityId });
export type SwitchIdentityRequest = z.infer<typeof SwitchIdentityRequest>;
export const AccountFavoriteItem = FavoriteItem.extend({ identityId: AccountIdentityId });
export type AccountFavoriteItem = z.infer<typeof AccountFavoriteItem>;
export const AccountFavoritesResponse = z.object({
  items: z.array(AccountFavoriteItem).max(1000),
  unavailableIdentityIds: z.array(AccountIdentityId),
});
export type AccountFavoritesResponse = z.infer<typeof AccountFavoritesResponse>;
export const AccountSearchResponse = z.object({
  query: z.string(),
  sections: z.object({
    folders: z.array(FsEntry.extend({ identityId: AccountIdentityId })).max(50),
    files: z.array(SearchHit.extend({ identityId: AccountIdentityId })).max(50),
    content: z.array(SearchHit.extend({ identityId: AccountIdentityId })).max(50),
  }),
  degraded: z.boolean(),
  unavailable: z.boolean(),
  tookMs: z.number().int().min(0),
  unavailableIdentityIds: z.array(AccountIdentityId),
});
export type AccountSearchResponse = z.infer<typeof AccountSearchResponse>;
