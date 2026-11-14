import { createHash, randomUUID } from "node:crypto";
import type { DesktopEntry } from "@fdrive/contracts";
import {
  type ContentStamp,
  DESKTOP_INTERNAL_ROOT,
  type FileEntry,
  isReservedPath,
  isUnderPath,
  normalizePath,
  type StorageProvider,
} from "@fdrive/core";
import type { IndexedContent } from "@fdrive/db";
import type { Principal } from "../auth/principal.js";
import { ApiHttpError } from "../errors.js";
import { runStorageCall, statEntry } from "../fs/routes.js";
import { indexedVersion } from "./indexed-content.js";
import type { DesktopDeps } from "./pairing.js";

const contains = (root: string, path: string) => root === path || isUnderPath(root, path);
interface Snapshot {
  identityId: string;
  tokenKey: string;
  path: string;
  expires: number;
  entries: DesktopEntry[];
}

/** Entries per listing page; a folder with more never gets a listing token. */
export const DESKTOP_PAGE_SIZE = 500;

export { DESKTOP_INTERNAL_ROOT };

/**
 * The entry at the normalized `path`, from one stat. The files folder follows
 * a link only while it stays inside the home and refuses one that leaves it;
 * a storage that reports a link as one is refused here. Desktop paths are
 * spelled as listings show them and the registry keys items by them, so
 * another spelling of a stored name (on a disk that ignores case) is not that
 * item.
 */
export async function storedEntry(storage: StorageProvider, path: string): Promise<DesktopEntry> {
  const found = await statEntry(storage, path);
  if (found.path !== path) throw new ApiHttpError("not_found", "Item no longer exists");
  if (found.kind === "symlink")
    throw new ApiHttpError("forbidden", "Symbolic links are not supported by this connection");
  return {
    path,
    name: found.name,
    kind: found.kind,
    size: found.size,
    modifiedAt: found.modifiedAt.toISOString(),
    readable: found.kind === "file" || found.kind === "dir",
  };
}

/**
 * Whether a desktop connection may see the normalized `path` at all: inside
 * its grants (or above one, when `browse`ing towards it), and outside
 * fdrive's own folders (`isReservedPath`: the storage's Trash, `trash`, the
 * Mac app's own folder and the rest). Listings drop every entry this
 * refuses, and so does the change feed.
 */
export function desktopPathAllowed(
  principal: Principal,
  path: string,
  options: { trash: string | null; writeProtocol: boolean; browse?: boolean },
): boolean {
  const grants = principal.tokenAccess;
  const { trash, writeProtocol, browse = false } = options;
  return (
    (grants?.mode === "read" || (writeProtocol && grants?.mode === "full")) &&
    grants.paths.some((root) => contains(root, path) || (browse && contains(path, root))) &&
    !isReservedPath(path, trash)
  );
}

