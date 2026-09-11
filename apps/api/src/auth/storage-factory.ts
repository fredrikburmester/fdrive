import type { TrashSettings } from "@fdrive/contracts";
import {
  createRecycleFolderTrash,
  isStorageError,
  type RecycleFolderLayout,
  type StorageProvider,
  withMoveToTrash,
} from "@fdrive/core";
import type { ProviderService } from "../providers/service.js";
import type { TokenSource } from "./token-source.js";

export type IdentityStorageFactory = (identityId: string) => Promise<StorageProvider>;

/**
 * Storage for `identityId` bound to `providerId`, with its upstream token
 * resolved up front and never refreshed: for callers that must not touch
 * the database again while they hold a write transaction (Office).
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
 * list/stat/move/mkdir/deleteFile/deleteDir, using the recycle-folder layout at
 * `trashPath`. Spreads `storage` into a new object so the original
 * provider is left untouched.
 */
export function withRecycleFolderTrash(
  storage: StorageProvider,
  trashPath: string,
  layout: RecycleFolderLayout = "native",
): StorageProvider {
  return {
    ...storage,
    trash: createRecycleFolderTrash({ storage: withIdempotentMkdir(storage), trashPath, layout }),
  };
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

export interface CreateStorageFactoryDeps {
  readonly providers: Pick<ProviderService, "forIdentity">;
  readonly tokenSource: Pick<TokenSource, "sessionFor" | "get" | "credential">;
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
 * changes apply without restart: a provider whose module moves deleted
 * files itself (`trash: "move"`) gets that wrapper underneath the recycle
 * folder view; a native one (SFTPGo's event rule) gets only the view.
 */
export function createIdentityStorageFactory(
  deps: CreateStorageFactoryDeps,
): IdentityStorageFactory {
  return async (identityId) => {
    const { identity, module, instance } = await deps.providers.forIdentity(identityId);
    const storage = module.createStorage(
      instance,
      deps.tokenSource.sessionFor(identityId, identity.externalUsername),
      { fetch: deps.fetch },
    );
    const settings = await deps.resolveTrashSettings?.(identityId);
    let result = storage;
    if (settings?.enabled === true && module.trash !== "none") {
      const base =
        module.trash === "move"
          ? withMoveToTrash({ storage, trashPath: settings.path, clock: deps.clock })
          : storage;
      result = withRecycleFolderTrash(base, settings.path, module.trash);
    }
    if (settings !== undefined) trashSettingsByStorage.set(result, settings);
    return result;
  };
}

/**
 * Builds storage whose upstream token is fetched now and pinned for the
 * storage's lifetime. Throws `upstream_unavailable` when the identity is
 * not bound to `providerId`.
 */
export function createPinnedStorageFactory(
  deps: Omit<CreateStorageFactoryDeps, "resolveTrashSettings" | "clock">,
): PinnedStorageFactory {
  return async (identityId, providerId) => {
    const { identity, provider, module, instance } = await deps.providers.forIdentity(identityId);
    if (provider.id !== providerId) {
      throw new Error("identity is not bound to the requested provider");
    }
    const token = await deps.tokenSource.get(identityId);
    return module.createStorage(
      instance,
      {
        externalUsername: identity.externalUsername,
        getCredential: () => deps.tokenSource.credential(identityId),
        getToken: async () => token,
        invalidateToken: async () => {},
      },
      { fetch: deps.fetch },
    );
  };
}
