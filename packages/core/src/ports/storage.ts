import type { EntryKind, FileEntry } from "../entries.ts";

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
 * A restored entry plus the path encoded by its provider's trash layout.
 * `originalPath` lets callers relocate metadata that survived deletion; it
 * is not a snapshot and cannot recreate metadata already removed.
 */
export type TrashRestoreResult = FileEntry & {
  readonly originalPath: string;
};

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
   * exists there, because providers such as SFTPGo overwrite on move. Returns
   * the provider-parsed original path together with the restored entry.
   */
  restore(id: string, options?: { target?: string }): Promise<TrashRestoreResult>;
  /** Permanently deletes the leaves identified by `ids`. Missing ids are ignored. */
  purge(ids: readonly string[]): Promise<void>;
  /** Permanently removes everything under the trash folder (never the folder itself). */
  empty(): Promise<void>;
}

/** What `StorageProvider.stat` reports for any existing path. */
export interface EntryStat {
  readonly kind: EntryKind;
  readonly size: number;
  readonly modifiedAt: Date | null;
  readonly contentType: string | null;
}

/**
 * Provider-neutral storage port. Each provider package implements it over
 * its own client (SFTPGo's REST API, WebDAV, S3). All paths are the
 * provider's own paths, already resolved from a scope by the caller: this
 * interface does no scoping of its own.
 *
 * Contract clauses every implementation honours (checked by
 * `describeStorageProvider` in `@fdrive/testkit`):
 *
 * - `statFile` on a directory throws `StorageError("bad_request")`; on a
 *   missing path `not_found`. `stat` reports either kind.
 * - `move`, `copy` and `upload` overwrite an existing target unless the
 *   provider can refuse it (`overwrite: false`); callers that need a
 *   conflict pre-check the target.
 * - `download` honours `range` with status 206 and a `Content-Range`, and
 *   `ifRange` when given.
 * - Optional methods are absent, not throwing, when the backend cannot
 *   offer them; `ProviderCapabilities` says which.
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
      /** False asks the provider to refuse an existing target with `conflict`, where it can. */
      overwrite?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<void>;

  mkdir(path: string, opts?: { parents?: boolean }): Promise<void>;

  move(path: string, target: string, opts?: { overwrite?: boolean }): Promise<void>;

  copy(path: string, target: string, opts?: { overwrite?: boolean }): Promise<void>;

  deleteFile(path: string): Promise<void>;

  deleteDir(path: string): Promise<void>;

  /** Absent when the backend cannot keep a client-supplied modification time. */
  setModifiedAt?(path: string, modifiedAt: Date): Promise<void>;

  /** Absent when the backend has no server-side zip. */
  zip?(
    paths: readonly string[],
    opts?: { signal?: AbortSignal },
  ): Promise<ReadableStream<Uint8Array>>;

  /** Present only when this provider exposes a recoverable recycle folder. */
  readonly trash?: TrashProvider;
}
