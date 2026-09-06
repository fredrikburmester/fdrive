import { z } from "zod";

/**
 * A tag an account can attach to files and folders. Tags are per-account,
 * shared across every identity the account has linked.
 */
export const Tag = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable(),
});

export type Tag = z.infer<typeof Tag>;

export const TagsResponse = z.object({
  tags: z.array(Tag),
});

export type TagsResponse = z.infer<typeof TagsResponse>;

export const CreateTagRequest = z.object({
  name: z.string().min(1).max(100),
  color: z.string().nullable().optional(),
});

export type CreateTagRequest = z.infer<typeof CreateTagRequest>;

export const UpdateTagRequest = z.object({
  name: z.string().min(1).max(100).optional(),
  color: z.string().nullable().optional(),
});

export type UpdateTagRequest = z.infer<typeof UpdateTagRequest>;

/** Every path (for the caller's active identity) assigned a given tag. */
export const TagFilesResponse = z.object({
  paths: z.array(z.string()),
});

export type TagFilesResponse = z.infer<typeof TagFilesResponse>;

/** Replaces the full set of tags on `path` with `tagIds`. */
export const SetFileTagsRequest = z.object({
  path: z.string(),
  tagIds: z.array(z.string()),
});

export type SetFileTagsRequest = z.infer<typeof SetFileTagsRequest>;

export const FavoriteKind = z.enum(["file", "dir"]);

export type FavoriteKind = z.infer<typeof FavoriteKind>;

export const FavoriteItem = z.object({
  path: z.string(),
  kind: FavoriteKind,
  addedAt: z.iso.datetime(),
});

export type FavoriteItem = z.infer<typeof FavoriteItem>;

export const FavoritesResponse = z.object({
  items: z.array(FavoriteItem),
});

export type FavoritesResponse = z.infer<typeof FavoritesResponse>;

/** Body for `POST /favorites` (add) and `DELETE /favorites` (remove); the kind is discovered server-side by stat'ing `path`. */
export const FavoriteRequest = z.object({
  path: z.string(),
});

export type FavoriteRequest = z.infer<typeof FavoriteRequest>;

export const RecentItem = z.object({
  path: z.string(),
  openedAt: z.iso.datetime(),
});

export type RecentItem = z.infer<typeof RecentItem>;

export const RecentsResponse = z.object({
  items: z.array(RecentItem),
});

export type RecentsResponse = z.infer<typeof RecentsResponse>;

export const RecentTouchRequest = z.object({
  path: z.string(),
});

export type RecentTouchRequest = z.infer<typeof RecentTouchRequest>;
