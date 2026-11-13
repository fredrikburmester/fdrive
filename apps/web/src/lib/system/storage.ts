import {
  type AdminProvider,
  type AdminProviderUpdateRequest,
  ProviderName,
} from "@fdrive/contracts";

/** What System > General says about where the files live. */
export const LOCAL_FOLDER_NOTE = "Folder on this server, set by FDRIVE_STORAGE_ROOT.";

/** Said on System > General when the admin view's probe could not reach the folder. */
export const STORAGE_UNREACHABLE_NOTE =
  "fdrive can't reach this folder. Check that FDRIVE_STORAGE_ROOT exists and is writable.";

/** Said on System > General when the deployment serves no folder at all. */
export const STORAGE_MISSING_NOTE =
  "This installation has no files folder. Set FDRIVE_STORAGE_ROOT and restart fdrive.";

/** The storage name's first problem, with the API's trimming and length limits, or `null`. */
export function providerNameError(label: string): string | null {
  const parsed = ProviderName.safeParse(label);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? "Enter a storage name.");
}

/**
 * The rename to send for a typed storage name, or `null` when there is
 * nothing to save: the name is invalid, or it trims to the saved one.
 */
export function storageRenamePatch(
  provider: Pick<AdminProvider, "label">,
  draft: string,
): AdminProviderUpdateRequest | null {
  if (providerNameError(draft) !== null) return null;
  const label = draft.trim();
  return label === provider.label ? null : { label };
}
