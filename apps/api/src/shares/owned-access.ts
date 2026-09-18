import {
  isStorageError,
  joinPath,
  normalizePath,
  parseRangeHeader,
  type StorageProvider,
} from "@fdrive/core";
import { isBackupPath } from "../backups/reserved-storage.ts";
import { ApiHttpError } from "../errors.ts";
import {
  formatShareRange,
  type PublicShareAccess,
  RangeNotSatisfiableError,
  type ShareByteRange,
  type ShareDownloadOptions,
  type ShareView,
} from "./access.ts";

/** True when `path` is `root` or lies beneath it. Both canonical. */
export function isUnder(path: string, root: string): boolean {
  return root === "/" || path === root || path.startsWith(`${root}/`);
}

/**
 * Runs one storage call for a visitor. A missing path and a path of the
 * wrong kind keep their meaning; every other failure is the owner's
 * storage or credential misbehaving, which a visitor is told nothing about
 * beyond "unavailable": never a password error, never a sign-in prompt.
 */
export async function storageCall<T>(fn: () => Promise<T>): Promise<T> {
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

/** The bounded range to ask storage for, or a 416 when `size` cannot satisfy `range`. */
export function boundedRange(range: ShareByteRange, size: number): { start: number; end?: number } {
  const parsed = parseRangeHeader(formatShareRange(range), size);
  if (parsed.kind !== "single") throw new RangeNotSatisfiableError(size);
  return parsed.end === undefined
    ? { start: parsed.start }
    : { start: parsed.start, end: parsed.end };
}

export interface OwnedShareAccessOptions {
  readonly storage: Pick<StorageProvider, "list" | "statFile" | "download" | "upload">;
  readonly view: ShareView;
  /** Canonical roots hidden from every listing and refused on every read: the owner's Trash. Backup folders always are. */
  readonly restricted: readonly string[];
  /** Spends one download once it has been served; `false` when the limit or expiry refuses it. */
  readonly consume: () => Promise<boolean>;
}

/**
 * A `PublicShareAccess` over the owner's own storage. Every path a visitor
 * names is resolved inside the single shared path and refused outside it or
 * inside a hidden folder; ranges are resolved against the file's size so
 * suffix ranges work and a bad one is a 416; a download counts against the
 * share's budget only after storage has actually answered it. Archives are
 * not served yet.
 */
export function ownedShareAccess(opts: OwnedShareAccessOptions): PublicShareAccess {
  const { storage, view, restricted, consume } = opts;
  const root = view.paths.length === 1 && view.paths[0] !== undefined ? view.paths[0] : null;
  const hidden = (path: string) =>
    isBackupPath(path) || restricted.some((folder) => isUnder(path, folder));
  function resolve(path: string): string {
    if (root === null) throw new ApiHttpError("bad_request", "This share is an archive");
    let target: string;
    try {
      target = path === "/" ? normalizePath(root) : joinPath(root, path);
    } catch {
      throw new ApiHttpError("bad_request", "Invalid shared path");
    }
    if (!isUnder(target, normalizePath(root)))
      throw new ApiHttpError("bad_request", "Invalid shared path");
    if (hidden(target)) throw new ApiHttpError("not_found", "Share unavailable");
    return target;
  }
  const statFile = (path: string) => storageCall(() => storage.statFile(resolve(path)));
  return {
    view,
    async list(path) {
      const entries = await storageCall(() => storage.list(resolve(path)));
      return entries
        .filter((entry) => !hidden(entry.path))
        .map(({ name, kind, size, modifiedAt }) => ({ name, kind, size, modifiedAt }));
    },
    statFile,
    async download(path, options: ShareDownloadOptions = {}) {
      const target = resolve(path);
      const range =
        options.range === undefined
          ? undefined
          : boundedRange(options.range, (await statFile(path)).size);
      const result = await storageCall(() =>
        storage.download(target, {
          ...(range === undefined ? {} : { range }),
          ...(options.ifRange === undefined ? {} : { ifRange: options.ifRange }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
      );
      if (!(await consume())) {
        await result.body.cancel();
        throw new ApiHttpError("forbidden", "Share download limit reached", { reason: "limit" });
      }
      return result;
    },
    async zip() {
      throw new ApiHttpError("unsupported", "Archive download is not available for this share", {
        capability: "shares",
      });
    },
    async upload(name, body, options = {}) {
      const target = resolve(`/${name}`);
      await storageCall(() =>
        storage.upload(target, body, {
          ...(options.contentLength === undefined ? {} : { contentLength: options.contentLength }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
      );
      // Counted once stored; a refusal here cannot take the file back and
      // only means the next upload is turned away.
      await consume();
    },
  };
}
