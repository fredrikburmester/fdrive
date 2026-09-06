import type { FileEntry } from "../entries.js";

/**
 * Provider-neutral storage port. `apps/api` implements this over the
 * SFTPGo HTTP client; a future Drive or S3 backend implements the same
 * port. All paths are the provider's own paths, already resolved from a
 * scope by the caller: this interface does no scoping of its own.
 */
export interface StorageProvider {
  list(path: string): Promise<FileEntry[]>;

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
}
