import { stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  type FileEntry,
  isInMoveTrashLayout,
  makeEntry,
  normalizePath,
  StorageError,
  type StorageProvider,
  splitSegments,
} from "@fdrive/core";
import { type DiskChangeListener, notify } from "./changes.js";
import { mapped } from "./errors.js";
import { isLocalUsername } from "./names.js";
import {
  copyEntry,
  createLocalStorage,
  type LocalStorage,
  moveEntry,
  type ZipItem,
  zipItems,
} from "./storage-provider.js";

/** The folder at the top of each user's files that holds what others share with them. */
export const SHARED_WITH_ME = "Shared with me";

/** A folder another user shares with this one, as it appears under `Shared with me`. */
export interface SharedFolder {
  /** Its name under `Shared with me`, unique among the user's shared folders. */
  readonly name: string;
  /** The shared folder on disk. */
  readonly dir: string;
  /** Its owner's home, which `dir` must really be inside. */
  readonly ownerHome: string;
  /** Whether the user may change what is in it. */
  readonly writable: boolean;
  /**
   * Folders on disk in its owner's files that no share reaches
   * (`closedToShares`). A shared folder really inside one, links resolved,
   * is left out of `Shared with me` and refused.
   */
  readonly closed?: readonly string[];
}

/** One folder shared with a user, before it has a name in their files. */
export interface SharedGrant {
  readonly owner: string;
  /** The folder in the owner's files, e.g. `/Projects/2026`. */
  readonly path: string;
  readonly writable: boolean;
}

/**
 * The name each grant appears under in `Shared with me`, in order: the
 * folder's own name, then `<name> (<owner>)` when two share it, then a
 * number when even that is taken. Grants come oldest first, so a name never
 * moves to another folder when a newer one arrives.
 */
export function sharedFolderNames(grants: readonly SharedGrant[]): string[] {
  const base = grants.map((grant) => basename(normalizePath(grant.path)) || grant.owner);
  const taken = new Set<string>();
  return grants.map((grant, index) => {
    const own = base[index] as string;
    const clash = base.some((other, at) => at !== index && other === own);
    let name = clash ? `${own} (${grant.owner})` : own;
    for (let n = 2; taken.has(name); n += 1) name = `${own} (${grant.owner}, ${n})`;
    taken.add(name);
    return name;
  });
}

/**
 * True when no share reaches a folder at `path` in its owner's files: one of
 * `folders` (their Trash while it is on, fdrive's own bookkeeping) or inside
 * one, or anywhere inside fdrive's Trash layout, which stays put when Trash
 * is turned off or moved. A share follows its folder into Trash, and is
 * refused there until a restore brings it back or a purge ends it.
 */
export function closedToShares(path: string, folders: readonly string[]): boolean {
  const target = normalizePath(path);
  if (isInMoveTrashLayout(target)) return true;
  return folders.some((folder) => {
    const closed = normalizePath(folder);
    return closed === "/" || target === closed || target.startsWith(`${closed}/`);
  });
}

/** A user's storage: every optional `StorageProvider` operation is there. */
export type UserStorage = StorageProvider &
  Required<Pick<StorageProvider, "zip" | "setModifiedAt" | "probeDirectoryRead" | "probeFileRead">>;

/**
 * The grants `username` sees, each with its name under `Shared with me`.
 * A grant whose owner could not be a home folder, or that the user made
 * to themselves, is skipped, never followed: it could only come from a row
 * written by hand. The storage and the API name folders through this, so
 * they always agree.
 */
export function namedSharedGrants<T extends SharedGrant>(
  username: string,
  grants: readonly T[],
): { readonly grant: T; readonly name: string }[] {
  const usable = grants.filter((grant) => isLocalUsername(grant.owner) && grant.owner !== username);
  const names = sharedFolderNames(usable);
  return usable.map((grant, index) => ({ grant, name: names[index] as string }));
}

export interface UserStorageOptions {
  /** The user's own home folder; created on first use. */
  readonly home: string;
  /** What other users share with this one; asked once, when first needed. */
  readonly shared: () => Promise<readonly SharedFolder[]>;
  /** Hears every change made on disk, in the user's own files and in shared folders. */
  readonly onChange?: DiskChangeListener;
}

/** Where a caller's path leads. */
type Place =
  | { readonly kind: "own"; readonly storage: LocalStorage; readonly rel: string }
  | { readonly kind: "shelf" }
  | {
      readonly kind: "mount";
      readonly storage: LocalStorage;
      readonly rel: string;
      readonly folder: SharedFolder;
      readonly prefix: string;
    }
  | { readonly kind: "nowhere"; readonly path: string };

type Located = Extract<Place, { kind: "own" | "mount" }>;

function forbidden(message: string): StorageError {
  return new StorageError("forbidden", message);
}

const SHELF_PATH = `/${SHARED_WITH_ME}`;

