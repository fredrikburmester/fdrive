import type { TrashSettings } from "@fdrive/contracts";
import { createRecycleFolderTrash, isStorageError, type StorageProvider } from "@fdrive/core";
import { createSftpgoStorageProvider } from "../storage/sftpgo-provider.js";
import type { ClientForIdentity } from "./provider-client.ts";
import type { TokenSource } from "./token-source.js";

export type IdentityStorageFactory = (identityId: string) => Promise<StorageProvider>;

const trashSettingsByStorage = new WeakMap<StorageProvider, TrashSettings>();

/** Returns the provider-bound Trash revision captured with this request's storage. */
export function trashSettingsForStorage(storage: StorageProvider): TrashSettings | null {
  return trashSettingsByStorage.get(storage) ?? null;
}

/**
 * True when `statFile(path)` reports `bad_request`, the convention this
 * codebase uses for "this path is a directory" (see `fs/routes.ts`'s
 * `statEntry`). Real SFTPGo has no "stat a path of unknown kind" endpoint,
 * so this is the only safe way to tell a directory from a nonexistent path
 * without calling `list` on a path that might be a file: doing that against
 * a real SFTPGo 2.7.5 server drops the connection instead of erroring.
 */
async function isExistingDirectory(storage: StorageProvider, path: string): Promise<boolean> {
  try {
    await storage.statFile(path);
    return false;
  } catch (error) {
    return isStorageError(error) && error.kind === "bad_request";
  }
}

/**
 * Wraps `storage.mkdir` so creating a directory that already exists
 * succeeds instead of throwing. Real SFTPGo 2.7.5 reports "already exists"
 * as an unhandled 500 even with `mkdir_parents: true`, which would
 * otherwise break every trash restore whose target's parent folder already
 * exists (`createRecycleFolderTrash`'s `restore` always calls
 * `mkdir(parent, { parents: true })` first). Only used to build the
 * storage `createRecycleFolderTrash` itself calls `mkdir` on; every other
 * route keeps `storage`'s own `mkdir` semantics unchanged.
 */
export function withIdempotentMkdir(storage: StorageProvider): StorageProvider {
  return {
    ...storage,
    async mkdir(path, opts) {
      try {
        await storage.mkdir(path, opts);
      } catch (error) {
        if (!isStorageError(error) || !(await isExistingDirectory(storage, path))) {
          throw error;
        }
      }
    },
  };
}

/**
 * Extends `storage` with a `trash` provider built on top of its own
 * list/move/mkdir/deleteFile/deleteDir, using the recycle-folder layout at
 * `trashPath`. Spreads `storage` into a new object so the original
 * provider is left untouched.
 */
export function withRecycleFolderTrash(
  storage: StorageProvider,
  trashPath: string,
): StorageProvider {
  return {
    ...storage,
    trash: createRecycleFolderTrash({ storage: withIdempotentMkdir(storage), trashPath }),
  };
}

/**
 * Delayed jobs retain this client; token validation can deny execution but
 * cannot retarget it. Trash settings are resolved once while constructing
 * each request's provider snapshot, so runtime changes apply without restart.
 */
export function createIdentityStorageFactory(deps: {
  clientForIdentity: ClientForIdentity;
  tokenSource: Pick<TokenSource, "withToken">;
  resolveTrashSettings?: (identityId: string) => Promise<TrashSettings>;
}): IdentityStorageFactory {
  return async (identityId) => {
    const client = await deps.clientForIdentity(identityId);
    const storage = createSftpgoStorageProvider({
      client,
      withToken: (fn) => deps.tokenSource.withToken(identityId, fn),
    });
    const settings = await deps.resolveTrashSettings?.(identityId);
    const result =
      settings?.enabled === true ? withRecycleFolderTrash(storage, settings.path) : storage;
    if (settings !== undefined) trashSettingsByStorage.set(result, settings);
    return result;
  };
}
