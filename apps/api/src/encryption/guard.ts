import { AsyncLocalStorage } from "node:async_hooks";
import {
  AGE_HEADER_PREFIX,
  ENCRYPTED_FOLDER_MARKER,
  ENCRYPTED_FOLDER_REFUSAL,
  EncryptedFolderMarker,
  isEncryptedName,
} from "@fdrive/contracts";
import {
  baseName,
  isStorageError,
  normalizePath,
  StorageError,
  type StorageProvider,
  splitSegments,
  TRASH_PATH,
} from "@fdrive/core";

/**
 * End-to-end encrypted folders on the server: a folder with a marker at its
 * top holds only ciphertext under encrypted names, which nothing here can
 * read. Every storage a request or job reaches is wrapped by
 * {@link guardEncryptedFolders}, which refuses any path inside an encrypted
 * folder unless the request runs inside {@link withEncryptedAccess}, which
 * only the routes on the allowed list do. A feature added later stays out
 * without a rule of its own.
 */

const access = new AsyncLocalStorage<true>();

/** Runs `work` as a caller allowed inside encrypted folders: the web's file routes, the Mac's. */
export function withEncryptedAccess<T>(work: () => T): T {
  return access.run(true, work);
}

/** Whether the running request may reach inside encrypted folders. */
export function encryptedAccessAllowed(): boolean {
  return access.getStore() === true;
}

/** The refusal for a path inside an encrypted folder; `details.code` names it for clients. */
export function encryptedFolderRefusal(
  message: string,
  kind: "forbidden" | "bad_request" = "forbidden",
) {
  return new StorageError(kind, message, { details: { code: ENCRYPTED_FOLDER_REFUSAL } });
}

const MARKER_LIMIT = 64 * 1024;
const HEADER = new TextEncoder().encode(AGE_HEADER_PREFIX);

function startsWithHeader(bytes: Uint8Array): boolean {
  return bytes.length >= HEADER.length && HEADER.every((byte, index) => bytes[index] === byte);
}

/**
 * Refuses a restore that would carry an item across an encrypted folder's
 * edge: it goes back into the encrypted folder it was deleted from, or, if
 * it was in none, into none. `from` is where the item was deleted from.
 */
export async function checkRestore(storage: StorageProvider, from: string, to: string) {
  const folders = encryptedFoldersOf(storage);
  if ((await folders.containing(from)) !== (await folders.containing(to))) {
    throw encryptedFolderRefusal(
      "this goes back only where it came from: inside or outside its encrypted folder",
    );
  }
}

/** What a request can learn about encrypted folders through its storage. */
export interface EncryptedFolders {
  /** The encrypted folder `path` is strictly inside; null when none. */
  containing(path: string): Promise<string | null>;
  /** Whether `path` is an encrypted folder itself. */
  isFolder(path: string): Promise<boolean>;
  /** The encrypted folder `path` is or is inside, with its marker; null when none or unreadable. */
  info(path: string): Promise<{ path: string; marker: EncryptedFolderMarker } | null>;
  /**
   * Writes a new encrypted folder's marker into the empty folder at `path`.
   * Only the encryption routes call this; no file route writes a marker.
   */
  writeMarker(path: string, marker: EncryptedFolderMarker): Promise<void>;
}

const folders = new WeakMap<StorageProvider, EncryptedFolders>();

/** The encrypted folders of a storage {@link guardEncryptedFolders} made. */
export function encryptedFoldersOf(storage: StorageProvider): EncryptedFolders {
  // A storage built without the guard, in a test, reads its markers the same way.
  return folders.get(storage) ?? (folders.get(guardEncryptedFolders(storage)) as EncryptedFolders);
}

function markerPath(folder: string): string {
  return folder === "/" ? `/${ENCRYPTED_FOLDER_MARKER}` : `${folder}/${ENCRYPTED_FOLDER_MARKER}`;
}

/** Every folder above `path`, from the top down, `path` itself excluded. */
function ancestors(path: string): string[] {
  const segments = splitSegments(path);
  return segments.slice(0, -1).map((_, index) => `/${segments.slice(0, index + 1).join("/")}`);
}

