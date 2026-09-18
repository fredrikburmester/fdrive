import type { FileEntry, StorageProvider } from "@fdrive/core";
import { parseRangeHeader } from "@fdrive/core";
import { ApiHttpError } from "../errors.ts";

/**
 * One HTTP byte range as the visitor asked for it: bounded (`start`-`end`),
 * open-ended (`start`-) or the last `suffix` bytes. The storage port has no
 * suffix form, so an access object over plain storage resolves it from the
 * file's size; one over a backend that speaks HTTP ranges forwards it.
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
 * implementation maps its backend's failures, so a route never learns the
 * backend's error types.
 */
export interface PublicShareAccess {
  readonly view: ShareView;
  list(path: string): Promise<readonly ShareEntry[]>;
  /** The file at `path` without opening it; absent when the backend cannot stat through a share. */
  statFile?(
    path: string,
  ): Promise<{ size: number; modifiedAt: Date | null; contentType: string | null }>;
  download(path: string, opts?: ShareDownloadOptions): Promise<ShareDownloadResult>;
  /** Every shared path, as one zip stream. */
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
 * outside the file. `size` is the file's length when the backend reported
 * it, for the 416 response's `Content-Range`.
 */
export class RangeNotSatisfiableError extends Error {
  readonly size: number | null;
  constructor(size: number | null) {
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

/** The `Range` header value for `range`, for a backend that answers HTTP ranges itself. */
export function formatShareRange(range: ShareByteRange): string {
  if ("suffix" in range) return `bytes=-${range.suffix}`;
  return `bytes=${range.start}-${range.end ?? ""}`;
}
