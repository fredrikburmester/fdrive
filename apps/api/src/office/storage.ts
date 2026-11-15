import type { IdentityStorageFactory } from "../auth/storage-factory.ts";
import { WopiError } from "./errors.ts";
import type { OfficeDeps } from "./types.ts";

/**
 * Office's storage for a document's owner, built before any write
 * transaction is acquired. A document keyed by another provider row than
 * the files folder's, or an owner whose storage cannot be built, is a 401
 * to the editor.
 */
export function createOfficeStorageFactory(deps: {
  storageId: string;
  storage: IdentityStorageFactory;
}): OfficeDeps["storageFactory"] {
  return async (identityId, providerId) => {
    if (providerId !== deps.storageId) throw new WopiError(401);
    try {
      return await deps.storage(identityId);
    } catch {
      throw new WopiError(401);
    }
  };
}
