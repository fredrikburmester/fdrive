import type { TrashSettings } from "@fdrive/contracts";
import {
  createRecycleFolderTrash,
  isStorageError,
  type ProviderInstance,
  type ProviderModule,
  type StorageProvider,
  withMoveToTrash,
} from "@fdrive/core";
import { captureRecycleReceipt } from "../activity/trash.js";
import { withoutBackupPaths } from "../backups/reserved-storage.js";
import { ApiHttpError } from "../errors.js";
import type { ProviderService } from "../providers/service.js";

export type IdentityStorageFactory = (identityId: string) => Promise<StorageProvider>;

/**
 * Storage for `identityId` bound to `providerId`, resolved up front: for
 * callers that must not touch the database again while they hold a write
 * transaction (Office).
 */
export type PinnedStorageFactory = (
  identityId: string,
  providerId: string,
) => Promise<StorageProvider>;

const trashSettingsByStorage = new WeakMap<StorageProvider, TrashSettings>();

/** Returns the provider-bound Trash revision captured with this request's storage. */
export function trashSettingsForStorage(storage: StorageProvider): TrashSettings | null {
  return trashSettingsByStorage.get(storage) ?? null;
}

/**
 * Wraps `storage.mkdir` so creating a directory that already exists
 * succeeds instead of throwing, for callers that may race another request
 * to the same folder. Every other error, and an existing file at the path,
 * still throws.
 */
export function withIdempotentMkdir(storage: StorageProvider): StorageProvider {
  return {
    ...storage,
    async mkdir(path, opts) {
      try {
        await storage.mkdir(path, opts);
      } catch (error) {
        if (!isStorageError(error)) {
          throw error;
        }
        const existing = await storage.stat(path).catch(() => null);
        if (existing?.kind !== "dir") {
          throw error;
        }
      }
    },
  };
}

/**
 * Extends `storage` with a `trash` provider built on top of its own
 * list/stat/move/mkdir/deleteFile/deleteDir, reading the leaves
 * `withMoveToTrash` writes under `trashPath`. Spreads `storage` into a new
 * object so the original provider is left untouched.
 */
export function withRecycleFolderTrash(
  storage: StorageProvider,
  trashPath: string,
): StorageProvider {
  return { ...storage, trash: createRecycleFolderTrash({ storage, trashPath }) };
}

/**
 * Storage for an identity whose provider cannot be used right now (an admin
 * disabled it, or its row is gone): every call rejects with `error`, and
 * there is no trash. The session itself stays valid, so `/auth/me`,
 * logout, switching to another login and the admin routes keep working
 * while only file operations fail.
 */
export function unavailableStorage(error: Error): StorageProvider {
  const fail = (): Promise<never> => Promise.reject(error);
  return {
    list: fail,
    stat: fail,
    statFile: fail,
    download: fail,
    upload: fail,
    mkdir: fail,
    move: fail,
    copy: fail,
    deleteFile: fail,
    deleteDir: fail,
  };
}

/**
 * Asks the module whether the login is still let in (a local user an
 * administrator disabled is not), as `forbidden`, before any storage is built.
 */
async function admit(
  module: ProviderModule,
  instance: ProviderInstance,
  externalUsername: string,
): Promise<void> {
  if (module.admit === undefined) return;
  try {
    await module.admit(instance, externalUsername);
  } catch (error) {
    if (isStorageError(error)) throw new ApiHttpError(error.kind, error.message);
    throw error;
  }
}

export interface CreateStorageFactoryDeps {
  readonly providers: Pick<ProviderService, "forIdentity">;
  readonly fetch: typeof globalThis.fetch;
  readonly clock: () => Date;
  readonly resolveTrashSettings?: (identityId: string) => Promise<TrashSettings>;
}

/**
 * Builds the per-request `StorageProvider` for an identity through its
 * provider module. Delayed jobs retain the result; token validation can
 * deny execution but never retarget it, because the module only ever sees
 * the provider row the identity is bound to. Trash settings are resolved
 * once while constructing each request's provider snapshot, so runtime
 * changes apply without restart: with Trash on, a module with Trash
 * (`trash: "move"`) gets the move-to-trash wrapper underneath the recycle
 * folder view.
 */
export function createIdentityStorageFactory(
  deps: CreateStorageFactoryDeps,
): IdentityStorageFactory {
  return async (identityId) => {
    const { identity, module, instance } = await deps.providers.forIdentity(identityId);
    await admit(module, instance, identity.externalUsername);
    const storage = withoutBackupPaths(
      module.createStorage(
        instance,
        { externalUsername: identity.externalUsername },
        { fetch: deps.fetch },
      ),
    );
    const settings = await deps.resolveTrashSettings?.(identityId);
    let result = storage;
    if (settings?.enabled === true && module.trash === "move") {
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

/**
 * Builds storage for an identity bound to `providerId`. Throws when the
 * identity is not bound to it.
 */
export function createPinnedStorageFactory(
  deps: Omit<CreateStorageFactoryDeps, "resolveTrashSettings" | "clock">,
): PinnedStorageFactory {
  return async (identityId, providerId) => {
    const { identity, provider, module, instance } = await deps.providers.forIdentity(identityId);
    if (provider.id !== providerId) {
      throw new Error("identity is not bound to the requested provider");
    }
    await admit(module, instance, identity.externalUsername);
    return withoutBackupPaths(
      module.createStorage(
        instance,
        { externalUsername: identity.externalUsername },
        { fetch: deps.fetch },
      ),
    );
  };
}
