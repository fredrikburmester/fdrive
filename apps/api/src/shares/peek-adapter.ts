import type { DownloadOptions, DownloadResult, SftpgoPublicShareApi } from "@fdrive/sftpgo";
import {
  PEEK_MAX_CENTRAL_DIRECTORY_BYTES,
  type PeekStoragePort,
  UnreadableArchiveError,
} from "../archive/peek.ts";

/**
 * The suffix range `createSharePeekPort`'s `statFile` issues to discover a
 * shared file's size without a real `statFile` call on the public share
 * API. Wide enough to comfortably cover a zip's end-of-central-directory
 * record, matching `peek.ts`'s own tail read.
 */
export const SHARE_PEEK_SUFFIX_RANGE_HEADER = "bytes=-65536";

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
  readonly api: SftpgoPublicShareApi;
  /** True when the share itself is a single file (the request path is
   * always `"/"` in that case), so the adapter reads through
   * `downloadFile` rather than `download(path, ...)`, matching every other
   * public share route's convention. */
  readonly isSingleFile: boolean;
}

/**
 * Adapts a `SftpgoPublicShareApi` (a public share's `list` / `download` /
 * `downloadFile` / `zip` / `upload` surface, with no `statFile`) into the
 * two-method `PeekStoragePort` `peekArchive` needs. `statFile` has no real
 * counterpart on the share API, so it is synthesized from a suffix-range
 * read (`Range: bytes=-65536`) and the resulting `Content-Range` header's
 * total. When the server ignores the range and answers `200` instead, the
 * whole body is accepted as the size only when `Content-Length` is known
 * and at most `PEEK_MAX_CENTRAL_DIRECTORY_BYTES`; otherwise the archive is
 * treated as unreadable rather than risking an unbounded buffer.
 */
export function createSharePeekPort(opts: SharePeekPortOptions): PeekStoragePort {
  const { api, isSingleFile } = opts;

  function download(path: string, downloadOpts?: DownloadOptions): Promise<DownloadResult> {
    return isSingleFile ? api.downloadFile(downloadOpts) : api.download(path, downloadOpts);
  }

  async function statFile(
    path: string,
  ): Promise<{ size: number; modifiedAt: Date | null; contentType: string | null }> {
    const result = await download(path, { rangeHeader: SHARE_PEEK_SUFFIX_RANGE_HEADER });
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
      const options: DownloadOptions = {};
      if (opts?.range !== undefined) options.range = opts.range;
      if (opts?.signal !== undefined) options.signal = opts.signal;
      return download(path, options);
    },
  };
}
