import { createHash, type Hash, randomBytes } from "node:crypto";
import type { BigIntStats, Stats } from "node:fs";
import { constants, createReadStream } from "node:fs";
import {
  copyFile,
  cp,
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { addAbortSignal, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
  baseName,
  createTrash,
  type EntryKind,
  type EntryStat,
  type FileEntry,
  isPrecompressedEntry,
  joinPath,
  type MoveOptions,
  makeEntry,
  normalizePath,
  type OpenFile,
  parentPath,
  StorageError,
  type StorageProvider,
  type StorageWithoutTrash,
  splitSegments,
  type UploadPart,
  type ZipProgress,
} from "@fdrive/core";
import { ZipFile } from "yazl";
import { type DiskChangeListener, type DiskContent, type MovedStamp, notify } from "./changes.js";
import { codeOf, mapped, toStorageError } from "./errors.js";
import { createHome, type Home, type Location } from "./home.js";

export interface LocalStorageOptions {
  /** The user's home folder, created on first use, or a folder someone shares. */
  readonly home: string;
  /** For a folder someone shares, its owner's home; see `CreateHomeOptions.within`. */
  readonly within?: string;
  /** Hears every change this storage makes on disk, once it is done. */
  readonly onChange?: DiskChangeListener;
}

/**
 * Storage over one folder, with the folder itself for callers that combine
 * several, and its Trash at `/.trash` in that folder.
 */
export interface LocalStorage extends StorageProvider {
  readonly home: Home;
}

export type { MoveOptions };

/** The refusal for a name that is taken. */
function taken(path: string): StorageError {
  return new StorageError("conflict", `something already exists at ${path}`);
}

/**
 * Uploads are written here, beside their target, and renamed into place, so
 * a reader never sees half a file. Listings, copies and zips skip the name;
 * one left by a crash is ordinary clutter, not data. A resumable upload's
 * part waits under this name at the top of the home until its last piece.
 */
const PARTIAL = /^\.fdrive-partial-[0-9a-f]{16}$/;

/** `link` errors meaning the filesystem has no hard links, not that the name is taken. */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

function partialIn(dir: string, id = randomBytes(8).toString("hex")): string {
  return join(dir, `.fdrive-partial-${id}`);
}

/**
 * Writes `body` into a resumable upload's part at `offset`, first cutting off
 * whatever a failed earlier call left past it; offset 0 starts it afresh.
 */
async function writePart(
  at: string,
  offset: number,
  body: ReadableStream<Uint8Array> | Uint8Array,
  signal: AbortSignal | undefined,
): Promise<void> {
  const create = offset === 0 ? constants.O_CREAT | constants.O_TRUNC : 0;
  const handle = await open(at, constants.O_WRONLY | constants.O_NOFOLLOW | create);
  try {
    if ((await handle.stat()).size < offset) {
      throw new StorageError("bad_request", `the upload has no byte ${offset}`);
    }
    await handle.truncate(offset);
  } catch (error) {
    await handle.close();
    throw error;
  }
  const sink = handle.createWriteStream({ start: offset });
  const source =
    body instanceof Uint8Array
      ? Readable.from([body])
      : Readable.fromWeb(body as unknown as NodeReadableStream<Uint8Array>);
  await (signal ? pipeline(source, sink, { signal }) : pipeline(source, sink));
}

/**
 * Removes the parts of resumable uploads nobody finished: the ones at the top
 * of each home under `root` that last changed before `before`. Returns how
 * many it removed.
 */
export async function removeStaleParts(root: string, before: Date): Promise<number> {
  let removed = 0;
  for (const home of await readdir(root)) {
    const names = await readdir(join(root, home)).catch(() => []);
    for (const name of names.filter((candidate) => PARTIAL.test(candidate))) {
      const at = join(root, home, name);
      const info = await lstatOrNull(at);
      if (info?.isFile() !== true || info.mtime >= before) continue;
      await rm(at, { force: true });
      removed += 1;
    }
  }
  return removed;
}

function aborted(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/** Opens for reading without following a link at the last segment, nor blocking on a FIFO. */
const READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;

/** True for the home itself, which some operations treat apart. */
function isTop(path: string): boolean {
  return splitSegments(normalizePath(path)).length === 0;
}

/**
 * Flushes `path`, a file's bytes or a folder's names, to disk. Any
 * descriptor of an inode flushes all of it.
 */
async function flush(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function kindOf(info: Stats | BigIntStats): EntryKind {
  if (info.isFile()) return "file";
  if (info.isDirectory()) return "dir";
  if (info.isSymbolicLink()) return "symlink";
  return "other";
}

/** Codes meaning nothing is at a path. */
const GONE = new Set(["ENOENT", "ENOTDIR"]);

/** What `stats` reads, or null when nothing is there. */
async function orGone<T>(stats: Promise<T>): Promise<T | null> {
  try {
    return await stats;
  } catch (error) {
    if (GONE.has(codeOf(error) ?? "")) return null;
    throw error;
  }
}

function lstatOrNull(path: string): Promise<Stats | null> {
  return orGone(lstat(path));
}

/**
 * An upload's content as published at `target`: its digest and the file
 * exactly as a stat shows it once the publish is complete, or nothing when
 * `target` is no longer the inode, size and modification time that were
 * written (another writer replaced or changed it meanwhile). A rename, a link
 * and unlinking the temporary name each change the change time, so it is
 * read last.
 */
export async function published(
  target: string,
  written: Omit<DiskContent, "ctimeNs">,
): Promise<{ readonly content?: DiskContent }> {
  const info = await lstat(target, { bigint: true }).catch(() => null);
  if (
    info === null ||
    info.ino !== written.ino ||
    info.size !== BigInt(written.size) ||
    info.mtimeNs !== written.mtimeNs
  )
    return {};
  const { sha256 } = written;
  return {
    content: {
      sha256,
      size: Number(info.size),
      mtimeNs: info.mtimeNs,
      ino: info.ino,
      ctimeNs: info.ctimeNs,
    },
  };
}

/**
 * What is at `path`, a storage path, as `info` describes it. Times come from
 * a bigint stat everywhere, so every report of one file agrees to the
 * millisecond.
 */
export function entryFrom(path: string, info: BigIntStats): EntryStat {
  const kind = kindOf(info);
  const size = kind === "file" ? Number(info.size) : 0;
  const entry = makeEntry(parentPath(path), {
    name: baseName(path),
    kind,
    size,
    modifiedAt: info.mtime,
  });
  return { ...entry, ino: info.ino };
}

/**
 * The storage path of `dir`, a folder on the way to `found` (or `found`
 * itself), spelled as `found` spells it.
 */
function pathTo(found: Location, dir: string): string {
  const below = relative(dir, found.at);
  const segments = splitSegments(found.path);
  const depth = segments.length - (below === "" ? 0 : below.split(sep).length);
  return `/${segments.slice(0, depth).join("/")}`;
}

/** Refuses a body that is not `contentLength` long. */
function checkLength(written: number, contentLength: number | undefined, path: string): void {
  if (contentLength !== undefined && written !== contentLength) {
    throw new StorageError(
      "bad_request",
      `upload ended after ${written} of ${contentLength} bytes: ${path}`,
    );
  }
}

/** Passes bytes through unchanged, adding each chunk to `hash` on the way. */
function hashing(hash: Hash): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
}

/**
 * How much of a file a stream reads at a time: few enough reads that a
 * large download costs little more than the disk and the socket.
 */
const STREAM_CHUNK = 1024 * 1024;

/** Reads up to `length` bytes at `position` into a new buffer: fewer only at the end of the file. */
async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

/**
 * The file `handle` opened at `path`, as `info` describes it: reads stop at
 * the size it had then, and its stream closes it once it ends, fails or is
 * cancelled.
 */
function openFile(handle: FileHandle, info: BigIntStats, path: string): OpenFile {
  const size = Number(info.size);
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= handle.close();
    return closing;
  };
  /** At most `length` bytes from `position`, none past `size`. */
  const within = (position: number, length: number) =>
    Math.max(0, Math.min(length, size - position));
  return {
    size,
    modifiedAt: info.mtime,
    read: (position, length) =>
      mapped(path, () => readAt(handle, position, within(position, length))),
    stream(start = 0, end = size - 1) {
      let position = start;
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await readAt(
              handle,
              position,
              within(position, Math.min(STREAM_CHUNK, end + 1 - position)),
            );
            position += chunk.length;
            if (chunk.length > 0) controller.enqueue(chunk);
            if (chunk.length === 0 || position > end) {
              await close();
              controller.close();
            }
          } catch (error) {
            await close();
            throw toStorageError(error, path);
          }
        },
        cancel: close,
      });
    },
    close,
  };
}

