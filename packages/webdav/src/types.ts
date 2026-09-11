export interface WebdavClientOptions {
  /** The endpoint, e.g. https://files.example/dav/. A trailing slash is optional. */
  baseUrl: string;
  /** Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Sent as the User-Agent header on every request. Defaults to "fdrive". */
  userAgent?: string;
  /** Per-request timeout in milliseconds for non-streaming calls. Defaults to 30000. */
  timeoutMs?: number;
  /** Largest multistatus body accepted, in bytes. Defaults to 32 MiB. */
  maxMultistatusBytes?: number;
  /** Most `response` elements accepted in one multistatus body. Defaults to 100 000. */
  maxMultistatusEntries?: number;
}

export interface WebdavCredential {
  readonly username: string;
  readonly password: string;
}

export type WebdavEntryKind = "file" | "dir";

/** One member of a listed collection. */
export interface WebdavEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: WebdavEntryKind;
  readonly size: number;
  readonly modifiedAt: Date | null;
  readonly contentType: string | null;
  readonly etag: string | null;
}

/** What `PROPFIND` Depth 0 reports for one resource. */
export interface WebdavStat {
  readonly kind: WebdavEntryKind;
  readonly size: number;
  readonly modifiedAt: Date | null;
  readonly contentType: string | null;
  readonly etag: string | null;
}

export interface ByteRange {
  start: number;
  end?: number;
}

export interface DownloadOptions {
  range?: ByteRange;
  ifRange?: string;
  signal?: AbortSignal;
}

export interface DownloadResult {
  status: 200 | 206;
  body: ReadableStream<Uint8Array>;
  contentLength: number | null;
  contentRange: string | null;
  contentType: string | null;
  lastModified: Date | null;
}

export interface UploadOptions {
  contentLength?: number;
  /** Sent as `X-OC-Mtime`; honoured by ownCloud-compatible servers, ignored elsewhere. */
  modifiedAt?: Date;
  /** False sends `If-None-Match: *`, so an existing target answers 412 (`conflict`). */
  overwrite?: boolean;
  signal?: AbortSignal;
}

export interface CopyMoveOptions {
  /** Sent as `Overwrite: T` (default) or `F`; an existing target then answers 412. */
  overwrite?: boolean;
}

/** WebDAV operations bound to one endpoint and one credential. */
export interface WebdavUserApi {
  /** Members of the collection at `path`; `bad_request` when `path` is not a collection. */
  list(path: string): Promise<WebdavEntry[]>;
  stat(path: string): Promise<WebdavStat>;
  /** A live `PROPFIND` Depth 1 on the collection at `path`, its body discarded. */
  probeDirectoryRead(path: string): Promise<void>;
  download(path: string, options?: DownloadOptions): Promise<DownloadResult>;
  upload(
    path: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    options?: UploadOptions,
  ): Promise<void>;
  /** `MKCOL`: a single collection whose parent must exist. */
  mkcol(path: string): Promise<void>;
  move(path: string, target: string, options?: CopyMoveOptions): Promise<void>;
  copy(path: string, target: string, options?: CopyMoveOptions): Promise<void>;
  /** `DELETE`: recursive for a collection, as the protocol defines it. */
  delete(path: string): Promise<void>;
}

export interface WebdavClient {
  readonly baseUrl: string;
  user(credential: WebdavCredential): WebdavUserApi;
}
