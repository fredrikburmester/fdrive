import type { TrashSettings } from "@fdrive/contracts";
import {
  createRecycleFolderTrash,
  isStorageError,
  type StorageProvider,
  withMoveToTrash,
} from "@fdrive/core";
import type { IdentityRepo } from "@fdrive/db";
import { captureRecycleReceipt } from "../activity/trash.js";
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

/** Runs `fn`, turning a `StorageError` into the `ApiHttpError` of the same kind. */
async function asHttp<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isStorageError(error)) throw new ApiHttpError(error.kind, error.message);
    throw error;
  }
}

/** What the factory needs of the files folder (`FilesFolder`). */
export interface StorageSource {
  storage(username: string): StorageProvider;
  admit(username: string): Promise<void>;
}

export interface CreateStorageFactoryDeps {
  readonly identities: Pick<IdentityRepo, "get">;
  readonly folder: StorageSource;
  readonly clock: () => Date;
  /** With it, deletes move into the Trash folder while Trash is on. */
  readonly resolveTrashSettings?: (identityId: string) => Promise<TrashSettings>;
}

/**
 * Builds the per-request `StorageProvider` for an identity: its home in the
 * files folder, once the folder admits its user (a user disabled since
 * signing in gets `forbidden`). Delayed jobs retain the result; token
 * validation can deny execution but never retarget it. Trash settings are resolved once per request's storage, so
 * runtime changes apply without restart: with Trash on, the storage gets
 * the move-to-trash wrapper underneath the recycle folder view.
 */
export function createIdentityStorageFactory(
  deps: CreateStorageFactoryDeps,
): IdentityStorageFactory {
  return async (identityId) => {
    const identity = await deps.identities.get(identityId);
    if (identity === null) throw new ApiHttpError("unauthorized", "sign in again");
    const username = identity.externalUsername;
    await asHttp(() => deps.folder.admit(username));
    const storage = await asHttp(() => deps.folder.storage(username));
    const settings = await deps.resolveTrashSettings?.(identityId);
    let result = storage;
    if (settings?.enabled === true) {
      const moving = withMoveToTrash({
        storage,
        trashPath: settings.path,
        clock: deps.clock,
        onRecycled: captureRecycleReceipt,
      });
      result = withRecycleFolderTrash(moving, settings.path);
    }
    if (settings !== undefined) trashSettingsByStorage.set(result, settings);
    return result;
  };
}
