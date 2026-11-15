import type { EntryKind, FileEntry } from "../entries.ts";

/** One deleted item still recoverable from the Trash folder. */
export interface TrashEntry {
  /** The leaf's path relative to the trash root, without a leading slash. */
  readonly id: string;
  /** The deleted item's original path (its leaf's parent, trash-relative, with a leading slash). */
  readonly originalPath: string;
  readonly name: string;
  readonly size: number;
  readonly deletedAt: Date;
}

/** The result of a bounded trash listing. */
export interface TrashListing {
  readonly entries: TrashEntry[];
  /** True when the listing stopped early because it reached its entry limit. */
  readonly truncated: boolean;
}

/** A restored entry plus the original path its Trash leaf encodes. */
export type TrashRestoreResult = FileEntry & {
  readonly originalPath: string;
};

/** Where `TrashProvider.put` moved an item. */
export interface TrashedItem {
  /**
   * Its leaf, a path in its owner's files: the storage's own Trash, or, for
   * an item in a folder another user shares, that user's.
   */
  readonly leaf: string;
  readonly kind: "file" | "dir";
}

/**
 * A storage's Trash at `TRASH_PATH`: moves items into fdrive's layout there
 * and lists, restores and purges its leaves. Restore and purge remove the
 * layout folders a leaf leaves empty. Deleting is never a trash:
 * `deleteFile` and `deleteDir` delete for good, and callers choose.
 */
export interface TrashProvider {
  /**
   * Moves the file or folder at `path` into Trash, at a new leaf, never
   * replacing one. Refuses the root and fdrive's own folders, Trash
   * included, with `bad_request`.
   */
  put(path: string): Promise<TrashedItem>;
  /**
   * The leaves, newest first: at most `limit` of them (default 10,000;
   * `Infinity` for all). With `prune`, also removes the empty layout folders
   * the walk passes: ones left from before restore and purge cleaned up
   * after themselves, or by a delete whose move failed.
   */
  list(options?: { limit?: number; prune?: boolean; signal?: AbortSignal }): Promise<TrashListing>;
  /**
   * Moves the leaf identified by `id` back to `target` (default: its
   * `originalPath`). Parent directories are created as needed. The move
   * refuses an occupied target, so a restore never replaces anything: it
   * throws `StorageError("conflict")` instead. Returns the provider-parsed
   * original path together with the restored entry.
   */
  restore(id: string, options?: { target?: string }): Promise<TrashRestoreResult>;
  /** Permanently deletes the leaf identified by `id`. A missing id is ignored. */
  purge(id: string): Promise<void>;
}

/** What `StorageProvider.stat` reports for any existing path. */
export interface EntryStat {
  readonly kind: EntryKind;
  readonly size: number;
  readonly modifiedAt: Date | null;
  readonly contentType: string | null;
  /**
   * The path as storage spells it, when that differs from the path asked
   * for: a disk that ignores case or how accents are encoded (macOS) finds
   * "Årsbesked" written with one character or with a combining ring. Absent
   * when the path asked for is the stored spelling.
   */
  readonly path?: string;
  /**
   * The inode number of what is there, file or folder, without following a
   * link. Absent where the backend has no inodes.
   */
  readonly ino?: bigint;
}

/**
 * What a file on disk is right now, read from its open descriptor: the
 * size, modification time, inode and change time (`st_ctim`), times in
 * nanoseconds since the epoch. A client can set a modification time but
 * never an inode or a change time, and any write changes the change time,
 * so a digest recorded with the same four still describes the file's bytes.
 */
export interface ContentStamp {
  readonly size: number;
  readonly mtimeNs: bigint;
  /** The unsigned inode number. */
  readonly ino: bigint;
  readonly ctimeNs: bigint;
}

/** How far `StorageProvider.zip` has got. */
export interface ZipProgress {
  /** Files read into the archive so far. */
  readonly processed: number;
  /** Files the archive holds. */
  readonly total: number;
  /** Bytes of those files read so far. */
  readonly bytes: number;
}

/** Options shared by `move` and `copy`. */
export interface TransferOptions {
  /** Replace an existing target; without it a taken target is a `conflict`. */
  readonly overwrite?: boolean;
}

/** Options for `move`. */
export interface MoveOptions extends TransferOptions {
  /**
   * Publishes an entry fdrive staged in its own folders. A file without
   * `overwrite` is linked into place only while the name is free, a real
   * create-if-absent as uploads publish, and then unlinked where it was
   * staged; file watchers see a new file rather than a move. The new name is
   * flushed to disk before the call returns, so it survives a crash.
   */
  readonly publish?: boolean;
}

