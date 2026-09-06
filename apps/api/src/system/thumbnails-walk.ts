import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** `readdir(path, { withFileTypes: true })`, or `null` when `path` cannot be read. */
async function tryReaddir(path: string): Promise<Dirent[] | null> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return null;
  }
}

/** Bytes and how many files were actually inspected while walking a thumbnails directory. */
export interface ThumbnailsWalkResult {
  readonly bytes: number;
  readonly filesWalked: number;
}

/**
 * Recursively sums the size of every regular file under `dir`, stopping
 * once `maxFiles` files have been visited (the indexer's thumbnail cache
 * can hold hundreds of thousands of small WebP files; a hard cap keeps this
 * a bounded, predictable cost for a page load rather than an unbounded disk
 * walk). Missing or unreadable entries are skipped rather than failing the
 * whole walk, since a thumbnail can be deleted or in flight between
 * `readdir` and `stat`.
 */
export async function walkThumbnailBytes(
  dir: string,
  maxFiles: number,
): Promise<ThumbnailsWalkResult> {
  let bytes = 0;
  let filesWalked = 0;
  const queue: string[] = [dir];

  for (const current of queue) {
    if (filesWalked >= maxFiles) {
      break;
    }

    const entries = await tryReaddir(current);
    if (entries === null) {
      continue;
    }

    for (const entry of entries) {
      if (filesWalked >= maxFiles) {
        break;
      }
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      try {
        const info = await stat(entryPath);
        bytes += info.size;
        filesWalked += 1;
      } catch {
        // Skip: the file may have been removed between readdir and stat.
      }
    }
  }

  return { bytes, filesWalked };
}
