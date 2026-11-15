import type { FileEntry } from "../entries.ts";

/** Where `TrashProvider.put` moved an item. */
export interface TrashedItem {
  /**
   * Its path in Trash, `/.trash/<id>/<name>` in its owner's files: the
   * storage's own, or, for an item in a folder another user shares, that
   * user's.
   */
  readonly leaf: string;
  readonly kind: "file" | "dir";
}

/**
 * A storage's Trash at `TRASH_PATH`: each item in a folder of its own,
 * `/.trash/<id>/<name>`, named by an id the caller gives and keeps with
 * where the item came from. Deleting is never a trash: `deleteFile` and
 * `deleteDir` delete for good, and callers choose.
 */
export interface TrashProvider {
  /**
   * Moves the file or folder at `path` into Trash as item `id`, at
   * `/.trash/<id>/<its name>` in its owner's files, never replacing
   * anything. Refuses the root and fdrive's own folders, Trash included,
   * with `bad_request`.
   */
  put(path: string, id: string): Promise<TrashedItem>;
  /**
   * Moves item `id`, named `name`, out of Trash to `target`, creating
   * missing parent folders, and removes its folder. The move refuses an
   * occupied target, so a restore never replaces anything: it throws
   * `StorageError("conflict")` instead.
   */
  restore(id: string, name: string, target: string): Promise<EntryStat>;
  /** Deletes item `id` for good, with its folder. A missing item is ignored. */
  purge(id: string): Promise<void>;
}

/**
 * An entry that exists, as storage reports it: `stat` for any path, and each
 * write for what it made. `path` and `name` are as storage spells them, which
 * need not be the spelling asked for: a disk that ignores case or how accents
 * are encoded (macOS) finds "Årsbesked" written with one character or with a
 * combining ring, but stores one of them, and listings show that one.
 */
export interface EntryStat extends FileEntry {
  /**
   * The inode number of what is there, file or folder, without following a
   * link; a rename keeps it. `Shared with me`, which no folder on disk
   * holds, has 0.
   */
  readonly ino: bigint;
}

/** What `mkdir` made: the folder at its path, and the top of what is new. */
export interface MadeFolder extends EntryStat {
  /**
   * The first folder the call created: the path asked for, a folder above
   * it with `parents`, or `null` when every folder was already there.
   */
  readonly created: string | null;
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

/** Options for `upload`. */
export interface UploadOptions {
  readonly mkdirParents?: boolean;
  readonly modifiedAt?: Date;
  /** The body's length; a body of any other length is refused (`bad_request`). */
  readonly contentLength?: number;
  /** Replace an existing file; without it a taken name is a `conflict`. */
  readonly overwrite?: boolean;
  /**
   * Flush the file to disk before publishing it, and its name after, so
   * it survives a crash once the call returns.
   */
  readonly durable?: boolean;
  readonly signal?: AbortSignal;
  /**
   * The last piece of a file sent in several calls: the body goes into the
   * upload's part `id` at `offset`, after the pieces `uploadPart` wrote,
   * and the whole part is published at `path`. `contentLength` is then the
   * body's own length.
   */
  readonly part?: UploadPart;
  /**
   * Runs each step that changes what is at `path` or above it (creating
   * missing parent folders, publishing the file) inside the caller's
   * critical section, and nothing else: the body is staged before, outside
   * it, so a body that arrives slowly, or never, holds nothing the caller
   * holds. Nothing appears at `path` before the last step.
   */
  readonly critical?: <T>(work: () => Promise<T>) => Promise<T>;
}

/** Where one piece of a file sent in several calls goes. */
export interface UploadPart {
  /** The upload's part: 16 lowercase hex digits. */
  readonly id: string;
  /** The piece's first byte in the file. */
  readonly offset: number;
}

/** Options for `uploadPart`. */
export interface UploadPartOptions {
  readonly part: UploadPart;
  /** Whether the last piece will replace an existing file, as `upload`'s option. */
  readonly overwrite?: boolean;
  /** The piece's length; a body of any other length is refused (`bad_request`). */
  readonly contentLength?: number;
  readonly signal?: AbortSignal;
}

/** What `download` opened. */
export interface Download {
  readonly status: 200 | 206;
  readonly body: ReadableStream<Uint8Array>;
  /** The bytes `body` holds. */
  readonly contentLength: number;
  /** For a 206, the range sent: `bytes <first>-<last>/<size>`. */
  readonly contentRange: string | null;
  readonly lastModified: Date;
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
 * - `upload`, `mkdir`, `move` and `copy` return the entry they made, as
 *   `stat` would report it then: callers do not stat it again.
 * - `move`, `copy` and `upload` refuse an existing target with
 *   `StorageError("conflict")` unless asked to replace it (`overwrite:
 *   true`). Callers do not check a target first: the storage refuses it.
 * - `download` honours `range` with status 206 and a `Content-Range`, and
 *   `ifRange` when given.
 * - A symbolic link is never followed: every operation refuses a path that
 *   passes through one, at any segment including the last, with
 *   `StorageError("forbidden")`. Listings show the link itself, as kind
 *   `symlink`; `stat` never reports that kind.
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
  probeDirectoryRead(path: string): Promise<void>;

  /**
   * The file at `path` as `download` would open it, without reading any of
   * it: see `ContentStamp`. Fails as `download` does.
   */
  contentStamp(path: string): Promise<ContentStamp>;

  /** Stats the file at `path`: `bad_request` for anything that is not a file. */
  statFile(path: string): Promise<EntryStat>;

  download(
    path: string,
    opts?: {
      range?: { start: number; end?: number };
      /** A validator (ETag or HTTP date) the range only applies to; else the full body is sent. */
      ifRange?: string;
      signal?: AbortSignal;
    },
  ): Promise<Download>;

  upload(
    path: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    opts?: UploadOptions,
  ): Promise<EntryStat>;

  /**
   * One piece of a file sent in several calls, before the last: the body
   * goes into the upload's part at `offset`, and nothing appears at `path`
   * until `upload` sends the last piece. Whatever the part holds past
   * `offset` is cut off first, so a failed call can be repeated. Refuses
   * what `upload` would, a taken name included.
   */
  uploadPart(
    path: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    opts: UploadPartOptions,
  ): Promise<void>;

  mkdir(path: string, opts?: { parents?: boolean }): Promise<MadeFolder>;

  move(path: string, target: string, opts?: MoveOptions): Promise<EntryStat>;

  copy(path: string, target: string, opts?: TransferOptions): Promise<EntryStat>;

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

  /**
   * One zip of `paths`: a file under its own name, a folder under its name
   * with everything in it, and the root as its contents. Each file is read
   * only as the archive is.
   */
  zip(
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