/**
 * Files in one user's home folder on this machine's disk. Paths are the
 * user's own (`/` is the home); see `createHome` for how they are confined,
 * and why a path through a symbolic link is refused.
 * Uploads and copies publish atomically and, unless asked to overwrite,
 * only while the name is free (`link`, a real create-if-absent); moves are
 * one `rename` within a filesystem.
 */
export function createLocalStorage(options: LocalStorageOptions): LocalStorage {
  const home = createHome(
    options.home,
    options.within === undefined ? {} : { within: options.within },
  );
  const listener = options.onChange;
  /** The top of the home, or of its owner's for a shared folder: where resumable uploads' parts wait. */
  const partsDir = options.within ?? options.home;

  /** The entry `path` names on disk; refuses a path through a symbolic link. */
  async function entry(path: string): Promise<string> {
    return (await home.locate(path)).at;
  }

  /**
   * A listing's entry, as it is: a symbolic link is one, kind `symlink`,
   * which every operation then refuses.
   */
  async function describe(dir: string, parent: string, name: string): Promise<FileEntry | null> {
    const info = await orGone(lstat(join(dir, name), { bigint: true }));
    if (info === null) return null;
    const { ino: _, ...entry } = entryFrom(joinPath(parent, name), info);
    return entry;
  }

  async function clearChildren(dir: string): Promise<void> {
    for (const name of await readdir(dir)) {
      await rm(join(dir, name), { recursive: true, force: true });
    }
  }

  /**
   * Where an upload of `path` publishes: refuses the home itself, a folder
   * there, and a taken name unless the upload replaces it.
   */
  async function uploadTarget(path: string, overwrite: boolean): Promise<Location> {
    if (isTop(path)) throw new StorageError("conflict", `a directory exists at ${path}`);
    const found = await home.locate(path);
    const existing = await lstatOrNull(found.at);
    if (existing?.isDirectory() === true) {
      throw new StorageError("conflict", `a directory exists at ${path}`);
    }
    if (existing !== null && !overwrite) throw taken(path);
    return found;
  }

  /** Where a resumable upload's part waits for its pieces. */
  function partialFor(part: UploadPart): string {
    const partial = partialIn(partsDir, part.id);
    if (!PARTIAL.test(basename(partial))) {
      throw new StorageError("bad_request", `invalid upload part: ${part.id}`);
    }
    return partial;
  }

  const storage: StorageWithoutTrash = {
    list: (path) =>
      mapped(path, async () => {
        const parent = normalizePath(path);
        const dir = await entry(parent);
        if (!(await lstat(dir)).isDirectory()) {
          throw new StorageError("bad_request", `not a directory: ${path}`);
        }
        const names = (await readdir(dir)).filter((name) => !PARTIAL.test(name));
        const entries = await Promise.all(names.map((name) => describe(dir, parent, name)));
        return entries.filter((entry) => entry !== null);
      }),

    stat: (path) =>
      mapped(path, async () => {
        const found = await home.locate(path);
        return entryFrom(found.path, await lstat(found.at, { bigint: true }));
      }),

    probeDirectoryRead: (path) =>
      mapped(path, async () => {
        const dir = await entry(path);
        if (!(await lstat(dir)).isDirectory()) {
          throw new StorageError("bad_request", `not a directory: ${path}`);
        }
        const handle = await opendir(dir);
        try {
          await handle.read();
        } finally {
          await handle.close();
        }
      }),

    // Opened as `open` opens it, so it fails as `open` would and describes
    // the file `open` would read; none of it is read.
    contentStamp: (path) =>
      mapped(path, async () => {
        const handle = await open(await entry(path), READ_FLAGS);
        try {
          const info = await handle.stat({ bigint: true });
          if (!info.isFile()) throw new StorageError("bad_request", `not a file: ${path}`);
          return {
            size: Number(info.size),
            mtimeNs: info.mtimeNs,
            ino: info.ino,
            ctimeNs: info.ctimeNs,
          };
        } finally {
          await handle.close();
        }
      }),

    async statFile(path) {
      const info = await storage.stat(path);
      if (info.kind !== "file") throw new StorageError("bad_request", `not a file: ${path}`);
      return info;
    },

    open: (path) =>
      mapped(path, async () => {
        const handle = await open(await entry(path), READ_FLAGS);
        try {
          const info = await handle.stat({ bigint: true });
          if (!info.isFile()) throw new StorageError("bad_request", `not a file: ${path}`);
          return openFile(handle, info, path);
        } catch (error) {
          await handle.close();
          throw error;
        }
      }),

    upload: (path, body, opts = {}) =>
      mapped(path, async () => {
        const signal = opts.signal;
        if (signal?.aborted === true) throw aborted(signal);
        const overwrite = opts.overwrite === true;
        const found = await uploadTarget(path, overwrite);
        const target = found.at;
        const dir = dirname(target);
        const part = opts.part;
        // Only what changes the path or above it runs in the caller's critical
        // section; the body is written beside the target, or into its part,
        // outside it.
        const critical = opts.critical ?? (<T>(work: () => Promise<T>) => work());
        const parents = async () => {
          if (opts.mkdirParents === true) await mkdir(dir, { recursive: true });
        };
        // A whole upload is written beside the target, which must be there first.
        if (part === undefined) await critical(parents);
        const partial = part === undefined ? partialIn(dir) : partialFor(part);
        // Only a listener needs the digest, so nobody else pays for it.
        const hash = listener === undefined ? undefined : createHash("sha256");
        let info: BigIntStats;
        try {
          if (part !== undefined) {
            await writePart(partial, part.offset, body, signal);
          } else if (body instanceof Uint8Array) {
            await writeFile(partial, body, { flag: "wx", ...(signal ? { signal } : {}) });
            hash?.update(body);
          } else {
            const sink = (await open(partial, "wx")).createWriteStream();
            // Converted only now and piped at once: a body that fails while
            // the file opens would otherwise emit an error nobody listens to.
            const source = Readable.fromWeb(body as unknown as NodeReadableStream<Uint8Array>);
            if (hash === undefined) {
              await (signal ? pipeline(source, sink, { signal }) : pipeline(source, sink));
            } else {
              const tap = hashing(hash);
              await (signal
                ? pipeline(source, tap, sink, { signal })
                : pipeline(source, tap, sink));
            }
          }
          if (opts.modifiedAt !== undefined) await utimes(partial, new Date(), opts.modifiedAt);
          if (opts.durable === true) await flush(partial);
          // Taken before publishing: whatever is at the name later may be
          // another writer's file. Publishing keeps the inode, size and
          // modification time.
          info = await stat(partial, { bigint: true });
          checkLength(Number(info.size) - (part?.offset ?? 0), opts.contentLength, path);
          // A part arrived over several calls, so its digest is read back whole.
          if (hash !== undefined && part !== undefined) {
            for await (const chunk of createReadStream(partial)) hash.update(chunk as Buffer);
          }
          await critical(async () => {
            if (part !== undefined) await parents();
            if (overwrite) await rename(partial, target);
            else await publishNew(partial, target, path);
            if (part !== undefined) await rm(partial, { force: true });
            if (opts.durable === true) await flush(dir);
          });
        } finally {
          // A part outlives a failed call, so the call can be repeated.
          if (part === undefined) await rm(partial, { force: true });
        }
        notify(listener, {
          kind: "changed",
          path: target,
          ...(hash === undefined
            ? {}
            : await published(target, {
                sha256: hash.digest("hex"),
                size: Number(info.size),
                mtimeNs: info.mtimeNs,
                ino: info.ino,
              })),
        });
        return entryFrom(found.path, info);
      }),

    uploadPart: (path, body, opts) =>
      mapped(path, async () => {
        const signal = opts.signal;
        if (signal?.aborted === true) throw aborted(signal);
        await uploadTarget(path, opts.overwrite === true);
        const partial = partialFor(opts.part);
        await writePart(partial, opts.part.offset, body, signal);
        checkLength((await stat(partial)).size - opts.part.offset, opts.contentLength, path);
      }),

    mkdir: (path, opts) =>
      mapped(path, async () => {
        const found = await home.locate(path);
        const parents = opts?.parents === true;
        // With `parents`, the first folder it made, if any; without, it made `at` or threw.
        const made = parents ? await mkdir(found.at, { recursive: true }) : await mkdir(found.at);
        const first = parents ? made : found.at;
        // Search finds folders by name, so a new one is reported even while empty.
        if (first !== undefined) notify(listener, { kind: "changed", path: first });
        return {
          ...entryFrom(found.path, await lstat(found.at, { bigint: true })),
          created: first === undefined ? null : pathTo(found, first),
        };
      }),

    move: (path, target, opts) =>
      mapped(path, async () => {
        if (isTop(path)) throw new StorageError("not_found", `not found: ${path}`);
        const from = await entry(path);
        const to = await entry(target);
        const stamp = await moveEntry(from, to, { path, target }, opts);
        notify(listener, {
          kind: "moved",
          path: from,
          target: to,
          ...(stamp === undefined ? {} : { stamp }),
        });
        return storage.stat(target);
      }),

    copy: (path, target, opts) =>
      mapped(path, async () => {
        if (isTop(path)) throw new StorageError("not_found", `not found: ${path}`);
        const from = await entry(path);
        const to = await entry(target);
        await copyEntry(from, to, { path, target }, opts);
        notify(listener, { kind: "changed", path: to });
        return storage.stat(target);
      }),

    deleteFile: (path) =>
      mapped(path, async () => {
        const at = await entry(path);
        if ((await lstat(at)).isDirectory()) {
          throw new StorageError("bad_request", `is a directory: ${path}`);
        }
        await unlink(at);
        notify(listener, { kind: "changed", path: at });
      }),

    deleteDir: (path) =>
      mapped(path, async () => {
        const at = await entry(path);
        if (!(await lstat(at)).isDirectory()) {
          throw new StorageError("bad_request", `not a directory: ${path}`);
        }
        // The home itself stays: deleting "/" empties it.
        if (isTop(path)) await clearChildren(at);
        else await rm(at, { recursive: true });
        notify(listener, { kind: "changed", path: at });
      }),

    deleteEmptyDir: (path) =>
      mapped(path, async () => {
        const at = await entry(path);
        if (!(await lstat(at)).isDirectory()) {
          throw new StorageError("bad_request", `not a directory: ${path}`);
        }
        if (isTop(path)) throw new StorageError("bad_request", `the home stays: ${path}`);
        // `rmdir` refuses a folder that holds anything, whatever arrived in it.
        await rmdir(at);
        notify(listener, { kind: "changed", path: at });
      }),

    zip: (paths, opts) =>
      mapped(paths.join(", "), async () => {
        const items: ZipItem[] = [];
        for (const path of paths) {
          items.push({ at: await entry(path), name: basename(normalizePath(path)) });
        }
        return zipItems(items, opts);
      }),
  };

  return { ...storage, trash: createTrash(storage), home };
}

