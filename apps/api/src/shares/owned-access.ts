import { joinPath, normalizePath, parseRangeHeader, type StorageProvider } from "@fdrive/core";
import { closedToShares, SHARED_WITH_ME } from "@fdrive/local";
import { isBackupPath } from "../backups/reserved-storage.ts";
import { DESKTOP_INTERNAL_ROOT } from "../desktop/internal-root.ts";
import { ApiHttpError } from "../errors.ts";
import {
  formatShareRange,
  type PublicShareAccess,
  RangeNotSatisfiableError,
  type ShareByteRange,
  type ShareDownloadOptions,
  type ShareView,
  shareCall,
} from "./access.ts";
import { guardZipStream, type ShareZipLimits, ShareZipTimeoutError } from "./zip-limits.ts";

/** True when `path` is `root` or lies beneath it. Both canonical. */
export function isUnder(path: string, root: string): boolean {
  return root === "/" || path === root || path.startsWith(`${root}/`);
}

/**
 * The folders no link may reach besides backup folders, all canonical: the
 * owner's Trash while it is on (`trashPath`), the Mac's own bookkeeping,
 * which holds its Trash, and the folder that holds what other users share
 * with the owner, which is theirs to share. The last only exists while
 * something is shared, but a link never needs it, so it is kept out always.
 */
export function restrictedRoots(trashPath: string | null): string[] {
  return [
    ...(trashPath === null ? [] : [normalizePath(trashPath)]),
    DESKTOP_INTERNAL_ROOT,
    `/${SHARED_WITH_ME}`,
  ];
}

/**
 * True when no link may reach canonical `path`: a backup folder, or what no
 * share between users reaches either (`closedToShares`): inside one of
 * `restricted`, or anywhere in fdrive's Trash layout, which a link follows
 * its item into and which stays refused after Trash is turned off or moved.
 */
export function hiddenFromLinks(path: string, restricted: readonly string[]): boolean {
  return isBackupPath(path) || closedToShares(path, restricted);
}

/**
 * True when `paths` cannot be one archive: two of them would land on the
 * same name in it (compared as a case-insensitive file system would), or
 * one lies inside another, so its files would be in it twice. The archive
 * names each shared path by its base name, as the storage's zip does.
 */
export function archiveConflict(paths: readonly string[]): boolean {
  if (paths.length < 2) return false;
  const names = new Set<string>();
  for (const path of paths) {
    if (paths.some((other) => other !== path && isUnder(path, other))) return true;
    const name = path
      .slice(path.lastIndexOf("/") + 1)
      .normalize("NFC")
      .toLowerCase();
    if (names.has(name)) return true;
    names.add(name);
  }
  return false;
}

/** The bounded range to ask storage for, or a 416 when `size` cannot satisfy `range`. */
export function boundedRange(range: ShareByteRange, size: number): { start: number; end?: number } {
  const parsed = parseRangeHeader(formatShareRange(range), size);
  if (parsed.kind !== "single") throw new RangeNotSatisfiableError(size);
  return parsed.end === undefined
    ? { start: parsed.start }
    : { start: parsed.start, end: parsed.end };
}

const LIMIT_REACHED = () =>
  new ApiHttpError("forbidden", "Share download limit reached", { reason: "limit" });

export interface OwnedShareAccessOptions {
  /**
   * The owner's storage as the identity storage factory builds it: its
   * `zip` already refuses a tree that holds a backup folder.
   */
  readonly storage: Pick<StorageProvider, "list" | "statFile" | "download" | "upload" | "zip">;
  readonly view: ShareView;
  /**
   * Canonical roots hidden from every listing and refused on every read
   * (`restrictedRoots`). Backup folders always are.
   */
  readonly restricted: readonly string[];
  /** Spends one download once it has been served; `false` when the limit or expiry refuses it. */
  readonly consume: () => Promise<boolean>;
  readonly zip: {
    readonly limits: ShareZipLimits;
    /** Takes one of this share's archive slots: its release, or `null` when none is free. */
    readonly acquire: () => (() => void) | null;
  };
}

