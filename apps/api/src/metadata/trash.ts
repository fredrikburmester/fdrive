import type { TrashedItem } from "@fdrive/core";
import type { MetadataService } from "./service.js";

/**
 * Where `path`, a login's own path, lies in its owner's files: in a folder
 * shared with the login, the owner's login and path; anywhere else, the
 * login's own (`LocalGrantService.ownerPath`).
 */
export type OwnerPath = (
  identityId: string,
  path: string,
) => Promise<{ identityId: string; path: string }>;

/**
 * Brings what is kept by path along after `identityId` moved `path` to Trash
 * (`TrashProvider.put`): it is a move to the leaf, in the files that hold
 * the item. That is the login's own Trash, or, for an item in a folder shared
 * with the login, its owner's, so the owner's tags, favorites, folder views
 * and the rest follow it there; the login's own at the path it can no longer
 * reach end. A new item at the old path inherits nothing, and a restore, a
 * move back, brings it all back. What grants access went with the item in
 * its own transaction already (`files/access.ts`, a Mac write's receipt).
 */
export async function followIntoTrash(
  metadata: Pick<MetadataService, "onMoved" | "onDeleted">,
  ownerPath: OwnerPath | undefined,
  identityId: string,
  path: string,
  moved: TrashedItem,
): Promise<void> {
  const owned = (await ownerPath?.(identityId, path)) ?? { identityId, path };
  const isDir = moved.kind === "dir";
  await metadata.onMoved(owned.identityId, owned.path, moved.leaf, isDir);
  // After the owner's move, so what follows by owner path has already gone with the item.
  if (owned.identityId !== identityId) await metadata.onDeleted(identityId, path, isDir);
}