/**
 * A user's files: their own home, plus `/Shared with me/<name>` for every
 * folder another user shares with them. Paths under a shared folder reach
 * the owner's folder on disk, confined to it like a home; a read-only one
 * refuses every change. `Shared with me` itself and the shared folders in
 * it cannot be renamed, moved or deleted here (their owner removes the
 * share), and nothing else can be added to it. A move or copy between the
 * user's own files and a shared folder is one filesystem operation, since
 * both live on the same disk.
 *
 * The name is reserved only while something is shared: a user with no
 * shared folders sees an ordinary folder of that name, should they have one.
 */
export function createUserStorage(options: UserStorageOptions): UserStorage {
  const listener = options.onChange;
  const heard = listener === undefined ? {} : { onChange: listener };
  const own = createLocalStorage({ home: options.home, ...heard });
  const mounts = new Map<string, LocalStorage>();
  let loaded: Promise<readonly SharedFolder[]> | undefined;

  function folders(): Promise<readonly SharedFolder[]> {
    loaded ??= options.shared();
    return loaded;
  }

  function mountStorage(folder: SharedFolder): LocalStorage {
    let storage = mounts.get(folder.name);
    if (storage === undefined) {
      storage = createLocalStorage({
        home: folder.dir,
        create: false,
        within: folder.ownerHome,
        ...(folder.closed === undefined ? {} : { outside: folder.closed }),
        ...heard,
      });
      mounts.set(folder.name, storage);
    }
    return storage;
  }

  async function place(path: string): Promise<Place> {
    const normalized = normalizePath(path);
    const segments = splitSegments(normalized);
    if (segments[0] !== SHARED_WITH_ME) return { kind: "own", storage: own, rel: normalized };
    const shared = await folders();
    if (shared.length === 0) return { kind: "own", storage: own, rel: normalized };
    if (segments.length === 1) return { kind: "shelf" };
    const folder = shared.find((candidate) => candidate.name === segments[1]);
    if (folder === undefined) return { kind: "nowhere", path: normalized };
    return {
      kind: "mount",
      storage: mountStorage(folder),
      rel: `/${segments.slice(2).join("/")}`,
      folder,
      prefix: `${SHELF_PATH}/${folder.name}`,
    };
  }

  /** For reads: the place, or `not_found` for a shared folder that does not exist. */
  async function readable(path: string): Promise<Located | { kind: "shelf" }> {
    const at = await place(path);
    if (at.kind === "nowhere") throw new StorageError("not_found", `not found: ${path}`);
    return at;
  }

  /**
   * For changes: a place that may change. `Shared with me` and a shared
   * folder itself are fixed unless `allowFixed` (a `mkdir -p` through them);
   * a read-only shared folder refuses.
   */
  async function writable(path: string, allowFixed = false): Promise<Located | null> {
    const at = await place(path);
    if (at.kind === "nowhere") {
      throw forbidden(`only folders others share can be in ${SHARED_WITH_ME}: ${path}`);
    }
    if (at.kind === "shelf" || (at.kind === "mount" && at.rel === "/")) {
      if (allowFixed) return null;
      throw forbidden(`a shared folder is changed by its owner: ${path}`);
    }
    if (at.kind === "mount" && !at.folder.writable) {
      throw forbidden(`this folder is shared read-only: ${path}`);
    }
    return at;
  }

  /**
   * When a shared folder last changed, or `null` when it cannot be read: its
   * owner removed it, or it is no longer a folder. Such a share is left out
   * of `Shared with me` rather than failing the whole listing.
   */
  async function folderTime(folder: SharedFolder): Promise<Date | null> {
    try {
      const info = await stat(await mountStorage(folder).home.real());
      return info.isDirectory() ? info.mtime : null;
    } catch {
      return null;
    }
  }

  async function shelfEntries(): Promise<FileEntry[]> {
    const entries: FileEntry[] = [];
    for (const folder of await folders()) {
      const modifiedAt = await folderTime(folder);
      if (modifiedAt === null) continue;
      entries.push(makeEntry(SHELF_PATH, { name: folder.name, kind: "dir", size: 0, modifiedAt }));
    }
    return entries;
  }

  /** Rewrites a shared folder's entries to the paths the user sees them at. */
  function under(prefix: string, entries: readonly FileEntry[]): FileEntry[] {
    return entries.map((entry) => ({ ...entry, path: `${prefix}${entry.path}` }));
  }

  /** The newest of the shared folders, so `Shared with me` sorts by its contents. */
  function newest(entries: readonly FileEntry[]): Date {
    return new Date(Math.max(0, ...entries.map((entry) => entry.modifiedAt.getTime())));
  }

  const storage: UserStorage = {
    async list(path) {
      const at = await readable(path);
      if (at.kind === "shelf") return shelfEntries();
      const entries = await at.storage.list(at.rel);
      if (at.kind === "mount") return under(at.prefix, entries);
      if (at.rel !== "/" || (await folders()).length === 0) return entries;
      // A real folder of the same name stays on disk but out of sight.
      const shelf = await shelfEntries();
      return [
        ...entries.filter((entry) => entry.name !== SHARED_WITH_ME),
        makeEntry("/", { name: SHARED_WITH_ME, kind: "dir", size: 0, modifiedAt: newest(shelf) }),
      ];
    },

    async stat(path) {
      const at = await readable(path);
      if (at.kind === "shelf") {
        return {
          kind: "dir",
          size: 0,
          modifiedAt: newest(await shelfEntries()),
          contentType: null,
        };
      }
      const info = await at.storage.stat(at.rel);
      if (at.kind === "own" || info.path === undefined) return info;
      // The folder's own spelling within it, under the name the user sees it by.
      return { ...info, path: `${at.prefix}${info.path}` };
    },

    async statFile(path) {
      const at = await readable(path);
      if (at.kind === "shelf") throw new StorageError("bad_request", `not a file: ${path}`);
      return at.storage.statFile(at.rel);
    },

    async probeDirectoryRead(path) {
      const at = await readable(path);
      if (at.kind === "shelf") return;
      // Local storage always has the probe.
      await (at.storage.probeDirectoryRead as (path: string) => Promise<void>)(at.rel);
    },

    async probeFileRead(path) {
      const at = await readable(path);
      if (at.kind === "shelf") throw new StorageError("bad_request", `not a file: ${path}`);
      await (at.storage.probeFileRead as (path: string) => Promise<void>)(at.rel);
    },

    async download(path, opts) {
      const at = await readable(path);
      if (at.kind === "shelf") throw new StorageError("bad_request", `not a file: ${path}`);
      return at.storage.download(at.rel, opts);
    },

    async upload(path, body, opts) {
      const at = await writable(path);
      // `writable` returns null only when asked to allow a fixed place.
      return (at as Located).storage.upload((at as Located).rel, body, opts);
    },

    async mkdir(path, opts) {
      const parents = opts?.parents === true;
      const at = await writable(path, parents);
      if (at === null) return;
      await at.storage.mkdir(at.rel, opts);
    },

    async move(path, target, opts) {
      const from = await readable(path);
      if (from.kind === "shelf" || (from.kind === "mount" && from.rel === "/")) {
        throw forbidden(`a shared folder is changed by its owner: ${path}`);
      }
      const source = (await writable(path)) as Located;
      const destination = (await writable(target)) as Located;
      if (source.storage === destination.storage) {
        await source.storage.move(source.rel, destination.rel, opts);
        return;
      }
      await mapped(path, async () => {
        const entry = await source.storage.home.entry(source.rel);
        if (entry === (await source.storage.home.real())) {
          throw new StorageError("not_found", `not found: ${path}`);
        }
        const to = await destination.storage.home.entry(destination.rel);
        await moveEntry(entry, to, { path, target }, opts);
        notify(listener, { kind: "moved", path: entry, target: to });
      });
    },

    async copy(path, target, opts) {
      const from = await readable(path);
      if (from.kind === "shelf") throw forbidden(`${SHARED_WITH_ME} cannot be copied: ${path}`);
      const destination = (await writable(target)) as Located;
      if (from.storage === destination.storage) {
        await from.storage.copy(from.rel, destination.rel, opts);
        return;
      }
      await mapped(path, async () => {
        if (from.kind === "own" && from.rel === "/") {
          throw new StorageError("not_found", `not found: ${path}`);
        }
        const to = await destination.storage.home.entry(destination.rel);
        await copyEntry(await from.storage.home.target(from.rel), to, { path, target }, opts);
        notify(listener, { kind: "changed", path: to });
      });
    },

    async deleteFile(path) {
      const at = await readable(path);
      if (at.kind === "shelf") throw forbidden(`a shared folder is changed by its owner: ${path}`);
      const located = (await writable(path)) as Located;
      await located.storage.deleteFile(located.rel);
    },

    async deleteDir(path) {
      const at = await readable(path);
      if (at.kind === "shelf") throw forbidden(`a shared folder is changed by its owner: ${path}`);
      const located = (await writable(path)) as Located;
      await located.storage.deleteDir(located.rel);
    },

    async setModifiedAt(path, modifiedAt) {
      const at = await readable(path);
      if (at.kind === "shelf") throw forbidden(`a shared folder is changed by its owner: ${path}`);
      const located = (await writable(path)) as Located;
      await (located.storage.setModifiedAt as (path: string, at: Date) => Promise<void>)(
        located.rel,
        modifiedAt,
      );
    },

    async zip(paths, opts) {
      const items: ZipItem[] = [];
      for (const path of paths) {
        const at = await readable(path);
        if (at.kind === "shelf") {
          for (const folder of await folders()) {
            if ((await folderTime(folder)) === null) continue;
            items.push({
              at: await mountStorage(folder).home.real(),
              name: `${SHARED_WITH_ME}/${folder.name}`,
            });
          }
          continue;
        }
        const name = at.kind === "mount" && at.rel === "/" ? at.folder.name : basename(at.rel);
        items.push({
          at: await mapped(path, () => at.storage.home.target(at.rel)),
          name,
        });
      }
      return mapped(paths.join(", "), () => zipItems(items, opts?.signal));
    },
  };

  return storage;
}
