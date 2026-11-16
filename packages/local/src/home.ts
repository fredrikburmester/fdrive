import type { Stats } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { normalizePath, StorageError, splitSegments } from "@fdrive/core";
import { codeOf } from "./errors.js";

/**
 * One user's home folder on disk, or a folder someone shares, and the only
 * way storage turns a caller's path into a path on disk. Paths are
 * normalized first, which clamps `..` at the home, and no symbolic link
 * below the home is ever followed: a path that passes through one, at any
 * segment including the last, is refused with `forbidden`, whatever it
 * points at. fdrive never makes links; writers outside it (SMB, rsync) may,
 * and everything fdrive checks about a path (grants, its own folders, share
 * links) holds only for the path as asked.
 *
 * A writer that swaps a folder for a link between the check and the use can
 * still win that race. Every writer of a home is trusted (fdrive, OCR, the
 * host's own tools), so links are refused to keep fdrive's checks true, not
 * to stop a hostile process on the same disk.
 */
export interface Home {
  /** Where `path` is on disk; see `Location`. */
  locate(path: string): Promise<Location>;
}

/** Where a caller's path is on disk. */
export interface Location {
  /**
   * The entry on disk: the folders on the way named as the disk stores them,
   * the last segment as asked. Operating on that name keeps a rename that
   * only changes case a rename on a disk that ignores case.
   */
  readonly at: string;
  /**
   * The path, normalized, as the disk spells what exists of it. A disk that
   * ignores case or how accents are encoded (macOS) finds "Årsbesked"
   * written with one character or with a combining ring, but stores one of
   * them, and that is the one every listing shows.
   */
  readonly path: string;
}

/** Codes that end a path early: nothing there, a file on the way, or a link loop. */
const UNRESOLVED = new Set(["ENOENT", "ENOTDIR", "ELOOP"]);

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    const code = codeOf(error);
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

function linked(path: string): StorageError {
  return new StorageError("forbidden", `symbolic links are not followed: ${path}`);
}

/** The names from `base` down to `dir`, a folder inside it. */
function namesBelow(base: string, dir: string): string[] {
  const rel = relative(base, dir);
  if (rel === "") return [];
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new StorageError("forbidden", "the shared folder is outside its owner's files");
  }
  return rel.split(sep);
}

export interface CreateHomeOptions {
  /**
   * For a folder someone shares: its owner's home, which `dir` is a folder
   * in. The folder is then never created, so one its owner removed reads as
   * missing, and it is reached from the owner's home as any path is, so a
   * link on the way to it is refused too.
   */
  readonly within?: string;
}

/**
 * The home folder at `dir`, which need not exist yet. The home itself, or
 * the owner's home of a shared folder, is the deployment's and may be
 * reached through a link; nothing below it may.
 */
export function createHome(dir: string, options: CreateHomeOptions = {}): Home {
  const { within } = options;
  let ready: Promise<{ readonly top: string; readonly prefix: readonly string[] }> | undefined;

  async function resolveTop() {
    if (within === undefined) {
      await mkdir(dir, { recursive: true });
      return { top: await realpath(dir), prefix: [] };
    }
    return { top: await realpath(within), prefix: namesBelow(within, dir) };
  }

  /** Where every path starts, and the names of a shared folder below it. */
  function start() {
    if (ready === undefined) {
      ready = resolveTop();
      // A failure is not cached: the next call tries again, so a home on a
      // disk that was briefly missing recovers without a restart.
      ready.catch(() => {
        ready = undefined;
      });
    }
    return ready;
  }

  return {
    async locate(path) {
      const { top, prefix } = await start();
      const names = [...prefix, ...splitSegments(normalizePath(path))];
      // Resolve the deepest part that exists: one call for a path that does.
      let depth = names.length;
      let real: string;
      for (;;) {
        try {
          real = await realpath(join(top, ...names.slice(0, depth)));
          break;
        } catch (error) {
          if (depth === 0 || !UNRESOLVED.has(codeOf(error) ?? "")) throw error;
          depth -= 1;
        }
      }
      // A real path names every folder as stored, so one that matches what
      // was asked means no link on the way and no other spelling. Otherwise
      // a segment is a link or spelled another way; only lstat tells which.
      if (real !== join(top, ...names.slice(0, depth))) {
        for (let at = 1; at <= depth; at += 1) {
          if ((await lstat(join(top, ...names.slice(0, at)))).isSymbolicLink()) throw linked(path);
        }
      }
      // The first name that did not resolve may be a link leading nowhere.
      const missing = names[depth];
      if (missing !== undefined && (await lstatOrNull(join(real, missing)))?.isSymbolicLink()) {
        throw linked(path);
      }
      // A shared folder its owner removed stays missing: nothing here creates it again.
      if (depth < prefix.length) throw new StorageError("not_found", `not found: ${path}`);
      // No link on the way, so the real path has a name for every segment asked.
      const stored = [
        ...relative(top, real)
          .split(sep)
          .filter((name) => name.length > 0),
        ...names.slice(depth),
      ];
      const last = names.at(-1);
      const at =
        depth < names.length || last === undefined
          ? join(real, ...names.slice(depth))
          : join(dirname(real), last);
      return { at, path: `/${stored.slice(prefix.length).join("/")}` };
    },
  };
}
