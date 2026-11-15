import type { TrashSettings } from "@fdrive/contracts";
import {
  createRecycleFolderTrash,
  isStorageError,
  type StorageProvider,
  withMoveToTrash,
} from "@fdrive/core";
import type { IdentityRepo } from "@fdrive/db";
import { captureRecycleReceipt } from "../activity/trash.js";
import { withoutBackupPaths } from "../backups/reserved-storage.js";
import { ApiHttpError } from "../errors.js";

export type IdentityStorageFactory = (identityId: string) => Promise<StorageProvider>;

const trashSettingsByStorage = new WeakMap<StorageProvider, TrashSettings>();

/** Returns the provider-bound Trash revision captured with this request's storage. */
export function trashSettingsForStorage(storage: StorageProvider): TrashSettings | null {
  return trashSettingsByStorage.get(storage) ?? null;
}

/**
 * Extends `storage` with a `trash` provider built on top of its own
 * list/stat/move/mkdir/deleteFile/deleteDir/deleteEmptyDir, reading the leaves
 * `withMoveToTrash` writes under `trashPath`. Spreads `storage` into a new
 * object so the original provider is left untouched.
 */
export function withRecycleFolderTrash(
  storage: StorageProvider,
  trashPath: string,
): StorageProvider {
  return { ...storage, trash: createRecycleFolderTrash({ storage, trashPath }) };
}

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
 * `username`'s storage: their home in the files folder, without the backup
 * namespace, and with `settings` (when given) recorded for the request. With
 * Trash on, the storage gets the move-to-trash wrapper underneath the
 * recycle folder view. Reads nothing: whoever asks has already admitted the
 * user. Throws `forbidden` for a name that cannot be a home folder.
 */
export function buildUserStorage(
  folder: Pick<StorageSource, "storage">,
  clock: () => Date,
  username: string,
  settings?: TrashSettings,
): StorageProvider {
  let storage: StorageProvider;
  try {
    storage = withoutBackupPaths(folder.storage(username));
  } catch (error) {
    throw asHttp(error);
  }
  let result = storage;
  if (settings?.enabled === true) {
    const moving = withMoveToTrash({
      storage,
      trashPath: settings.path,
      clock,
      onRecycled: captureRecycleReceipt,
    });
    result = withRecycleFolderTrash(moving, settings.path);
  }
  if (settings !== undefined) trashSettingsByStorage.set(result, settings);
  return result;
}

export interface CreateStorageFactoryDeps {
  readonly identities: Pick<IdentityRepo, "get">;
  readonly folder: StorageSource;
  readonly clock: () => Date;
  /** With it, deletes move into the Trash folder while Trash is on. */
  readonly resolveTrashSettings?: (identityId: string) => Promise<TrashSettings>;
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
    const settings = await deps.resolveTrashSettings?.(identityId);
    return buildUserStorage(deps.folder, deps.clock, username, settings);
  };
}
