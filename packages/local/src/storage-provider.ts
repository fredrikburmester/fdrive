import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { constants } from "node:fs";
import {
  access,
  copyFile,
  cp,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { addAbortSignal, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
  type EntryKind,
  type EntryStat,
  type FileEntry,
  isPrecompressedEntry,
  makeEntry,
  normalizePath,
  StorageError,
  type StorageProvider,
  splitSegments,
} from "@fdrive/core";
import { ZipFile } from "yazl";
import { codeOf, mapped } from "./errors.js";
import { createHome, type Home } from "./home.js";

export interface LocalStorageOptions {
  /** The user's home folder; created on first use. */
  readonly home: string;
  /**
   * False for a folder someone else owns (a shared folder): it is never
   * created, so a folder its owner removed reads as missing.
   */
  readonly create?: boolean;
  /** A folder `home` must really be inside; see `CreateHomeOptions.within`. */
  readonly within?: string;
}

/** Storage over one folder, with the folder itself for callers that combine several. */
export interface LocalStorage extends StorageProvider {
  readonly home: Home;
}

export interface MoveOptions {
  readonly overwrite?: boolean;
}

/**
 * Uploads are written here, beside their target, and renamed into place, so
 * a reader never sees half a file. Listings, copies and zips skip the name;
 * one left by a crash is ordinary clutter, not data.
 */
const PARTIAL = /^\.fdrive-partial-[0-9a-f]{16}$/;

/** `link` errors meaning the filesystem has no hard links, not that the name is taken. */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

function partialIn(dir: string): string {
  return join(dir, `.fdrive-partial-${randomBytes(8).toString("hex")}`);
}

function aborted(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function kindOf(info: Stats): EntryKind {
  if (info.isFile()) return "file";
  if (info.isDirectory()) return "dir";
  if (info.isSymbolicLink()) return "symlink";
  return "other";
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    const code = codeOf(error);
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

function webStream(stream: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
}

/**
 * Whether a range request still applies under `ifRange`. fdrive sends no
 * ETag for this storage, only `Last-Modified`, so an entity tag never
 * matches and a date matches when it names the file's current second.
 */
function rangeApplies(ifRange: string | undefined, modifiedAt: Date): boolean {
  if (ifRange === undefined) return true;
  if (ifRange.startsWith('"') || ifRange.startsWith("W/")) return false;
  const date = Date.parse(ifRange);
  return !Number.isNaN(date) && Math.floor(date / 1000) === Math.floor(modifiedAt.getTime() / 1000);
}

/**
 * Files in one user's home folder on this machine's disk. Paths are the
 * user's own (`/` is the home); see `createHome` for how they are confined.
 * Uploads and copies publish atomically, `overwrite: false` is a real
 * create-if-absent, and moves are one `rename` within a filesystem.
 */
export function createLocalStorage(options: LocalStorageOptions): LocalStorage {
  const home = createHome(options.home, {
    create: options.create ?? true,
    ...(options.within === undefined ? {} : { within: options.within }),
  });

  async function isHome(at: string): Promise<boolean> {
    return at === (await home.real());
  }

  async function describe(dir: string, parent: string, name: string): Promise<FileEntry | null> {
    const at = join(dir, name);
    let info = await lstatOrNull(at);
    if (info === null) return null;
    if (info.isSymbolicLink()) {
      try {
        const resolved = await realpath(at);
        if (await home.contains(resolved)) info = await stat(resolved);
      } catch {
        // A dangling link is listed as what it is.
      }
    }
    const kind = kindOf(info);
    return makeEntry(parent, {
      name,
      kind,
      size: kind === "file" ? info.size : 0,
      modifiedAt: info.mtime,
    });
  }

  async function clearChildren(dir: string): Promise<void> {
    for (const name of await readdir(dir)) {
      await rm(join(dir, name), { recursive: true, force: true });
    }
  }

  const storage: StorageProvider = {
    list: (path) =>
      mapped(path, async () => {
        const parent = normalizePath(path);
        const dir = await home.target(parent);
        if (!(await stat(dir)).isDirectory()) {
          throw new StorageError("bad_request", `not a directory: ${path}`);
        }
        const names = (await readdir(dir)).filter((name) => !PARTIAL.test(name));
        const entries = await Promise.all(names.map((name) => describe(dir, parent, name)));
        return entries.filter((entry) => entry !== null);
      }),

    stat: (path) =>
      mapped(path, async (): Promise<EntryStat> => {
        const info = await stat(await home.target(path));
        const kind = kindOf(info);
        const spelled = await home.spelled(path);
        return {
          kind,
          size: kind === "file" ? info.size : 0,
          modifiedAt: info.mtime,
          contentType: null,
          ...(spelled === normalizePath(path) ? {} : { path: spelled }),
        };
      }),

    probeDirectoryRead: (path) =>
      mapped(path, async () => {
        const dir = await home.target(path);
        if (!(await stat(dir)).isDirectory()) {
          throw new StorageError("bad_request", `not a directory: ${path}`);
        }
        const handle = await opendir(dir);
        try {
          await handle.read();
        } finally {
          await handle.close();
        }
      }),

    // The checks `download` makes, in its order, without opening the file:
    // `access` asks the permission question `open` would. Only metadata is
    // looked up, which the kernel usually has cached; no content is read.
    probeFileRead: (path) =>
      mapped(path, async () => {
        const at = await home.target(path);
        await access(at, constants.R_OK);
        const info = await stat(at);
        if (!info.isFile()) throw new StorageError("bad_request", `not a file: ${path}`);
      }),

    async statFile(path) {
      const info = await storage.stat(path);
      if (info.kind !== "file") throw new StorageError("bad_request", `not a file: ${path}`);
      return { size: info.size, modifiedAt: info.modifiedAt, contentType: null };
    },

    download: (path, opts) =>
      mapped(path, async () => {
        const signal = opts?.signal;
        if (signal?.aborted === true) throw aborted(signal);
        // Non-blocking, so a FIFO answers instead of hanging the open; it
        // changes nothing for a regular file.
        const handle = await open(
          await home.target(path),
          constants.O_RDONLY | constants.O_NONBLOCK,
        );
        try {
          const info = await handle.stat();
          if (!info.isFile()) throw new StorageError("bad_request", `not a file: ${path}`);
          const total = info.size;
          const range = opts?.range;
          const end = range === undefined ? total - 1 : Math.min(range.end ?? total - 1, total - 1);
          const ranged =
            range !== undefined &&
            range.start < total &&
            end >= range.start &&
            rangeApplies(opts?.ifRange, info.mtime);
          const start = ranged ? range.start : 0;
          const length = ranged ? end - start + 1 : total;
          const stream =
            length === 0
              ? Readable.from([])
              : handle.createReadStream({ start, end: start + length - 1 });
          if (length === 0) await handle.close();
          if (signal !== undefined) addAbortSignal(signal, stream);
          return {
            status: ranged ? 206 : 200,
            body: webStream(stream),
            contentLength: length,
            contentRange: ranged ? `bytes ${start}-${end}/${total}` : null,
            contentType: null,
            lastModified: info.mtime,
          };
        } catch (error) {
          await handle.close();
          throw error;
        }
      }),

    upload: (path, body, opts) =>
      mapped(path, async () => {
        const signal = opts?.signal;
        if (signal?.aborted === true) throw aborted(signal);
        const target = await home.entry(path);
        if (await isHome(target))
          throw new StorageError("conflict", `a directory exists at ${path}`);
        const dir = dirname(target);
        if (opts?.mkdirParents === true) await mkdir(dir, { recursive: true });
        const existing = await lstatOrNull(target);
        if (existing?.isDirectory() === true) {
          throw new StorageError("conflict", `a directory exists at ${path}`);
        }
        if (existing !== null && opts?.overwrite === false) {
          throw new StorageError("conflict", `target exists: ${path}`);
        }
        const partial = partialIn(dir);
        try {
          if (body instanceof Uint8Array) {
            await writeFile(partial, body, { flag: "wx", ...(signal ? { signal } : {}) });
          } else {
            const sink = (await open(partial, "wx")).createWriteStream();
            // Converted only now and piped at once: a body that fails while
            // the file opens would otherwise emit an error nobody listens to.
            const source = Readable.fromWeb(body as unknown as NodeReadableStream<Uint8Array>);
            await (signal ? pipeline(source, sink, { signal }) : pipeline(source, sink));
          }
          const written = (await stat(partial)).size;
          if (opts?.contentLength !== undefined && written !== opts.contentLength) {
            throw new StorageError(
              "bad_request",
              `upload ended after ${written} of ${opts.contentLength} bytes: ${path}`,
            );
          }
          if (opts?.modifiedAt !== undefined) await utimes(partial, new Date(), opts.modifiedAt);
          if (opts?.overwrite === false) await publishNew(partial, target, path);
          else await rename(partial, target);
        } finally {
          await rm(partial, { force: true });
        }
      }),

    mkdir: (path, opts) =>
      mapped(path, async () => {
        const at = await home.entry(path);
        await mkdir(at, { recursive: opts?.parents === true });
      }),

    move: (path, target, opts) =>
      mapped(path, async () => {
        const from = await home.entry(path);
        if (await isHome(from)) throw new StorageError("not_found", `not found: ${path}`);
        await moveEntry(from, await home.entry(target), { path, target }, opts);
      }),

    copy: (path, target, opts) =>
      mapped(path, async () => {
        if (splitSegments(normalizePath(path)).length === 0) {
          throw new StorageError("not_found", `not found: ${path}`);
        }
        await copyEntry(await home.target(path), await home.entry(target), { path, target }, opts);
      }),

    deleteFile: (path) =>
      mapped(path, async () => {
        const at = await home.entry(path);
        if ((await lstat(at)).isDirectory()) {
          throw new StorageError("bad_request", `is a directory: ${path}`);
        }
        await unlink(at);
      }),

    deleteDir: (path) =>
      mapped(path, async () => {
        const at = await home.entry(path);
        if (!(await lstat(at)).isDirectory()) {
          throw new StorageError("bad_request", `not a directory: ${path}`);
        }
        // The home itself stays: deleting "/" empties it.
        if (await isHome(at)) await clearChildren(at);
        else await rm(at, { recursive: true });
      }),

    setModifiedAt: (path, modifiedAt) =>
      mapped(path, async () => {
        const at = await home.target(path);
        await utimes(at, (await stat(at)).atime, modifiedAt);
      }),

    zip: (paths, opts) =>
      mapped(paths.join(", "), async () => {
        const items: ZipItem[] = [];
        for (const path of paths) {
          items.push({ at: await home.target(path), name: basename(normalizePath(path)) });
        }
        return zipItems(items, opts?.signal);
      }),
  };

  return { ...storage, home };
}

/**
 * Creates `target` from the finished `partial`, refusing a name that is
 * taken: the publish step of a create-if-absent upload.
 */
async function publishNew(partial: string, target: string, path: string): Promise<void> {
  try {
    await link(partial, target);
  } catch (error) {
    const code = codeOf(error);
    if (code === "EEXIST") throw new StorageError("conflict", `target exists: ${path}`);
    if (code === undefined || !NO_HARD_LINKS.has(code)) throw error;
    // Without hard links the check and the rename are two steps, so a
    // concurrent writer can still take the name between them.
    if ((await lstatOrNull(target)) !== null) {
      throw new StorageError("conflict", `target exists: ${path}`);
    }
    await rename(partial, target);
    return;
  }
  // A hard link raises only a create event, which file watchers such as the
  // indexer's skip as a file still being written. Opening it for writing and
  // closing it again raises the "finished writing" event they act on.
  await (await open(target, "r+")).close();
}

/** The caller's names for a move or copy, for error messages. */
interface Names {
  readonly path: string;
  readonly target: string;
}

/**
 * Moves the entry at `from` to `to`, both real paths already confined by
 * their homes: one `rename`, which also works between two users' folders on
 * the same disk. A taken target is a `conflict` unless `overwrite`.
 */
export async function moveEntry(
  from: string,
  to: string,
  names: Names,
  opts?: MoveOptions,
): Promise<void> {
  if (to.startsWith(`${from}${sep}`)) {
    throw new StorageError("bad_request", `cannot move ${names.path} into itself`);
  }
  const source = await lstat(from);
  const existing = await lstatOrNull(to);
  // The same inode under another spelling is a case-only rename on a
  // case-insensitive disk, not a collision.
  const same = existing !== null && existing.ino === source.ino && existing.dev === source.dev;
  if (existing !== null && !same) {
    if (opts?.overwrite !== true) {
      throw new StorageError("conflict", `target exists: ${names.target}`);
    }
    if (existing.isDirectory() || source.isDirectory()) {
      await rm(to, { recursive: true, force: true });
    }
  }
  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch (error) {
    if (codeOf(error) !== "EXDEV") throw error;
    // Another filesystem under the same home (a bind mount): copy,
    // then remove the source only once the copy is complete.
    await cp(from, to, { recursive: true, preserveTimestamps: true, errorOnExist: true });
    await rm(from, { recursive: true, force: true });
  }
}

/**
 * Copies `from` (a file or folder, already resolved) to the entry `to`,
 * keeping modification times; a file is published atomically.
 */
export async function copyEntry(
  from: string,
  to: string,
  names: Names,
  opts?: MoveOptions,
): Promise<void> {
  if (to === from || to.startsWith(`${from}${sep}`)) {
    throw new StorageError("bad_request", `cannot copy ${names.path} into itself`);
  }
  const source = await stat(from);
  const existing = await lstatOrNull(to);
  if (existing !== null && opts?.overwrite === false) {
    throw new StorageError("conflict", `target exists: ${names.target}`);
  }
  const dir = dirname(to);
  await mkdir(dir, { recursive: true });
  if (source.isFile()) {
    if (existing?.isDirectory() === true) await rm(to, { recursive: true, force: true });
    const partial = partialIn(dir);
    try {
      await copyFile(from, partial, constants.COPYFILE_FICLONE);
      await utimes(partial, source.atime, source.mtime);
      await rename(partial, to);
    } finally {
      await rm(partial, { force: true });
    }
    return;
  }
  if (!source.isDirectory()) throw new StorageError("bad_request", `not a file: ${names.path}`);
  if (existing !== null && !existing.isDirectory()) await rm(to, { force: true });
  await cp(from, to, {
    recursive: true,
    preserveTimestamps: true,
    force: true,
    filter: (src) => !PARTIAL.test(basename(src)),
  });
}

/** One thing to put in a zip: a resolved file or folder and its name in the archive. */
export interface ZipItem {
  readonly at: string;
  readonly name: string;
}

/** Streams a zip of `items`; a folder goes in with everything under it. */
export async function zipItems(
  items: readonly ZipItem[],
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  if (signal?.aborted === true) throw aborted(signal);
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
  // yazl reports a file that vanished mid-zip on the zip itself; an
  // unhandled "error" there would take the process down.
  zip.on("error", (error: Error) => output.destroy(error));
  for (const { at, name } of items) {
    const info = await stat(at);
    if (info.isFile()) {
      zip.addFile(at, name, { mtime: info.mtime, compress: !isPrecompressedEntry(name) });
    } else if (info.isDirectory()) {
      await addTree(zip, at, name, info.mtime);
    }
  }
  zip.end();
  if (signal !== undefined) addAbortSignal(signal, output);
  return webStream(output);
}

/**
 * Adds the folder at `dir` to `zip` under `prefix` (empty for the home).
 * Only regular files and folders go in: a symlink is skipped, so a zip can
 * never reach outside the home through one.
 */
async function addTree(zip: ZipFile, dir: string, prefix: string, mtime: Date): Promise<void> {
  const children = (await readdir(dir, { withFileTypes: true })).filter(
    (child) => !PARTIAL.test(child.name),
  );
  if (children.length === 0 && prefix.length > 0) {
    zip.addEmptyDirectory(prefix, { mtime });
    return;
  }
  for (const child of children) {
    const name = prefix.length > 0 ? `${prefix}/${child.name}` : child.name;
    const at = join(dir, child.name);
    if (child.isDirectory()) {
      await addTree(zip, at, name, (await lstat(at)).mtime);
    } else if (child.isFile()) {
      zip.addFile(at, name, {
        mtime: (await lstat(at)).mtime,
        compress: !isPrecompressedEntry(name),
      });
    }
  }
}
