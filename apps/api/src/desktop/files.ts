import { createHash, randomUUID } from "node:crypto";
import type { DesktopEntry } from "@fdrive/contracts";
import { isUnderPath, normalizePath } from "@fdrive/core";
import type { Principal } from "../auth/principal.js";
import { ApiHttpError } from "../errors.js";
import { runStorageCall } from "../fs/routes.js";
import { DESKTOP_INTERNAL_ROOT } from "./internal-root.js";
import type { DesktopDeps } from "./pairing.js";

const contains = (root: string, path: string) => root === path || isUnderPath(root, path);
interface Snapshot {
  identityId: string;
  tokenKey: string;
  path: string;
  expires: number;
  entries: DesktopEntry[];
}

export { DESKTOP_INTERNAL_ROOT };
export function createDesktopFiles(
  deps: Pick<DesktopDeps, "clock" | "trashPathForStorage">,
  writeProtocol = false,
) {
  const snapshots = new Map<string, Snapshot>();
  const hashing = new Set<string>();
  function allowed(principal: Principal, path: string, browse = false) {
    const grants = principal.tokenAccess;
    const trash = deps.trashPathForStorage(principal.storage);
    return (
      (grants?.mode === "read" || (writeProtocol && grants?.mode === "full")) &&
      grants.paths.some((root) => contains(root, path) || (browse && contains(path, root))) &&
      !(trash && contains(trash, path)) &&
      !contains(DESKTOP_INTERNAL_ROOT, path)
    );
  }
  function authorize(principal: Principal, raw: string, browse = false) {
    const path = normalizePath(raw);
    if (!allowed(principal, path, browse))
      throw new ApiHttpError("forbidden", "Path is not available to this connection");
    return path;
  }
  // Do not follow a symlink inside a folder grant. The adapters expose entry kinds in
  // listings, whereas HTTP stat can describe the symlink's target as an ordinary file.
  async function entry(principal: Principal, path: string): Promise<DesktopEntry> {
    if (path === "/") {
      await runStorageCall(async () => {
        await (principal.storage.probeDirectoryRead?.("/") ?? principal.storage.list("/"));
      });
      return {
        path,
        name: "/",
        kind: "dir",
        size: 0,
        modifiedAt: new Date(0).toISOString(),
        readable: true,
      };
    }
    const parts = path.slice(1).split("/");
    if (parts.length > 128) throw new ApiHttpError("bad_request", "Path has too many components");
    let parent = "";
    let result: DesktopEntry | undefined;
    for (let i = 0; i < parts.length; i++) {
      const current = `${parent}/${parts[i]}`;
      const entries = await runStorageCall(() => principal.storage.list(parent || "/"));
      const found = entries.find((candidate) => normalizePath(candidate.path) === current);
      if (!found) throw new ApiHttpError("not_found", "Item no longer exists");
      if ((i < parts.length - 1 && found.kind !== "dir") || found.kind === "symlink")
        throw new ApiHttpError("forbidden", "Symbolic links are not supported by this connection");
      result = {
        ...found,
        modifiedAt: found.modifiedAt.toISOString(),
        readable: found.kind === "file" || found.kind === "dir",
      };
      parent = current;
    }
    return result as DesktopEntry;
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
        if (offset >= snapshot.entries.length || offset % 500 !== 0)
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
          entries: live
            .filter((item) => allowed(principal, normalizePath(item.path), item.kind === "dir"))
            .map((item) => ({
              path: normalizePath(item.path),
              name: item.name,
              kind: item.kind,
              size: item.size,
              modifiedAt: item.modifiedAt.toISOString(),
              readable: item.kind === "file" || item.kind === "dir",
            }))
            .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
        };
        snapshots.set(id, snapshot);
      }
      const end = offset + 500;
      const entries = snapshot.entries.slice(offset, end);
      const nextCursor = end < snapshot.entries.length ? `${id}:${end}` : null;
      if (nextCursor === null) snapshots.delete(id);
      return { entries, nextCursor };
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
        const results = [];
        for (const raw of paths) {
          const path = authorize(principal, raw);
          const current = await entry(principal, path);
          if (current.kind !== "file")
            throw new ApiHttpError("bad_request", "Only files have content versions");
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