/**
 * The bytes of the files at `at`, already located: a file's size, or every
 * file's in a folder and the folders in it. A link counts as nothing, as a
 * copy takes it along as the link it is.
 */
export async function bytesAt(at: string): Promise<number> {
  const info = await lstat(at);
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) return 0;
  let total = 0;
  for (const name of await readdir(at)) total += await bytesAt(join(at, name));
  return total;
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
    if (code === "EEXIST") throw taken(path);
    if (code === undefined || !NO_HARD_LINKS.has(code)) throw error;
    // Without hard links the check and the rename are two steps, so a
    // concurrent writer can still take the name between them.
    if ((await lstatOrNull(target)) !== null) throw taken(path);
    await rename(partial, target);
    return;
  }
  // A hard link raises only a create event, which file watchers such as the
  // indexer's skip as a file still being written. Opening it for writing and
  // closing it again raises the "finished writing" event they act on. Only a
  // nudge: a copy of a file nobody may write cannot be opened so, and is
  // published all the same; the change storage reports still names it.
  await open(target, "r+").then(
    (handle) => handle.close(),
    () => undefined,
  );
}

/** The caller's names for a move or copy, for error messages. */
interface Names {
  readonly path: string;
  readonly target: string;
}

/**
 * Moves the entry at `from` to `to`, both located by their homes: one
 * `rename`, which also works between two users' folders on the same disk. A
 * folder takes the links in it along as they are, followed by nothing. A
 * taken target is a `conflict` unless `overwrite`. Returns a file's stamp
 * exactly as the rename left it, with its change time just before
 * (`MovedStamp`); nothing for a folder, for a file copied to another
 * filesystem, which is another inode, or for one that changed meanwhile.
 *
 * Checking the target and renaming are two steps, since Node has no
 * `RENAME_NOREPLACE`: a writer that takes the name between them is
 * replaced. A file could close that gap with `link` and `unlink`, but a
 * move stays a `rename` because file watchers (the indexer's) see a rename
 * as a move and keep what they know about the file, while a link and an
 * unlink read as a deleted file and a new one nobody finished writing.
 *
 * With `publish`, for an entry fdrive staged where no watcher looks, a new
 * file is linked into place only while the name is free and then unlinked
 * where it was staged, and the new name is flushed to disk before this
 * returns.
 */
