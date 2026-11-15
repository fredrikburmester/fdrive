import type { IdentityStorageFactory } from "../auth/storage-factory.ts";
import { WopiError } from "./errors.ts";
import type { OfficeDeps } from "./types.ts";

/**
 * Office's storage for a login, built before any write transaction is
 * acquired. A login whose storage cannot be built is a 401 to the editor.
 */
export function createOfficeStorageFactory(
  storage: IdentityStorageFactory,
): OfficeDeps["storageFactory"] {
  return async (identityId) => {
    try {
      return await storage(identityId);
    } catch {
      throw new WopiError(401);
    }
  };
}
