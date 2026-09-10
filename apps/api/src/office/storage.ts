import type { PinnedStorageFactory } from "../auth/storage-factory.ts";
import { WopiError } from "./errors.ts";
import type { OfficeDeps } from "./types.ts";

/**
 * Resolves database-backed credentials before any write transaction is
 * acquired: the pinned factory fetches the upstream token up front and the
 * resulting storage never refreshes it, so a token refresh happens on the
 * next request, never while a SQL write scope holds a connection. Any
 * failure to bind the identity to `providerId` is a 401 to the editor.
 */
export function createOfficeStorageFactory(deps: {
  pinned: PinnedStorageFactory;
}): OfficeDeps["storageFactory"] {
  return async (identityId, providerId) => {
    try {
      return await deps.pinned(identityId, providerId);
    } catch {
      throw new WopiError(401);
    }
  };
}