/** Refuses an upload body that is not an age file, as it arrives. */
function ageOnly(
  body: ReadableStream<Uint8Array> | Uint8Array,
  refused: () => void,
): ReadableStream<Uint8Array> | Uint8Array {
  if (body instanceof Uint8Array) {
    if (!startsWithHeader(body)) {
      refused();
      throw encryptedFolderRefusal("files in an encrypted folder must be encrypted", "bad_request");
    }
    return body;
  }
  let seen = new Uint8Array(0);
  let checked = false;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!checked) {
          const joined = new Uint8Array(seen.length + chunk.length);
          joined.set(seen);
          joined.set(chunk, seen.length);
          if (joined.length < HEADER.length) {
            seen = joined;
            return;
          }
          checked = true;
          if (!startsWithHeader(joined)) {
            refused();
            controller.error(
              encryptedFolderRefusal("files in an encrypted folder must be encrypted"),
            );
            return;
          }
          controller.enqueue(joined);
          return;
        }
        controller.enqueue(chunk);
      },
      flush(controller) {
        if (!checked) {
          refused();
          controller.error(
            encryptedFolderRefusal("files in an encrypted folder must be encrypted"),
          );
        }
      },
    }),
  );
}

/**
 * Wraps a user's storage so encrypted folders hold only what their owner's
 * devices encrypted, and reach only the callers allowed to see them. The
 * marker file is never listed, read or written through it.
 */
