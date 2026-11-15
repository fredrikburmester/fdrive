import {
  StorageName,
  type SystemStorage,
  type SystemStorageUpdateRequest,
} from "@fdrive/contracts";

/** What System > General says about where the files live. */
export const LOCAL_FOLDER_NOTE = "Folder on this server, set by FDRIVE_STORAGE_ROOT.";

/** The storage name's first problem, with the API's trimming and length limits, or `null`. */
export function storageNameError(name: string): string | null {
  const parsed = StorageName.safeParse(name);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? "Enter a storage name.");
}

/**
 * The rename to send for a typed storage name, or `null` when there is
 * nothing to save: the name is invalid, or it trims to the saved one.
 */
export function storageRenamePatch(
  storage: Pick<SystemStorage, "name">,
  draft: string,
): SystemStorageUpdateRequest | null {
  if (storageNameError(draft) !== null) return null;
  const name = draft.trim();
  return name === storage.name ? null : { name };
}
