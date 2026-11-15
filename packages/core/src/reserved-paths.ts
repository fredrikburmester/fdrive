import { normalizePath, splitSegments } from "./paths.ts";

/** fdrive's Trash, always at the top of each user's files. */
export const TRASH_PATH = "/.trash";

/**
 * The Mac app's own folder at the top of each user's files: staged uploads,
 * the versions its writes replace and its Trash.
 */
export const DESKTOP_INTERNAL_ROOT = "/.fdrive-desktop";

/**
 * The folder Trash kept its items in before each had a folder of its own,
 * `<trash>/.fdrive-move-v1/<kind>/p/<segment>/…/v/<timestamp>`. The API moves
 * what `/.trash` still holds there into Trash when it starts; an earlier
 * Trash folder elsewhere may have left one too. It stays reserved until that
 * start-up move goes.
 */
export const OLD_TRASH_LAYOUT = ".fdrive-move-v1";

/**
 * Folder names that are fdrive's own wherever they lie, compared in any
 * case: Trash's old layout, which stays fdrive's wherever it was left.
 */
export const RESERVED_FOLDER_NAMES: readonly string[] = [OLD_TRASH_LAYOUT];

/** fdrive's own folders at fixed places in a user's files: the Trash and the Mac app's folder. */
export const RESERVED_FOLDERS: readonly string[] = [TRASH_PATH, DESKTOP_INTERNAL_ROOT];

/** True when `path` is `folder` or lies inside it; both are normalized first. */
export function isAtOrUnder(folder: string, path: string): boolean {
  const target = normalizePath(path);
  const root = normalizePath(folder);
  return root === "/" || target === root || target.startsWith(`${root}/`);
}

/**
 * True when `path` is one of fdrive's own places in a user's files or lies
 * inside one: a folder `RESERVED_FOLDERS` names, or anything with a segment
 * `RESERVED_FOLDER_NAMES` names, all in any case, since a disk that ignores
 * case finds them under any spelling. These hold fdrive's bookkeeping, not
 * the user's files, so search, MCP and AI never show them, and links and
 * shares between users never reach them.
 */
export function isReservedPath(path: string): boolean {
  const target = normalizePath(path).toLowerCase();
  const named = splitSegments(target).some((segment) => RESERVED_FOLDER_NAMES.includes(segment));
  return named || RESERVED_FOLDERS.some((folder) => isAtOrUnder(folder, target));
}
