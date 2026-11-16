import { basename, relative, sep } from "node:path";
import {
  baseName,
  createTrash,
  type EntryStat,
  type FileEntry,
  isReservedPath,
  joinPath,
  makeEntry,
  normalizePath,
  StorageError,
  type StorageProvider,
  type StorageWithoutTrash,
  splitSegments,
  type UploadOptions,
} from "@fdrive/core";
import { type DiskChangeListener, notify } from "./changes.js";
import { mapped } from "./errors.js";
import { isLocalUsername } from "./names.js";
import {
  bytesAt,
  copyEntry,
  createLocalStorage,
  type LocalStorage,
  moveEntry,
  type ZipItem,
  zipItems,
} from "./storage-provider.js";

/**
 * The folder at the top of each user's files that holds what others share
 * with them. The name is reserved there: nothing else can take it.
 */
export const SHARED_WITH_ME = "Shared with me";

/** A folder another user shares with this one, as it appears under `Shared with me`. */
export interface SharedFolder {
  /** Its name under `Shared with me`, unique among the user's shared folders. */
  readonly name: string;
  /** The user whose files it is in. */
  readonly owner: string;
  /** The shared folder on disk. */
  readonly dir: string;
  /**
   * Its owner's home, which `dir` is a folder in: the folder is reached from
   * it as any path is, so a symbolic link on the way to it is refused.
   */
  readonly ownerHome: string;
  /** Whether the user may change what is in it. */
  readonly writable: boolean;
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
 * fdrive's own folders (`isReservedPath`: the Trash, the Mac app's folder)
 * or anything inside one. A share follows its folder into Trash, and is
 * refused there until a restore brings it back or a purge ends it.
 */
export function closedToShares(path: string): boolean {
  return isReservedPath(path);
}

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
  /** Throws when the folder may not be used now; asked before every operation. */
  readonly ready?: () => Promise<void>;
  /**
   * How many more bytes may land in the user's own files (`null`) or in a
   * shared folder's owner's files, or `null` for no limit. With it, an
   * upload, a copy or a move into another owner's files that would put more
   * than that there is refused (`storage_limit_reached`).
   */
  readonly room?: (folder: SharedFolder | null) => Promise<number | null>;
}

/** The refusal for a write its folder's owner has no room for. */
function limitReached(): StorageError {
  return new StorageError("storage_limit_reached", "Storage limit reached");
}

/** `body`, refused as soon as more than `max` bytes of it arrive. */
function capped(
  body: ReadableStream<Uint8Array> | Uint8Array,
  max: number,
): ReadableStream<Uint8Array> | Uint8Array {
  if (body instanceof Uint8Array) {
    if (body.byteLength > max) throw limitReached();
    return body;
  }
  let total = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > max) controller.error(limitReached());
        else controller.enqueue(chunk);
      },
    }),
  );
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
 * the owner's folder on disk, confined to it like a home, and one whose own
 * path passes through a symbolic link is refused; a read-only one
 * refuses every change. `Shared with me` itself and the shared folders in
 * it cannot be renamed, moved or deleted here (their owner removes the
 * share), and nothing else can be added to it. A move or copy between the
 * user's own files and a shared folder is one filesystem operation, since
 * both live on the same disk.
 *
 * The name is reserved at the top of every home, whether or not anything is
 * shared: nothing can be created, uploaded, moved or renamed to it. A real
 * folder of that name, made before the name was reserved or outside fdrive,
 * stays on disk untouched and out of sight. The folder is listed only while
 * something is shared.
 *
 * Its Trash is at `/.trash` in the user's home. Something in a writable
 * shared folder goes to its owner's Trash, since it is the owner's file:
 * the leaf `trash.put` reports is then in the owner's files, where only the
 * owner lists, restores and purges it.
 */