export async function moveEntry(
  from: string,
  to: string,
  names: Names,
  opts?: MoveOptions,
): Promise<MovedStamp | undefined> {
  if (opts?.publish !== true) return relocate(from, to, names, opts);
  let stamp: MovedStamp | undefined;
  if (opts.overwrite !== true && (await lstat(from)).isFile()) {
    await mkdir(dirname(to), { recursive: true });
    try {
      await publishNew(from, to, names.target);
      await rm(from, { force: true });
    } catch (error) {
      // Another filesystem under the same home: no link reaches it.
      if (codeOf(error) !== "EXDEV") throw error;
      stamp = await relocate(from, to, names, opts);
    }
  } else stamp = await relocate(from, to, names, opts);
  await flush(dirname(to));
  return stamp;
}

/** `moveEntry` without `publish`: one `rename`. */
async function relocate(
  from: string,
  to: string,
  names: Names,
  opts?: MoveOptions,
): Promise<MovedStamp | undefined> {
  if (to.startsWith(`${from}${sep}`)) {
    throw new StorageError("bad_request", `cannot move ${names.path} into itself`);
  }
  const overwrite = opts?.overwrite === true;
  const source = await lstat(from);
  const existing = await lstatOrNull(to);
  // The same inode under another spelling is a case-only rename on a
  // case-insensitive disk, not a collision.
  const same = existing !== null && existing.ino === source.ino && existing.dev === source.dev;
  if (existing !== null && !same) {
    if (!overwrite) throw taken(names.target);
    if (existing.isDirectory() || source.isDirectory()) {
      await rm(to, { recursive: true, force: true });
    }
  }
  await mkdir(dirname(to), { recursive: true });
  // Taken last before the rename and first after it, so that nothing else
  // comes between the two stats and the move.
  const before = source.isFile() ? await lstat(from, { bigint: true }) : undefined;
  try {
    await rename(from, to);
  } catch (error) {
    if (codeOf(error) !== "EXDEV") throw error;
    // Another filesystem under the same home (a bind mount): copy,
    // then remove the source only once the copy is complete.
    await cp(from, to, {
      recursive: true,
      preserveTimestamps: true,
      force: overwrite,
      errorOnExist: true,
      verbatimSymlinks: true,
    });
    await rm(from, { recursive: true, force: true });
    return undefined;
  }
  if (before === undefined) return undefined;
  const after = await lstat(to, { bigint: true }).catch(() => null);
  if (
    after === null ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeNs !== before.mtimeNs
  )
    return undefined;
  return {
    size: Number(after.size),
    mtimeNs: after.mtimeNs,
    ino: after.ino,
    ctimeNs: after.ctimeNs,
    previousCtimeNs: before.ctimeNs,
  };
}

