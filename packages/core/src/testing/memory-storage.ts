import {
  baseName,
  createTrash,
  type EntryStat,
  type FileEntry,
  type MadeFolder,
  makeEntry,
  normalizePath,
  type OpenFile,
  parentPath,
  StorageError,
  type StorageProvider,
  splitSegments,
  type UploadOptions,
} from "../index.js";
import { type StoredZipEntry, storedZip } from "./stored-zip.js";

export interface MemoryStorage extends StorageProvider {
  dump(): Record<string, string>;
  dirs(): string[];
}

export interface MemoryStorageOptions {
  /** Modification times of new files. */
  readonly clock?: () => Date;
}

/** Every folder's modification time: the memory storage keeps none. */
const DIR_TIME = new Date(0);

interface MemFile {
  content: Uint8Array;
  mtime: Date;
  /** Like a disk's: every publish is a new inode, and every write moves the change time. */
  ino: bigint;
  ctimeNs: bigint;
}

/** The refusal for a name that is taken, worded as the local folder words it. */
function taken(path: string): StorageError {
  return new StorageError("conflict", `something already exists at ${path}`);
}

async function readAll(body: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array> {
  return body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * What `stat` would report at `path`, for a test that stands in for storage:
 * an empty file modified at the epoch, unless `fields` says otherwise.
 */
export function entryStat(
  path: string,
  fields: Partial<Pick<EntryStat, "kind" | "size" | "modifiedAt" | "ino">> = {},
): EntryStat {
  const normalized = normalizePath(path);
  const entry = makeEntry(parentPath(normalized), {
    name: baseName(normalized),
    kind: fields.kind ?? "file",
    size: fields.size ?? 0,
    modifiedAt: fields.modifiedAt ?? new Date(0),
  });
  return { ...entry, ino: fields.ino ?? BigInt(0) };
}

export function createMemoryStorage(
  files: Record<string, string | Uint8Array> = {},
  options: MemoryStorageOptions = {},
): MemoryStorage {
  const fileMap = new Map<string, MemFile>();
  /** Resumable uploads' bytes so far, by part id, until their final piece publishes them. */
  const parts = new Map<string, Uint8Array>();
  const childrenOf = new Map<string, Set<string>>([["/", new Set()]]);
  /** A folder's inode, kept across a move as a disk's rename keeps it. */
  const dirInodes = new Map<string, bigint>();
  const clock = options.clock ?? (() => new Date(0));
  // BigInt() rather than literals: the web app type-checks this file for an older target.
  let ticks = BigInt(0);
  const tick = () => {
    ticks += BigInt(1);
    return ticks;
  };
  dirInodes.set("/", tick());

  function isDir(p: string): boolean {
    return childrenOf.has(p);
  }

  /** Adds the folder at `p` unless it is there; true when it was not. */
  function addDir(p: string, ino?: bigint): boolean {
    if (childrenOf.has(p)) return false;
    childrenOf.set(p, new Set());
    dirInodes.set(p, ino ?? tick());
    childrenOf.get(parentPath(p))?.add(p);
    return true;
  }

  /** Adds every missing folder down to `path`; returns the first it added. */
  function ensureDirsFor(path: string): string | null {
    let current = "/";
    let first: string | null = null;
    for (const segment of splitSegments(path)) {
      current = `${current === "/" ? "" : current}/${segment}`;
      if (addDir(current)) first ??= current;
    }
    return first;
  }

  function putFile(path: string, content: Uint8Array, mtime: Date): void {
    const normalized = normalizePath(path);
    const parent = parentPath(normalized);
    ensureDirsFor(parent);
    childrenOf.get(parent)?.add(normalized);
    fileMap.set(normalized, { content, mtime, ino: tick(), ctimeNs: tick() });
  }

  function removeFile(path: string): void {
    fileMap.delete(path);
    childrenOf.get(parentPath(path))?.delete(path);
  }

  function removeDirTree(path: string): void {
    const prefix = `${path}/`;
    for (const filePath of [...fileMap.keys()]) {
      if (filePath.startsWith(prefix)) removeFile(filePath);
    }
    for (const dirPath of [...childrenOf.keys()]) {
      if (dirPath === path || dirPath.startsWith(prefix)) {
        childrenOf.get(parentPath(dirPath))?.delete(dirPath);
        childrenOf.delete(dirPath);
        dirInodes.delete(dirPath);
      }
    }
  }

  function copyTree(source: string, target: string): void {
    const prefix = `${source}/`;
    const treeDirs = [...childrenOf.keys()].filter((d) => d === source || d.startsWith(prefix));
    const treeFiles = [...fileMap.entries()].filter(([f]) => f.startsWith(prefix));
    ensureDirsFor(parentPath(target));
    addDir(target);
    for (const dirPath of treeDirs) {
      addDir(`${target}${dirPath.slice(source.length)}`);
    }
    for (const [filePath, entry] of treeFiles) {
      putFile(`${target}${filePath.slice(source.length)}`, entry.content, entry.mtime);
    }
  }

  /** Renames `source` to `target` as a disk does: every file and folder keeps its inode. */
  function renameTree(source: string, target: string): void {
    ensureDirsFor(parentPath(target));
    const file = fileMap.get(source);
    if (file !== undefined) {
      removeFile(source);
      childrenOf.get(parentPath(target))?.add(target);
      fileMap.set(target, { ...file, ctimeNs: tick() });
      return;
    }
    const prefix = `${source}/`;
    const treeDirs = [...childrenOf.keys()]
      .filter((d) => d === source || d.startsWith(prefix))
      .sort((a, b) => a.length - b.length)
      .map((d) => [d, dirInodes.get(d)] as const);
    const treeFiles = [...fileMap.entries()].filter(([f]) => f.startsWith(prefix));
    removeDirTree(source);
    for (const [dirPath, ino] of treeDirs) addDir(`${target}${dirPath.slice(source.length)}`, ino);
    for (const [filePath, entry] of treeFiles) {
      const moved = `${target}${filePath.slice(source.length)}`;
      childrenOf.get(parentPath(moved))?.add(moved);
      fileMap.set(moved, entry);
    }
  }

  for (const [path, content] of Object.entries(files)) {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const normalized = normalizePath(path);
    putFile(normalized, bytes, new Date(0));
  }

  function requireFile(path: string): { normalized: string; file: MemFile } {
    const normalized = normalizePath(path);
    const file = fileMap.get(normalized);
    if (!file) throw new StorageError("not_found", `not found: ${path}`);
    return { normalized, file };
  }

  /** What is at the normalized `path`, or null. */
  function entryAt(path: string): EntryStat | null {
    const parent = parentPath(path);
    const name = baseName(path);
    const file = fileMap.get(path);
    if (file !== undefined) {
      const entry = makeEntry(parent, {
        name,
        kind: "file",
        size: file.content.length,
        modifiedAt: file.mtime,
      });
      return { ...entry, ino: file.ino };
    }
    const ino = dirInodes.get(path);
    if (ino === undefined) return null;
    return { ...makeEntry(parent, { name, kind: "dir", size: 0, modifiedAt: DIR_TIME }), ino };
  }

  /** What a write just made at the normalized `path`. */
  function made(path: string): EntryStat {
    return entryAt(path) as EntryStat;
  }

  /**
   * Adds `path` to `entries` as a zip names it under `name`: a folder with
   * everything in it, unless it holds a file named `skip`.
   */
  function zipEntries(
    entries: StoredZipEntry[],
    path: string,
    name: string,
    skip: string | undefined,
  ): void {
    const file = fileMap.get(path);
    if (file !== undefined) {
      entries.push({ name, content: file.content, modifiedAt: file.mtime });
      return;
    }
    const children = [...(childrenOf.get(path) as Set<string>)];
    if (
      skip !== undefined &&
      children.some((child) => fileMap.has(child) && baseName(child) === skip)
    )
      return;
    if (children.length === 0 && name.length > 0) entries.push({ name, modifiedAt: DIR_TIME });
    for (const child of children) {
      zipEntries(
        entries,
        child,
        name.length > 0 ? `${name}/${baseName(child)}` : baseName(child),
        skip,
      );
    }
  }

  /** Checks an upload's target and reads its body, outside any critical section. */
  async function staged(
    path: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    opts: Pick<UploadOptions, "overwrite" | "mkdirParents" | "contentLength"> | undefined,
  ): Promise<{ normalized: string; bytes: Uint8Array }> {
    const normalized = normalizePath(path);
    if (isDir(normalized)) throw new StorageError("conflict", `a directory exists at ${path}`);
    if (opts?.overwrite !== true && fileMap.has(normalized)) throw taken(path);
    if (opts?.mkdirParents !== true && !isDir(parentPath(normalized)))
      throw new StorageError("not_found", `parent not found: ${path}`);
    const bytes = await readAll(body);
    if (opts?.contentLength !== undefined && bytes.length !== opts.contentLength)
      throw new StorageError("bad_request", `upload ended after ${bytes.length} bytes: ${path}`);
    return { normalized, bytes };
  }

  /** `bytes` written into upload part `id` at `offset`, cutting off what it held past it. */
  function writePart(path: string, id: string, offset: number, bytes: Uint8Array): Uint8Array {
    const held = parts.get(id) ?? new Uint8Array();
    if (held.length < offset)
      throw new StorageError("bad_request", `the upload has no byte ${offset}: ${path}`);
    const content = new Uint8Array(offset + bytes.length);
    content.set(held.subarray(0, offset));
    content.set(bytes, offset);
    parts.set(id, content);
    return content;
  }

  const storage: Omit<MemoryStorage, "trash"> = {
    dump(): Record<string, string> {
      const result: Record<string, string> = {};
      for (const [path, file] of fileMap) {
        result[path] = new TextDecoder().decode(file.content);
      }
      return result;
    },

    dirs(): string[] {
      return [...childrenOf.keys()].sort();
    },

    async list(path: string): Promise<FileEntry[]> {
      const normalized = normalizePath(path);
      const childPaths = childrenOf.get(normalized);
      if (childPaths !== undefined) {
        return [...childPaths].map((childPath) => {
          const { ino: _, ...entry } = made(childPath);
          return entry;
        });
      }
      if (fileMap.has(normalized)) throw new StorageError("bad_request", "not a directory");
      throw new StorageError("not_found", `not found: ${path}`);
    },

    async probeDirectoryRead(path: string): Promise<void> {
      await storage.list(path);
    },

    async contentStamp(path: string) {
      const { file } = requireFile((await storage.statFile(path)).path);
      return {
        size: file.content.length,
        mtimeNs: BigInt(file.mtime.getTime()) * BigInt(1_000_000),
        ino: file.ino,
        ctimeNs: file.ctimeNs,
      };
    },

    async statFile(path: string) {
      const s = await storage.stat(path);
      if (s.kind === "dir") throw new StorageError("bad_request", "is a directory");
      return s;
    },

    async stat(path: string): Promise<EntryStat> {
      const found = entryAt(normalizePath(path));
      if (found === null) throw new StorageError("not_found", `not found: ${path}`);
      return found;
    },

    async open(path: string): Promise<OpenFile> {
      const found = entryAt(normalizePath(path));
      if (found === null) throw new StorageError("not_found", `not found: ${path}`);
      if (found.kind !== "file") throw new StorageError("bad_request", `not a file: ${path}`);
      const { file } = requireFile(found.path);
      const { content } = file;
      let closed = false;
      const opened = () => {
        if (closed) throw new StorageError("internal", `the file is closed: ${path}`);
      };
      return {
        size: content.length,
        modifiedAt: file.mtime,
        stream(start = 0, end = content.length - 1) {
          opened();
          const bytes = content.slice(start, end + 1);
          return new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                closed = true;
                if (bytes.length > 0) controller.enqueue(bytes);
                controller.close();
              },
              cancel() {
                closed = true;
              },
            },
            { highWaterMark: 0 },
          );
        },
        async read(position, length) {
          opened();
          return content.slice(position, position + length);
        },
        async close() {
          closed = true;
        },
      };
    },

    async upload(path, body, opts): Promise<EntryStat> {
      // Staged first, outside the caller's critical section.
      const { normalized, bytes } = await staged(path, body, opts);
      const part = opts?.part;
      const content = part === undefined ? bytes : writePart(path, part.id, part.offset, bytes);
      if (part !== undefined) parts.delete(part.id);
      const critical = opts?.critical ?? (<T>(work: () => Promise<T>) => work());
      await critical(async () => {
        // A create-if-absent publish: a name taken meanwhile is refused.
        if (isDir(normalized)) throw new StorageError("conflict", `a directory exists at ${path}`);
        if (opts?.overwrite !== true && fileMap.has(normalized)) throw taken(path);
        putFile(normalized, content, opts?.modifiedAt ?? clock());
      });
      return made(normalized);
    },

    async uploadPart(path, body, opts): Promise<void> {
      const { bytes } = await staged(path, body, { ...opts, mkdirParents: true });
      writePart(path, opts.part.id, opts.part.offset, bytes);
    },

    async mkdir(path, opts): Promise<MadeFolder> {
      const normalized = normalizePath(path);
      if (fileMap.has(normalized)) throw new StorageError("conflict", `a file exists at ${path}`);
      if (opts?.parents !== true) {
        if (!isDir(parentPath(normalized)))
          throw new StorageError("not_found", `parent not found: ${path}`);
        if (isDir(normalized)) throw taken(path);
      }
      const created = ensureDirsFor(normalized);
      return { ...made(normalized), created };
    },

    async move(path, target, opts): Promise<EntryStat> {
      const destination = normalizePath(target);
      const source = normalizePath(path);
      const s = await storage.stat(source);
      if (source === "/") throw new StorageError("not_found", `not found: ${path}`);
      if (s.kind === "dir" && destination.startsWith(`${source}/`))
        throw new StorageError("bad_request", `cannot move ${path} into itself`);
      if (fileMap.has(destination) || isDir(destination)) {
        if (opts?.overwrite !== true) throw taken(target);
        if (isDir(destination)) removeDirTree(destination);
        else removeFile(destination);
      }
      renameTree(source, destination);
      return made(destination);
    },

    async copy(path, target, opts): Promise<EntryStat> {
      const source = normalizePath(path);
      const destination = normalizePath(target);
      if ((!fileMap.has(source) && !isDir(source)) || source === "/")
        throw new StorageError("not_found", `not found: ${path}`);
      if ((fileMap.has(destination) || isDir(destination)) && opts?.overwrite !== true)
        throw taken(target);
      const file = fileMap.get(source);
      if (file !== undefined) {
        if (isDir(destination)) removeDirTree(destination);
        putFile(destination, file.content, file.mtime);
        return made(destination);
      }
      if (fileMap.has(destination)) removeFile(destination);
      copyTree(source, destination);
      return made(destination);
    },

    async deleteFile(path: string): Promise<void> {
      const { normalized } = requireFile(path);
      removeFile(normalized);
    },

    async deleteDir(path: string): Promise<void> {
      const normalized = normalizePath(path);
      if (!isDir(normalized)) throw new StorageError("not_found", `not found: ${path}`);
      if (normalized === "/") {
        for (const child of [...(childrenOf.get("/") ?? [])]) {
          if (fileMap.has(child)) removeFile(child);
          else removeDirTree(child);
        }
        return;
      }
      removeDirTree(normalized);
    },

    async deleteEmptyDir(path: string): Promise<void> {
      const normalized = normalizePath(path);
      if (fileMap.has(normalized))
        throw new StorageError("bad_request", `not a directory: ${path}`);
      const children = childrenOf.get(normalized);
      if (children === undefined) throw new StorageError("not_found", `not found: ${path}`);
      if (normalized === "/") throw new StorageError("bad_request", "the root stays");
      if (children.size > 0) throw new StorageError("conflict", `not empty: ${path}`);
      removeDirTree(normalized);
    },

    async zip(paths, opts) {
      if (opts?.signal?.aborted === true) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      const entries: StoredZipEntry[] = [];
      for (const path of paths) {
        const found = await storage.stat(path);
        zipEntries(entries, found.path, found.name, opts?.skipFoldersWith);
      }
      const files = entries.flatMap((entry) =>
        entry.content === undefined ? [] : [entry.content],
      );
      let bytes = 0;
      opts?.onProgress?.({ processed: 0, total: files.length, bytes });
      for (const [index, content] of files.entries()) {
        bytes += content.length;
        opts?.onProgress?.({ processed: index + 1, total: files.length, bytes });
      }
      return streamOf(storedZip(entries));
    },
  };

  return Object.assign(storage, { trash: createTrash(storage) });
}
