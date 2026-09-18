import type { DownloadOptions, SftpgoPublicShareApi } from "@fdrive/sftpgo";
import { SftpgoError } from "@fdrive/sftpgo";
import { ApiHttpError } from "../errors.ts";
import {
  formatShareRange,
  type PublicShareAccess,
  RangeNotSatisfiableError,
  type ShareView,
} from "./access.ts";

/**
 * Maps an SFTPGo failure on a share operation to the API's own error,
 * never leaking the upstream message. Anything the API already classified,
 * and a range the file cannot satisfy, pass through unchanged.
 */
export async function shareCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ApiHttpError || error instanceof RangeNotSatisfiableError) throw error;
    if (error instanceof SftpgoError) {
      if (error.kind === "not_found") throw new ApiHttpError("not_found", "Share unavailable");
      if (error.kind === "unauthorized" || error.kind === "forbidden")
        throw new ApiHttpError("forbidden", "Share access denied");
      if (error.kind === "bad_request")
        throw new ApiHttpError("bad_request", "Share operation rejected by storage");
    }
    throw new ApiHttpError("upstream_unavailable", "Share storage unavailable");
  }
}

/**
 * `shareCall` for the public share API: SFTPGo answers a wrong or missing
 * share password with 401 or 403, which is the visitor's fault, not a
 * forbidden operation, so a password-protected share reports it as such.
 */
export async function publicCall<T>(fn: () => Promise<T>, hasPassword: boolean): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (
      error instanceof SftpgoError &&
      hasPassword &&
      (error.kind === "unauthorized" || error.kind === "forbidden")
    )
      throw new ApiHttpError("unauthorized", "Share password required or incorrect", {
        reason: "password",
      });
    return shareCall(async () => {
      throw error;
    });
  }
}

/**
 * A `PublicShareAccess` over SFTPGo's public share API, which enforces the
 * share's password, expiry and download budget itself and answers HTTP
 * ranges, including suffix ranges, on its own. A single-file share has no
 * path of its own upstream (`downloadFile`), so `/` maps to that call.
 */
export function nativeShareAccess(api: SftpgoPublicShareApi, view: ShareView): PublicShareAccess {
  const call = <T>(fn: () => Promise<T>) => publicCall(fn, view.hasPassword);
  return {
    view,
    list: (path) =>
      call(async () =>
        (await api.list(path)).map(({ name, kind, size, modifiedAt }) => ({
          name,
          kind,
          size,
          modifiedAt,
        })),
      ),
    download: (path, opts = {}) =>
      call(async () => {
        const options: DownloadOptions = {};
        if (opts.range !== undefined) options.rangeHeader = formatShareRange(opts.range);
        if (opts.ifRange !== undefined) options.ifRange = opts.ifRange;
        if (opts.signal !== undefined) options.signal = opts.signal;
        try {
          return await (path === "/" ? api.downloadFile(options) : api.download(path, options));
        } catch (error) {
          // SFTPGo reports the size only in a 206; a 416 carries none.
          if (error instanceof SftpgoError && error.status === 416)
            throw new RangeNotSatisfiableError(null);
          throw error;
        }
      }),
    zip: (opts) => call(() => api.zip(opts)),
    upload: (name, body, opts) => call(() => api.upload(name, body, opts)),
  };
}
