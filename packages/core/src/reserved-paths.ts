import { normalizePath, splitSegments } from "./paths.ts";
import { MOVE_LAYOUT_NAMESPACE } from "./trash/recycle-folder.ts";

/**
 * The Mac app's own folder at the top of each user's files: staged uploads,
 * the versions its writes replace and its Trash.
 */
export const DESKTOP_INTERNAL_ROOT = "/.fdrive-desktop";

/** The folder installation backups are written into, under whatever folder a target names. */
export const BACKUP_FOLDER_NAME = ".fdrive-backups";

/**
 * Folder names that are fdrive's own wherever they lie, compared in any
 * case: its Trash layout, which stays put when Trash is turned off or moved,
 * and backup folders.
 */
export const RESERVED_FOLDER_NAMES: readonly string[] = [MOVE_LAYOUT_NAMESPACE, BACKUP_FOLDER_NAME];

/** True when one of `path`'s segments is a backup folder, in any case. */
export function isBackupPath(path: string): boolean {
  return splitSegments(path).some((segment) => segment.toLowerCase() === BACKUP_FOLDER_NAME);
}

/**
 * fdrive's own folders at fixed places in a user's files, canonical: the
 * Trash folder while Trash is on (`trashPath`) and the Mac app's folder.
 */
export function reservedFolders(trashPath: string | null): string[] {
  return [...(trashPath === null ? [] : [normalizePath(trashPath)]), DESKTOP_INTERNAL_ROOT];
}

/**
 * True when `path` is one of fdrive's own places in a user's files or lies
 * inside one: a folder `reservedFolders` names, or anything with a segment
 * `RESERVED_FOLDER_NAMES` names. These hold fdrive's bookkeeping, not the
 * user's files, so search, MCP and AI never show them, and links and shares
 * between users never reach them.
 */
export function isReservedPath(path: string, trashPath: string | null): boolean {
  const target = normalizePath(path);
  const named = splitSegments(target).some((segment) =>
    RESERVED_FOLDER_NAMES.includes(segment.toLowerCase()),
  );
  return (
    named ||
    reservedFolders(trashPath).some(
      (folder) => target === folder || target.startsWith(`${folder}/`),
    )
  );
}
