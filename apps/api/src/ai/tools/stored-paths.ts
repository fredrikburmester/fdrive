import {
  baseName,
  type FileEntry,
  isStorageError,
  joinPath,
  parentPath,
  type StorageProvider,
} from "@fdrive/core";

/** What is at a path. `unknown` when storage could not answer (no access, rate limited, unavailable). */
export type Occupancy = "free" | "file" | "dir" | "unknown";

export interface LocatedPath {
  /** The path as storage spells it, as far as it exists; any missing rest as it was asked for. */
  readonly path: string;
  readonly occupancy: Occupancy;
}

/**
 * The same text for names that read the same. An accented letter can be one
 * character ("ö") or a letter plus a combining mark ("o" + "¨"): macOS
 * writes names the second way, while models write paths the first way.
 */
export function nameKey(name: string): string {
  return name.normalize("NFC");
}

function once<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let pending = cache.get(key);
  if (pending === undefined) {
    pending = load();
    cache.set(key, pending);
  }
  return pending;
}

/**
 * Finds the stored spelling of paths a model wrote. Each lookup tries the
 * exact path first, taking the spelling storage reports for it, and lists the
 * parent folder only when that misses, so a name written with differently
 * encoded accents still finds its file or folder. Answers are cached: use one
 * locator per moment in time.
 */
export function createPathLocator(storage: StorageProvider) {
  const stats = new Map<string, Promise<LocatedPath>>();
  const listings = new Map<string, Promise<readonly FileEntry[] | null>>();
  const located = new Map<string, Promise<LocatedPath>>();

  // A disk that ignores case or accent encoding (macOS) finds other
  // spellings too, and says which one it stores.
  const statOf = (path: string) =>
    once(stats, path, () =>
      storage.stat(path).then(
        (stat): LocatedPath => ({
          path: stat.path ?? path,
          occupancy: stat.kind === "dir" ? "dir" : "file",
        }),
        (error: unknown): LocatedPath => {
          if (isStorageError(error)) {
            return { path, occupancy: error.kind === "not_found" ? "free" : "unknown" };
          }
          throw error;
        },
      ),
    );

  const listingOf = (path: string) =>
    once(listings, path, () =>
      storage.list(path).catch((error: unknown) => {
        if (isStorageError(error)) return null;
        throw error;
      }),
    );

  function locate(path: string): Promise<LocatedPath> {
    return once(located, path, async () => {
      if (path === "/") return { path, occupancy: "dir" };
      const exact = await statOf(path);
      if (exact.occupancy !== "free") return exact;
      const parent = await locate(parentPath(path));
      const name = baseName(path);
      if (parent.occupancy !== "dir")
        return { path: joinPath(parent.path, name), occupancy: "free" };
      const entries = await listingOf(parent.path);
      if (entries === null) return { path: joinPath(parent.path, name), occupancy: "unknown" };
      const match =
        entries.find((entry) => entry.name === name) ??
        entries.find((entry) => nameKey(entry.name) === nameKey(name));
      if (match === undefined) return { path: joinPath(parent.path, name), occupancy: "free" };
      return {
        path: joinPath(parent.path, match.name),
        occupancy: match.kind === "dir" ? "dir" : "file",
      };
    });
  }

  return { locate };
}