/**
 * Provider-neutral storage port. `@fdrive/local` implements it over a folder
 * on the API's disk. All paths are the
 * provider's own paths, already resolved from a scope by the caller: this
 * interface does no scoping of its own.
 *
 * Contract clauses every implementation honours (checked by
 * `describeStorageProvider` in `@fdrive/testkit`):
 *
 * - `statFile` on a directory throws `StorageError("bad_request")`; on a
 *   missing path `not_found`. `stat` reports either kind.
 * - `move`, `copy` and `upload` refuse an existing target with
 *   `StorageError("conflict")` unless asked to replace it (`overwrite:
 *   true`). Callers do not check a target first: the storage refuses it.
 * - `download` honours `range` with status 206 and a `Content-Range`, and
 *   `ifRange` when given.
 * - A symbolic link is never followed: every operation refuses a path that
 *   passes through one, at any segment including the last, with
 *   `StorageError("forbidden")`. Listings show the link itself, as kind
 *   `symlink`; `stat` never reports that kind.
 * - Optional methods are absent, not throwing, when the storage cannot
 *   offer them (the in-memory test storage); the files folder has them all.
 */
export interface StorageProvider {
  list(path: string): Promise<FileEntry[]>;

  /** Stats `path` whatever its kind. Throws `not_found` when nothing is there. */
  stat(path: string): Promise<EntryStat>;

  /**
   * Live read proof for the directory at `path`. Confirms that the caller can
   * read the directory without loading its full listing. This is not stat or
   * cached permission: it performs a live authenticated read.
   */
  probeDirectoryRead?(path: string): Promise<void>;

  /**
   * Live read proof for the file at `path` that reads none of its content:
   * whether `download` could open it now. Fails as `download` does:
   * `not_found` when nothing is there, `bad_request` for anything that is not
   * a file, `forbidden` when the file may not be read. Absent where only a
   * download proves it; callers then open `download` and cancel the body.
   */
  probeFileRead?(path: string): Promise<void>;

  /**
   * The file at `path` as `download` would open it, without reading any of
   * it: see `ContentStamp`. Fails as `download` does. Absent where the
   * backend has no inodes or change times.
   */
  contentStamp?(path: string): Promise<ContentStamp>;

  statFile(path: string): Promise<{
    size: number;
    modifiedAt: Date | null;
    contentType: string | null;
  }>;

  download(
    path: string,
    opts?: {
      range?: { start: number; end?: number };
      /** A validator (ETag or HTTP date) the range only applies to; else the full body is sent. */
      ifRange?: string;
      signal?: AbortSignal;
    },
  ): Promise<{
    status: 200 | 206;
    body: ReadableStream<Uint8Array>;
    contentLength: number | null;
    contentRange: string | null;
    contentType: string | null;
    lastModified: Date | null;
  }>;

  upload(
    path: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    opts?: {
      mkdirParents?: boolean;
      modifiedAt?: Date;
      contentLength?: number;
      /** Replace an existing file; without it a taken name is a `conflict`. */
      overwrite?: boolean;
      /**
       * Flush the file to disk before publishing it, and its name after, so
       * it survives a crash once the call returns.
       */
      durable?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<void>;

  mkdir(path: string, opts?: { parents?: boolean }): Promise<void>;

  move(path: string, target: string, opts?: MoveOptions): Promise<void>;

  copy(path: string, target: string, opts?: TransferOptions): Promise<void>;

  /** Deletes the file at `path` for good; `trash.put` moves it into Trash instead. */
  deleteFile(path: string): Promise<void>;

  /** Deletes the folder at `path` and everything in it for good. */
  deleteDir(path: string): Promise<void>;

  /**
   * Removes the directory at `path` only while it is empty: `conflict` when
   * it holds anything, `not_found` when nothing is there, `bad_request` for
   * a file or the storage's root. Never recursive, so it cannot take
   * something moved into the directory after a caller saw it empty.
   */
  deleteEmptyDir(path: string): Promise<void>;

  /** Absent when the backend cannot keep a client-supplied modification time. */
  setModifiedAt?(path: string, modifiedAt: Date): Promise<void>;

  /** Absent when the backend has no server-side zip. */
  zip?(
    paths: readonly string[],
    opts?: {
      signal?: AbortSignal;
      /** Called once every file is counted, then as each is read into the archive. */
      onProgress?: (progress: ZipProgress) => void;
    },
  ): Promise<ReadableStream<Uint8Array>>;

  /** The storage's Trash. */
  readonly trash: TrashProvider;
}

/** A storage's file operations, before its Trash is built over them. */
export type StorageWithoutTrash = Omit<StorageProvider, "trash">;