/**
 * Copies `from` (a file or folder, already located) to the entry `to`,
 * keeping modification times. A taken target is a `conflict` unless
 * `overwrite`, which replaces a file and merges into a folder. A file is
 * published atomically, and without `overwrite` only while the name is free.
 * A link in a folder is copied as the link it is, its target text unchanged,
 * as a move would take it along: never followed, and never its target.
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
  const overwrite = opts?.overwrite === true;
  const source = await lstat(from);
  const existing = await lstatOrNull(to);
  if (existing !== null && !overwrite) throw taken(names.target);
  const dir = dirname(to);
  await mkdir(dir, { recursive: true });
  if (source.isFile()) {
    if (existing?.isDirectory() === true) await rm(to, { recursive: true, force: true });
    const partial = partialIn(dir);
    try {
      await copyFile(from, partial, constants.COPYFILE_FICLONE);
      await utimes(partial, source.atime, source.mtime);
      if (overwrite) await rename(partial, to);
      else await publishNew(partial, to, names.target);
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
    force: overwrite,
    errorOnExist: true,
    verbatimSymlinks: true,
    filter: (src) => !PARTIAL.test(basename(src)),
  });
}

/** One thing to put in a zip: a located file or folder and its name in the archive. */
export interface ZipItem {
  readonly at: string;
  readonly name: string;
}

