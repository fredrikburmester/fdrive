import type { FsEntry } from "@fdrive/contracts";

/** The outcome of resolving one path: its live `FsEntry`, or `null` when
 * the path could not be stat'd (deleted, moved out of scope, and so on). */
export interface ResolvedEntry {
  readonly path: string;
  readonly entry: FsEntry | null;
}

export const DEFAULT_RESOLVE_CONCURRENCY = 6;

/**
 * Resolves every path in `paths` to a live `FsEntry` via `stat` (injected so
 * this stays a pure function of its arguments in tests), running at most
 * `concurrency` stats in flight at once. A path whose `stat` call rejects
 * resolves to `{ path, entry: null }` rather than failing the whole batch,
 * so one deleted or moved-away file never blocks the rest of the page.
 * Results are returned in the same order as `paths`, regardless of which
 * order the stats actually settle in.
 */
export async function resolveEntries(
  paths: readonly string[],
  stat: (path: string) => Promise<FsEntry>,
  concurrency: number = DEFAULT_RESOLVE_CONCURRENCY,
): Promise<ResolvedEntry[]> {
  const results: ResolvedEntry[] = new Array(paths.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= paths.length) {
        return;
      }
      const path = paths[index] as string;
      try {
        const entry = await stat(path);
        results[index] = { path, entry };
      } catch {
        results[index] = { path, entry: null };
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, paths.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}
