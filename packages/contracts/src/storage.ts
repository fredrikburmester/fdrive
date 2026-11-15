import { z } from "zod";

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
  /** The files folder's row in `app.providers`, which Trash settings and Office name. */
  id: z.uuid(),
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