/**
 * A `PublicShareAccess` over the owner's own storage. Every path a visitor
 * names is resolved inside the single shared path and refused outside it or
 * inside a hidden folder; ranges are resolved against the file's size so
 * suffix ranges work and a bad one is a 416; a download or an archive counts
 * against the share's budget only after storage has actually answered it.
 */
export function ownedShareAccess(opts: OwnedShareAccessOptions): PublicShareAccess {
  const { storage, view, restricted, consume } = opts;
  const root = view.paths.length === 1 && view.paths[0] !== undefined ? view.paths[0] : null;
  const hidden = (path: string) => hiddenFromLinks(path, restricted);
  function canonical(path: string): string {
    try {
      return normalizePath(path);
    } catch {
      throw new ApiHttpError("bad_request", "Invalid shared path");
    }
  }
  function resolve(path: string): string {
    if (root === null) throw new ApiHttpError("bad_request", "This share is an archive");
    const base = canonical(root);
    let target: string;
    try {
      target = path === "/" ? base : joinPath(base, path);
    } catch {
      throw new ApiHttpError("bad_request", "Invalid shared path");
    }
    if (!isUnder(target, base)) throw new ApiHttpError("bad_request", "Invalid shared path");
    if (hidden(target)) throw new ApiHttpError("not_found", "Share unavailable");
    return target;
  }
  /**
   * The shared paths an archive walks. A path that became hidden is gone;
   * a restricted folder inside a shared folder would ride along with it, so
   * such a share is refused rather than trusted to skip it; and two paths
   * that would collide in the archive are refused rather than both written.
   */
  function archivePaths(): string[] {
    const paths = view.paths.map(canonical);
    if (paths.some(hidden)) throw new ApiHttpError("not_found", "Share unavailable");
    if (restricted.some((folder) => paths.some((path) => isUnder(folder, path))))
      throw new ApiHttpError(
        "forbidden",
        "A share that holds the Trash or folders shared with its owner can't be downloaded as an archive",
      );
    if (archiveConflict(paths))
      throw new ApiHttpError(
        "bad_request",
        "Two shared items overlap or have the same name, so they can't be one archive",
      );
    return paths;
  }
  const statFile = (path: string) => shareCall(() => storage.statFile(resolve(path)));
  return {
    view,
    async list(path) {
      const entries = await shareCall(() => storage.list(resolve(path)));
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
      const result = await shareCall(() =>
        storage.download(target, {
          ...(range === undefined ? {} : { range }),
          ...(options.ifRange === undefined ? {} : { ifRange: options.ifRange }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
      );
      if (!(await consume())) {
        await result.body.cancel();
        throw LIMIT_REACHED();
      }
      return result;
    },
    async zip(options = {}) {
      const zip = storage.zip?.bind(storage);
      if (zip === undefined)
        throw new ApiHttpError("unsupported", "Archive download is not available for this share", {
          capability: "zip",
        });
      const paths = archivePaths();
      const release = opts.zip.acquire();
      if (release === null)
        throw new ApiHttpError(
          "rate_limited",
          "This share is already being downloaded as an archive. Try again shortly.",
        );
      const { limits } = opts.zip;
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(new ShareZipTimeoutError()), limits.timeoutMs);
      timer.unref();
      const done = () => {
        clearTimeout(timer);
        release();
      };
      const signal =
        options.signal === undefined
          ? timeout.signal
          : AbortSignal.any([options.signal, timeout.signal]);
      let source: ReadableStream<Uint8Array> | undefined;
      try {
        source = await shareCall(() => zip(paths, { signal }));
        if (!(await consume())) throw LIMIT_REACHED();
        return guardZipStream(source, { maxBytes: limits.maxBytes, signal, done });
      } catch (error) {
        done();
        await source?.cancel();
        throw error;
      }
    },
    async upload(name, body, options = {}) {
      const target = resolve(`/${name}`);
      await shareCall(() =>
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
