import type { FileEntry, StorageProvider } from "@fdrive/core";
import { isStorageError, parseRangeHeader } from "@fdrive/core";
import { ApiHttpError } from "../errors.ts";

/**
 * One HTTP byte range as the visitor asked for it: bounded (`start`-`end`),
 * open-ended (`start`-) or the last `suffix` bytes. The storage port has no
 * suffix form, so the access object resolves it from the file's size.
 */
export type ShareByteRange =
  | { readonly start: number; readonly end?: number }
  | { readonly suffix: number };

export interface ShareDownloadOptions {
  readonly range?: ShareByteRange;
  /** A validator (ETag or HTTP date) the range only applies to; else the full body is sent. */
  readonly ifRange?: string;
  readonly signal?: AbortSignal;
}

export type ShareDownloadResult = Awaited<ReturnType<StorageProvider["download"]>>;

export type ShareEntry = Pick<FileEntry, "name" | "kind" | "size" | "modifiedAt">;

/** What the public routes may know about a share they serve, whatever backs it. */
export interface ShareView {
  readonly name: string;
  readonly scope: "read" | "write";
  readonly paths: readonly string[];
  readonly hasPassword: boolean;
  readonly maxDownloads: number;
}

/**
 * A public share the routes can serve without knowing what stores it. Built
 * per request once the share is loaded and its password, expiry and limit
 * have been checked, so every method below is an authorized operation on
 * that one share. Paths are relative to the shared directory (`/` is its
 * root); a single-file share is addressed as `/`. Every method throws
 * `ApiHttpError` (or `RangeNotSatisfiableError` from `download`): the
 * implementation maps the storage's failures, so a route never learns the
 * storage's error types.
 */
export interface PublicShareAccess {
  readonly view: ShareView;
  list(path: string): Promise<readonly ShareEntry[]>;
  /** The file at `path` without opening it or spending a download. */
  statFile(
    path: string,
  ): Promise<{ size: number; modifiedAt: Date | null; contentType: string | null }>;
  download(path: string, opts?: ShareDownloadOptions): Promise<ShareDownloadResult>;
  /**
   * Every shared path as one zip stream, counted as one download. The
   * stream ends early, in error, once the visitor leaves or a ceiling on
   * its time or size is passed.
   */
  zip(opts?: { signal?: AbortSignal }): Promise<ReadableStream<Uint8Array>>;
  /** Stores `body` as `name` directly under the shared directory. */
  upload(
    name: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    opts?: { contentLength?: number; signal?: AbortSignal },
  ): Promise<void>;
}

/**
 * Thrown by `PublicShareAccess.download` when the requested range lies
 * outside the file. `size` is the file's length, for the 416 response's
 * `Content-Range`.
 */
export class RangeNotSatisfiableError extends Error {
  readonly size: number;
  constructor(size: number) {
    super("Range not satisfiable");
    this.name = "RangeNotSatisfiableError";
    this.size = size;
  }
}

function unsupportedRange(): never {
  throw new ApiHttpError("bad_request", "Unsupported byte range");
}

/**
 * Parses a public download's `Range` header into a single byte range.
 * `null` for a well-formed multi-range header, which the storage contract
 * cannot serve and callers answer with the complete file; `bad_request` for
 * anything else that is not one bounded, open-ended or suffix range with
 * safe-integer bounds.
 */
export function parseShareRange(header: string): ShareByteRange | null {
  if (parseRangeHeader(header, null).kind === "multiple") return null;
  const match = /^bytes=(?:([0-9]+)-([0-9]*)|-([0-9]+))$/.exec(header);
  if (match === null) return unsupportedRange();
  const [, startText, endText, suffixText] = match;
  if (suffixText !== undefined) {
    const suffix = Number(suffixText);
    return Number.isSafeInteger(suffix) && suffix > 0 ? { suffix } : unsupportedRange();
  }
  const start = Number(startText);
  if (!Number.isSafeInteger(start)) return unsupportedRange();
  if (endText === "") return { start };
  const end = Number(endText);
  return Number.isSafeInteger(end) && end >= start ? { start, end } : unsupportedRange();
}

/** The `Range` header value for `range`. */
export function formatShareRange(range: ShareByteRange): string {
  if ("suffix" in range) return `bytes=-${range.suffix}`;
  return `bytes=${range.start}-${range.end ?? ""}`;
}

/**
 * Runs one share operation for a visitor or its owner. A missing path and a
 * path of the wrong kind keep their meaning; every other failure is the
 * owner's storage or credential misbehaving, which a visitor is told nothing
 * about beyond "unavailable": never a password error, never a sign-in
 * prompt, never the storage's own message.
 */
export async function shareCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ApiHttpError || error instanceof RangeNotSatisfiableError) throw error;
    if (isStorageError(error)) {
      if (error.kind === "not_found") throw new ApiHttpError("not_found", "Share unavailable");
      if (error.kind === "bad_request")
        throw new ApiHttpError("bad_request", "Share operation rejected by storage");
    }
    throw new ApiHttpError("upstream_unavailable", "Share storage unavailable");
  }
}