export function guardEncryptedFolders(inner: StorageProvider): StorageProvider {
  const markers = new Map<string, boolean>();

  async function hasMarker(folder: string): Promise<boolean> {
    const cached = markers.get(folder);
    if (cached !== undefined) return cached;
    let found = false;
    try {
      found = (await inner.stat(markerPath(folder))).kind === "file";
    } catch (error) {
      if (!isStorageError(error)) throw error;
    }
    markers.set(folder, found);
    return found;
  }

  async function containing(path: string): Promise<string | null> {
    for (const folder of ancestors(normalizePath(path))) {
      if (await hasMarker(folder)) return folder;
    }
    return null;
  }

  async function isFolder(path: string): Promise<boolean> {
    const normalized = normalizePath(path);
    return normalized !== "/" && hasMarker(normalized);
  }

  function isMarker(path: string): boolean {
    return baseName(path) === ENCRYPTED_FOLDER_MARKER;
  }

  /** Refuses a path inside an encrypted folder outside the allowed list; returns its folder. */
  async function reach(path: string): Promise<string | null> {
    if (isMarker(path)) throw new StorageError("not_found", "not found");
    const folder = await containing(path);
    if (folder !== null && !encryptedAccessAllowed()) {
      throw encryptedFolderRefusal("this is inside an encrypted folder");
    }
    return folder;
  }

  /** A new name inside an encrypted folder: every segment below it must be an encrypted name. */
  function encryptedNamesBelow(folder: string, path: string) {
    const below = splitSegments(path).slice(splitSegments(folder).length);
    if (!below.every(isEncryptedName)) {
      throw encryptedFolderRefusal("names in an encrypted folder must be encrypted", "bad_request");
    }
  }

  /** Where a new entry goes: inside an encrypted folder only under encrypted names. */
  async function creating(path: string): Promise<string | null> {
    const folder = await reach(path);
    if (folder !== null) encryptedNamesBelow(folder, path);
    return folder;
  }

  /** A move or copy stays on one side of an encrypted folder's edge; returns the target's folder. */
  async function transfer(from: string, to: string): Promise<string | null> {
    const source = await reach(from);
    const target = await creating(to);
    if (source !== target) {
      throw encryptedFolderRefusal(
        "files move into and out of an encrypted folder only by encrypting them again",
      );
    }
    return target;
  }

  async function changed<T>(work: Promise<T>): Promise<T> {
    try {
      return await work;
    } finally {
      markers.clear();
    }
  }

  async function upload<T>(
    path: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    checkBody: boolean,
    write: (body: ReadableStream<Uint8Array> | Uint8Array) => Promise<T>,
  ): Promise<T> {
    const folder = await creating(path);
    if (folder === null || !checkBody) return changed(write(body));
    let refused = false;
    const checked = ageOnly(body, () => {
      refused = true;
    });
    try {
      return await changed(write(checked));
    } catch (error) {
      if (refused) {
        throw encryptedFolderRefusal(
          "files in an encrypted folder must be encrypted",
          "bad_request",
        );
      }
      throw error;
    }
  }

  const guarded: StorageProvider = {
    async list(path) {
      const normalized = normalizePath(path);
      if ((await isFolder(normalized)) && !encryptedAccessAllowed()) {
        throw encryptedFolderRefusal("this is an encrypted folder");
      }
      await reach(normalized);
      return (await inner.list(normalized)).filter(
        (entry) => entry.name !== ENCRYPTED_FOLDER_MARKER,
      );
    },
    async stat(path) {
      await reach(path);
      return inner.stat(path);
    },
    async probeDirectoryRead(path) {
      if ((await isFolder(path)) && !encryptedAccessAllowed()) {
        throw encryptedFolderRefusal("this is an encrypted folder");
      }
      await reach(path);
      return inner.probeDirectoryRead(path);
    },
    async contentStamp(path) {
      await reach(path);
      return inner.contentStamp(path);
    },
    async statFile(path) {
      await reach(path);
      return inner.statFile(path);
    },
    async open(path) {
      await reach(path);
      return inner.open(path);
    },
    async upload(path, body, opts) {
      // A piece after the first was checked when the first arrived.
      const first = opts?.part === undefined || opts.part.offset === 0;
      return upload(path, body, first, (checked) => inner.upload(path, checked, opts));
    },
    async uploadPart(path, body, opts) {
      await upload(path, body, opts.part.offset === 0, (checked) =>
        inner.uploadPart(path, checked, opts),
      );
    },
    async mkdir(path, opts) {
      await creating(path);
      return changed(inner.mkdir(path, opts));
    },
    async move(path, target, opts) {
      if (opts?.publish === true) {
        // The Mac stages a save in its own folder and publishes it with one move.
        const folder = await creating(target);
        if (folder !== null) {
          const staged = await inner.open(path);
          try {
            if (!startsWithHeader(await staged.read(0, HEADER.length))) {
              throw encryptedFolderRefusal(
                "files in an encrypted folder must be encrypted",
                "bad_request",
              );
            }
          } finally {
            await staged.close();
          }
        }
        return changed(inner.move(path, target, opts));
      }
      await transfer(path, target);
      return changed(inner.move(path, target, opts));
    },
    async copy(path, target, opts) {
      await transfer(path, target);
      return changed(inner.copy(path, target, opts));
    },
    async deleteFile(path) {
      await reach(path);
      return changed(inner.deleteFile(path));
    },
    async deleteDir(path) {
      await reach(path);
      return changed(inner.deleteDir(path));
    },
    async deleteEmptyDir(path) {
      await reach(path);
      return changed(inner.deleteEmptyDir(path));
    },
    async zip(paths, opts) {
      for (const path of paths) {
        if ((await isFolder(path)) || (await containing(path)) !== null) {
          throw encryptedFolderRefusal("an encrypted folder cannot be zipped on the server");
        }
      }
      // What is zipped may hold an encrypted folder further down: it stays out of the archive.
      return inner.zip(paths, { ...opts, skipFoldersWith: ENCRYPTED_FOLDER_MARKER });
    },
    trash: {
      async put(path, id) {
        await reach(path);
        return changed(inner.trash.put(path, id));
      },
      async restore(id, name, target) {
        const folder = await creating(target);
        if (folder === null && isEncryptedName(baseName(target))) {
          throw encryptedFolderRefusal(
            "an encrypted item goes back only into its encrypted folder",
          );
        }
        if (folder !== null && (await hasMarker(`${TRASH_PATH}/${id}/${name}`))) {
          throw encryptedFolderRefusal("an encrypted folder cannot go inside another");
        }
        return changed(inner.trash.restore(id, name, target));
      },
      purge(id) {
        return changed(inner.trash.purge(id));
      },
    },
  };

  folders.set(guarded, {
    containing,
    isFolder,
    async info(path) {
      const normalized = normalizePath(path);
      const folder = (await isFolder(normalized)) ? normalized : await containing(normalized);
      if (folder === null) return null;
      let text: string;
      try {
        const file = await inner.open(markerPath(folder));
        try {
          if (file.size > MARKER_LIMIT) return null;
          text = new TextDecoder().decode(await file.read(0, file.size));
        } finally {
          await file.close();
        }
      } catch (error) {
        if (isStorageError(error)) return null;
        throw error;
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return null;
      }
      const marker = EncryptedFolderMarker.safeParse(json);
      return marker.success ? { path: folder, marker: marker.data } : null;
    },
    async writeMarker(path, marker) {
      await inner.upload(
        markerPath(normalizePath(path)),
        new TextEncoder().encode(JSON.stringify(marker)),
        {
          overwrite: false,
          durable: true,
        },
      );
      markers.clear();
    },
  });
  return guarded;
}
