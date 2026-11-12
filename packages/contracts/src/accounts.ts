import { z } from "zod";
import { CanonicalUuid } from "./canonical-uuid.ts";
import { FavoriteItem } from "./metadata.ts";
import { ProviderFieldValues } from "./providers.ts";

export const AccountIdentityId = CanonicalUuid;
/**
 * Body for `POST /api/v1/account/identities`. `credential` holds the new
 * login's values for its provider's `credentialFields`; `currentCredential`
 * re-proves the signed-in login (its password and one-time code when its
 * provider demands one, never its username) because linking plants a
 * durable login path on the account.
 */
export const LinkIdentityRequest = z.strictObject({
  providerId: CanonicalUuid.optional(),
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
