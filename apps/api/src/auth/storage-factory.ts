import {
  createRecycleFolderTrash,
  isStorageError,
  type StorageProvider,
  TRASH_PATH,
  withMoveToTrash,
} from "@fdrive/core";
import type { IdentityRepo } from "@fdrive/db";
import { captureRecycleReceipt } from "../activity/trash.js";
import { ApiHttpError } from "../errors.js";

export type IdentityStorageFactory = (identityId: string) => Promise<StorageProvider>;

/** Turns a `StorageError` into the `ApiHttpError` of the same kind. */
function asHttp(error: unknown): unknown {
  return isStorageError(error) ? new ApiHttpError(error.kind, error.message) : error;
}

/** What the factory needs of the files folder (`FilesFolder`). */
export interface StorageSource {
  storage(username: string): StorageProvider;
  admit(username: string): Promise<void>;
}

/**
 * `username`'s storage: their home in the files folder, whose deletes move
 * into their Trash at `TRASH_PATH` (`withMoveToTrash`), with the Trash view
 * over it (`createRecycleFolderTrash`). With `trash` false deletes are
 * real, for fdrive's own bookkeeping. Reads nothing: whoever asks has
 * already admitted the user. Throws `forbidden` for a name that cannot be a
 * home folder.
 */
export function buildUserStorage(
  folder: Pick<StorageSource, "storage">,
  clock: () => Date,
  username: string,
  trash = true,
): StorageProvider {
  let storage: StorageProvider;
  try {
    storage = folder.storage(username);
  } catch (error) {
    throw asHttp(error);
  }
  if (!trash) return storage;
  const moving = withMoveToTrash({
    storage,
    trashPath: TRASH_PATH,
    clock,
    onRecycled: captureRecycleReceipt,
  });
  return { ...moving, trash: createRecycleFolderTrash({ storage: moving, trashPath: TRASH_PATH }) };
}

export interface CreateStorageFactoryDeps {
  readonly identities: Pick<IdentityRepo, "get">;
  readonly folder: StorageSource;
  readonly clock: () => Date;
  /**
   * Deletes are real instead of moving into Trash: for fdrive's own
   * bookkeeping (the Mac's staged files) and Trash's own retention.
   */
  readonly withoutTrash?: boolean;
}

/**
 * Builds an identity's `StorageProvider` outside a signed-in request (a
 * share link's owner, the indexer's events, Office, the Mac's bookkeeping):
 * `buildUserStorage`, once the folder admits its user (a disabled or removed
 * user gets `forbidden`). Delayed jobs retain the result; token validation
 * can deny execution but never retarget it. A signed-in request has its
 * storage from its principal instead (`createPrincipalFactory`).
 */
export function createIdentityStorageFactory(
  deps: CreateStorageFactoryDeps,
): IdentityStorageFactory {
  return async (identityId) => {
    const identity = await deps.identities.get(identityId);
    if (identity === null) throw new ApiHttpError("unauthorized", "sign in again");
    const username = identity.externalUsername;
    try {
      await deps.folder.admit(username);
    } catch (error) {
      throw asHttp(error);
    }
    return buildUserStorage(deps.folder, deps.clock, username, deps.withoutTrash !== true);
  };
}
