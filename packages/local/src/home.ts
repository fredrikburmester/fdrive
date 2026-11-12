import { lstat, mkdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { normalizePath, StorageError, splitSegments } from "@fdrive/core";
import { codeOf } from "./errors.js";

/**
 * One user's home folder on disk, and the only way storage turns a caller's
 * path into a path on disk. Paths are normalized first, which clamps `..`
 * at the home, so the only way out is a symlink: every lookup resolves the
 * real path of what already exists and refuses one outside the home with
 * `forbidden`. Missing trailing segments cannot be links, so creating them
 * stays inside.
 *
 * A writer that swaps a directory for a symlink between the check and the
 * use can still win that race. Every writer of a home is trusted (fdrive,
 * OCR, the host's own tools), so links are guarded against mistakes and
 * stale configuration, not against a hostile process on the same disk.
 */
export interface Home {
  /** The home's real path, creating the folder on first use. */
  real(): Promise<string>;
  /**
   * The entry `path` names: its parent resolved and confined, the final
   * segment itself not followed. Use it for operations on the directory
   * entry: delete, move, publish, mkdir.
   */
  entry(path: string): Promise<string>;
  /**
   * Like `entry`, but a symlink at the final segment is followed, and is
   * `forbidden` when its target is outside the home. Use it for operations
   * on content: read, list, stat, copy from.
   */
  target(path: string): Promise<string>;
  /** True when `realPath` is the home or inside it. */
  contains(realPath: string): Promise<boolean>;
}

function isMissing(error: unknown): boolean {
  const code = codeOf(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function inside(home: string, realPath: string): boolean {
  return realPath === home || realPath.startsWith(home.endsWith(sep) ? home : `${home}${sep}`);
}

function outside(path: string): StorageError {
  return new StorageError("forbidden", `outside the home folder: ${path}`);
}

/** The home folder at `dir`, which need not exist yet. */
export function createHome(dir: string): Home {
  let ready: Promise<string> | undefined;

  function real(): Promise<string> {
    if (ready === undefined) {
      ready = mkdir(dir, { recursive: true }).then(() => realpath(dir));
      // A failure is not cached: the next call tries again, so a home on a
      // disk that was briefly missing recovers without a restart.
      ready.catch(() => {
        ready = undefined;
      });
    }
    return ready;
  }

  /** Resolves `segments` under the home through the deepest part that exists. */
  async function resolveDir(home: string, segments: readonly string[], path: string) {
    for (let depth = segments.length; ; depth -= 1) {
      try {
        const resolved = await realpath(join(home, ...segments.slice(0, depth)));
        if (!inside(home, resolved)) throw outside(path);
        return join(resolved, ...segments.slice(depth));
      } catch (error) {
        if (depth === 0 || !isMissing(error)) throw error;
      }
    }
  }

  async function entry(path: string): Promise<string> {
    const segments = splitSegments(normalizePath(path));
    const home = await real();
    const leaf = segments.pop();
    if (leaf === undefined) return home;
    return join(await resolveDir(home, segments, path), leaf);
  }

  return {
    real,
    entry,

    async target(path) {
      const at = await entry(path);
      try {
        if (!(await lstat(at)).isSymbolicLink()) return at;
      } catch (error) {
        // Missing: the operation itself reports `not_found`.
        if (isMissing(error)) return at;
        throw error;
      }
      const resolved = await realpath(at);
      if (!inside(await real(), resolved)) throw outside(path);
      return resolved;
    },

    async contains(realPath) {
      return inside(await real(), realPath);
    },
  };
}