export function createUserStorage(options: UserStorageOptions): StorageProvider {
  const listener = options.onChange;
  const heard = listener === undefined ? {} : { onChange: listener };
  const own = createLocalStorage({ home: options.home, ...heard });
  const mounts = new Map<string, LocalStorage>();
  /** Each sharing owner's whole home, whose Trash takes what is trashed in their folders. */
  const owners = new Map<string, LocalStorage>();
  let loaded: Promise<readonly SharedFolder[]> | undefined;

  function folders(): Promise<readonly SharedFolder[]> {
    loaded ??= options.shared();
    return loaded;
  }

  function mountStorage(folder: SharedFolder): LocalStorage {
    let storage = mounts.get(folder.name);
    if (storage === undefined) {
      storage = createLocalStorage({ home: folder.dir, within: folder.ownerHome, ...heard });
      mounts.set(folder.name, storage);
    }
    return storage;
  }

  async function place(path: string): Promise<Place> {
    await options.ready?.();
    const normalized = normalizePath(path);
    const segments = splitSegments(normalized);
    if (segments[0] !== SHARED_WITH_ME) return { kind: "own", storage: own, rel: normalized };
    if (segments.length === 1) return { kind: "shelf" };
    const folder = (await folders()).find((candidate) => candidate.name === segments[1]);
    if (folder === undefined) return { kind: "nowhere", path: normalized };
    return {
      kind: "mount",
      storage: mountStorage(folder),
      rel: `/${segments.slice(2).join("/")}`,
      folder,
      prefix: `${SHELF_PATH}/${folder.name}`,
    };
  }

  /** How many more bytes may land at `at`, or `null` for no limit. */
  function roomAt(at: Located): Promise<number | null> {
    return options.room?.(at.kind === "mount" ? at.folder : null) ?? Promise.resolve(null);
  }

  /**
   * Refuses to put the files at `from` (a file, or a folder and everything
   * in it) at `to` when the owner of `to` has no room for them: the one check
   * every copy, and every move into another owner's files, passes.
   */
  async function admit(path: string, from: Located, to: Located): Promise<void> {
    const room = await roomAt(to);
    if (room === null) return;
    const bytes = await mapped(path, async () =>
      bytesAt((await from.storage.home.locate(from.rel)).at),
    );
    if (bytes > room) throw limitReached();
  }

  /** Whose files `at` is in: the user's own (`null`) or a shared folder's owner. */
  function ownerOf(at: Located): string | null {
    return at.kind === "mount" ? at.folder.owner : null;
  }

  /** The bytes a file at `at` holds, which replacing it frees; 0 for anything else. */
  async function replaced(at: Located): Promise<number> {
    const info = await at.storage.stat(at.rel).catch(() => null);
    return info?.kind === "file" ? info.size : 0;
  }

  /** A path within `at`'s storage as the user sees it: under its shared folder's name for a mount. */
  function outwardPath(at: Located, path: string): string {
    return at.kind === "own" ? path : joinPath(at.prefix, path);
  }

  /** `entry`, found in `at`'s storage, as the user sees it. */
  function outward<T extends EntryStat>(at: Located, entry: T): T {
    if (at.kind === "own") return entry;
    const path = outwardPath(at, entry.path);
    return { ...entry, path, name: baseName(path) };
  }

  /** An upload's `body` for `at`: refused when its owner has no room, cut off past the room left. */
  async function admitUpload(
    at: Located,
    body: ReadableStream<Uint8Array> | Uint8Array,
    opts: Pick<UploadOptions, "overwrite" | "part">,
  ): Promise<ReadableStream<Uint8Array> | Uint8Array> {
    const room = await roomAt(at);
    if (room === null) return body;
    // A file being replaced frees its bytes; a piece of an upload sent in
    // pieces shares the room with the pieces before it, which wait unindexed.
    const max =
      room + (opts.overwrite === true ? await replaced(at) : 0) - (opts.part?.offset ?? 0);
    if (max < 0) throw limitReached();
    return capped(body, max);
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
    if (at.kind === "shelf") {
      if (allowFixed) return null;
      throw forbidden(`${SHARED_WITH_ME} is reserved for folders others share: ${path}`);
    }
    if (at.kind === "mount" && at.rel === "/") {
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
   * owner removed it, it is no longer a folder, or a symbolic link is on the
   * way to it. Such a share is left out of `Shared with me` rather than
   * failing the whole listing.
   */
  async function folderTime(folder: SharedFolder): Promise<Date | null> {
    try {
      const info = await mountStorage(folder).stat("/");
      return info.kind === "dir" ? info.modifiedAt : null;
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

  function ownerStorage(folder: SharedFolder): LocalStorage {
    let storage = owners.get(folder.ownerHome);
    if (storage === undefined) {
      storage = createLocalStorage({ home: folder.ownerHome, ...heard });
      owners.set(folder.ownerHome, storage);
    }
    return storage;
  }

  /** Rewrites a shared folder's entries to the paths the user sees them at. */
  function under(prefix: string, entries: readonly FileEntry[]): FileEntry[] {
    return entries.map((entry) => ({ ...entry, path: `${prefix}${entry.path}` }));
  }

  /** The newest of the shared folders, so `Shared with me` sorts by its contents. */
  function newest(entries: readonly FileEntry[]): Date {
    return new Date(Math.max(0, ...entries.map((entry) => entry.modifiedAt.getTime())));
  }

  const storage: StorageWithoutTrash = {
    async list(path) {
      const at = await readable(path);
      if (at.kind === "shelf") return shelfEntries();
      const entries = await at.storage.list(at.rel);
      if (at.kind === "mount") return under(at.prefix, entries);
      if (at.rel !== "/") return entries;
      // The name is reserved: a real folder of that name stays out of sight.
      const mine = entries.filter((entry) => entry.name !== SHARED_WITH_ME);
      if ((await folders()).length === 0) return mine;
      const shelf = await shelfEntries();
      return [
        ...mine,
        makeEntry("/", { name: SHARED_WITH_ME, kind: "dir", size: 0, modifiedAt: newest(shelf) }),
      ];
    },

    async stat(path) {
      const at = await readable(path);
      if (at.kind === "shelf") {
        const modifiedAt = newest(await shelfEntries());
        const entry = makeEntry("/", { name: SHARED_WITH_ME, kind: "dir", size: 0, modifiedAt });
        return { ...entry, ino: 0n };
      }
      // The folder's own spelling within it, under the name the user sees it by.
      return outward(at, await at.storage.stat(at.rel));
    },

    async statFile(path) {
      const at = await readable(path);
      if (at.kind === "shelf") throw new StorageError("bad_request", `not a file: ${path}`);
      return outward(at, await at.storage.statFile(at.rel));
    },

    async probeDirectoryRead(path) {
      const at = await readable(path);
      if (at.kind === "shelf") return;
      await at.storage.probeDirectoryRead(at.rel);
    },

    async contentStamp(path) {
      const at = await readable(path);
      if (at.kind === "shelf") throw new StorageError("bad_request", `not a file: ${path}`);
      return at.storage.contentStamp(at.rel);
    },

    async open(path) {
      const at = await readable(path);
      if (at.kind === "shelf") throw new StorageError("bad_request", `not a file: ${path}`);
      return at.storage.open(at.rel);
    },

    async upload(path, body, opts = {}) {
      // `writable` returns null only when asked to allow a fixed place.
      const at = (await writable(path)) as Located;
      return outward(at, await at.storage.upload(at.rel, await admitUpload(at, body, opts), opts));
    },

    async uploadPart(path, body, opts) {
      const at = (await writable(path)) as Located;
      await at.storage.uploadPart(at.rel, await admitUpload(at, body, opts), opts);
    },

    async mkdir(path, opts) {
      const parents = opts?.parents === true;
      const at = await writable(path, parents);
      // `Shared with me` or a shared folder itself, which only a `mkdir -p` passes through.
      if (at === null) return { ...(await storage.stat(path)), created: null };
      const made = await at.storage.mkdir(at.rel, opts);
      const created = made.created === null ? null : outwardPath(at, made.created);
      return { ...outward(at, made), created };
    },

    async move(path, target, opts) {
      const from = await readable(path);
      if (from.kind === "shelf" || (from.kind === "mount" && from.rel === "/")) {
        throw forbidden(`a shared folder is changed by its owner: ${path}`);
      }
      const source = (await writable(path)) as Located;
      const destination = (await writable(target)) as Located;
      // A move within one owner's files adds nothing to them.
      if (ownerOf(source) !== ownerOf(destination)) await admit(path, source, destination);
      if (source.storage === destination.storage) {
        return outward(destination, await source.storage.move(source.rel, destination.rel, opts));
      }
      await mapped(path, async () => {
        // Only the user's own home can be the source's top: a shared one is fixed.
        if (source.rel === "/") throw new StorageError("not_found", `not found: ${path}`);
        const entry = (await source.storage.home.locate(source.rel)).at;
        const to = (await destination.storage.home.locate(destination.rel)).at;
        const stamp = await moveEntry(entry, to, { path, target }, opts);
        notify(listener, {
          kind: "moved",
          path: entry,
          target: to,
          ...(stamp === undefined ? {} : { stamp }),
        });
      });
      return outward(destination, await destination.storage.stat(destination.rel));
    },

    async copy(path, target, opts) {
      const from = await readable(path);
      if (from.kind === "shelf") throw forbidden(`${SHARED_WITH_ME} cannot be copied: ${path}`);
      const destination = (await writable(target)) as Located;
      await admit(path, from, destination);
      if (from.storage === destination.storage) {
        return outward(destination, await from.storage.copy(from.rel, destination.rel, opts));
      }
      await mapped(path, async () => {
        if (from.kind === "own" && from.rel === "/") {
          throw new StorageError("not_found", `not found: ${path}`);
        }
        const source = (await from.storage.home.locate(from.rel)).at;
        const to = (await destination.storage.home.locate(destination.rel)).at;
        await copyEntry(source, to, { path, target }, opts);
        notify(listener, { kind: "changed", path: to });
      });
      return outward(destination, await destination.storage.stat(destination.rel));
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

    async deleteEmptyDir(path) {
      const at = await readable(path);
      if (at.kind === "shelf") throw forbidden(`a shared folder is changed by its owner: ${path}`);
      const located = (await writable(path)) as Located;
      await located.storage.deleteEmptyDir(located.rel);
    },

    async zip(paths, opts) {
      const items: ZipItem[] = [];
      for (const path of paths) {
        const at = await readable(path);
        if (at.kind === "shelf") {
          for (const folder of await folders()) {
            if ((await folderTime(folder)) === null) continue;
            items.push({
              at: (await mapped(path, () => mountStorage(folder).home.locate("/"))).at,
              name: `${SHARED_WITH_ME}/${folder.name}`,
            });
          }
          continue;
        }
        const name = at.kind === "mount" && at.rel === "/" ? at.folder.name : basename(at.rel);
        items.push({
          at: (await mapped(path, () => at.storage.home.locate(at.rel))).at,
          name,
        });
      }
      return mapped(paths.join(", "), () => zipItems(items, opts));
    },
  };

  // Listed, restored and purged through the user's own files, so a restore
  // may land in a shared folder.
  const trash = createTrash(storage);
  return {
    ...storage,
    trash: {
      ...trash,
      async put(path, id) {
        const at = (await writable(path)) as Located;
        if (at.kind === "own") return own.trash.put(at.rel, id);
        const folder = relative(at.folder.ownerHome, at.folder.dir).split(sep);
        return ownerStorage(at.folder).trash.put(joinPath("/", ...folder, at.rel), id);
      },
    },
  };
}
