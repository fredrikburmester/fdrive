import {
  PEEK_MAX_CENTRAL_DIRECTORY_BYTES,
  type PeekStoragePort,
  UnreadableArchiveError,
} from "../archive/peek.ts";
import type { PublicShareAccess, ShareDownloadOptions } from "./access.ts";

/**
 * The suffix `createSharePeekPort`'s `statFile` reads to discover a shared
 * file's size without a real `statFile` on the public share. Wide enough to
 * comfortably cover a zip's end-of-central-directory record, matching
 * `peek.ts`'s own tail read.
 */
export const SHARE_PEEK_SUFFIX_BYTES = 65536;

/**
 * Parses the total size out of an HTTP `Content-Range` response header of
 * the form `bytes <start>-<end>/<total>`. Returns `null` for anything else,
 * including a `*` total (the server declining to report it) or a missing
 * header, so the caller can fall back rather than trust an unparsed value.
 */
export function parseContentRangeTotal(contentRange: string | null): number | null {
  if (contentRange === null) {
    return null;
  }
  const match = /^bytes \d+-\d+\/(\d+)$/.exec(contentRange);
  if (match === null) {
    return null;
  }
  const total = match[1];
  if (total === undefined) {
    return null;
  }
  const parsed = Number(total);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Drains and discards a response body the caller never reads, so the
 * underlying connection is released instead of left dangling. */
async function discard(body: ReadableStream<Uint8Array>): Promise<void> {
  await body.cancel();
}

export interface SharePeekPortOptions {
  readonly access: Pick<PublicShareAccess, "download">;
  /** True when the share itself is a single file: `peekArchive` is then
   * given the shared path for its extension, while the share is read at
   * `/`, the path every public share route uses for that file. */
  readonly isSingleFile: boolean;
}

/**
 * Adapts a `PublicShareAccess` (which has no `statFile`) into the two-method
 * `PeekStoragePort` `peekArchive` needs. `statFile` is synthesized from a
 * suffix-range read (the last `SHARE_PEEK_SUFFIX_BYTES`) and the resulting
 * `Content-Range` header's total. When the backend ignores the range and
 * answers `200` instead, the whole body is accepted as the size only when
 * `Content-Length` is known and at most `PEEK_MAX_CENTRAL_DIRECTORY_BYTES`;
 * otherwise the archive is treated as unreadable rather than risking an
 * unbounded buffer.
 */
export function createSharePeekPort(opts: SharePeekPortOptions): PeekStoragePort {
  const { access, isSingleFile } = opts;

  function download(path: string, options: ShareDownloadOptions = {}) {
    return access.download(isSingleFile ? "/" : path, options);
  }

  async function statFile(
    path: string,
  ): Promise<{ size: number; modifiedAt: Date | null; contentType: string | null }> {
    const result = await download(path, { range: { suffix: SHARE_PEEK_SUFFIX_BYTES } });
    await discard(result.body);

    if (result.status === 206) {
      const total = parseContentRangeTotal(result.contentRange);
      if (total === null) {
        throw new UnreadableArchiveError();
      }
      return { size: total, modifiedAt: result.lastModified, contentType: result.contentType };
    }

    if (result.contentLength !== null && result.contentLength <= PEEK_MAX_CENTRAL_DIRECTORY_BYTES) {
      return {
        size: result.contentLength,
        modifiedAt: result.lastModified,
        contentType: result.contentType,
      };
    }
    throw new UnreadableArchiveError();
  }

  return {
    statFile,
    download(
      path: string,
      opts?: { range?: { start: number; end?: number }; signal?: AbortSignal },
    ) {
      const options: { range?: { start: number; end?: number }; signal?: AbortSignal } = {};
      if (opts?.range !== undefined) options.range = opts.range;
      if (opts?.signal !== undefined) options.signal = opts.signal;
      return download(path, options);
    },
  };
}
