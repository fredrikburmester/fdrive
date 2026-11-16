import { z } from "zod";
import { StorageLimit } from "./users.ts";

/** The installation's name for its storage, shown under each username and in Finder. */
export const StorageName = z
  .string()
  .trim()
  .min(1, "Enter a name for this storage.")
  .max(120, "Use 120 characters or fewer for the storage name.");

/** The `app.settings` key of the storage name; unset means `DEFAULT_STORAGE_NAME`. */
export const STORAGE_NAME_SETTINGS_KEY = "storage.name";

export const DEFAULT_STORAGE_NAME = "Local folder";

/** `GET /api/v1/system/storage`: the files folder as System > General shows it. */
export const SystemStorage = z.object({
  name: z.string(),
  /** Whether fdrive can use the folder now: this installation's, readable, writable and enterable. */
  healthy: z.boolean(),
  /** What the check found: why fdrive cannot use the folder, or that it can. */
  detail: z.string(),
});
export type SystemStorage = z.infer<typeof SystemStorage>;

/** `PATCH /api/v1/system/storage`: rename the storage. */
export const SystemStorageUpdateRequest = z.strictObject({ name: StorageName });
export type SystemStorageUpdateRequest = z.infer<typeof SystemStorageUpdateRequest>;

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
