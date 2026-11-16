import { normalizePath } from "./paths.ts";

/** fdrive's Trash, always at the top of each user's files. */
export const TRASH_PATH = "/.trash";

/** The Mac app's own folder at the top of each user's files, where its writes stage what they publish. */
export const DESKTOP_INTERNAL_ROOT = "/.fdrive-desktop";

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
 * inside one: a folder `RESERVED_FOLDERS` names, in any case, since a disk
 * that ignores case finds them under any spelling. These hold fdrive's
 * bookkeeping, not the user's files, so search, MCP and AI never show them,
 * and links and shares between users never reach them.
 */
export function isReservedPath(path: string): boolean {
  const target = normalizePath(path).toLowerCase();
  return RESERVED_FOLDERS.some((folder) => isAtOrUnder(folder, target));
}
