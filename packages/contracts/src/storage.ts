import { z } from "zod";
import { StorageLimit } from "./users.ts";

/** What the Storage page splits a folder's bytes into, by each file's extension. */
export const StorageKind = z.enum(["images", "videos", "documents", "audio", "other"]);
export type StorageKind = z.infer<typeof StorageKind>;

/** One file the Storage page lists, at the signed-in login's own path. */
export const StorageFile = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  modifiedAt: z.iso.datetime(),
});
export type StorageFile = z.infer<typeof StorageFile>;

/** Identical files (same size and content hash) at the signed-in login's own paths. */
export const StorageDuplicates = z.object({
  /** The size of each copy. */
  size: z.number().int().positive(),
  paths: z.array(z.string()).min(2),
});
export type StorageDuplicates = z.infer<typeof StorageDuplicates>;

/**
 * `GET /api/v1/storage`: how much the signed-in login's own folder holds, as
 * the search index counts it. `indexed` is false when its folder is not
 * indexed, and every number is then zero.
 */
export const StorageUsageResponse = z.object({
  indexed: z.boolean(),
  /** Every byte in the folder, its Trash included. */
  used: z.number().int().nonnegative(),
  /** The most bytes the folder may hold, or `null` for no limit. */
  limit: StorageLimit.nullable(),
  /** Bytes per kind, every kind once, in `StorageKind`'s order. */
  kinds: z.array(z.object({ kind: StorageKind, bytes: z.number().int().nonnegative() })),
  /** The largest files, largest first, leaving out fdrive's own folders. */
  largest: z.array(StorageFile),
  /** Groups of identical files, most wasted space first, leaving out fdrive's own folders. */
  duplicates: z.array(StorageDuplicates),
});
export type StorageUsageResponse = z.infer<typeof StorageUsageResponse>;
