import { isStorageError, type StorageProvider } from "@fdrive/core";
import type { IdentityRepo } from "@fdrive/db";
import { ApiHttpError } from "../errors.js";

export type IdentityStorageFactory = (identityId: string) => Promise<StorageProvider>;

/** Turns a `StorageError` into the `ApiHttpError` of the same kind. */
function asHttp(error: unknown): unknown {
  return isStorageError(error) ? new ApiHttpError(error.kind, error.message) : error;
}

/** What the factory needs of the files folder (`FilesFolder`), whose storage is `S`. */
export interface StorageSource<S extends StorageProvider = StorageProvider> {
  storage(username: string): S;
  admit(username: string): Promise<void>;
}

/**
 * `username`'s storage: their home in the files folder, with its Trash.
 * Reads nothing: whoever asks has already admitted the user. Throws
 * `forbidden` for a name that cannot be a home folder.
 */
export function buildUserStorage<S extends StorageProvider>(
  folder: Pick<StorageSource<S>, "storage">,
  username: string,
): S {
  try {
    return folder.storage(username);
  } catch (error) {
    throw asHttp(error);
  }
}

export interface CreateStorageFactoryDeps<S extends StorageProvider = StorageProvider> {
  readonly identities: Pick<IdentityRepo, "get">;
  readonly folder: StorageSource<S>;
}

/**
 * Builds an identity's `StorageProvider` outside a signed-in request (a
 * share link's owner, the indexer's events, Office, the Mac's bookkeeping,
 * Trash retention): `buildUserStorage`, once the folder admits its user (a
 * disabled or removed user gets `forbidden`). Delayed jobs retain the
 * result; token validation can deny execution but never retarget it. A
 * signed-in request has its storage from its principal instead
 * (`createPrincipalFactory`).
 */
export function createIdentityStorageFactory<S extends StorageProvider>(
  deps: CreateStorageFactoryDeps<S>,
): (identityId: string) => Promise<S> {
  return async (identityId) => {
    const identity = await deps.identities.get(identityId);
    if (identity === null) throw new ApiHttpError("unauthorized", "sign in again");
    const username = identity.username;
    try {
      await deps.folder.admit(username);
    } catch (error) {
      throw asHttp(error);
    }
    return buildUserStorage(deps.folder, username);
  };
}