/** What `zipItems` is asked for besides the items. */
export interface ZipOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ZipProgress) => void;
}

/** One entry of a zip, in archive order: a file to read, or an empty folder. */
interface ZipEntry {
  readonly name: string;
  readonly mtime: Date;
  /** The file, its permission bits and size; absent for an empty folder. */
  readonly file?: { readonly at: string; readonly mode: number; readonly size: number };
}

/**
 * Streams a zip of `items`; a folder goes in with everything under it.
 * Every file is counted before the first is read, so progress has a total.
 */
export async function zipItems(
  items: readonly ZipItem[],
  opts: ZipOptions = {},
): Promise<ReadableStream<Uint8Array>> {
  const { signal, onProgress } = opts;
  if (signal?.aborted === true) throw aborted(signal);
  const entries: ZipEntry[] = [];
  for (const { at, name } of items) {
    const info = await lstat(at);
    if (info.isFile()) {
      entries.push({ name, mtime: info.mtime, file: { at, mode: info.mode, size: info.size } });
    } else if (info.isDirectory()) {
      await collectTree(entries, at, name, info.mtime);
    }
  }
  const total = entries.filter((entry) => entry.file !== undefined).length;
  let processed = 0;
  let bytes = 0;
  const report = () => onProgress?.({ processed, total, bytes });

  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
  // yazl reports its own failures on the zip; an unhandled "error" there
  // would take the process down.
  zip.on("error", (error: Error) => output.destroy(error));
  // yazl leaves the file it is reading open when the zip's reader goes
  // away, so the zip closes it.
  const reading = new Set<Readable>();
  output.once("close", () => {
    for (const file of reading) file.destroy();
  });
  for (const { name, mtime, file } of entries) {
    if (file === undefined) {
      zip.addEmptyDirectory(name, { mtime });
      continue;
    }
    // With the size it counted, yazl fails a file that changed size meanwhile.
    const options = {
      mtime,
      mode: file.mode,
      size: file.size,
      compress: !isPrecompressedEntry(name),
    };
    zip.addReadStreamLazy(name, options, (callback) => {
      const stream = createReadStream(file.at);
      reading.add(stream);
      stream.once("close", () => reading.delete(stream));
      // A file that vanished mid-zip fails it, named as the zip names it.
      stream.once("error", (error) => output.destroy(toStorageError(error, name) as Error));
      stream.on("data", (chunk: string | Buffer) => {
        bytes += chunk.length;
        report();
      });
      stream.once("end", () => {
        processed += 1;
        report();
      });
      callback(null, stream);
    });
  }
  report();
  zip.end();
  if (signal !== undefined) addAbortSignal(signal, output);
  // Read through the stream's async iterator, not `Readable.toWeb`: that
  // adapter can still hand on a chunk the zip had buffered after its reader
  // cancelled, and the throw lands where nothing catches it.
  return NodeReadableStream.from(output) as unknown as ReadableStream<Uint8Array>;
}

/**
 * Adds the folder at `dir` to `entries` under `prefix` (empty for the home).
 * Only regular files and folders go in: a symbolic link is skipped, as are
 * pipes and devices, since storage never follows one.
 */
async function collectTree(
  entries: ZipEntry[],
  dir: string,
  prefix: string,
  mtime: Date,
): Promise<void> {
  const children = (await readdir(dir, { withFileTypes: true })).filter(
    (child) => !PARTIAL.test(child.name),
  );
  if (children.length === 0 && prefix.length > 0) {
    entries.push({ name: prefix, mtime });
    return;
  }
  for (const child of children) {
    const name = prefix.length > 0 ? `${prefix}/${child.name}` : child.name;
    const at = join(dir, child.name);
    if (child.isDirectory()) {
      await collectTree(entries, at, name, (await lstat(at)).mtime);
    } else if (child.isFile()) {
      const info = await lstat(at);
      entries.push({ name, mtime: info.mtime, file: { at, mode: info.mode, size: info.size } });
    }
  }
}