export function createDesktopFiles(
  deps: Pick<DesktopDeps, "clock" | "trashPathForStorage" | "indexedContent">,
  writeProtocol = false,
) {
  const snapshots = new Map<string, Snapshot>();
  const hashing = new Set<string>();
  function allowed(principal: Principal, path: string, browse = false) {
    return desktopPathAllowed(principal, path, {
      trash: deps.trashPathForStorage(principal.storage),
      writeProtocol,
      browse,
    });
  }
  function authorize(principal: Principal, raw: string, browse = false) {
    const path = normalizePath(raw);
    if (!allowed(principal, path, browse))
      throw new ApiHttpError("forbidden", "Path is not available to this connection");
    return path;
  }
  /** What this connection may see of a folder's upstream listing, in path order. */
  function visible(principal: Principal, live: readonly FileEntry[]): DesktopEntry[] {
    return live
      .filter((item) => allowed(principal, normalizePath(item.path), item.kind === "dir"))
      .map((item) => ({
        path: normalizePath(item.path),
        name: item.name,
        kind: item.kind,
        size: item.size,
        modifiedAt: item.modifiedAt.toISOString(),
        readable: item.kind === "file" || item.kind === "dir",
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  async function entry(principal: Principal, path: string): Promise<DesktopEntry> {
    const found = await storedEntry(principal.storage, path);
    // The root keeps the presentation clients already hold for it.
    return path === "/" ? { ...found, name: "/", modifiedAt: new Date(0).toISOString() } : found;
  }
  /**
   * The index rows behind the files of a version request this connection may
   * read, in one lookup. Paths it may not read are left for `authorize` to
   * refuse in their turn, as before.
   */
  async function indexedRows(principal: Principal, paths: readonly string[]) {
    if (deps.indexedContent === undefined || principal.storage.contentStamp === undefined)
      return new Map();
    const readable = paths.flatMap((raw) => {
      try {
        const path = normalizePath(raw);
        return allowed(principal, path) ? [path] : [];
      } catch {
        return [];
      }
    });
    return deps.indexedContent(principal, readable);
  }
  /** A file's version from its index row, when the row provably describes the file now. */
  async function indexed(principal: Principal, path: string, row: IndexedContent | undefined) {
    if (row === undefined) return null;
    // `indexedRows` finds rows only where storage has stamps.
    const stamp = (await runStorageCall(async () =>
      principal.storage.contentStamp?.(path),
    )) as ContentStamp;
    const version = indexedVersion(row, stamp);
    return version === null ? null : { path, size: stamp.size, version };
  }
  function prune() {
    for (const [id, snapshot] of snapshots)
      if (snapshot.expires <= deps.clock().getTime()) snapshots.delete(id);
  }
  return {
    async stat(principal: Principal, raw: string) {
      return entry(principal, authorize(principal, raw, true));
    },
    async list(principal: Principal, raw: string, tokenKey: string, cursor?: string) {
      const path = authorize(principal, raw, true);
      prune();
      let id: string;
      let offset = 0;
      let snapshot: Snapshot;
      // Re-prove live directory access on every page, before disclosing a cached snapshot.
      const current = await entry(principal, path);
      if (current.kind !== "dir") throw new ApiHttpError("bad_request", "Item is not a folder");
      if (cursor) {
        const match = /^([0-9a-f-]{36}):(\d{1,6})$/.exec(cursor);
        const existing = match && snapshots.get(match[1] as string);
        if (
          !existing ||
          existing.identityId !== principal.identityId ||
          existing.tokenKey !== tokenKey ||
          existing.path !== path
        )
          throw new ApiHttpError("conflict", "Folder snapshot expired. Refresh the folder.");
        id = match[1] as string;
        offset = Number(match[2]);
        snapshot = existing;
        if (offset >= snapshot.entries.length || offset % DESKTOP_PAGE_SIZE !== 0)
          throw new ApiHttpError("bad_request", "Invalid folder continuation");
        await runStorageCall(async () => {
          await (principal.storage.probeDirectoryRead?.(path) ?? principal.storage.list(path));
        });
      } else {
        const live = await runStorageCall(() => principal.storage.list(path));
        if (live.length > 100_000 || snapshots.size >= 32)
          throw new ApiHttpError("rate_limited", "Folder listing capacity reached. Retry shortly.");
        id = randomUUID();
        snapshot = {
          identityId: principal.identityId,
          tokenKey,
          path,
          expires: deps.clock().getTime() + 120_000,
          entries: visible(principal, live),
        };
        snapshots.set(id, snapshot);
      }
      const end = offset + DESKTOP_PAGE_SIZE;
      const entries = snapshot.entries.slice(offset, end);
      const nextCursor = end < snapshot.entries.length ? `${id}:${end}` : null;
      if (nextCursor === null) snapshots.delete(id);
      return { entries, nextCursor };
    },
    /**
     * A whole folder with live access proven, for a folder check. No snapshot: checks
     * must not use up the listing capacity that paged listings share. Null when the
     * path is no longer a folder.
     */
    async folder(principal: Principal, raw: string) {
      const path = authorize(principal, raw, true);
      if ((await entry(principal, path)).kind !== "dir") return null;
      return {
        path,
        entries: visible(principal, await runStorageCall(() => principal.storage.list(path))),
      };
    },
    async content(principal: Principal, raw: string, signal: AbortSignal) {
      const path = authorize(principal, raw);
      const current = await entry(principal, path);
      if (current.kind !== "file")
        throw new ApiHttpError("bad_request", "Only regular files can be downloaded");
      return runStorageCall(() => principal.storage.download(path, { signal }));
    },
    async versions(principal: Principal, paths: string[], signal: AbortSignal) {
      if (hashing.has(principal.identityId))
        throw new ApiHttpError("rate_limited", "Content validation is already running");
      hashing.add(principal.identityId);
      try {
        const rows = await indexedRows(principal, paths);
        const results = [];
        for (const raw of paths) {
          const path = authorize(principal, raw);
          const current = await entry(principal, path);
          if (current.kind !== "file")
            throw new ApiHttpError("bad_request", "Only files have content versions");
          const known = await indexed(principal, path, rows.get(path));
          if (known !== null) {
            results.push(known);
            continue;
          }
          const result = await runStorageCall(() => principal.storage.download(path, { signal }));
          const reader = result.body.getReader();
          const digest = createHash("sha256");
          let size = 0;
          try {
            for (;;) {
              signal.throwIfAborted();
              const chunk = await reader.read();
              if (chunk.done) break;
              size += chunk.value.byteLength;
              digest.update(chunk.value);
            }
          } finally {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
          }
          if (result.contentLength !== null && size !== result.contentLength)
            throw new ApiHttpError("upstream_unavailable", "Incomplete content validation");
          results.push({ path, size, version: digest.digest("hex") });
        }
        return { items: results };
      } finally {
        hashing.delete(principal.identityId);
      }
    },
  };
}
