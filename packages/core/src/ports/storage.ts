import type { FileEntry } from "../entries.ts";

/** One deleted item still recoverable from a provider's recycle folder. */
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
  /** True when the listing stopped early because it hit its entry or directory-visit bound. */
  readonly truncated: boolean;
}

/**
 * Optional capability a `StorageProvider` may expose: a recoverable recycle
 * folder for deletes the provider itself performed (never fdrive moving
 * files into a trash folder on its own).
 */
export interface TrashProvider {
  list(options?: { limit?: number; signal?: AbortSignal }): Promise<TrashListing>;
  /**
   * Moves the leaf identified by `id` back to `target` (default: its
   * `originalPath`). Parent directories are created as needed. Checks the
   * target first and throws `StorageError("conflict")` when anything already
   * exists there, because providers such as SFTPGo overwrite on move.
   */
  restore(id: string, options?: { target?: string }): Promise<FileEntry>;
  /** Permanently deletes the leaves identified by `ids`. Missing ids are ignored. */
  purge(ids: readonly string[]): Promise<void>;
  /** Permanently removes everything under the trash folder (never the folder itself). */
  empty(): Promise<void>;
}

/**
 * Provider-neutral storage port. `apps/api` implements this over the
 * SFTPGo HTTP client; a future Drive or S3 backend implements the same
 * port. All paths are the provider's own paths, already resolved from a
 * scope by the caller: this interface does no scoping of its own.
 */
export interface StorageProvider {
  list(path: string): Promise<FileEntry[]>;

  /**
   * Live read proof for the directory at `path`. Confirms that the caller can
   * read the directory without loading its full listing. This is not stat or
   * cached permission: it performs a live authenticated read.
   */
  probeDirectoryRead?(path: string): Promise<void>;

  statFile(path: string): Promise<{
    size: number;
    modifiedAt: Date | null;
    contentType: string | null;
  }>;

  download(
    path: string,
    opts?: {
      range?: { start: number; end?: number };
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
      signal?: AbortSignal;
    },
  ): Promise<void>;

  mkdir(path: string, opts?: { parents?: boolean }): Promise<void>;

  move(path: string, target: string): Promise<void>;

  copy(path: string, target: string): Promise<void>;

  deleteFile(path: string): Promise<void>;

  deleteDir(path: string): Promise<void>;

  setModifiedAt(path: string, modifiedAt: Date): Promise<void>;

  zip(paths: readonly string[]): Promise<ReadableStream<Uint8Array>>;

  /** Present only when this provider exposes a recoverable recycle folder. */
  readonly trash?: TrashProvider;
}
