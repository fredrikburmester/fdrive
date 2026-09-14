import { normalizePath, type StorageProvider } from "@fdrive/core";
import { ApiHttpError } from "../errors.js";
export function isBackupPath(path: string): boolean {
  return normalizePath(path)
    .split("/")
    .some((part) => part.toLowerCase() === ".fdrive-backups");
}
/** Backup I/O uses the raw adapter. Normal browsing, writes and shares never expose it. */
export function withoutBackupPaths(storage: StorageProvider): StorageProvider {
  const guard = (path: string) => {
    if (isBackupPath(path))
      throw new ApiHttpError("forbidden", "This directory is reserved for installation backups");
  };
  async function tree(path: string, depth = 0): Promise<void> {
    guard(path);
    if (depth > 128) throw new ApiHttpError("bad_request", "Directory is too deeply nested");
    for (const entry of await storage.list(path)) {
      if (
        !entry.path.startsWith(`${normalizePath(path).replace(/\/$/, "")}/`) ||
        entry.path.slice(normalizePath(path).replace(/\/$/, "").length + 1).includes("/")
      )
        throw new ApiHttpError("bad_request", "Invalid directory listing");
      guard(entry.path);
      if (entry.kind === "dir") await tree(entry.path, depth + 1);
    }
  }
  return new Proxy(storage, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      if (key === "withWriteLease")
        return (action: (storage: StorageProvider) => Promise<unknown>, signal?: AbortSignal) =>
          target.withWriteLease?.((leased) => action(withoutBackupPaths(leased)), signal);
      if (key === "list")
        return async (path: string) => {
          guard(path);
          return (await target.list(path)).filter((entry) => !isBackupPath(entry.path));
        };
      if (key === "zip")
        return async (paths: readonly string[], options: unknown) => {
          for (const path of paths) {
            guard(path);
            if ((await target.stat(path)).kind === "dir") await tree(path);
          }
          return Reflect.apply(value, target, [paths, options]);
        };
      return async (...args: unknown[]) => {
        if (typeof args[0] === "string") guard(args[0]);
        if ((key === "copy" || key === "move") && typeof args[1] === "string") guard(args[1]);
        if (["copy", "move", "deleteDir"].includes(String(key))) {
          for (const path of args.slice(0, key === "deleteDir" ? 1 : 2)) {
            if (typeof path !== "string") continue;
            const entry = await target.stat(path).catch((error) => {
              if (
                typeof error === "object" &&
                error !== null &&
                "kind" in error &&
                error.kind === "not_found"
              )
                return null;
              throw error;
            });
            if (entry?.kind === "dir") await tree(path);
          }
        }
        return Reflect.apply(value, target, args);
      };
    },
  });
}
