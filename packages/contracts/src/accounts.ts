import { z } from "zod";
import { FsEntry } from "./fs.ts";
import { FavoriteItem } from "./metadata.ts";
import { SearchHit } from "./search.ts";

export const AccountIdentityId = z.uuid().regex(/^[0-9a-f-]+$/);
export const LinkIdentityRequest = z.strictObject({
  username: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[^\0]+$/),
  password: z.string().min(1).max(4096),
  otp: z.string().min(1).max(32).optional(),
  /** The signed-in login's own password: linking re-authenticates the account owner. */
  currentPassword: z.string().min(1).max(4096),
  currentOtp: z.string().min(1).max(32).optional(),
});
export type LinkIdentityRequest = z.infer<typeof LinkIdentityRequest>;
/** Unlinking also re-authenticates the signed-in login; sent as the DELETE body. */
export const UnlinkIdentityRequest = LinkIdentityRequest.pick({
  currentPassword: true,
  currentOtp: true,
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
