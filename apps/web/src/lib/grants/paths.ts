import type { FsEntry, ReceivedGrant } from "@fdrive/contracts";
import { isRoot } from "@fdrive/core";

/**
 * Where folders other people share with this login appear in its files. The
 * folder exists only while something is shared with it.
 */
export const SHARED_WITH_ME_PATH = "/Shared with me";

const SHARED_PREFIX = `${SHARED_WITH_ME_PATH}/`;

/** True for `/Shared with me` and anything inside it. */
export function isUnderSharedWithMe(path: string): boolean {
  return path === SHARED_WITH_ME_PATH || path.startsWith(SHARED_PREFIX);
}

/**
 * True for `/Shared with me` itself and the shared folders directly in it:
 * only their owners rename, move or delete them.
 */
export function isPinnedSharedPath(path: string): boolean {
  if (path === SHARED_WITH_ME_PATH) return true;
  return path.startsWith(SHARED_PREFIX) && !path.slice(SHARED_PREFIX.length).includes("/");
}

/** The folder shared with this login that `path` is, or lies inside; `undefined` for its own files. */
export function receivedGrantFor(
  path: string,
  received: readonly ReceivedGrant[],
): ReceivedGrant | undefined {
  return received.find((grant) => path === grant.path || path.startsWith(`${grant.path}/`));
}

/**
 * Whether "Share with people" applies: a folder of this login's own, never
 * all of its files and never something already shared with it.
 */
export function canShareWithPeople(entry: Pick<FsEntry, "kind" | "path">): boolean {
  return entry.kind === "dir" && !isRoot(entry.path) && !isUnderSharedWithMe(entry.path);
}

/**
 * Why nothing can be added to `folder`, or `null` when it can: `Shared with
 * me` holds only what others share, and a folder shared to view belongs to
 * its owner.
 */
export function folderWriteBlock(
  folder: string,
  received: readonly ReceivedGrant[],
): string | null {
  if (folder === SHARED_WITH_ME_PATH) return "Only folders others share with you appear here.";
  const grant = receivedGrantFor(folder, received);
  return grant?.access === "read"
    ? `${grant.owner} shares this folder with you to view only.`
    : null;
}

/**
 * Why `path` cannot be renamed, moved, duplicated or deleted, or `null`
 * when it can: `Shared with me` and the folders in it belong to their
 * owners, and so does everything in a folder shared to view.
 */
export function lockedReason(path: string, received: readonly ReceivedGrant[]): string | null {
  if (path === SHARED_WITH_ME_PATH) return "Shared with me only lists what others share with you.";
  if (isPinnedSharedPath(path)) return "Only its owner can rename, move or delete a shared folder.";
  const grant = receivedGrantFor(path, received);
  return grant?.access === "read"
    ? `${grant.owner} shares this folder with you to view only.`
    : null;
}

/** The first reason one of `paths` cannot be renamed, moved or deleted, or `null`. */
export function firstLockedReason(
  paths: readonly string[],
  received: readonly ReceivedGrant[],
): string | null {
  for (const path of paths) {
    const reason = lockedReason(path, received);
    if (reason !== null) return reason;
  }
  return null;
}

/**
 * Why dropping `paths` onto the folder `target` would be refused, or `null`
 * when it would not: nothing goes into a folder that takes nothing, and a
 * move takes its sources out of where they are.
 */
export function dropBlock(
  paths: readonly string[],
  target: string,
  effect: "move" | "copy",
  received: readonly ReceivedGrant[],
): string | null {
  return (
    folderWriteBlock(target, received) ??
    (effect === "move" ? firstLockedReason(paths, received) : null)
  );
}

/** What the file browser may offer for one entry, given what is shared with this login. */
export interface EntryRestrictions {
  /** "Share with people" applies to it. */
  readonly shareWithPeople: boolean;
  /** A public link may include it; links never reach into `Shared with me`. */
  readonly publicLink: boolean;
  /** The shared folder this entry is, for "Leave"; `null` for anything else. */
  readonly leave: ReceivedGrant | null;
  /** Why rename, move, delete and duplicate would be refused; `null` when they would not. */
  readonly locked: string | null;
}

export function entryRestrictions(
  entry: Pick<FsEntry, "kind" | "path">,
  received: readonly ReceivedGrant[],
): EntryRestrictions {
  const grant = receivedGrantFor(entry.path, received);
  return {
    shareWithPeople: canShareWithPeople(entry),
    publicLink: !isUnderSharedWithMe(entry.path),
    leave: grant !== undefined && grant.path === entry.path ? grant : null,
    locked: lockedReason(entry.path, received),
  };
}
